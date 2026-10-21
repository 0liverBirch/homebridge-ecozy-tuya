'use strict';

const { EcozyTuyaPlatform, PLATFORM_NAME } = require('./src/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, EcozyTuyaPlatform);
};
