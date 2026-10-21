'use strict';

const { TuyaDevice } = require('./tuya-device');
const { setupServices } = require('./services');
const { startAlarmServer } = require('./alarm-server');

const PLUGIN_NAME = 'homebridge-ecozy-tuya';
const PLATFORM_NAME = 'EcozyTuya';

class EcozyTuyaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.accessories = new Map(); // uuid -> PlatformAccessory
    this.devices = new Map();     // deviceId -> TuyaDevice

    if (!Array.isArray(this.config.devices)) {
      this.log.warn('No "devices" array in config — nothing to do.');
      this.config.devices = [];
    }

    this.api.on('didFinishLaunching', () => this.discoverDevices());
    this._alarmServer = null;
    this.api.on('shutdown', () => {
      for (const device of this.devices.values()) device.stop();
      if (this._alarmServer) {
        try { this._alarmServer.close(); } catch (e) { /* ignore */ }
        this._alarmServer = null;
      }
    });
  }

  // Called once per cached accessory at startup.
  configureAccessory(accessory) {
    this.log.info(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const seen = new Set();

    for (const dev of this.config.devices) {
      if (!dev.id || !dev.key) {
        this.log.error(`Device "${dev.name || '?'}" is missing id or key — skipping.`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(dev.id);
      seen.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(dev.name || dev.id, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`Registered new accessory: ${dev.name}`);
      } else {
        accessory.displayName = dev.name || accessory.displayName;
      }

      accessory.getService(this.Service.AccessoryInformation)
        .setCharacteristic(this.Characteristic.Manufacturer, 'ecozy / Tuya')
        .setCharacteristic(this.Characteristic.Model, dev.model || 'Tuya Device')
        .setCharacteristic(this.Characteristic.SerialNumber, dev.id);

      // One shared connection per device (Tuya allows a single local socket).
      const device = new TuyaDevice(this.log, dev);
      this.devices.set(dev.id, device);

      setupServices(
        {
          Service: this.Service,
          Characteristic: this.Characteristic,
          hap: this.api.hap,
          log: this.log,
          accessory,
        },
        device,
        dev,
      );

      device.start();
    }

    // Remove accessories that are no longer in config.
    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }

    // Alarm editor: served by the plugin itself, through the same device
    // connections (the clock only allows one). It is also embedded in the
    // plugin's Homebridge settings page. Set "uiPort": 0 to disable.
    const uiPort = Number(this.config.uiPort != null ? this.config.uiPort : 8735);
    if (uiPort > 0 && this.devices.size > 0 && !this._alarmServer) {
      this._alarmServer = startAlarmServer(this.log, this.devices, uiPort);
    }
  }
}

module.exports = { EcozyTuyaPlatform, PLATFORM_NAME, PLUGIN_NAME };
