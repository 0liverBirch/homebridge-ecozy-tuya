'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getAlarms, setAlarms, DAY_NAMES, SOUNDS } = require('./alarms');

const MAX_BODY_BYTES = 64 * 1024;

/**
 * A tiny HTTP server, run by the plugin itself, that serves the alarm
 * editor page and a JSON API for the four alarms. It talks to the clock
 * through the plugin's existing TuyaDevice connections, so it never opens
 * a second connection and never touches the Tuya cloud.
 *
 * There is deliberately no authentication: like the rest of this setup it
 * is LAN-only. Set "uiPort": 0 in the plugin config to disable it.
 */
function startAlarmServer(log, devices, port) {
  let pageHtml = null;
  try {
    pageHtml = fs.readFileSync(path.join(__dirname, 'alarm-page.html'), 'utf8');
  } catch (e) {
    log.warn(`[alarms] editor page missing (${e.message}) - API only`);
  }

  const pickDevice = (url) => {
    const id = url.searchParams.get('device');
    if (id && devices.has(id)) return devices.get(id);
    const first = devices.values().next();
    return first.done ? null : first.value;
  };

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        if (!pageHtml) { sendJson(res, 500, { error: 'Editor page unavailable' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHtml);
        return;
      }

      if (url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          devices: [...devices.values()].map((d) => ({
            name: d.name,
            connected: d.connected,
          })),
        });
        return;
      }

      if (url.pathname === '/api/alarms') {
        const device = pickDevice(url);
        if (!device) { sendJson(res, 503, { error: 'No device configured' }); return; }

        if (req.method === 'GET') {
          const alarms = await getAlarms(device);
          sendJson(res, 200, {
            device: device.name,
            connected: device.connected,
            days: DAY_NAMES,
            sounds: SOUNDS,
            alarms,
          });
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          const payload = JSON.parse(body || '{}');
          if (!Array.isArray(payload.alarms)) {
            sendJson(res, 400, { error: 'Expected { alarms: [...] }' });
            return;
          }
          const alarms = await setAlarms(device, payload.alarms);
          log.info(`[alarms] saved to ${device.name}`);
          sendJson(res, 200, {
            device: device.name,
            connected: device.connected,
            days: DAY_NAMES,
            sounds: SOUNDS,
            alarms,
          });
          return;
        }

        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      log.error(`[alarms] ${req.method} ${url.pathname} failed: ${e.message}`);
      sendJson(res, 502, { error: e.message });
    }
  });

  server.on('error', (e) => {
    log.error(`[alarms] server error: ${e.message}`);
  });
  server.listen(port, () => {
    log.info(`[alarms] alarm editor listening on port ${port}`);
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { startAlarmServer };
