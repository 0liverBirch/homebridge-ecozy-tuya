'use strict';

/*
 * Homebridge UI server for the settings page. The page itself (public/
 * index.html) edits the plugin config through the standard UI bridge and
 * embeds the alarm editor served by the plugin, so this process has no
 * device work to do. It exists to satisfy the custom-UI contract and is
 * deliberately defensive: if the UI utilities cannot be loaded, the
 * settings page degrades instead of breaking.
 */

try {
  const { PluginUiServer } = require('homebridge-plugin-ui-utils');

  class EcozyUiServer extends PluginUiServer {
    constructor() {
      super();
      this.ready();
    }
  }

  // eslint-disable-next-line no-new
  new EcozyUiServer();
} catch (e) {
  // Optional by design - nothing to do.
}
