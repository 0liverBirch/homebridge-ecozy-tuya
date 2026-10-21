# homebridge-ecozy-tuya

Control ecozy / Tuya-based devices locally in HomeKit via Homebridge. Built for the **ecozy E80S sunrise alarm clock**: it talks the Tuya local protocol directly on your LAN, no cloud, and it can do the one thing HomeKit cannot — **set the alarm times**, from the plugin's own settings page.

## What it adds to HomeKit

One accessory for the clock, with services you choose in the config:

- **Bedside Light** — on/off, brightness, and full colour (the clock's HSV datapoint).
- **Alarm 1–4** — switches that enable and disable each alarm. (The times themselves are set in the settings page, below.)
- **Sleep** — the sleep function switch.
- **Sleep Sounds** — the 22 sleep sounds as a HomeKit Television picker, with volume.
- **Bedtime** — one tap: light on at its last colour, chosen sleep sound playing with no countdown, sleep enabled. Off stops the sound and the light.

## Setting the alarms

Open the plugin's settings in the Homebridge UI. Under the device fields there is an **Alarms** section laid out like the ecozy app: the four alarms as cards with big times and repeat summaries, and on/off switches that work straight away. Tap a card to edit its time, repeat days, volume and brightness (shown as percentages), the sunrise lead-in ("light up in advance") and the light effect, saved straight to the clock through the plugin's existing connection. The alarm sound and snooze settings are not editable here yet, and are never modified.

The editor is also served on its own port (default **8735**) so you can bookmark it: `http://<your-homebridge-host>:8735/`. It has no login; it is meant for a trusted home LAN. Set `"uiPort": 0` in the config to turn it off.

Alarm times live in datapoint 127, a packed 56-byte value (4 alarms × 14 bytes). The plugin only ever rewrites the bytes it understands — hour, minute, repeat days, light mode, brightness, sunrise, volume — and carries every other byte over from the clock untouched. If it cannot read the current value, it refuses to write rather than guess.

## Several clocks

One plugin instance runs as many clocks as you add. Each clock has its own device ID, local key and IP address; add them all on the settings page (the scan helps: "Use this device" fills in a found clock, or adds a new entry for it). In HomeKit each clock appears under its own name with its own accessories. The alarm editor shows a clock switcher at the top when more than one clock is configured.

## Install

From the Homebridge UI: Plugins → search **homebridge-ecozy-tuya** → Install. Or from a terminal:

```bash
npm install -g homebridge-ecozy-tuya
```

Then restart Homebridge and open the plugin's settings page.

## First setup (finding your clock)

1. Open the plugin's settings in the Homebridge UI and press **Scan for devices**. Tuya devices announce their **device ID** and **IP address** on the local network; the scan listens for about 12 seconds and lists what it hears. Pick yours and the form fills in. (The same scan exists offline as `ecozy-tuya-dump --scan`.)
2. Get the clock's **local key** from the Tuya IoT platform (below). The key is never broadcast and cannot be scanned for; that is Tuya's design.
3. Paste the key into the form, save, and restart Homebridge. The clock appears in HomeKit, and the alarm editor appears in the same settings page.

## Configuration

Add a platform block to the `platforms` section of your Homebridge config, or use the plugin's settings page in the Homebridge UI. A complete worked example for the E80S ships in `config.sample.json`.

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `platform` | Yes | | Must be `EcozyTuya`. |
| `name` | Yes | | Platform name. |
| `uiPort` | No | `8735` | Port for the alarm editor. `0` disables it. |
| `devices[].id` | Yes | | The Tuya device ID. |
| `devices[].key` | Yes | | The Tuya **local key** (see below). |
| `devices[].ip` | No | auto-discover | The clock's IP. A static address or DHCP reservation is recommended. |
| `devices[].version` | No | `3.3` | Tuya protocol version (`3.4` for the E80S). |
| `devices[].pollInterval` | No | `10` | Seconds between state refreshes. |
| `devices[].services` | Yes | | The HomeKit services to expose, each with its datapoint mapping. |

**Your device ID and local key belong in the config and nowhere else.** They are entered on the settings page or in `config.json`; they are never part of this package.

### Getting the local key

1. Create a free project at the [Tuya IoT Platform](https://iot.tuya.com), in the data centre your account belongs to (Central Europe for EU accounts).
2. Link your ecozy / Smart Life app account to the project by QR scan.
3. Under **Devices**, read the `local_key` for your clock.

Note: shared devices (shown as `sweeper_is_share: 1`) may hide the key; linking the *owner's* app account exposes it.

### E80S datapoint map

| DP | Meaning |
| --- | --- |
| 101 | Light on/off |
| 102 | Brightness (10–200 in services config: scale 200) |
| 110 | Colour (HSV, 12-hex) |
| 111 | Colour mode (set to `17` before a colour write) |
| 113 | Sleep sound track (packed) |
| 114 / 122 / 123 / 124 | Alarm 1–4 enabled |
| 126 | Sleep function on/off |
| 127 | Alarm settings (packed, handled by the alarm editor) |

## Discovering datapoints on another device

The config's datapoint mapping is specific to the E80S. For a different Tuya device, the plugin ships a dump tool:

```bash
# from the machine running Homebridge, with Homebridge stopped
cd /var/lib/homebridge
./node_modules/.bin/ecozy-tuya-dump --scan         # list Tuya devices on the LAN (ID + IP), nothing else needed
./node_modules/.bin/ecozy-tuya-dump                # reads your Homebridge config automatically
./node_modules/.bin/ecozy-tuya-dump --once         # one snapshot, no watching
./node_modules/.bin/ecozy-tuya-dump --id <id> --key <localKey> --ip <ip> --version 3.4
```

It prints every datapoint with its current value (decoding the sleep track and the alarm blob on E80S-class devices), then watches for 30 seconds (`--seconds` to change) and prints whatever changes. Toggle one function at a time on the device or in its app and note which datapoint moves; that mapping is what goes in the config's `services` list. `--json <file>` saves the raw snapshot. Your local key is used to connect and is never printed.

Stop Homebridge first: the device allows one local connection, and the tool and the plugin cannot share it.

## How it works, and why it is not flaky

- **One connection.** Tuya devices accept a single local connection, so every service shares one socket and all traffic is serialised through one queue.
- **Timeouts on everything.** These clocks occasionally swallow a request. Every request has an 8-second timeout; on timeout the socket is dropped and reconnected with back-off, instead of the queue wedging forever behind a dead request.
- **Coalesced polls.** State is refreshed every `pollInterval` seconds; simultaneous refresh requests share a single device round-trip.
- **Honest state.** When the clock is unreachable, characteristics report a communication failure, so the Home app shows "No Response" instead of letting you tap controls that silently revert later.
- **Writes are never built on an empty cache.** Packed values (sleep sounds, alarms) are modified copies of the device's current value. If that value has never been seen, the plugin fetches it first, and refuses the write if it cannot.

## Notes and limitations

- Because of the one-connection rule, do not run other local Tuya tools (dump scripts, other plugins) against the clock at the same time as Homebridge.
- The alarm editor page has no authentication. Keep it on your home LAN, or disable it with `"uiPort": 0` and use the ecozy app for alarm times.
- The Python probe scripts from early development are not included; the datapoint dump tool below supersedes them.

## Licence

MIT. See [LICENSE](LICENSE).
