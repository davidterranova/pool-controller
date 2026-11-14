# ESP32 - Pool controller

ESPHome firmware for an ESP32-WROOM that runs a swimming pool's variable-speed
pump: an autonomous on-device filtration schedule (computed from water
temperature and sunrise/sunset, plus manual override), a freeze-protection
safety rule that always wins, and three temperature sensors — all exposed to
Home Assistant, but not dependent on it. The device keeps running its
schedule whether or not HA is reachable.

See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for how the controller actually
works: wiring, control logic, and Home Assistant setup. This file covers the
repo itself — layout and tooling.

## Repo layout

| File | Purpose |
|---|---|
| `pool-controller.yaml` | The ESPHome device config — this *is* the firmware source. |
| `wifi-setup.yaml` | Package included by `pool-controller.yaml`: fallback hotspot, joining a network from the page, Wi-Fi statistics, clock from the browser (see below). |
| `secrets.yaml` | Wi-Fi credentials, API encryption key, OTA password. Gitignored — create your own (see below). |
| `Makefile` | Validate / build / flash / OTA / status tooling. |
| `home-assistant/` | `piscine-card.js`, the pool card of the Home Assistant dashboard, also used by the page in `webui/` (see below). Installed in HA through the Marketplace (HACS). |
| `hacs.json` | Tells the Marketplace (HACS) which file this repo publishes: the card above, from each GitHub release. |
| `tools/webui-mock/` | Local mock of the device's web UI, for working on the page without flashing (see below). |
| `webui/` | The device's own web page, built around the same `piscine-card` (see below). `make webui` bundles it into `webui/dist/` (gitignored), which the firmware embeds. |
| `.gitignore` | Excludes `secrets.yaml`, `.esphome/` (build cache), `.vscode/`. |
| `LICENSE` | MIT. |

## Toolchain

- **Docker** — `validate`, `build`, and `ota` run the official
  `ghcr.io/esphome/esphome` image, so no local Python/ESPHome install is
  needed for those.
- **esptool** (bundled with a local ESP-IDF install) — used only for the
  initial USB flash. Docker Desktop on macOS can't pass a host USB-serial
  device through to a Linux container, so `make flash` shells out to the
  host's esptool directly instead of going through Docker.

## First-time setup

1. Create `secrets.yaml` in this directory (gitignored, never commit it):

   ```yaml
   wifi_ssid: "..."
   wifi_password: "..."
   # Must be base64-encoded, 32 random bytes:
   #   python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
   pool_controller_api_key: "..."
   pool_controller_ota_password: "..."
   # Local web UI at http://pool-controller.local/ (username: admin):
   pool_controller_web_password: "..."
   # Used by the autonomous filtration schedule for sunrise/sunset + local
   # midnight -- decimal degrees and an IANA zone name:
   pool_latitude: "..."
   pool_longitude: "..."
   pool_timezone: "Europe/Paris"
   ```

2. Check the `substitutions:` block at the top of `pool-controller.yaml` —
   the four relay GPIO pins and the OneWire bus pin — match your own wiring.
   See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for what each one does.

3. `make validate` — parses the YAML and checks component schemas (fast, no
   compile).

4. `make build` — compiles the firmware. The first run downloads the
   ESP32 Arduino/ESP-IDF toolchain inside the container (~1GB), so budget
   several minutes; later builds are quick.

5. Plug the board in over USB and `make flash`.

6. Pair it with Home Assistant — see
   [POOL-CONTROLLER.md](POOL-CONTROLLER.md#home-assistant-configuration).

## Makefile targets

| Target | What it does |
|---|---|
| `make validate` | Parse + schema-check `pool-controller.yaml`, no compile. |
| `make build` | Compile the firmware (also catches errors inside C++ lambdas, which `validate` can't). |
| `make webui` | Bundle the page in `webui/` into the two files the firmware embeds (`webui/dist/`). Run by `validate`, `build` (so `ota` and `flash`) and `mock-ui` whenever a page source changed. |
| `make flash` | Rebuild, then flash over USB via esptool. Auto-detects the serial port; override with `PORT=/dev/cu.xxxx`. |
| `make status` | Query the connected board over USB: chip type, revision, MAC address. |
| `make kill-port` | Kill whatever process (a leftover `screen`/monitor session, usually) is holding the serial port open. |
| `make ota` | Rebuild, then push the firmware over Wi-Fi instead of USB. Only works once the device has already joined Wi-Fi at least once. |
| `make ip` | Resolve and print the device's current IP via mDNS. |
| `make mock-ui` | Serve a local mock of the device's web UI at http://localhost:8080/ (see below). `MOCK_PORT=` to change the port, `MOCK_INDEX=path.html` to serve your own page. |
| `make mock-webui` | `make mock-ui` serving the page from its sources in `webui/`, reloading on save (see below). `MOCK_HOTSPOT=1` starts the simulated device on its hotspot, with no clock. |
| `make mock-ui-check` | Print the web UI layout (sections and order) and fail on any entity type the mock can't render. Runs in CI. |
| `make clean` | Remove the local build cache (`.esphome/`). |

`PORT` (serial) and `HOST` (network) both auto-detect and can be overridden
on the command line, e.g. `make flash PORT=/dev/cu.usbserial-XXXX` or
`make ota HOST=192.168.4.72`.

## Working on the web UI without flashing

`make mock-ui` runs [tools/webui-mock/mock_server.py](tools/webui-mock/mock_server.py)
in the same ESPHome image as `make build` and serves the device's web UI at
<http://localhost:8080/>. The UI is the page your firmware build serves: the
index.html ESPHome builds from the `web_server` block, and the bundle from
`make webui` behind it (or ESPHome's stock page, decoded from the image, if
you set `local: true` back).

- **The layout comes from the YAML.** Entities, names, icons, number ranges and
  the `web_server` sorting groups are read from `pool-controller.yaml`. Save
  the file and the open page reloads with the change. No build, no flash.
- **The controls act like the device.** A small simulation behind the
  entities computes today's plan, the boosts, the Manual Override and its
  timeout, the Apply gate and filtration hours. Changing a setting moves the
  values the way it would on the device. The simulation is an approximation
  for UI work, not a test of the control logic. Sunrise/sunset are fixed
  (07:45 / 17:15), and the clock is your machine's.
- **Same protocol as the device.** The mock implements the `/events` stream
  and the REST endpoints the page calls, so `MOCK_INDEX=my-page.html make
  mock-ui` serves your own HTML against the same API. That's the way to
  prototype a custom page before deciding to put it on the device. The
  scripts and styles next to that HTML are served too, and saving one
  reloads the page like the YAML does.
- **No login.** Unlike the device, the mock has no auth, to keep iteration
  quick.
- An entity the simulation doesn't know (e.g. one you just added) still
  shows up, with a static value. `make mock-ui-check` marks it
  `[static: not simulated]`. Add it to the `N` map in `mock_server.py` to make
  it move.

## Home Assistant card (`home-assistant/`)

[home-assistant/piscine-card.js](home-assistant/piscine-card.js) is
`custom:piscine-card`, the pool card of the Home Assistant dashboard: a tile,
and a panel shown in a pop-up with the pump's state, today's plan timeline,
Auto/Manuel, the forced speed and its duration. It's a plain custom element,
no framework and no build step, in French.

It lives here because it's written against this firmware's entities, and
because it now has two users that must change together:

- **Home Assistant**, where it was first written, configured with HA
  entity ids. It installs the card through the Marketplace (see below).
- **The device's own page** ([webui/](webui/), see below), which runs the
  same file unchanged against the ESP32. `webui/piscine-card.js` is a
  symlink to it.

What it needs from Home Assistant, besides the entities:

- two scripts, which only set the Manual Override select and its timeout:
  `script.piscine_forcer_vitesse` (`vitesse`, optional `duree` in minutes)
  and `script.piscine_retour_auto`;
- the recorder's history of the Manual Override select since midnight, for
  the overrides already ended today on the timeline.

Those scripts, the dashboard and the push alert are Home Assistant config,
edited in its UI; they aren't in this repo.

### Installing it in Home Assistant

The card is installed through the Marketplace, built into Home Assistant
since 2026.11 (Settings → Marketplace; HACS, a custom integration, on older
releases), as a custom repository:

1. Add `davidterranova/pool-controller` as a custom repository, type
   Dashboard. This needs a GitHub account connected to the Marketplace;
   without one it also wouldn't check the repo for updates.
2. Install « Piscine Card ». The Marketplace registers the dashboard
   resource itself, `/local/community/pool-controller/piscine-card.js`, with
   the version in its query string. Don't add a resource by hand: it would
   load the card twice.

Releases in this repo are only the card's
([hacs.json](hacs.json)): each carries `piscine-card.js` as an asset, and
its tag is the card's `VERSION`. The firmware is built and flashed from a
checkout, not released.

### Shipping a change to the card

1. Bump `VERSION` at the top of the card. A pull request that changes the
   card without a new `VERSION` fails CI
   ([.github/workflows/card.yml](.github/workflows/card.yml)).
2. Check the panel on the device's page against the mock (`make
   mock-webui`). It doesn't exercise the HA-only parts: the tile variant, the
   scripts, the recorder.
3. Merge. The workflow publishes release `v<VERSION>` with the card, then
   runs the Marketplace's (HACS's) own checks against the repo.
4. Home Assistant offers the update (Settings → Updates) once the
   Marketplace has seen the release. Install it: that also changes the
   resource URL, so browsers fetch the new file on their next reload.

The card's history up to 1.2.0 is in the local-k3s repo's git log, where it
was first written (`bridges/homeassistant/config/www/piscine/`).

## The device's page (`webui/`)

The device serves a page of our own instead of ESPHome's stock one, with the
look of the Home Assistant dashboard. It has three tabs:

- **Contrôle**, for daily use: Home Assistant's `piscine-card` panel (the
  pump's state, today's plan timeline, Auto/Manuel, forced speed and its
  duration), with tiles for the temperatures (the pool's with today's
  min/max) and the filling meter.
- **Avancé**: the filtration settings with their Apply gate, today's plan in
  detail, the last 7 days (hours filtered, pool min/max), the device's
  sensors, and its live log.
- **Wi-Fi** (see below): the connection and its statistics, and a way to
  join a network. Only shown when the device has those entities.

How it fits together:

- **The card is Home Assistant's, unchanged.** The page loads
  [home-assistant/piscine-card.js](home-assistant/piscine-card.js) (see
  above) through the `webui/piscine-card.js` symlink. It runs anywhere it
  gets a `hass` object, so a change to the card shows up here too; the page
  only needs a change if the card starts calling something new.
- **[esphome-hass.js](webui/esphome-hass.js) plays Home Assistant.** It builds
  `hass.states` from the device's `/events` stream, keyed by ESPHome's
  `name_id` (`select/Manual Override`), and turns the card's calls into the
  device's REST calls. The two HA scripts the card calls,
  `piscine_forcer_vitesse` and `piscine_retour_auto`, only set the Manual
  Override select (and its timeout), so they map onto that directly.
- **No charts, on purpose.** The device keeps no history of its sensors, so
  a chart would only show the time a page happened to be open. What the page
  shows over time, the device records itself: today's pool min/max (Pool
  Water Min/Max Today) and, for each of the last 7 days, the hours filtered
  and the pool's min/max (Daily History). The page only keeps the Manual
  Override's changes in memory from the moment it opens (gone on reload),
  for the card's record of today's overrides.
- **No framework.** Icons are path data from `@mdi/js` (the set HA uses),
  in [icons.js](webui/icons.js).
- **What's missing on the device:** sunrise/sunset (the card's timeline has
  no sun marks), and when an override started if this page didn't see it
  happen. The card's "since" is then estimated from the override's deadline.

### How it gets on the device

ESPHome's `web_server` builds a tiny index.html that only loads `/0.css` and
`/0.js`, which it embeds from `css_include` and `js_include` in
`pool-controller.yaml` (with `local` off and `js_url` empty, so the stock
page is neither embedded nor fetched). `make webui` bundles the page into
those two files with esbuild, in a `node` container:

- `webui/dist/device.js` from [device.js](webui/device.js): the markup of
  [index.html](webui/index.html) (inlined, and rebuilt into ESPHome's page
  by [device-shell.js](webui/device-shell.js)), then the card, then the app.
  So `index.html` stays the one source for both the mock and the device.
- `webui/dist/device.css`: `app.css`, minified.

About 35 KB gzipped together, against 78 KB for the stock page it replaces.
`make build`, `make ota` and `make flash` rebuild it first when a page source
changed, so a change to the page ships with the next `make ota`.

Two ways to check it before flashing:

- `make mock-webui` serves the source files, and reloads on save: the way to
  work on the page.
- `make mock-ui` serves exactly what the firmware will: ESPHome's index and
  the bundle.

The stock page had a firmware upload form and listed every entity; this one
doesn't upload firmware (use `make ota`). To get the stock page back, set
`local: true` in the `web_server` block and drop `js_url`, `css_include` and
`js_include`.

### Wi-Fi setup and statistics (`wifi-setup.yaml`)

[wifi-setup.yaml](wifi-setup.yaml) is an ESPHome package that
`pool-controller.yaml` includes (`packages:`), and the mock reads it the
same way:

- **Fallback hotspot.** After 1 minute without Wi-Fi (no network yet, router
  down, password changed), the device opens an open network named
  `pool-controller`; its page answers at http://192.168.4.1, still behind
  the web login. Not ESPHome's `captive_portal`: that answers every page
  request itself, without login, so the page would be unreachable.
- **Join a network from the page** (Wi-Fi tab): pick one of the networks
  nearby or type it, give the password, « Se connecter ». The device tries
  for 30 s and saves the network only if it connects; otherwise it keeps the
  current one. The password is held on the device and never sent back to a
  page or to HA. A network saved this way takes precedence over the one in
  `secrets.yaml`, until it's replaced the same way.
- **Wi-Fi statistics:** signal (dBm and %), network, router (BSSID), IP and
  MAC addresses, disconnections since boot, devices on the hotspot.
- **Clock.** On the hotspot alone there's no internet, so no time, so no
  daily plan. When the device has no clock, the page sets it to the
  browser's time, once, and says so.
- **Reboot watchdog.** ESPHome drops `wifi: reboot_timeout` once a hotspot is
  configured, so the package brings its own: reboot after 15 min without
  Wi-Fi, unless someone is on the hotspot.

In the mock, joining `Maison` or `Maison-Invités` works with any password
of 8 characters or more; the other networks fail, as with a wrong password.
`MOCK_HOTSPOT=1 make mock-webui` starts on the hotspot with no clock, as a
new install would.

## Updating firmware after the first flash

Once the device has joined Wi-Fi, prefer `make ota` over `make flash` — no
cable needed. `make flash` (USB) is only required for the very first flash,
or if the device is stuck in a state where it can't reach Wi-Fi at all (e.g.
a bad password baked into a previous build).

## Troubleshooting

- **`esptool` fails with "port is busy"**: something else has the port open
  — usually a `screen` or `idf.py monitor` session left running from
  checking the boot log. Run `make kill-port`, then retry.
- **`make flash` says no port found**: check the board is plugged in and
  showing up under `ls /dev/cu.*`.
- **Wi-Fi `4-Way Handshake Timeout` in the boot log**: almost always a wrong
  password in `secrets.yaml` — the ESP32 finds and associates with the SSID
  fine, but the pairwise key derived from the password doesn't match what
  the AP expects.
- **`make ota` can't resolve the hostname**: the device isn't on Wi-Fi yet
  (first flash must go over USB), or mDNS hasn't propagated yet. Pass
  `HOST=<ip>` explicitly if you know it.
