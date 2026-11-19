# ESP32 - Pool controller

ESPHome firmware for an ESP32-WROOM that runs a swimming pool's variable-speed
pump: an autonomous on-device filtration schedule (computed from water
temperature and sunrise/sunset, plus manual override), a freeze-protection
safety rule that always wins, three temperature sensors, and an optional
fill-line water meter with a long-fill alarm — all exposed to Home
Assistant, but not dependent on it. The device keeps running its
schedule whether or not HA is reachable.

**Install it from the browser: <https://pool-controller.kitesize.fr/>**
(Chrome or Edge on a computer, the board over USB), then finish on the
controller's own page. See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for how
the controller actually works: wiring, first setup, updates, control logic,
and Home Assistant setup. This file covers the repo itself — layout and
tooling, and building the firmware yourself.

## Repo layout

| File | Purpose |
|---|---|
| `pool-controller.yaml` | The ESPHome device config — this *is* the firmware source. |
| `wifi-setup.yaml` | Package included by `pool-controller.yaml`: fallback hotspot, joining a network from the page, Wi-Fi statistics, clock from the browser (see below). |
| `device-settings.yaml`, `device_settings.h` | Package included by `pool-controller.yaml`: the controller's settings, set at run time and kept on the device (page and OTA passwords, API key, position, timezone, probe roles, Setup State, Factory Reset). Nothing personal is compiled in. |
| `fill-meter.yaml`, `fill_meter.h` | Package included by `pool-controller.yaml`: the fill-line water meter as an option (Fill Meter on/off, its pulse test, the long-fill alarm and its acknowledgement). `fill_meter.h` is pure logic, tested on the host (`make firmware-test`). |
| `Makefile` | Validate / build / flash / OTA / status tooling. |
| `home-assistant/` | `piscine-card.js`, the pool card of the Home Assistant dashboard, also used by the page in `webui/` (see below). Installed in HA through the Marketplace (HACS). `dashboard/`: dashboard components for these entities and the scripts the card calls, with a guide ([home-assistant/dashboard/README.md](home-assistant/dashboard/README.md)). |
| `hacs.json` | Tells the Marketplace (HACS) which file this repo publishes: the card above, from each GitHub release. |
| `tools/webui-mock/` | Local mock of the device's web UI, for working on the page without flashing (see below). |
| `tools/card-preview/` | The pool card against a stand-in for Home Assistant, in named situations, with screenshots and a check (see [Previewing the card](#previewing-the-card)). |
| `tools/tz-posix.py` | Regenerates the card's IANA → POSIX time-zone table from tzdata (« Utiliser la position et le fuseau de Home Assistant »). |
| `tools/release/` | Release helpers for CI: the guard that keeps secrets out of a published firmware, and the firmware's `manifest.json` (see [Releases](#releases)), with its tests (`python3 -I tools/release/test_manifest.py`). |
| `tools/migrate/` | `make migrate`: moves a controller built with `secrets.yaml` to this firmware in one OTA (see [Coming from a secrets.yaml build](#coming-from-a-secretsyaml-build)). |
| `docs/install/` | The install page, served at the root of <https://pool-controller.kitesize.fr/> (see [The install page](#the-install-page-docsinstall)). |
| `webui/` | The device's own web page, built around the same `piscine-card` (see below). `make webui` bundles it into `webui/dist/` (gitignored), which the firmware embeds. |
| `docs/plans/` | Plans for work spanning several PRs, with their progress: [secret-free firmware and OTA updates](docs/plans/secret-free-firmware.md), [optional fill meter](docs/plans/optional-fill-meter.md). |
| `.gitignore` | Excludes `.ota-password` (see `make ota`), `secrets.yaml` (older builds, `make migrate`), `.migrate/`, `.esphome/` (build cache), `.vscode/`. |
| `LICENSE` | MIT. |

## Toolchain

- **Docker** — `validate`, `build`, and `ota` run the official
  `ghcr.io/esphome/esphome` image, so no local Python/ESPHome install is
  needed for those. The version is pinned once, `ESPHOME_VERSION` at the top
  of the Makefile, and CI builds and checks with it too; `make build
  ESPHOME_VERSION=<version>` tries another.
- **esptool** (bundled with a local ESP-IDF install) — used only for the
  initial USB flash. Docker Desktop on macOS can't pass a host USB-serial
  device through to a Linux container, so `make flash` shells out to the
  host's esptool directly instead of going through Docker.

## Installing a controller

Nothing to build: each release's firmware is published, and
<https://pool-controller.kitesize.fr/> installs it from Chrome or Edge on a
computer, over USB (ESP Web Tools; every install erases the board), then
sends the Wi-Fi over the same cable (Improv). The controller's own page then
runs its setup wizard (page password, Wi-Fi, position, probes and whether
a fill meter is there, Home Assistant). The whole walk-through, with what to do without Wi-Fi:
[POOL-CONTROLLER.md, First setup](POOL-CONTROLLER.md#first-setup).

From then on it updates itself from the releases (Auto Update, on by
default, every 24 h; see [POOL-CONTROLLER.md, Updates](POOL-CONTROLLER.md#updates)).

## Development builds

For a change to the firmware, or other GPIOs than the published ones.

1. Nothing to fill in before building, and no `secrets.yaml`: the firmware
   compiles in no network, key, password, position or probe address (the
   guard, `tools/release/secret_guard.py`, keeps it that way). Each
   controller is set up after the flash, from its page.

2. Check the `substitutions:` block at the top of `pool-controller.yaml` —
   the four relay GPIO pins, the OneWire bus pin and the water meter's —
   match your own wiring. See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for
   what each one does.

3. `make validate` — parses the YAML and checks component schemas (fast, no
   compile).

4. `make build` — compiles the firmware. The first run downloads the
   ESP32 Arduino/ESP-IDF toolchain inside the container (~1GB), so budget
   several minutes; later builds are quick.

5. First flash: plug the board in over USB and `make flash` (it writes the
   build over whatever the board holds, without erasing its settings).
   A board with nothing saved opens its hotspot `pool-controller` at once:
   join it and open http://192.168.4.1 (no login yet), where the setup
   wizard starts, as after an install from the page.

6. Later, over Wi-Fi: `make ota`. It needs the controller's **OTA
   Password** — random at first boot, so set your own on the page
   (Réglages contrôleur › Accès) — read from `.ota-password` (one line, gitignored)
   or `OTA_PASSWORD=…`, and given to the upload only, never compiled in.

A controller running your own build still checks the published releases:
your build reports `git describe`'s version (`v1.5.0-3-g1a2b3c4`, `dev`),
which never matches a release's, so with Auto Update on the next scheduled
check installs the release over it. Turn Auto Update off, or set Update
Check Interval to « À la demande », on a controller you flash yourself
(Réglages contrôleur › Firmware, or Home Assistant).

## Coming from a secrets.yaml build

A controller still running a firmware built with `secrets.yaml` (v1.3.x)
moves over once, from the checkout that holds that file: `make migrate`. One
OTA carries every setting it was built with (Wi-Fi, API key, page and OTA
passwords, position and timezone, probe roles) into the controller's own
storage, so it comes back in about 20 s, set up and still paired with Home
Assistant, with no wizard. It checks the controller is idle first, checks
it afterwards, prints the rollback on a failure, and writes `.ota-password`
for the next `make ota`. From then on it updates like any other, and
`secrets.yaml` can go. Details: `make migrate` in the Makefile, and WP8 of
the [plan](docs/plans/secret-free-firmware.md).

## Makefile targets

| Target | What it does |
|---|---|
| `make validate` | Parse + schema-check `pool-controller.yaml`, no compile. |
| `make build` | Compile the firmware (also catches errors inside C++ lambdas, which `validate` can't). |
| `make webui` | Bundle the page in `webui/` into the two files the firmware embeds (`webui/dist/`). Run by `validate`, `build` (so `ota` and `flash`) and `mock-ui` whenever a page source changed. |
| `make flash` | Rebuild, then flash over USB via esptool. Auto-detects the serial port; override with `PORT=/dev/cu.xxxx`. |
| `make status` | Query the connected board over USB: chip type, revision, MAC address. |
| `make kill-port` | Kill whatever process (a leftover `screen`/monitor session, usually) is holding the serial port open. |
| `make ota` | Rebuild, then push the firmware over Wi-Fi instead of USB. Only works once the device has already joined Wi-Fi at least once; the OTA Password comes from `.ota-password` or `OTA_PASSWORD=`. |
| `make migrate` | Move a controller built with `secrets.yaml` to this firmware in one OTA (see above). `make migrate-build` only builds it, `make migrate-check` repeats its checks, `make migrate-clean` deletes the generated build, `make migrate-test` runs its tests. |
| `make ip` | Resolve and print the device's current IP via mDNS. |
| `make mock-ui` | Serve a local mock of the device's web UI at http://localhost:8080/ (see below). `MOCK_PORT=` to change the port, `MOCK_INDEX=path.html` to serve your own page. |
| `make mock-webui` | `make mock-ui` serving the page from its sources in `webui/`, reloading on save (see below). `MOCK_HOTSPOT=1` starts the simulated device on its hotspot, with no clock. |
| `make mock-ui-check` | Print the web UI layout (sections and order) and fail on any entity type the mock can't render. Runs in CI. |
| `make firmware-test` | Host tests of the firmware's pure C++ helpers (`tools/tests/`). Runs in CI. |
| `make webui-test` | Unit tests of the device's page and the install page's pure modules, with Node's test runner. Runs in CI. |
| `make card-preview` | Serve the pool card's preview at http://localhost:8124/tools/card-preview/ (see [Previewing the card](#previewing-the-card)). `make card-shots` screenshots every situation into `tools/card-preview/shots/` (`SCENARIO=a,b` for some); `make card-preview-check` loads them all and fails on an error or a « NaN ». |
| `make ha-dashboard-check` | Fail when the Home Assistant dashboard components in `home-assistant/dashboard/` name an entity the firmware doesn't have, or leave one out of the pool card. Runs in CI. |
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
- **The fill meter** (fill-meter.yaml) is simulated too: the valve runs 3 min
  every quarter hour, « Tester » opens it for 20 s so the pulse test passes,
  and turning Fill Meter off empties Remplissage. `MOCK_FILL=off make
  mock-webui` starts with it off; `MOCK_LONG_FILL=1 make mock-webui` with a
  fill already past Fill Alarm After, so the banner and « Acquitter » can be
  tried (the fill stops 3 min after it, and the alarm clears 5 min later).
- An entity the simulation doesn't know (e.g. one you just added) still
  shows up, with a static value. `make mock-ui-check` marks it
  `[static: not simulated]`. Add it to the `N` map in `mock_server.py` to make
  it move.

## Home Assistant card (`home-assistant/`)

[home-assistant/piscine-card.js](home-assistant/piscine-card.js) is
`custom:piscine-card`, the pool card of the Home Assistant dashboard: a tile,
and a panel shown in a pop-up with three tabs, the device page's own.
« Contrôle » has the pump's state, today's plan timeline, the pool's
temperature (24 h, 7, 30 and 90 days, a year), Auto/Manuel, the forced speed
and its duration, then the fill water today, this month and by day, week or
month with the period's total; « Réglages » today's plan with « Recalculer »,
the probes (a tap opens Home Assistant's more-info), « Filtration et hors
gel », every setting the controller has, then the last 7 days; « Réglages
contrôleur » its position and time zone, which « Utiliser la position et le
fuseau de Home Assistant » sets from Home Assistant's own, and its firmware
(installed and latest version, a tap opening Home Assistant's own update
dialog, « Vérifier » and « Installer » on its update entity, automatic
updates and how often to check). Two more variants draw a part alone:
`settings` the settings, with a line under each saying what it does, and
`water` the fill water.
A light on the tile and in the panel's header says when the controller was
last heard: green while it talks, amber when it goes quiet or has just gone
offline, red after 15 min; each new message sends a ring out of it. In the
panel, it opens Home Assistant's device page for the controller (its link,
Wi-Fi signal and disconnections).
The fill meter is optional ([POOL-CONTROLLER.md, Fill meter](POOL-CONTROLLER.md#fill-meter)):
with Fill Meter off, the fill water is gone from « Contrôle » and `water`
hides. A fill running longer than Fill Alarm After puts a banner in
« Contrôle » with « Acquitter » (Acknowledge Fill Alarm), and until someone
acknowledges it the light turns amber and keeps pulsing, the tile and the
header read « Remplissage depuis 1 h 12 », and the header's light leads to
the banner. Its order: red (controller lost) > pulsing amber (fill alarm) >
amber > green. The meter's settings are not the card's: the device's page in
Home Assistant (Configuration), or the controller's own page.
It's a plain custom element, no framework and no build step, in French.

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
- the recorder's history of the last 24 h: the Manual Override select, for
  the overrides already ended today on the timeline, and Pool Return
  Temperature with Pump Commanded Speed, for the temperature curve;
- the long-term statistics of Pool Water Min/Max Today, for the 30-day,
  90-day and year views (they have a `state_class` since 2026-11-17, so they
  fill up from the day the firmware was flashed), and of Pool Return
  Temperature, whose daily mean (pipe included) stands in for the days before;
- the long-term statistics of the fill meter (Piscine - Volume total
  remplissage, `total_increasing`), for the fill water in « Contrôle ».
  Without the meter or the recorder, it isn't there;
- Fill Meter, Fill Running, Fill Running Too Long, Fill Alarm Acknowledged,
  Acknowledge Fill Alarm and Fill Alarm After
  ([fill-meter.yaml](fill-meter.yaml), 1.9.0), for hiding the fill water
  and for the alarm. A firmware without them counts the meter always and has
  no alarm;
- the Device Clock ([wifi-setup.yaml](wifi-setup.yaml)), which changes every
  minute: the light's heartbeat. Without it, the light only follows the link;
- the firmware's update entity (Firmware, with Check for Update, Cancel
  Update, Auto Update, Update Check Interval and Update Status), for
  « Réglages contrôleur » › Firmware: « Installer » is `update.install`, which the
  firmware holds while a manual override or a fill runs (« Annuler la
  demande » presses Cancel Update); Auto Update installs only what a
  scheduled check finds; a tap on a version row opens Home Assistant's own
  dialog for the entity (release notes, « Ignorer »). Whether a newer
  firmware exists is the controller's to say: the card asks GitHub nothing
  (it is itself updated by HACS). A firmware without that entity (before
  v1.4) has no Firmware section;
- Latitude, Longitude, Timezone and Timezone Name, for « Réglages
  contrôleur » › Position; its « Utiliser » reads Home Assistant's own location and zone
  (Settings › System › General) and converts the zone to the POSIX string the
  controller applies, from tzdata's rules
  ([tools/tz-posix.py](tools/tz-posix.py) regenerates the card's table).

The temperature graph exists because the probe is on the return pipe: it
reads the pool only while water flows, and with the pump stopped it drifts
toward the equipment pad's air, warmer than the water in winter (14.5 °C in
the pipe for a 13.1 °C pool on a November night). So, like the firmware's
min/max, the graph only trusts readings taken after 10 minutes of pumping:
solid line for those, dashed for the pipe. The 7- and 30-day views show each
day's min–max from those readings: Daily History for the last 7 days, the
statistics' 23:00 hourly row before that (Min Today only falls and Max Today
only rises within a day, so that row holds its final values; HA's own daily
min/max would also count the 00:00 hour, which still has the day before's
value until the device resets it).

The two scripts, and a dashboard built from this firmware's entities, are in
[home-assistant/dashboard/](home-assistant/dashboard/README.md) as generic
building blocks (a fresh install's entity ids, Home Assistant's own cards),
with a guide; `make ha-dashboard-check` keeps them in step with the firmware.
Any particular install's own dashboards and alerts stay in that Home
Assistant.

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

Each release carries `piscine-card.js` as an asset, which is what the
Marketplace installs ([hacs.json](hacs.json)), and its tag is the card's
`VERSION`. See [Releases](#releases) for what else it carries.

### Shipping a change to the card

1. Bump `VERSION` at the top of the card. A pull request that changes the
   card without a new `VERSION` fails CI
   ([.github/workflows/release.yml](.github/workflows/release.yml)).
2. Look at it in the preview (`make card-preview`, below) and run `make
   card-preview-check`; check the panel on the device's page against the mock
   (`make mock-webui`) too, since the page runs the same file.
3. Merge. The workflow publishes release `v<VERSION>` with the card, then
   runs the Marketplace's (HACS's) own checks against the repo.
4. Home Assistant offers the update (Settings → Updates) once the
   Marketplace has seen the release. Install it: that also changes the
   resource URL, so browsers fetch the new file on their next reload.

The card's history up to 1.2.0 is in the local-k3s repo's git log, where it
was first written (`bridges/homeassistant/config/www/piscine/`).

### Previewing the card

[tools/card-preview/](tools/card-preview/) runs the card as it is against a
stand-in for Home Assistant: no Home Assistant, no controller. `make
card-preview` serves it at http://localhost:8124/tools/card-preview/: pick a
situation (normal day, override, freeze protection, controller offline, a
fill running too long, the fill meter off, a firmware update waiting…), the pop-up's width (phone or screen) and the
theme. The tile, the panel on any tab and the `water` and `settings` variants
are drawn side by side, and what the card calls (scripts, services, the
pages it opens) is listed. Its commands are applied as the controller would
(« Manuel » then « High » sets the override, a setting takes its value), so
it can be clicked through. The recorder's 24 h history and long-term
statistics are generated, so every chart draws.

- **Situations** are in [scenarios.js](tools/card-preview/scenarios.js),
  written with the card's own keys (`override`, `water`…) as changes to a
  normal day; add one when the card learns a new state. Entity ids are the
  dashboard's (a fresh install's), so nothing there is one install's.
- **`make card-shots`** takes each situation's tile and panel at 390 and
  760 px, light and dark, at a fixed time, into `tools/card-preview/shots/`
  (not committed): for a pull request's description. `SCENARIO=stuck,offline`
  takes only those.
- **`make card-preview-check`** loads every situation on each of the panel's
  tabs at both widths, and fails on a page or console error, or on
  « undefined », « NaN » or « [object Object] » in what the card shows.

Both run Chromium in Playwright's image (about 3.5 GB, pulled once);
`playwright-core` is installed once into `.card-preview/`. The stand-in is
not Home Assistant: the preview catches layout and wiring, not how Home
Assistant itself behaves (when it changes `last_changed`, what the recorder
really keeps).

## The device's page (`webui/`)

The device serves a page of our own instead of ESPHome's stock one, with the
look of the Home Assistant dashboard. It has three tabs, the card's own:

- **Contrôle** (`#controle`), for daily use: Home Assistant's `piscine-card`
  panel (the pump's state, today's plan timeline, the pool's last 7 days,
  Auto/Manuel, forced speed and its duration) and, on its right (below it on
  a phone), Remplissage: the card's `water` variant on the controller's own
  record (Fill Water Today, Days and Months): today, this month, the flow,
  and the litres by day over 30 days or by month over 12. With Fill Meter
  off there is no Remplissage. A fill running longer than Fill Alarm After
  puts the card's banner here, with « Acquitter », fed by the controller, so
  it works with Home Assistant down.
- **Réglages** (`#reglages`): today's plan in detail, the device's sensors,
  « Filtration et hors gel » (the filtration settings with their Apply gate,
  the boost pulses and the freeze-protection threshold: the card's settings
  variant, the rows of its « Réglages » tab in Home Assistant), and the last
  7 days (hours filtered, pool min/max).
- **Réglages contrôleur** (`#reglages-controleur`): a Wi-Fi section (see
  below: the connection and its statistics, and a way to join a network;
  only when the device has those entities), Position, Sondes, Compteur d'eau
  (the fill meter on or off, its pulse test, its last pulse and « Alarme
  après »; the setup wizard asks the same in its Sondes step), a Firmware
  one (the version it runs, ESPHome's, and its updates: « Vérifier »,
  « Installer », as in the card's « Réglages contrôleur »), Accès, Home
  Assistant, Réinitialiser, and its live log (Journal).

Links from before keep working: `#avance` opens Réglages, `#controleur` and
`#wifi` Réglages contrôleur, `#remplissage` Contrôle at its Remplissage.

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
- **Only what the device records.** The device keeps no history of its
  sensors, so a curve would only show the time a page happened to be open.
  What the page shows over time, the device records itself: today's pool
  min/max (Pool Water Min/Max Today), each of the last 7 days' hours
  filtered and pool min/max (Daily History) against its plan (Daily Plan
  History), and the fill water of today,
  the last 30 days and the last 12 months (Fill Water Today, Days, Months).
  So the card's temperature graph runs with `recorder: false` here: 7 days,
  with no range to pick; its fill water is the `water` variant on that
  record, beside it in the page's « Contrôle ». The panel has no tabs
  (`settings_tab: false`): the page has its own Réglages and Réglages
  contrôleur. Nor the card's
  light: the page's own « Connecté au contrôleur » chip is its link to the
  device. The page only keeps the Manual Override's changes in memory from
  the moment it opens (gone on reload), for the card's record of today's
  overrides.
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
- **Join a network from the page** (Contrôleur tab, Wi-Fi): pick one of the networks
  nearby or type it, give the password, « Se connecter ». The device tries
  for 30 s and saves the network only if it connects; otherwise it keeps the
  current one. The password is held on the device and never sent back to a
  page or to HA. The firmware compiles in no network, so the one saved this
  way (or by Improv serial) is the controller's network, until it's replaced
  the same way.
- **Wi-Fi statistics:** signal (dBm, % and in words: bon, moyen, faible, as
  the pool card also says it), network, router (BSSID), IP and
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

## The install page (`docs/install/`)

`docs/install/index.html` is the page at <https://pool-controller.kitesize.fr/>:
it reads `firmware/manifest.json` beside it (the published release) and
installs it with [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
10.4.0, pinned and loaded from unpkg. Its decisions (which browser, which
manifest state) are in `install-model.js`, tested by `make webui-test`;
`install.js` draws them.

- **States.** Ready (the release's version on the button); a phone or tablet
  (installing is done from a computer: a note, and a link to copy); a
  browser without Web Serial; a page opened without HTTPS; no firmware
  published yet (the manifest answers 404: the button stays off); the
  manifest unreachable (« Réessayer »); ESP Web Tools not loaded from unpkg.
- **Always erases.** The manifest has no `new_install_prompt_erase`, so ESP
  Web Tools erases the board without asking, then goes straight to the Wi-Fi
  step. The page is for a new board or one to start over; a controller in
  service updates itself.
- **Trying it locally.** Serve `docs/install/` with any static server on
  localhost (a secure context, so Web Serial works), with a
  `firmware/` folder beside it holding a release's three files, or none for
  the 404 state.
- It reaches the site with the next release that carries the firmware (see
  below); a change to the page alone waits for that release.

## Updating firmware after the first flash

An installed controller updates itself from the releases: see
[POOL-CONTROLLER.md, Updates](POOL-CONTROLLER.md#updates). For your own
build, `make ota` (no cable; see [Development builds](#development-builds));
`make flash` (USB) only for a first flash, or a controller that can't reach
Wi-Fi at all.

The fill meter (Fill Meter, 1.9.0) is on after the update, as it was
before: a controller without a meter on its fill line turns it off once
(Réglages contrôleur › Compteur d'eau on its page, or the device's
Configuration in Home Assistant). See
[POOL-CONTROLLER.md, Fill meter](POOL-CONTROLLER.md#fill-meter).

## Releases

One version for the whole project: the card's `const VERSION = "x.y.z"`
(`home-assistant/piscine-card.js`). A pull request that changes the card,
the firmware (`pool-controller.yaml` or any `*.yaml` package beside it) or
the device's page (`webui/`) needs a `VERSION` that isn't released yet; on
merge, [.github/workflows/release.yml](.github/workflows/release.yml)
publishes release `v<VERSION>`. Nobody tags or releases by hand.

A release carries:

- `piscine-card.js`, for the Marketplace (HACS), as above;
- the controller's firmware, built by
  [.github/workflows/firmware.yml](.github/workflows/firmware.yml) with a
  pinned ESPHome (the Makefile's `ESPHOME_VERSION`) and `-s firmware_version v<VERSION>`:
  - `firmware.ota.bin`: what an installed controller downloads to update;
  - `firmware.factory.bin`: a whole flash image, for a first install from a
    browser;
  - `manifest.json`: ESP Web Tools' manifest, whose `ota` block (path, md5,
    summary, release URL) is what ESPHome's `update: platform:
    http_request` reads. Its paths are relative, so the three files work
    wherever they sit together.

**No firmware is released while it reads secrets.yaml.** A published
firmware must hold nothing personal. Since the
[secret-free firmware plan](docs/plans/secret-free-firmware.md)'s WP2 it
reads none (`!secret`): every such value is a setting kept on the controller
(device-settings.yaml). `tools/release/secret_guard.py` keeps it that way:
should it find a `!secret` again, the release build makes nothing and the
release carries the card only, with a notice saying why.

**Trying the build.** Actions › Firmware › Run workflow (or `gh workflow
run firmware.yml --ref <branch>`) builds `dev-<commit>` as a workflow
artifact, never a release. (Should the sources read secrets.yaml again,
it compiles with placeholder secrets and names the artifact
`firmware-dev-<commit>-placeholder-secrets-not-a-release`: a test of the
build, not something to install.)

**GitHub Pages.** Controllers look for updates at a stable URL,
`https://pool-controller.kitesize.fr/firmware/manifest.json` (the repository's
Pages site on its custom domain; a fork without one uses
`https://<owner>.github.io/<repo>/firmware/manifest.json` through the
`firmware_site` substitution). The
release workflow publishes the release's three files there, replacing the
previous ones, only when the repository allows it:

1. Settings › Pages › Build and deployment › Source: **GitHub Actions**.
2. Settings › Secrets and variables › Actions › Variables: add
   `PUBLISH_FIRMWARE_PAGES` = `true`.

Without both, a firmware release is attached to the release only, and the
workflow says so. Each deploy replaces the whole Pages site, so the `pages`
job rebuilds it whole: `docs/install/`'s contents at the root (the install
page, `/`), and the release's three files under `/firmware/`, where both the
page and the controllers read them. The custom domain is a repository
setting (Settings › Pages): a site deployed by GitHub Actions needs no
`CNAME` file, and ignores one.

## Troubleshooting

- **`esptool` fails with "port is busy"**: something else has the port open
  — usually a `screen` or `idf.py monitor` session left running from
  checking the boot log. Run `make kill-port`, then retry.
- **`make flash` says no port found**: check the board is plugged in and
  showing up under `ls /dev/cu.*`.
- **Wi-Fi `4-Way Handshake Timeout` in the boot log**: almost always a wrong
  Wi-Fi password saved on the controller — the ESP32 finds and associates with the SSID
  fine, but the pairwise key derived from the password doesn't match what
  the AP expects.
- **`make ota` can't resolve the hostname**: the device isn't on Wi-Fi yet
  (first flash must go over USB), or mDNS hasn't propagated yet. Pass
  `HOST=<ip>` explicitly if you know it.
