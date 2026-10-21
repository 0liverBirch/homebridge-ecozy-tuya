'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

/*
 * Discover Tuya devices on the local network.
 *
 * Tuya devices announce themselves with UDP broadcasts on ports 6666
 * (plain JSON) and 6667 (the same JSON, AES-128-ECB encrypted with the
 * well-known broadcast key - this is how every Tuya scanner, including
 * tinytuya's wizard, finds them). An announcement carries the device ID
 * (gwId) and its IP address, which is exactly what a new user needs for
 * the plugin config. It never carries the local key: that still has to
 * come from the Tuya IoT platform, by design.
 */

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
const PORTS = [6666, 6667];

function parseAnnouncement(msg, rinfo) {
  let payload = msg;
  // Framed packets: 0x000055AA prefix, 20-byte header, 8-byte trailer.
  if (msg.length > 28 && msg.readUInt32BE(0) === 0x000055aa) {
    payload = msg.slice(20, msg.length - 8);
  }
  const asJson = (buf) => {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      return j && j.gwId ? j : null;
    } catch (e) { return null; }
  };
  let j = asJson(payload);
  if (!j) {
    try {
      const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
      const out = Buffer.concat([d.update(payload), d.final()]);
      j = asJson(out);
    } catch (e) { /* not an encrypted announcement */ }
  }
  if (!j) return null;
  return {
    id: j.gwId,
    ip: j.ip || (rinfo && rinfo.address) || null,
    version: j.version || null,
    productKey: j.productKey || null,
  };
}

/**
 * Listen for announcements for `seconds` and resolve with the devices
 * found: [{ id, ip, version, productKey }], de-duplicated by device ID.
 */
function scan(seconds) {
  const listenMs = Math.max(1000, Math.min(60, Number(seconds) || 15) * 1000);
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const s of sockets) { try { s.close(); } catch (e) { /* ignore */ } }
      resolve([...found.values()].sort((a, b) => a.id.localeCompare(b.id)));
    };

    for (const port of PORTS) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (msg, rinfo) => {
        const dev = parseAnnouncement(msg, rinfo);
        if (dev && !found.has(dev.id)) found.set(dev.id, dev);
        else if (dev && found.has(dev.id) && !found.get(dev.id).ip && dev.ip) {
          found.set(dev.id, dev);
        }
      });
      sock.on('error', () => { /* the other port may still work */ });
      try {
        sock.bind(port, () => {
          try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
        });
        sockets.push(sock);
      } catch (e) { /* ignore */ }
    }

    setTimeout(finish, listenMs);
  });
}

module.exports = { scan, parseAnnouncement, PORTS };
