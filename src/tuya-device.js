'use strict';

const TuyAPI = require('tuyapi');
const EventEmitter = require('events');

const RECONNECT_BASE_MS = 15000;
const RECONNECT_MAX_MS = 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

/**
 * One TuyaDevice per physical device.
 *
 * IMPORTANT: Tuya devices accept only ONE local connection at a time, so every
 * HomeKit service for a device MUST share a single instance of this class.
 * It keeps a live cache of datapoint (dp) values and emits 'dp-update' whenever
 * the device pushes new state.
 *
 * Reliability rules (learned the hard way):
 * - Every device request has a timeout. These clocks occasionally swallow a
 *   request entirely; without a timeout the serial queue behind it wedges and
 *   every later command waits forever. On timeout the socket is dropped so
 *   the reconnect logic starts from a clean connection.
 * - Polls are coalesced: any number of simultaneous poll() calls share one
 *   device request.
 */
class TuyaDevice extends EventEmitter {
  constructor(log, config) {
    super();
    this.log = log;
    this.name = config.name || config.id;
    this.state = {};                 // dp (string) -> value
    this.connected = false;
    this._configIp = config.ip || null;
    this._hasIp = Boolean(config.ip);
    this._reconnectTimer = null;
    this._stopped = false;
    this._pollTimer = null;
    this._pollPromise = null;
    this.pollMs = Math.max(5000, Number(config.pollInterval || 10) * 1000);
    this.requestTimeoutMs = Math.max(
      1000,
      Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
    );
    // The device handles one request at a time. Overlapping a write with a
    // poll makes it stop responding, so everything goes through this queue.
    this._queue = Promise.resolve();

    this.api = new TuyAPI({
      id: config.id,
      key: config.key,
      ip: config.ip || undefined,
      version: config.version || '3.3',
      issueGetOnConnect: true,
      nullPayloadOnJSONError: true,
    });

    this.api.on('connected', () => {
      this.connected = true;
      this.log.info(`[${this.name}] connected`);
      this._backoff = 0;          // reset back-off on a good connection
      this.emit('connected');
      this.poll();
    });

    this.api.on('disconnected', () => {
      this.connected = false;
      this.log.warn(`[${this.name}] disconnected`);
      if (!this._configIp) this._hasIp = false; // re-discover on next attempt
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this.api.on('error', (err) => {
      const msg = err && err.message ? err.message : String(err);
      this.log.error(`[${this.name}] error: ${msg}`);
    });

    const ingest = (data) => {
      if (data && data.dps) {
        Object.assign(this.state, data.dps);
        this.emit('dp-update', data.dps);
      }
    };
    this.api.on('data', ingest);
    this.api.on('dp-refresh', ingest);
  }

  async start() {
    this._stopped = false;
    await this._connect();
    // Poll so changes made on the clock itself, or in the app, show up in
    // HomeKit rather than the tile going stale.
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      this.poll().catch(() => { /* poll logs its own failures */ });
    }, this.pollMs);
  }

  async stop() {
    this._stopped = true;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { await this.api.disconnect(); } catch (e) { /* ignore */ }
  }

  async _connect() {
    try {
      if (!this._hasIp) {
        await this.api.find({ timeout: 10 });
        this._hasIp = true;
      }
      await this.api.connect();
    } catch (e) {
      this.log.error(`[${this.name}] connect failed: ${e.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    // Exponential back-off: a device that is asleep or busy should not be
    // hammered every 15 seconds.
    this._backoff = Math.min(
      this._backoff ? this._backoff * 2 : RECONNECT_BASE_MS,
      RECONNECT_MAX_MS,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.log.info(`[${this.name}] reconnecting…`);
      this._connect();
    }, this._backoff);
  }

  /** Latest cached value for a datapoint, or undefined if not seen yet. */
  get(dp) {
    return this.state[String(dp)];
  }

  /**
   * The cached value for a datapoint, fetching it first if we have never
   * seen it. Packed datapoints (the sleep-sound blob, the alarm blob) are
   * written by modifying the current value, so writing from an empty cache
   * would clobber settings the device holds. Callers that get undefined
   * back must refuse to write.
   */
  async ensureValue(dp) {
    const key = String(dp);
    if (this.state[key] !== undefined) return this.state[key];
    await this.poll();
    return this.state[key];
  }

  /**
   * Run one device operation with a hard timeout. A swallowed request must
   * never wedge the queue: on timeout the socket is dropped (the normal
   * reconnect flow then re-establishes it) and the operation fails.
   */
  _withTimeout(fn, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.error(
          `[${this.name}] ${label} timed out after ${this.requestTimeoutMs}ms`
          + ' - dropping the connection to recover',
        );
        try {
          const p = this.api.disconnect();
          if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
        } catch (e) { /* ignore */ }
        reject(new Error(`${label} timed out`));
      }, this.requestTimeoutMs);

      // Handlers are attached for both outcomes even after a timeout, so a
      // late completion can never surface as an unhandled rejection.
      Promise.resolve()
        .then(fn)
        .then(
          (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
          (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
        );
    });
  }

  /** Run device traffic one operation at a time. */
  _enqueue(fn, label) {
    const run = this._queue.then(() => this._withTimeout(fn, label));
    // keep the chain alive even when an operation rejects
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Write a datapoint value to the device. */
  async set(dp, value) {
    try {
      await this._enqueue(
        () => this.api.set({ dps: String(dp), set: value }),
        `set dp ${dp}`,
      );
      // Update the cache immediately. This clock does not reliably push state
      // back, and without this HomeKit would keep reading the stale value and
      // the control would appear stuck.
      this.state[String(dp)] = value;
      this.emit('dp-update', { [String(dp)]: value });
    } catch (e) {
      this.log.error(`[${this.name}] set dp ${dp}=${value} failed: ${e.message}`);
      throw e;
    }
  }

  /** Ask the device for its current state. Concurrent calls share one request. */
  async poll() {
    if (!this.connected) return;
    if (this._pollPromise) return this._pollPromise;
    this._pollPromise = this._doPoll()
      .catch((e) => {
        this.log.warn(`[${this.name}] poll failed: ${e.message}`);
      })
      .finally(() => { this._pollPromise = null; });
    return this._pollPromise;
  }

  async _doPoll() {
    const data = await this._enqueue(
      () => this.api.get({ schema: true }),
      'poll',
    );
    const dps = (data && data.dps) ? data.dps : null;
    if (!dps) return;
    const changed = {};
    for (const [k, v] of Object.entries(dps)) {
      if (this.state[k] !== v) changed[k] = v;
    }
    Object.assign(this.state, dps);
    if (Object.keys(changed).length) this.emit('dp-update', changed);
  }
}

module.exports = { TuyaDevice };
