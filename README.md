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
| `wifi-setup.yaml` | Proposed package: fallback hotspot, joining a network from the page, Wi-Fi statistics, clock from the browser. Not included in the firmware yet (see below). |
| `secrets.yaml` | Wi-Fi credentials, API encryption key, OTA password. Gitignored — create your own (see below). |
| `Makefile` | Validate / build / flash / OTA / status tooling. |
| `home-assistant/` | `piscine-card.js`, the pool card of the Home Assistant dashboard, also used by the page in `webui/` (see below). Published to HA through HACS. |
| `hacs.json` | Tells HACS which file this repo publishes: the card above, from each GitHub release. |
| `tools/webui-mock/` | Local mock of the device's web UI, for working on the page without flashing (see below). |
| `webui/` | Prototype of a custom page for the device, built around the same `piscine-card` (see below). Not on the device yet. |
| `.gitignore` | Excludes `secrets.yaml`, `.esphome/` (build cache), `.vscode/`. |

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
| `make flash` | Rebuild, then flash over USB via esptool. Auto-detects the serial port; override with `PORT=/dev/cu.xxxx`. |
| `make status` | Query the connected board over USB: chip type, revision, MAC address. |
| `make kill-port` | Kill whatever process (a leftover `screen`/monitor session, usually) is holding the serial port open. |
| `make ota` | Rebuild, then push the firmware over Wi-Fi instead of USB. Only works once the device has already joined Wi-Fi at least once. |
| `make ip` | Resolve and print the device's current IP via mDNS. |
| `make mock-ui` | Serve a local mock of the device's web UI at http://localhost:8080/ (see below). `MOCK_PORT=` to change the port, `MOCK_INDEX=path.html` to serve your own page. |
| `make mock-webui` | `make mock-ui` with the custom page in `webui/` and the proposed Wi-Fi package (see below). `MOCK_HOTSPOT=1` starts the simulated device on its hotspot, with no clock. |
| `make mock-ui-check` | Print the web UI layout (sections and order) and fail on any entity type the mock can't render. Runs in CI. |
| `make ha-card` | Until HA installs the card from HACS: copy `home-assistant/piscine-card.js` into the local-k3s checkout that deploys it today (see below). `LOCAL_K3S=` to point at another checkout. |
| `make ha-card-diff` | Show how the card deployed through local-k3s differs from this repo's. |
| `make clean` | Remove the local build cache (`.esphome/`). |

`PORT` (serial) and `HOST` (network) both auto-detect and can be overridden
on the command line, e.g. `make flash PORT=/dev/cu.usbserial-XXXX` or
`make ota HOST=192.168.4.72`.

## Working on the web UI without flashing

`make mock-ui` runs [tools/webui-mock/mock_server.py](tools/webui-mock/mock_server.py)
in the same ESPHome image as `make build` and serves the device's web UI at
<http://localhost:8080/>. The UI is the page your firmware build embeds, decoded
from the image, so it always matches the ESPHome version you build with.

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
  entity ids. It gets the card through HACS (see below).
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

### Releasing it through HACS

Home Assistant installs the card with HACS, from this repo's GitHub
releases ([hacs.json](hacs.json)). Each release carries `piscine-card.js` as
an asset, and its tag is the card's `VERSION`. HACS checks the repo
periodically and offers a new release as an update, like the other cards.
It also registers the dashboard resource and changes its URL on each update,
so browsers don't keep a cached copy. Releases in this repo are only the
card's: the firmware is built and flashed from a checkout, not released.

To ship a change to the card:

1. Bump `VERSION` at the top of the card. A pull request that changes the
   card without a new `VERSION` fails CI
   ([.github/workflows/card.yml](.github/workflows/card.yml)).
2. Check the panel on the device's page against the mock (`make
   mock-webui`). It doesn't exercise the HA-only parts: the tile variant, the
   scripts, the recorder.
3. Merge. The workflow publishes release `v<VERSION>` with the card, then
   runs HACS's own checks against the repo.
4. In Home Assistant, install the update (Settings → Updates, or HACS), then
   reload the dashboard.

### Switching Home Assistant over to HACS (once)

Until the first release is published and installed, HA still loads the
card from the local-k3s repo, at `/local/piscine/piscine-card.js?v=…`, and
`make ha-card` / `make ha-card-diff` keep that copy in step (runbook:
local-k3s `tasks/ha-piscine-widget.md`). To switch, once `v1.2.1` or later
is released:

1. HACS → ⋮ → Custom repositories: add `davidterranova/pool-controller`,
   type Dashboard. Install « Piscine Card ». HACS adds the resource
   `/hacsfiles/pool-controller/piscine-card.js`.
2. In the same sitting, delete the old `/local/piscine/piscine-card.js`
   dashboard resource, so only one copy loads.
3. Remove `bridges/homeassistant/config/www/piscine/` from local-k3s and
   point its runbook here. Then drop `make ha-card` and `make ha-card-diff`.

The card's history up to 1.2.0 is in local-k3s's git log
(`bridges/homeassistant/config/www/piscine/`).

## Custom page prototype (`webui/`)

`make mock-webui` serves a page of our own instead of ESPHome's stock one,
with the look of the Home Assistant dashboard. It has two tabs:

- **Contrôle**, for daily use: Home Assistant's `piscine-card` panel (the
  pump's state, today's plan timeline, Auto/Manuel, forced speed and its
  duration), with tiles for the temperatures (the pool's with today's
  min/max) and the filling meter.
- **Avancé**: the filtration settings with their Apply gate, today's plan in
  detail, the last 7 days (hours filtered, pool min/max), the device's
  sensors, and its live log.
- **Wi-Fi** (proposed, see below): the connection and its statistics, and a
  way to join a network. Only shown when the device has those entities.

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
- **No framework, no build step for the prototype.** Icons are path data
  from `@mdi/js` (the set HA uses), in [icons.js](webui/icons.js). The
  whole page is about 30 KB gzipped once minified, against 78 KB for the
  stock page the firmware embeds today.
- **What's missing on the device:** sunrise/sunset (the card's timeline has
  no sun marks), and when an override started if this page didn't see it
  happen. The card's "since" is then estimated from the override's deadline.

Putting the page on the device (bundling it into a `web_server` `js_include`)
is a separate step, not done yet.

### Proposed: Wi-Fi setup and statistics (`wifi-setup.yaml`)

Not in the firmware yet. [wifi-setup.yaml](wifi-setup.yaml) is an ESPHome
package (it builds when included; it isn't), and `make mock-webui` loads it
next to `pool-controller.yaml` so the page can be designed against it:

- **Fallback hotspot.** After 1 minute without Wi-Fi (no network yet, router
  down, password changed), the device opens an open network named
  `pool-controller`; its page answers at http://192.168.4.1, still behind
  the web login. Not ESPHome's `captive_portal`: that answers every page
  request itself, without login, so the page would be unreachable.
- **Join a network from the page** (Wi-Fi tab): pick one of the networks
  nearby or type it, give the password, « Se connecter ». The device tries
  for 30 s and saves the network only if it connects; otherwise it keeps the
  current one. The password is held on the device and never sent back to a
  page or to HA.
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
new install would. The page's Wi-Fi tab and banners only appear when the
device has these entities.

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
