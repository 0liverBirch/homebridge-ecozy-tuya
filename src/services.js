'use strict';

const { SLEEP_SOUNDS, decodeTrack, encodeTrack } = require('./sounds');

// HomeKit ColorTemperature is expressed in mireds: 140 = coolest, 500 = warmest.
const HK_MIRED_COOL = 140;
const HK_MIRED_WARM = 500;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// When the device is unreachable, reads must fail honestly so the Home app
// shows "No Response" instead of acting on stale cached values.
function commError(ctx) {
  const HapStatusError = ctx.hap && ctx.hap.HapStatusError;
  const HAPStatus = ctx.hap && ctx.hap.HAPStatus;
  if (HapStatusError && HAPStatus) {
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  return new Error('Device is not responding');
}
function assertOnline(ctx, device) {
  if (!device.connected) throw commError(ctx);
}

// The current sleep-track value, fetched first if never seen. Packed values
// are written by modification, so a write built on an empty cache would
// clobber the device's own settings; this refuses instead.
async function currentTrack(ctx, device, trackDp) {
  const current = await device.ensureValue(trackDp);
  if (current === undefined) throw commError(ctx);
  return current;
}

function getOrAdd(ctx, type, name) {
  return ctx.accessory.getServiceById(type, name)
      || ctx.accessory.addService(type, name, name);
}

// --- Tuya HSV colour_data helpers (12-hex: HHHHSSSSVVVV) ---
// Tuya ranges: H 0-360, S 0-1000, V 0-1000. HomeKit: H 0-360, S 0-100, V(brightness) 0-100.
function decodeHSV(hex) {
  if (!hex || typeof hex !== 'string' || hex.length < 12) return null;
  return {
    h: parseInt(hex.substr(0, 4), 16),
    s: parseInt(hex.substr(4, 4), 16),
    v: parseInt(hex.substr(8, 4), 16),
  };
}
function encodeHSV(h, s, v) {
  return [h, s, v].map((x) => Math.round(clamp(x, 0, 65535)).toString(16).padStart(4, '0')).join('');
}

function setupServices(ctx, device, devCfg) {
  device.setMaxListeners(50);
  const services = Array.isArray(devCfg.services) ? devCfg.services : [];

  if (services.length === 0) {
    ctx.log.warn(`[${devCfg.name}] no services configured.`);
    return;
  }

  for (const cfg of services) {
    const type = (cfg.type || '').toLowerCase();
    switch (type) {
      case 'lightbulb': setupLightbulb(ctx, device, cfg); break;
      case 'switch': setupBinary(ctx, device, cfg, 'switch'); break;
      case 'outlet': setupBinary(ctx, device, cfg, 'outlet'); break;
      case 'soundpicker': setupSoundPicker(ctx, device, cfg); break;
      case 'bedtime': setupBedtime(ctx, device, cfg); break;
      default: ctx.log.warn(`[${devCfg.name}] unknown service type "${cfg.type}" — skipping.`);
    }
  }
}

function setupBinary(ctx, device, cfg, kind) {
  const { Service, Characteristic } = ctx;
  const svcType = kind === 'outlet' ? Service.Outlet : Service.Switch;
  const name = cfg.name || (kind === 'outlet' ? 'Outlet' : 'Switch');
  const dps = cfg.dps || {};
  const onDp = String(dps.on);
  const invert = Boolean(dps.invert);

  const toHK = (raw) => (invert ? !raw : Boolean(raw));
  const toTuya = (val) => (invert ? !val : Boolean(val));

  const svc = getOrAdd(ctx, svcType, name);

  svc.getCharacteristic(Characteristic.On)
    .onGet(() => {
      assertOnline(ctx, device);
      const raw = device.get(onDp);
      if (raw === undefined) device.poll();   // no value cached yet - go and ask
      return toHK(raw);
    })
    .onSet(async (value) => { await device.set(onDp, toTuya(value)); });

  device.on('dp-update', (changed) => {
    if (onDp in changed) svc.updateCharacteristic(Characteristic.On, toHK(changed[onDp]));
  });
}

function setupLightbulb(ctx, device, cfg) {
  const { Service, Characteristic } = ctx;
  const name = cfg.name || 'Light';
  const dps = cfg.dps || {};
  const svc = getOrAdd(ctx, Service.Lightbulb, name);

  // On / Off
  const onDp = String(dps.on);
  svc.getCharacteristic(Characteristic.On)
    .onGet(() => {
      assertOnline(ctx, device);
      const raw = device.get(onDp);
      if (raw === undefined) device.poll();
      return Boolean(raw);
    })
    .onSet(async (v) => { await device.set(onDp, Boolean(v)); });

  // Brightness (Tuya raw 0..scale -> HomeKit 0..100)
  const hasBright = dps.brightness != null;
  const bDp = hasBright ? String(dps.brightness) : null;
  const bScale = dps.brightnessScale || 1000;
  const bMin = dps.brightnessMin || 10;
  if (hasBright) {
    svc.getCharacteristic(Characteristic.Brightness)
      .onGet(() => {
        assertOnline(ctx, device);
        const raw = device.get(bDp);
        return raw == null ? 0 : clamp(Math.round((raw / bScale) * 100), 0, 100);
      })
      .onSet(async (v) => {
        // HomeKit sends 0 when a light is switched off, but this device only
        // accepts brightnessMin..brightnessScale. Sending 0 is rejected, the
        // write times out and the socket drops - so treat 0 as "off" and let
        // the On characteristic handle it instead.
        if (Number(v) <= 0) {
          await device.set(onDp, false);
          return;
        }
        let scaled = Math.round((v / 100) * bScale);
        if (scaled < bMin) scaled = bMin;
        if (scaled > bScale) scaled = bScale;
        await device.set(bDp, scaled);
      });
  }

  // Colour (Tuya HSV colour_data) -> HomeKit Hue + Saturation
  const hasColour = dps.colour != null;
  const colDp = hasColour ? String(dps.colour) : null;
  const colModeDp = dps.colourMode && dps.colourMode.dp != null ? String(dps.colourMode.dp) : null;
  const colModeVal = dps.colourMode ? dps.colourMode.value : null;
  if (hasColour) {
    const cur = decodeHSV(device.get(colDp)) || { h: 0, s: 0, v: 1000 };
    svc._hue = cur.h;              // 0..360
    svc._sat = Math.round(cur.s / 10); // HomeKit 0..100
    svc._val = cur.v || 1000;      // keep colour value at last/max

    const flush = async () => {
      const hex = encodeHSV(svc._hue, Math.round(svc._sat * 10), svc._val || 1000);
      // Switching to a colour needs the device in a colour mode first.
      if (colModeDp && colModeVal != null) {
        try { await device.set(colModeDp, colModeVal); } catch (e) { /* ignore */ }
      }
      await device.set(colDp, hex);
    };
    const schedule = () => {
      clearTimeout(svc._colTimer);
      svc._colTimer = setTimeout(() => flush().catch(() => {}), 60);
    };

    svc.getCharacteristic(Characteristic.Hue)
      .onGet(() => { assertOnline(ctx, device); const c = decodeHSV(device.get(colDp)); return c ? c.h : svc._hue; })
      .onSet((v) => { svc._hue = v; schedule(); });

    svc.getCharacteristic(Characteristic.Saturation)
      .onGet(() => { assertOnline(ctx, device); const c = decodeHSV(device.get(colDp)); return c ? Math.round(c.s / 10) : svc._sat; })
      .onSet((v) => { svc._sat = v; schedule(); });
  }

  // Colour temperature (only if configured; unused on the E80S)
  const hasCT = dps.colorTemp != null;
  const ctDp = hasCT ? String(dps.colorTemp) : null;
  const ctScale = dps.colorTempScale || 1000;
  const ctInvert = Boolean(dps.colorTempInvert);
  if (hasCT) {
    svc.getCharacteristic(Characteristic.ColorTemperature)
      .onGet(() => { assertOnline(ctx, device); return rawToMired(device.get(ctDp), ctScale, ctInvert); })
      .onSet(async (mired) => { await device.set(ctDp, miredToRaw(mired, ctScale, ctInvert)); });
  }

  // Push live device updates back into HomeKit
  device.on('dp-update', (changed) => {
    if (onDp in changed) svc.updateCharacteristic(Characteristic.On, Boolean(changed[onDp]));
    if (hasBright && bDp in changed) {
      svc.updateCharacteristic(Characteristic.Brightness, clamp(Math.round((changed[bDp] / bScale) * 100), 0, 100));
    }
    if (hasColour && colDp in changed) {
      const c = decodeHSV(changed[colDp]);
      if (c) {
        svc._hue = c.h; svc._sat = Math.round(c.s / 10); svc._val = c.v || svc._val;
        svc.updateCharacteristic(Characteristic.Hue, c.h);
        svc.updateCharacteristic(Characteristic.Saturation, Math.round(c.s / 10));
      }
    }
    if (hasCT && ctDp in changed) {
      svc.updateCharacteristic(Characteristic.ColorTemperature, rawToMired(changed[ctDp], ctScale, ctInvert));
    }
  });
}

function rawToMired(raw, scale, invert) {
  if (raw == null) return 300;
  let coolFrac = raw / scale;
  if (invert) coolFrac = 1 - coolFrac;
  coolFrac = clamp(coolFrac, 0, 1);
  return Math.round(HK_MIRED_WARM - coolFrac * (HK_MIRED_WARM - HK_MIRED_COOL));
}
function miredToRaw(mired, scale, invert) {
  let coolFrac = (HK_MIRED_WARM - mired) / (HK_MIRED_WARM - HK_MIRED_COOL);
  coolFrac = clamp(coolFrac, 0, 1);
  if (invert) coolFrac = 1 - coolFrac;
  return Math.round(coolFrac * scale);
}

/**
 * Sleep-sound picker, exposed as a HomeKit Television service - the only
 * native control that offers a list to choose from. Power maps to the sleep
 * switch; the "inputs" are the 22 sleep sounds.
 */
function setupSoundPicker(ctx, device, cfg) {
  const { Service, Characteristic, accessory, log } = ctx;
  const name = cfg.name || 'Sleep Sounds';
  const dps = cfg.dps || {};
  const trackDp = String(dps.track);          // dp113 - the packed sound settings
  const switchDp = dps.on != null ? String(dps.on) : null;  // dp126 - sleep on/off

  const sounds = Array.isArray(cfg.sounds) && cfg.sounds.length
    ? cfg.sounds
    : SLEEP_SOUNDS;

  const tv = accessory.getServiceById(Service.Television, name)
    || accessory.addService(Service.Television, name, name);

  tv.setCharacteristic(Characteristic.ConfiguredName, name);
  tv.setCharacteristic(
    Characteristic.SleepDiscoveryMode,
    Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
  );

  // Power = the sleep switch (falls back to the track's own playing flag).
  tv.getCharacteristic(Characteristic.Active)
    .onGet(() => {
      assertOnline(ctx, device);
      if (switchDp) {
        const raw = device.get(switchDp);
        if (raw === undefined) device.poll();
        return raw ? 1 : 0;
      }
      const t = decodeTrack(device.get(trackDp));
      return t && t.playing ? 1 : 0;
    })
    .onSet(async (value) => {
      const on = value === 1;
      const current = await currentTrack(ctx, device, trackDp);
      if (switchDp) await device.set(switchDp, on);
      await device.set(trackDp, encodeTrack({ playing: on }, current));
    });

  // Which sound is selected.
  tv.getCharacteristic(Characteristic.ActiveIdentifier)
    .onGet(() => {
      assertOnline(ctx, device);
      const t = decodeTrack(device.get(trackDp));
      if (!t) { device.poll(); return sounds[0].id; }
      return sounds.some((s) => s.id === t.sound) ? t.sound : sounds[0].id;
    })
    .onSet(async (id) => {
      const current = await currentTrack(ctx, device, trackDp);
      await device.set(trackDp, encodeTrack({ sound: Number(id), playing: true }, current));
      log.info(`[${name}] sound -> ${(sounds.find((s) => s.id === Number(id)) || {}).name || id}`);
    });

  // Remote key: use up/down to step through the list.
  tv.getCharacteristic(Characteristic.RemoteKey).onSet(async (key) => {
    const current = await device.ensureValue(trackDp);
    const t = decodeTrack(current);
    if (!t) return;
    const idx = sounds.findIndex((s) => s.id === t.sound);
    let next = idx;
    if (key === Characteristic.RemoteKey.ARROW_UP) next = idx - 1;
    else if (key === Characteristic.RemoteKey.ARROW_DOWN) next = idx + 1;
    else return;
    if (next < 0) next = sounds.length - 1;
    if (next >= sounds.length) next = 0;
    await device.set(trackDp, encodeTrack({ sound: sounds[next].id, playing: true }, current));
  });

  // One input source per sound.
  sounds.forEach((sound, i) => {
    const inputName = `${name} ${sound.id}`;
    const input = accessory.getServiceById(Service.InputSource, inputName)
      || accessory.addService(Service.InputSource, inputName, inputName);
    input
      .setCharacteristic(Characteristic.Identifier, sound.id)
      .setCharacteristic(Characteristic.ConfiguredName, sound.name)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION)
      .setCharacteristic(
        Characteristic.CurrentVisibilityState,
        Characteristic.CurrentVisibilityState.SHOWN,
      );
    tv.addLinkedService(input);
  });

  // Volume, via the Television Speaker service.
  const speakerName = `${name} Volume`;
  const speaker = accessory.getServiceById(Service.TelevisionSpeaker, speakerName)
    || accessory.addService(Service.TelevisionSpeaker, speakerName, speakerName);
  speaker
    .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
    .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
  speaker.getCharacteristic(Characteristic.Volume)
    .onGet(() => {
      assertOnline(ctx, device);
      const t = decodeTrack(device.get(trackDp));
      return t ? Math.round((t.volume / 16) * 100) : 0;   // device 1-16 -> HomeKit 0-100
    })
    .onSet(async (v) => {
      const vol = Math.max(1, Math.round((Number(v) / 100) * 16));
      const current = await currentTrack(ctx, device, trackDp);
      await device.set(trackDp, encodeTrack({ volume: vol }, current));
    });
  speaker.getCharacteristic(Characteristic.VolumeSelector).onSet(async (dir) => {
    const current = await device.ensureValue(trackDp);
    const t = decodeTrack(current);
    if (!t) return;
    const vol = dir === Characteristic.VolumeSelector.INCREMENT
      ? Math.min(16, t.volume + 1)
      : Math.max(1, t.volume - 1);
    await device.set(trackDp, encodeTrack({ volume: vol }, current));
  });
  tv.addLinkedService(speaker);

  // Reflect device-side changes.
  device.on('dp-update', (changed) => {
    if (trackDp in changed) {
      const t = decodeTrack(changed[trackDp]);
      if (t) {
        if (sounds.some((s) => s.id === t.sound)) {
          tv.updateCharacteristic(Characteristic.ActiveIdentifier, t.sound);
        }
        speaker.updateCharacteristic(Characteristic.Volume, Math.round((t.volume / 16) * 100));
        if (!switchDp) tv.updateCharacteristic(Characteristic.Active, t.playing ? 1 : 0);
      }
    }
    if (switchDp && switchDp in changed) {
      tv.updateCharacteristic(Characteristic.Active, changed[switchDp] ? 1 : 0);
    }
  });
}

/**
 * One-tap bedtime switch.
 *
 * ON  - turns the light on at whatever colour/mode it was last set to (we
 *       deliberately do not write the colour or mode datapoints, so the last
 *       setting is preserved), starts the chosen sleep sound with no
 *       countdown so it runs indefinitely, and enables the sleep function.
 * OFF - stops the sound and turns the light off.
 *
 * The switch reports ON while the sound is actually playing, so it will fall
 * back to OFF by itself once the clock stops the sound.
 */
function setupBedtime(ctx, device, cfg) {
  const { Service, Characteristic, log } = ctx;
  const name = cfg.name || 'Bedtime';
  const dps = cfg.dps || {};
  const lightDp = dps.light != null ? String(dps.light) : null;   // 101
  const trackDp = dps.track != null ? String(dps.track) : null;   // 113
  const sleepDp = dps.sleep != null ? String(dps.sleep) : null;   // 126
  const soundId = Number(cfg.sound != null ? cfg.sound : 2);      // 2 = Flowing Water
  const volume = cfg.volume != null ? Number(cfg.volume) : null;
  const turnLightOff = cfg.turnLightOff !== false;

  const svc = getOrAdd(ctx, Service.Switch, name);

  const isOn = () => {
    if (trackDp) {
      const t = decodeTrack(device.get(trackDp));
      if (t) return t.playing;
    }
    if (sleepDp) return Boolean(device.get(sleepDp));
    return false;
  };

  svc.getCharacteristic(Characteristic.On)
    .onGet(() => {
      assertOnline(ctx, device);
      if (trackDp && device.get(trackDp) === undefined) device.poll();
      return isOn();
    })
    .onSet(async (value) => {
      const on = Boolean(value);
      if (on) {
        // Light first, at its existing colour - we never write colour or mode.
        if (lightDp) await device.set(lightDp, true);
        if (trackDp) {
          const current = await currentTrack(ctx, device, trackDp);
          const changes = { sound: soundId, playing: true, countdown: 0 };
          if (volume != null) changes.volume = volume;
          await device.set(trackDp, encodeTrack(changes, current));
        }
        if (sleepDp) await device.set(sleepDp, true);
        log.info(`[${name}] on - light at last colour, sound ${soundId}, no countdown`);
      } else {
        if (trackDp) {
          const current = await currentTrack(ctx, device, trackDp);
          await device.set(trackDp, encodeTrack({ playing: false }, current));
        }
        if (sleepDp) await device.set(sleepDp, false);
        if (turnLightOff && lightDp) await device.set(lightDp, false);
        log.info(`[${name}] off`);
      }
    });

  device.on('dp-update', (changed) => {
    if ((trackDp && trackDp in changed) || (sleepDp && sleepDp in changed)) {
      svc.updateCharacteristic(Characteristic.On, isOn());
    }
  });
}

module.exports = { setupServices, setupSoundPicker, setupBedtime, decodeHSV, encodeHSV };
