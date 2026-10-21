'use strict';

/*
 * Alarm codec for the ecozy E80S "clock_set" datapoint (dp 127), plus the
 * glue that reads and writes alarms through a TuyaDevice.
 *
 * Confirmed layout: 56 bytes = 4 alarms x 14 bytes. Verified against a known
 * alarm (Alarm 1 = 05:00, Thu+Fri) and the device's thing-model spec.
 *
 *   b0  alarm index (1-4)
 *   b1  hour (0-23)
 *   b2  minute (0-59)
 *   b3  repeat-day bitmask, bit0 = Monday ... bit6 = Sunday (0 = one-off)
 *   b4  constant - preserved, never written
 *   b5  constant - preserved, never written
 *   b6  light mode (1-19)
 *   b7  constant - preserved, never written
 *   b8  constant - preserved, never written
 *   b9  light brightness, 10-200
 *   b10 sunrise lead-in, minutes before the alarm
 *   b11 constant - preserved, never written
 *   b12 varies, meaning unconfirmed - preserved, never written
 *   b13 volume (1-16)
 *
 * Whether an alarm is ON is NOT in this blob; it lives in the boolean
 * datapoints 114 / 122 / 123 / 124 (Alarm 1-4).
 *
 * Safety principle: only the bytes we understand are ever rewritten. Every
 * other byte is carried over verbatim from the blob currently on the device,
 * and a write is refused outright if the current blob cannot be read.
 */

const ALARM_DP = '127';
const ENABLE_DPS = ['114', '122', '123', '124'];

const LAYOUT = {
  headerBytes: 0,
  recordLength: 14,
  alarms: 4,
  offsets: {
    index: 0,
    hour: 1,
    minute: 2,
    repeatDays: 3,
    lightMode: 6,
    brightness: 9,
    sunriseMin: 10,
    volume: 13,
  },
  preserve: [4, 5, 7, 8, 11, 12],
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SOUNDS = {
  0: 'None', 1: 'River', 2: 'Flowing water', 3: 'Morning forest birds', 4: 'Birdsong',
  5: 'Night insects', 6: 'Crickets', 7: 'Summer & autumn', 8: 'Campfire forest',
  9: 'Rain & thunder', 10: 'Rain', 11: 'Waves', 12: 'Ocean waves', 13: 'Wind',
  14: 'Wind noise', 15: 'Wind chimes', 16: 'Train', 17: 'Church bells',
  18: 'Heartbeat', 19: 'Pink noise', 20: 'White noise', 21: 'Twinkle twinkle',
  22: 'Lullaby', 23: 'FM radio',
};

function hexToBytes(hex) {
  if (typeof hex !== 'string') return [];
  const clean = hex.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  return out;
}
function bytesToHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
function base64ToHex(b64) { return bytesToHex(Array.from(Buffer.from(b64, 'base64'))); }
function hexToBase64(hex) { return Buffer.from(hexToBytes(hex)).toString('base64'); }

function decodeDays(mask) {
  if (mask == null) return [];
  return DAY_NAMES.filter((_, i) => (mask >> i) & 1);
}
function encodeDays(days) {
  return (days || []).reduce((m, d) => {
    const i = DAY_NAMES.indexOf(d);
    return i >= 0 ? m | (1 << i) : m;
  }, 0);
}

/** Decode the raw blob (base64, as TuyAPI delivers it, or hex) into records. */
function decode(raw) {
  let hex = raw || '';
  if (/^[A-Za-z0-9+/=]+$/.test(hex) && /[^0-9a-fA-F]/.test(hex)) {
    try { hex = base64ToHex(hex); } catch (e) { /* keep as-is */ }
  }
  const bytes = hexToBytes(hex);
  const out = { hex, alarms: [] };
  const { recordLength, alarms, offsets, headerBytes } = LAYOUT;
  if (bytes.length >= headerBytes + recordLength * alarms) {
    for (let a = 0; a < alarms; a++) {
      const base = headerBytes + a * recordLength;
      const at = (f) => bytes[base + offsets[f]];
      out.alarms.push({
        index: at('index'),
        hour: at('hour'),
        minute: at('minute'),
        time: `${String(at('hour')).padStart(2, '0')}:${String(at('minute')).padStart(2, '0')}`,
        days: decodeDays(at('repeatDays')),
        daysMask: at('repeatDays'),
        lightMode: at('lightMode'),
        brightness: at('brightness'),
        sunriseMin: at('sunriseMin'),
        volume: at('volume'),
      });
    }
  }
  return out;
}

/**
 * Rewrite the blob with new alarm settings, as hex. Only fields present on
 * each alarm object are changed; unknown bytes are preserved from the blob
 * currently on the device. Throws if that blob is missing or the wrong
 * size, so a write can never be built on guesswork.
 */
function encode(alarms, currentRaw) {
  const decoded = decode(currentRaw);
  const bytes = hexToBytes(decoded.hex);
  const { recordLength, offsets, headerBytes } = LAYOUT;

  if (bytes.length < headerBytes + recordLength * LAYOUT.alarms) {
    throw new Error('Current alarm blob is missing or the wrong size - refusing to write.');
  }

  for (const a of alarms || []) {
    const n = Number(a.index);
    if (!(n >= 1 && n <= LAYOUT.alarms)) continue;
    const base = headerBytes + (n - 1) * recordLength;
    const put = (field, val) => { bytes[base + offsets[field]] = val & 0xff; };

    if (a.hour != null) {
      const h = Number(a.hour);
      if (!(h >= 0 && h <= 23)) throw new Error(`Alarm ${n}: hour must be 0-23.`);
      put('hour', h);
    }
    if (a.minute != null) {
      const m = Number(a.minute);
      if (!(m >= 0 && m <= 59)) throw new Error(`Alarm ${n}: minute must be 0-59.`);
      put('minute', m);
    }
    if (a.days != null) put('repeatDays', encodeDays(a.days));
    if (a.lightMode != null) {
      const lm = Number(a.lightMode);
      if (!(lm >= 1 && lm <= 19)) throw new Error(`Alarm ${n}: light mode must be 1-19.`);
      put('lightMode', lm);
    }
    if (a.brightness != null) {
      const b = Number(a.brightness);
      if (!(b >= 10 && b <= 200)) throw new Error(`Alarm ${n}: brightness must be 10-200.`);
      put('brightness', b);
    }
    if (a.sunriseMin != null) {
      const s = Number(a.sunriseMin);
      if (!(s >= 0 && s <= 60)) throw new Error(`Alarm ${n}: sunrise must be 0-60 minutes.`);
      put('sunriseMin', s);
    }
    if (a.volume != null) {
      const v = Number(a.volume);
      if (!(v >= 1 && v <= 16)) throw new Error(`Alarm ${n}: volume must be 1-16.`);
      put('volume', v);
    }
  }
  return bytesToHex(bytes);
}

/** Read all four alarms (with their on/off state) from a device. */
async function getAlarms(device) {
  const raw = await device.ensureValue(ALARM_DP);
  if (raw === undefined) {
    throw new Error(`[${device.name}] could not read the alarm settings from the clock.`);
  }
  const { alarms } = decode(raw);
  return alarms.map((a, i) => ({
    ...a,
    enabled: Boolean(device.get(ENABLE_DPS[i])),
  }));
}

const CONTENT_FIELDS = ['hour', 'minute', 'days', 'lightMode', 'brightness', 'sunriseMin', 'volume'];

/**
 * Write alarm edits to a device. If any alarm carries content fields
 * (time, days, ...), the blob is rewritten - reading the current blob
 * first and refusing to write if that read fails. A call that only flips
 * on/off states writes just those, without touching the blob.
 */
async function setAlarms(device, alarms) {
  const touchesBlob = (alarms || []).some((a) => CONTENT_FIELDS.some((f) => a[f] != null));
  if (touchesBlob) {
    const raw = await device.ensureValue(ALARM_DP);
    if (raw === undefined) {
      throw new Error(`[${device.name}] could not read the alarm settings from the clock.`);
    }
    const hex = encode(alarms, raw);
    // TuyAPI carries raw datapoints as base64, matching how they arrive.
    await device.set(ALARM_DP, hexToBase64(hex));
  }

  for (const a of alarms || []) {
    const n = Number(a.index);
    if (!(n >= 1 && n <= LAYOUT.alarms) || a.enabled == null) continue;
    const dp = ENABLE_DPS[n - 1];
    const want = Boolean(a.enabled);
    if (Boolean(device.get(dp)) !== want) {
      await device.set(dp, want);
    }
  }
  return getAlarms(device);
}

module.exports = {
  ALARM_DP, ENABLE_DPS, LAYOUT, DAY_NAMES, SOUNDS,
  decode, encode, decodeDays, encodeDays,
  hexToBytes, bytesToHex, base64ToHex, hexToBase64,
  getAlarms, setAlarms,
};
