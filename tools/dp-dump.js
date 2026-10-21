#!/usr/bin/env node
'use strict';

/*
 * dp-dump - discover and decode the datapoints of a local Tuya device.
 *
 *   ecozy-tuya-dump --scan [--seconds <n>]
 *   ecozy-tuya-dump [--config <path>] [--device <name|index>]
 *                   [--id <id> --key <key>] [--ip <ip>] [--version <3.4>]
 *                   [--seconds <n>] [--once] [--json <file>]
 *
 * With no device flags it reads the EcozyTuya platform block from your
 * Homebridge config.json, so there is nothing to retype. --once prints a
 * single snapshot and exits; otherwise it also watches for the given
 * number of seconds and prints every datapoint that changes - toggle
 * things on the device or in its app and watch which dp moves. That is
 * how the mapping in the README was worked out.
 *
 * IMPORTANT: Tuya devices accept ONE local connection. Stop Homebridge
 * first, or the dump and the plugin will fight over the clock.
 *
 * The local key is used to connect and is never printed.
 */

const fs = require('fs');
const path = require('path');
const TuyAPI = require('tuyapi');
const { decodeTrack } = require('../src/sounds');
const { decode: decodeAlarms } = require('../src/alarms');

function parseArgs(argv) {
  const args = { seconds: 30, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--id': args.id = next(); break;
      case '--key': args.key = next(); break;
      case '--ip': args.ip = next(); break;
      case '--version': args.version = next(); break;
      case '--config': args.config = next(); break;
      case '--device': args.device = next(); break;
      case '--seconds': args.seconds = Number(next()); break;
      case '--json': args.json = next(); break;
      case '--once': args.once = true; break;
      case '--scan': args.scan = true; break;
      case '--help': case '-h': args.help = true; break;
      default: break;
    }
  }
  return args;
}

function findConfig(explicit) {
  const candidates = [
    explicit,
    process.env.HOMEBRIDGE_STORAGE_PATH
      ? path.join(process.env.HOMEBRIDGE_STORAGE_PATH, 'config.json')
      : null,
    '/var/lib/homebridge/config.json',
    path.join(process.env.HOME || '', '.homebridge', 'config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function deviceFromConfig(args) {
  const cfgPath = findConfig(args.config);
  if (!cfgPath) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${cfgPath}: ${e.message}`);
    return null;
  }
  const platforms = Array.isArray(cfg.platforms) ? cfg.platforms : [];
  const block = platforms.find((p) => p && p.platform === 'EcozyTuya');
  if (!block || !Array.isArray(block.devices) || !block.devices.length) return null;

  let dev = null;
  if (args.device != null) {
    const byIndex = block.devices[Number(args.device)];
    dev = block.devices.find((d) => d.name === args.device) || byIndex || null;
  } else {
    dev = block.devices[0];
  }
  if (dev) console.log(`Using device "${dev.name || dev.id}" from ${cfgPath}`);
  return dev;
}

function describe(dp, value) {
  const parts = [];
  if (dp === '113') {
    const t = decodeTrack(value);
    if (t) parts.push(`sleep track: playing=${t.playing} sound=${t.sound} volume=${t.volume} mode=${t.mode} countdown=${t.countdown}min`);
  }
  if (dp === '127') {
    const { alarms } = decodeAlarms(value);
    for (const a of alarms) {
      parts.push(
        `alarm ${a.index}: ${a.time} days=[${a.days.join(' ') || 'once'}]`
        + ` lightMode=${a.lightMode} brightness=${a.brightness}`
        + ` sunrise=${a.sunriseMin}min volume=${a.volume}`,
      );
    }
  }
  return parts;
}

function printDp(dp, value, indent) {
  const raw = typeof value === 'string' && value.length > 60
    ? `${value.slice(0, 57)}...`
    : JSON.stringify(value);
  console.log(`${indent}dp ${dp} = ${raw}`);
  for (const line of describe(dp, value)) {
    console.log(`${indent}    ${line}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 24).join('\n'));
    return;
  }

  if (args.scan) {
    const { scan } = require('../src/scan');
    const secs = Math.max(2, Number(args.seconds) || 15);
    console.log(`Listening for Tuya device announcements for ${secs}s...`);
    const devices = await scan(secs);
    if (!devices.length) {
      console.log('No devices heard. Check the device is powered, on this LAN, and not already connected to something else.');
      return;
    }
    for (const d of devices) {
      console.log(`  id ${d.id}  ip ${d.ip || '?'}${d.version ? `  protocol ${d.version}` : ''}`);
    }
    console.log('\nThe local key is never broadcast - get it from the Tuya IoT platform (see the README).');
    return;
  }

  const fromConfig = (args.id && args.key) ? null : deviceFromConfig(args);
  const dev = {
    id: args.id || (fromConfig && fromConfig.id),
    key: args.key || (fromConfig && fromConfig.key),
    ip: args.ip || (fromConfig && fromConfig.ip),
    version: args.version || (fromConfig && fromConfig.version) || '3.3',
    name: (fromConfig && fromConfig.name) || 'Tuya device',
  };
  if (!dev.id || !dev.key) {
    console.error('No device found. Pass --id and --key, or point --config at a Homebridge config.json with an EcozyTuya platform.');
    process.exitCode = 2;
    return;
  }

  const api = new TuyAPI({
    id: dev.id,
    key: dev.key,
    ip: dev.ip || undefined,
    version: dev.version,
    issueGetOnConnect: false,
    nullPayloadOnJSONError: true,
  });

  const state = {};
  const noteChanges = (dps, label) => {
    for (const [dp, v] of Object.entries(dps || {})) {
      if (state[dp] !== v) {
        state[dp] = v;
        printDp(dp, v, label);
      }
    }
  };
  api.on('data', (d) => noteChanges(d && d.dps, '  [change] '));
  api.on('dp-refresh', (d) => noteChanges(d && d.dps, '  [change] '));
  api.on('error', (e) => console.error(`device error: ${e.message || e}`));

  try {
    if (!dev.ip) {
      console.log('Discovering the device on the LAN...');
      await api.find({ timeout: 10 });
    }
    await api.connect();
  } catch (e) {
    console.error(`Could not connect: ${e.message}`);
    console.error('Hint: the device allows ONE local connection. If Homebridge is running, stop it and retry.');
    process.exitCode = 1;
    return;
  }

  console.log(`Connected to ${dev.name} (protocol ${dev.version}). Current datapoints:`);
  try {
    const data = await api.get({ schema: true });
    const dps = (data && data.dps) || {};
    const keys = Object.keys(dps).sort((a, b) => Number(a) - Number(b));
    for (const dp of keys) {
      state[dp] = dps[dp];
      printDp(dp, dps[dp], '  ');
    }
    if (args.json) {
      fs.writeFileSync(args.json, JSON.stringify({ device: dev.name, dps }, null, 2));
      console.log(`Snapshot written to ${args.json}`);
    }
  } catch (e) {
    console.error(`Snapshot failed: ${e.message}`);
  }

  if (!args.once && args.seconds > 0) {
    console.log(`\nWatching for ${args.seconds}s - change things on the device or in its app...`);
    await new Promise((r) => setTimeout(r, args.seconds * 1000));
  }

  try { await api.disconnect(); } catch (e) { /* ignore */ }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
