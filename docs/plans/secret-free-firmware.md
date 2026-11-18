# Secret-free firmware: settings on the controller, OTA updates for everyone

Tracking document for parallel work. **One session per work package (WP)**, each on its own branch/worktree off main.

To claim a WP:
1. Check `gh pr list` and the table below.
2. In your branch's first commit, set the row to `in progress` with your branch.
3. The PR that finishes the WP sets it to `done` and links itself.

Record spike findings and decisions in the logs at the end, in the PR that learns them.

## Why

Every personal or secret value is compiled into the firmware today: Wi-Fi credentials, the API key, the OTA and page passwords, the location and timezone (`secrets.yaml`), plus the temperature probes' addresses. So no binary can be published, and every update is `make ota` from a checkout holding those secrets.

Target:
- one generic firmware, built by CI for each release;
- each controller set up once, its settings kept in the ESP32's NVS preferences, a partition app OTA never touches;
- updates found and installed automatically on a user-set schedule, on request from the controller's page, or from Home Assistant's Update entity;
- anyone with the hardware can install from a browser page.

## Status

| WP | What | Depends on | Branch | Status | PR |
|---|---|---|---|---|---|
| 0 | Card 1.3.1: parse ESPHome 2026.7's version string (« … (config hash …, built YYYY-MM-DD HH:MM:SS +0000) ») | — | fix/card-esphome-version-built | done | #28 (merged) |
| 1 | Spike: confirm the runtime hooks on hardware with ESPHome 2026.11 | — | spike/wp1-runtime-hooks | review (hardware checks left) | #30 |
| 2 | Firmware: settings package, no `!secret` left | 1 | feat/wp2-device-settings | done in `feat/secret-free-firmware` (hardware checks left, in the WP8 window; ESPHome beta) | #31 (merged) |
| 3 | Controller's page: setup wizard, « Contrôleur » sections | contract below (UI on the mock); 2 to finish | | todo | |
| 4 | Card: Firmware section on the update entity, position/timezone from HA | contract below; 6 to finish | | todo | |
| 5 | CI: releases carry the firmware, manifest + files on GitHub Pages | 2 (for a real build) | ci/wp5-firmware-releases | done (publishing waits for WP2 and the owner) | #29 (merged) |
| 6 | Firmware: updates (http_request OTA + update entity + auto-update) | 1, 5 (manifest URL) | | todo | |
| 7 | Install page (ESP Web Tools) + docs | 5 | | todo | |
| 8 | Automatic migration of an existing controller (`make migrate`: one OTA seeds its secrets.yaml settings) | 2 | | todo | |

Parallel from day one: 0, 1, the mock-ups of 3 and 4, and 5's workflow (tested on a dummy build).

Integration branch: WP2, WP3 and WP6 merge into `feat/secret-free-firmware`, not main, which gets it once the firmware is usable end to end (so main never releases a firmware nobody can set up).

## What leaves the build

| Compiled today | Becomes (NVS) | Applied by | Set from |
|---|---|---|---|
| `wifi_ssid/password` | ESPHome's saved Wi-Fi credentials | the wifi component | install page (Improv serial); the page's « Rejoindre un réseau » (exists); the hotspot fallback stays |
| API encryption key | provisioned noise PSK, `api: encryption: {}` | `APIServer::save_noise_psk()` / `clear_noise_psk()` (only exist without a YAML key) | Home Assistant on pairing: it generates and sets the key itself (WP1, from HA's source); the page only for a pasted key (migration), or « Je n'utilise pas Home Assistant »: Generate API Key, a random key the firmware keeps and nobody sees; Forget API Key hands the controller to HA later |
| OTA password | global, `ota: … password: ""` in YAML | `id(ota_id).set_auth_password()` on boot; random at first boot so OTA is never open. From 2026.11 the API key also authenticates OTA (Noise), the password only guards plaintext uploads | page |
| page password | global; `web_server: auth:` compiled with placeholders | `web_server_base` `set_auth_username/password()` on boot; 2026.11 stores the `const char *` and reads it per request, so a change applies at once; null username = setup mode | page, wizard step 1 |
| latitude / longitude | restored `number`s, rounded to 0.01° | `id(sun_id).set_latitude/longitude()` | page; card « Utiliser la position de Home Assistant » (`hass.config`) |
| timezone (IANA, converted at build) | global `timezone_posix` (POSIX TZ, applied) + `timezone_name` (IANA, display only) | 2026.11 has no `set_timezone()`: our own POSIX parser (`device_settings.h`, a port of aioesphomeapi's) fills a `time::ParsedTimezone`, then `time::set_global_tz()`; YAML keeps `timezone: UTC0` | page (IANA→POSIX table, preset from the browser's zone); card (from `hass.config.time_zone`); both write Timezone and Timezone Name together |
| 3 DS18B20 `address:` | role→address globals | `set_address()` before the first read; bus scan via `one_wire` | page: detected probes with live readings, one role select each |

Rules:
- **Secrets are never entity states.** CVE-2026-71260 leaks password-mode text values through web_server. A secret's `set_action` writes to a global, and the entity only reports « défini / non défini ». This is the pattern `wifi_join_password` in `wifi-setup.yaml` already follows.
- **Global ids are stable forever.** A global's NVS key is the md5 of its id, so renaming one silently loses its value (and so does changing its type or size).
- **No `provisioning:` block.** Its window closing stops the hotspot until a power cycle (WP1). The API stays open on the LAN until a key is set, so the wizard gets to Home Assistant early.
- **`web_server: local: false`** stays explicit: from 2026.11 an « AP only » Wi-Fi config (no network in YAML) would otherwise embed the stock page and serve it as a captive portal, outside auth.
- **Factory reset:** our own selective erase, not ESPHome's `factory_reset` (which wipes all of NVS): the page and OTA passwords, the saved Wi-Fi and the API key go; probe roles, position, both timezone entities, filtration/freeze settings and history stay. The page asks for a confirmation; the controller reboots into setup mode on its hotspot.

## Entity contract

These are agreed up front, so 3, 4 and the mock can proceed before 2 and 6. Names are the ESPHome `name`s. HA's ids follow from the device name.

| Name | Type | Notes |
|---|---|---|
| Setup State | text_sensor | `configured`, or the missing items in wizard order: `page_password,wifi,position,probes,api_key` (`position` = latitude, longitude and timezone; `probes` = the pool probe) |
| Page Password | text (password mode, write-only, 8–64) | write → global; state never holds it; none = setup mode (no login) |
| OTA Password | text (write-only, 8–64) | idem; random at first boot |
| API Key | text (write-only, 44) | base64 32 bytes, validated, all-zero refused, then `save_noise_psk` |
| Generate API Key | button | a random key, kept, never shown (use without HA); ignored when a key is set |
| Forget API Key | button | `clear_noise_psk`: back to no key, for HA to pair |
| Latitude, Longitude | number (°, 0.01, box) | restored; unknown (NaN) until set |
| Timezone | text | POSIX TZ, validated by the device's parser, applied, restored |
| Timezone Name | text | IANA name (Europe/Paris), display only, restored; written with Timezone |
| Detected Probes | text_sensor | `52000000518fe928: 13.6, ff00000026007028: 14.9` (address as ESPHome's `address:`, family code last; `--` for no answer; `--` alone for none), every minute |
| Pool Probe, Pad Probe, Outdoor Probe | select | options = `none` + detected addresses (+ a role's address the bus didn't answer for); one role per probe; HA sees options a rescan added once it reconnects |
| Rescan Probes | button | |
| Schedule Waiting For | text_sensor | why the plan isn't computed: `position`, `timezone`, `clock`, `pool probe`, `pool temperature`, `sunrise/sunset`; `--` when it is |
| Auto Update | switch | restored (WP6) |
| Update Check Interval | select (WP6) | « À la demande / 6 h / 24 h / 7 j », default 24 h, restored |
| Firmware | update (http_request) | installed / latest / release URL; install action; behind our own gate (WP6) |
| Update Status | text_sensor (WP6) | the gate's state, e.g. « en attente » while a manual override or a fill runs |
| Check for Update | button | |
| Factory Reset | button | page asks for confirmation; selective erase (Rules) |

## Work packages

### WP0: card 1.3.1 hotfix
- [x] `PiscineCard.parseEsphome` (home-assistant/piscine-card.js) takes the date after `built `; harness case for the 2026.7 string; VERSION 1.3.1

### WP1: spike (findings in the log below)
- [x] compile level: every hook below builds on 2026.7.2 and 2026.11.0b6 (`tools/spike/runtime-hooks.yaml`, sizes in the log)
- [x] HA 2026.11 provisions a keyless device's key by itself (from HA's source; seen on hardware: below)
- [ ] ESPHome 2026.11 builds and runs this firmware (flash use with http_request + update + improv): builds, ~63 % flash projected (log); needs hardware: runs
- [ ] web auth: credentials set before setup apply; a null username serves without auth (setup mode): source says yes on 2026.11 (no on 2026.7.2, see log); needs hardware
- [ ] `ota.esphome` with `password: ""` + `set_auth_password()` on boot; `make ota` with `-s ota_password` uploads: compiles; needs hardware
- [ ] `set_address()` on dallas_temp before the first update; `one_wire` lists the bus: compiles; needs hardware
- [ ] ~~`set_timezone()`~~ `set_global_tz()` + sun `set_latitude/longitude()` give the same sunrise as the compiled values: compiles; needs hardware
- [ ] keyless API: `save_noise_psk()` from a set_action works; HA pairs and sets the key: compiles; needs hardware
- [ ] `update.http_request` reads a GitHub Pages manifest over HTTPS (ESP-IDF cert bundle), OTA from it: compiles; needs hardware and a published manifest

### WP2: firmware settings
- [x] new package `device-settings.yaml` + `device_settings.h`: globals, contract entities, boot lambdas (`on_boot` 700: after globals restore and the bus scan, before dallas_temp, OTA and web_server; 590: right after dallas_temp, a role with no probe back to address 0; -200: first publishes); `pool-controller.yaml` / `wifi-setup.yaml` lose every `!secret` (the guard finds none)
- [x] ESPHome pinned once (Makefile `ESPHOME_VERSION`, used by CI): **2026.11.0b6, a beta**: move to 2026.11.x stable before `feat/secret-free-firmware` reaches main; a POSIX TZ parser header for `time::set_global_tz()`; `web_server: local: false`; no `provisioning:`
- [x] `esphome: project: {name: davidterranova.pool-controller, version: ${firmware_version}}`; `improv_serial:`
- [x] the schedule waits for a position and timezone (Schedule Not Computed on at once, Schedule Waiting For says why); probes without a role read `unknown`
- [x] webui mock simulates the contract (`MOCK_FRESH=1` = an unconfigured device, digest login once a Page Password is set); `make validate` / `build` / `mock-ui-check` / `ha-dashboard-check`
- [ ] on hardware: see « WP2 adds » under the spike log's hardware checks

### WP3: controller's page
- [ ] mock-up first: a wizard while Setup State ≠ configured (page password → Wi-Fi → position/timezone → probes → Home Assistant)
- [ ] « Contrôleur »: Accès, Position, Sondes, Home Assistant, Réinitialiser, beside Wi-Fi and Firmware
- [ ] the Home Assistant step says « ajoutez l'appareil dans Home Assistant » (HA sets the key); fallbacks: paste a key (API Key), or « Je n'utilise pas Home Assistant » (Generate API Key: the firmware makes and keeps a key nobody sees; Forget API Key to pair with HA later)

### WP4: card
- [ ] Avancé › Firmware on the update entity: installed / latest, notes link, « Installer » (`update.install`), Auto Update + interval rows; retire `checkFirmware` / `FIRMWARE_FILES` (keep `parseVersion`)
- [ ] « Utiliser la position et le fuseau de Home Assistant » (Latitude, Longitude, Timezone)
- [ ] harness: a fake update entity in each state; VERSION bump

### WP5: CI releases
- [x] one project version: a change to the card **or** firmware sources needs a new VERSION (card.yml's check, now `release.yml`: the card, `webui/`, any `*.yaml` at the root)
- [x] on release: compile with pinned ESPHome, no secrets, `-s firmware_version vX.Y.Z`; attach `firmware.ota.bin`, `firmware.factory.bin`, `manifest.json` (ESP-Web-Tools format + `ota` block: path, md5, release_url) — wired and tested on a development build; the first release that carries them comes after WP2
- [ ] publish them to GitHub Pages under `/firmware/` (stable URL, no redirect); the repo setting is the owner's call — wired, off until the owner enables Pages and sets `PUBLISH_FIRMWARE_PAGES`
- [x] `validate.yml` drops the placeholder-secrets step — done in WP2 (it runs the guard instead)

How it works (`.github/workflows/`):
- `release.yml` (was `card.yml`): on main, a VERSION with no release calls `firmware.yml` with the tag, then releases. The card is released exactly as before; the firmware's three files are attached only when `firmware.yml` built a publishable release, after checking the manifest's version and md5.
- `firmware.yml`: reusable (`workflow_call`), also run by hand or on a PR changing the build. `make build ESPHOME_IMAGE=… FW_VERSION=…` (webui bundle, then compile) with `ESPHOME_IMAGE: ghcr.io/esphome/esphome:2026.7.2`, the one place the version is pinned. `tools/release/manifest.py` writes the manifest (paths relative to it, `chipFamily: ESP32`, md5 + sha256).
- The guard, `tools/release/secret_guard.py`: any `!secret` in `pool-controller.yaml`, its `!include`s or the `*.yaml` beside it means a release builds nothing (notice: the release carries the card only), and a development build uses validate.yml's placeholders, artifact `firmware-dev-<sha>-placeholder-secrets-not-a-release`. A release build also runs with no secrets.yaml, so a `!secret` the guard missed fails the compile.
- `pages` job: only with `vars.PUBLISH_FIRMWARE_PAGES == 'true'`; deploys `/firmware/` (this release's three files) plus `docs/install/` as `/install/` when it exists. Each deploy replaces the site.

For the WPs that build on it:
- WP2: the manifest's `version` is the `firmware_version` string, the tag with its `v` (`v1.4.0`), so `esphome: project: version: ${firmware_version}` matches it exactly. Once no `!secret` is left, the next release carries the firmware with no change here.
- WP6: `source: https://<owner>.github.io/<repo>/firmware/manifest.json` (relative `ota.path`, so no redirect, unlike release assets).
- WP7: the install page in `docs/install/` reaches Pages with the next release's deploy (or add a `workflow_dispatch` path to the `pages` job then). Its ESP Web Tools manifest is `../firmware/manifest.json`; it sets `new_install_prompt_erase` and `home_assistant_domain: esphome`.

### WP6: updates
- [ ] new package `updates.yaml`: `http_request:` (verify_ssl), `ota: platform: http_request`, `update: platform: http_request` (source = Pages manifest, `update_interval: never`)
- [ ] a 1-min `interval:` checks every Update Check Interval hours; with Auto Update on, it installs, deferred while a manual override or a fill runs; each step logged
- [ ] HA's native Update entity installs too; the page gets « Vérifier » / « Installer »

### WP7: install page + docs
- [ ] `docs/install/index.html` on Pages: ESP Web Tools (Chrome/Edge, USB), Improv Wi-Fi, then « ouvrez http://pool-controller.local pour terminer »
- [ ] README, POOL-CONTROLLER: first setup, updates, factory reset, dev builds (no secrets.yaml; `make ota` takes the OTA password from an untracked file); `secrets.yaml.template` goes

### WP8: migrating a controller built with secrets.yaml, automatically (one OTA, no setup, no re-pairing)
The goal is uptime. One OTA carries every setting over, so the controller is back in about 15–20 s with nothing to set up. That is the same downtime as any `make ota`, and the pump keeps its plan through the reboot, as it does today.

- [ ] **`make migrate`.** It builds the generic firmware plus a local-only package, `migration.yaml`. The Makefile generates that package from `secrets.yaml` and the three probe addresses compiled into today's firmware; it is gitignored, never committed, never published. The secret guard and CI never see it.
- [ ] **Seeding on boot.** The package seeds the settings at `on_boot` priority 800, before WP2's 700 step applies them and before Wi-Fi and the API start. **It only fills an empty value, never overwrites.**
  - Wi-Fi: saved credentials under the generic (no-network) key, so it connects at once with no hotspot.
  - API key: the current one, via `save_noise_psk`, so HA reconnects without a prompt and never sees a keyless device.
  - Page and OTA passwords: the current ones.
  - Latitude, longitude, POSIX timezone and the IANA name.
  - Probe roles: pool, pad and outdoor from the compiled addresses. The pool probe has its role before its first read, so freeze protection and the plan never stop.
- [ ] **Uploaded like today.** `make migrate` uploads with today's OTA password, which is also the seeded one.
- [ ] **Waits and checks.** It waits for the controller to come back, then checks that Setup State reads `configured`, the pool temperature reads again, and the controller answers with the same API key (HA's Status on). On any failure it prints the rollback command.
- [ ] **Later updates.** The next normal update (a published release) no longer carries the package; the values stay in NVS. Then secrets.yaml can go.

Rollback: the last secrets.yaml build (v1.3.x) stays at hand; `make ota` of it restores the controller as it is today.

The only failure that cuts the controller off is Wi-Fi seeding not taking. It then falls back to its hotspot, and someone rejoins from its page near the pool. Verify this first (spike log: the fixed key `88491487` when the YAML has no network).

Timing: with the pump off, no manual override, no fill; someone stays on it until the checks pass. No spare board, so this is the first time it runs on hardware: the WP1/WP2 hardware checks happen in the same window, right after.

Before it runs: confirm that a value seeded at priority 800 survives into WP2's apply step, and that `save_noise_psk` at boot doesn't race HA's first connection. Both are read from the source, then compiled.

## Verification (the WP closing each item ticks it)
- [ ] each PR: `make validate`, `make mock-ui-check`, `make ha-dashboard-check`, CI green
- [ ] fresh board: install from the Pages page, complete setup, pair with HA
- [ ] reboot and OTA keep every setting
- [ ] a test release is found and installed: automatically on schedule, with « Installer » on the page, and from HA's Update entity
- [ ] factory reset brings back setup mode
- [ ] `make migrate` (WP8) on a controller in service: back within one reboot, `configured`, same API key, pool temperature reading

## Decisions
- Audience: anyone with the hardware (CI-built firmware, browser install page).
- Updates: the user chooses automatic (with a check interval) or on request; HA's Update entity can install when paired.
- Probes: detected on the bus, roles assigned on the page.
- Setup State lists `wifi` too, in wizard order: `page_password,wifi,position,probes,api_key`.
- Timezone: two entities, Timezone (POSIX, applied) and Timezone Name (IANA, display only), written together by the page and the card.
- Factory reset: our own selective erase (Rules), never ESPHome's `factory_reset`.
- API key without HA: generated and kept by the firmware (Generate API Key), never in the browser; Forget API Key to hand over to HA.
- Updates (WP6): Update Check Interval is a select « À la demande / 6 h / 24 h / 7 j » (24 h); every install, HA's Update entity included, waits for a manual override or a fill to end (our own gate around `update.http_request`), with an Update Status text_sensor.
- Integration branch: WP2, WP3 and WP6 merge into `feat/secret-free-firmware`; it reaches main once the firmware is usable end to end.
- This file: `docs/plans/`, updated by each WP's PR.
- Migration (2026-11-18): automatic, to keep uptime. One `make migrate` OTA seeds every current setting (Wi-Fi, API key, passwords, position, timezone, probe roles) from secrets.yaml into NVS, with nothing to set up and no re-pairing; manual steps are only the fallback (WP8).
- Hardware: there is no spare ESP32. The hardware checks run on the controller in service, in one planned window right after `make migrate`, with the last secrets.yaml build kept as the rollback. A spare ESP32 with DS18B20s would move them off it; recommended, not required.

## Spike log (WP1)
_(findings, with the ESPHome version they were checked on)_

**2026-11-17, compile level, no hardware.** ESPHome 2026.7.2 (the repo's current image) and 2026.11.0b6 (newest beta), Arduino framework as in `pool-controller.yaml`. Spike config: `tools/spike/runtime-hooks.yaml` (no `!secret`; hooks whose signature changed are wrapped in `ESPHOME_VERSION_CODE` checks so one file builds on both). Signatures read from each image's `esphome/components/` sources; Home Assistant's side read from home-assistant/core 2026.11.2.

| Hook | 2026.7.2 | 2026.11.0b6 | Notes |
|---|---|---|---|
| keyless API + `save_noise_psk()` | compiles | compiles | `bool APIServer::save_noise_psk(psk, bool make_active = true)`, `psk` is `api::psk_t` (2026.7) / `noise::psk_t` (2026.11), `std::array<uint8_t, 32>`; only without a YAML key (`#ifndef USE_API_NOISE_PSK_FROM_YAML`). Writes and syncs NVS at once, applies after 100 ms, drops every client. Does not reject the all-zero key itself (only the API request handler does): the page must. `global_api_server->get_noise_ctx().has_psk()` tells if a key is set (both versions) |
| OTA `password: ""` + `set_auth_password()` | compiles | compiles | `void set_auth_password(const std::string &)`, real only under `USE_OTA_PASSWORD`, which `password:` defines even when empty (else a `static_assert` stub). Empty = no auth, so the random first-boot password is needed |
| web auth `set_auth_username/password()` | compiles (`std::string`) | compiles (`const char *`) | see « web auth » below; `nullptr` compiles on both, but is only meaningful on 2026.11 |
| dallas_temp `set_address()`, bus list | compiles | compiles | `OneWireDevice::set_address(uint64_t)`; `OneWireBus::search()` and `get_devices()` (`const std::vector<uint64_t> &`) are public |
| timezone | `set_timezone(const char *)` / `(const std::string &)` compiles | **gone** | see « timezone » below; spike uses `time::set_global_tz()` on 2026.11 |
| sun `set_latitude/longitude()` | compiles | compiles | `void set_latitude(double)`, `set_longitude(double)` |
| `http_request` + `ota: http_request` + `update: http_request` | compiles | compiles | `verify_ssl: true` pulls the ESP-IDF certificate bundle; manifest read: `name`, `version`, `builds[].chipFamily`, `builds[].ota.path` + `md5` (required), `summary`, `release_url` (optional). 2026.11 adds a runtime `set_source_url()` |
| `improv_serial:`, `factory_reset` button, `esphome: project:` | compiles | compiles | |

Sizes (`Flash` / `RAM` as ESPHome prints them):

| Build | ESPHome | Flash | RAM |
|---|---|---|---|
| `pool-controller.yaml` as today (CI's placeholder secrets) | 2026.7.2 | 1,099,023 B (59.9 %) | 56,384 B (31.2 %) |
| idem | 2026.11.0b6 | 1,037,275 B (56.5 %) | 52,948 B (29.3 %) |
| idem + keyless API, `http_request` OTA + `update`, `improv_serial`, `factory_reset` (the generic firmware, roughly) | 2026.11.0b6 | 1,156,603 B (63.0 %) | 53,684 B (29.7 %) |
| spike | 2026.7.2 | 1,068,711 B (58.2 %) | 50,416 B (27.9 %) |
| spike | 2026.11.0b6 | 999,347 B (54.5 %) | 47,396 B (26.2 %) |

Flash % is of the 1,835,008 B app slot. The firmware builds unchanged on 2026.11.0b6, about 62 KB smaller (2026.11 also warns that `ota: password:` costs flash and RAM next to an API key and suggests `ota: encryption:`); the update path adds about 119 KB, so the generic firmware should land near 63 %, with room to spare.

**2026-11-18, WP2 build (no hardware).** The whole firmware with `device-settings.yaml`, ESPHome 2026.11.0b6 (2026.11.0 stable wasn't out: still the newest on 2026-11-18): compiles with no warning from our code. **Flash 1,059,447 B (57.7 %), RAM 56,068 B (31.0 %)**, vs 56.5 % / 29.3 % for the secrets build on the same ESPHome: the settings cost ~22 KB of flash. What WP2 learned or decided while building it:
- `random_uint32()` is « not suitable for cryptographic use » (helpers.h): the OTA password and Generate API Key use `random_bytes()` instead (the spike's lambda used `random_uint32`).
- **Forgetting the saved Wi-Fi** without wiping NVS: the wifi component loads a 98-byte `SavedWifiSettings` under key 88491487 (no network in the YAML) and a length mismatch reads as none, so Factory Reset saves a 1-byte record under that key and syncs.
- **Select options at run time**: `select.traits.set_options(FixedVector<const char *>)` copies the pointer list but not the strings, so the addresses live in a static, append-only table (`probe_option()`); the selects republish their state after each change. HA reads options on connect only.
- **dallas_temp auto-picks**: a sensor with no address takes the bus's only device at setup, so a second `on_boot` (590, right after dallas_temp's 600) puts unassigned roles back to address 0 (`update()` then does nothing: unknown).
- **web login from another task**: on ESP32 web_server_idf answers in the httpd task, which reads the credential pointers per request, so the password sits in one of two static buffers and a change swaps the pointer (`set_page_login()`).
- **on_boot in a package**: packages merge lists by concatenation but a mapping replaces, so `pool-controller.yaml`'s `on_boot` became a list, which the package's entries join.
- `make ota` passes the OTA password with `-s ota_password …` to `esphome upload` only (`ota: password: ${ota_password}`, empty when compiled), from `OTA_PASSWORD` or the untracked `.ota-password`.

**web auth.**
- 2026.11: `Credentials` holds `const char *` pointers (« point to string literals in generated code; nothing is copied »), and every request reads them (`GuardMiddlewareHandler::check_auth_`): `username == nullptr` means no auth. So a null username is setup mode, and a password set from the page applies on the next request, no reboot. The pointer must outlive the call: point it at a global `std::string`'s `c_str()` and set it again after each change. YAML `auth:` still requires a non-empty username and password, hence placeholders.
- 2026.7.2: `std::string` copies, and auth is decided once per handler when web_server registers it (`add_handler`, at its setup, priority 249): an empty username then means no auth **until reboot**. Password changes apply live; leaving setup mode needs a reboot. `nullptr` compiles there but is undefined behaviour (`std::string(nullptr)`): use `""`.
- 2026.11 also makes web_server a **captive portal** (DNS + a not-found redirect outside auth) while the AP is up, if it serves its embedded page: `local: true`, or by default when Wi-Fi is « AP only », which is how a YAML without a network reads. Our page (`js_url: ""`) counts as a custom frontend, so it is not; WP2 sets `local: false` explicitly anyway.

**timezone.** 2026.11 removed `RealTimeClock::set_timezone()` and the on-device POSIX parser: codegen parses the YAML zone (aioesphomeapi's `parse_posix_tz`) and emits `time::set_global_tz(const time::ParsedTimezone &)`; Home Assistant ≥ 2026.3 sends a pre-parsed zone, applied only by `time: platform: homeassistant`. A lambda can build a `ParsedTimezone` and call `set_global_tz()` (the spike does, for `CET-1CEST,M3.5.0,M10.5.0/3`). A `timezone:` must stay in the YAML (`UTC0`), or `USE_TIME_TIMEZONE` is not compiled and an empty one makes the build take the builder's own zone.

**`provisioning:` (2026.11): don't use it.** When its window closes with the device unprovisioned, wifi stops the fallback AP and never starts it again until a power cycle (`is_provisioning_closed_()` gates the AP start in `WiFiComponent::loop`), and the API refuses clients and keys. « Provisioned » needs every source: the network one is latched in RAM only, so a reboot during a router outage closes the window and the hotspot is gone. Our hotspot must stay up, so no `provisioning:` (it is optional; the keyless API works without it). ESPHome then warns that whoever provisions the API key can OTA without the password: accepted, see OTA below.

**keyless API.** `encryption: {}` compiles both `USE_API_NOISE` and `USE_API_PLAINTEXT`. Until a key is saved the device accepts plaintext clients (deprecated, to be removed after 2027.2.0) and Noise with the well-known all-zero key, so **anyone on the LAN can connect, drive the entities and set the key**. Once saved: Noise only, existing clients dropped. Same on 2026.7.2 and 2026.11.

**Home Assistant provisions the key itself.** home-assistant/core 2026.11.2, `esphome/manager.py` `_handle_dynamic_encryption_key()`: connected without a key to a device reporting `api_encryption_supported`, HA generates 32 random bytes, sends them over a zero-key Noise session (`api_encryption_provisionable`, both ESPHome versions report it) or plaintext, and keeps the key in its own storage. So pairing needs no key from the page. And if a device that HA knows with a key comes back keyless (WP8, right after the OTA), HA's reauth offers to **remove** the key (`reauth_encryption_removed_confirm`): don't confirm it; paste the old key on the page instead.

**OTA and the API key (2026.11).** With `api: encryption: {}`, `ota: platform: esphome` also gets `USE_OTA_ENCRYPTION_PROVISIONED`: once an API key is set, OTA offers Noise with it, and a client holding the key uploads **without** the password; plaintext uploads still ask for it. So the OTA password only guards the plaintext path (`make ota`), and HA (which holds the key) can OTA too.

**Saved Wi-Fi and migration.** The wifi component keys its saved credentials by the config hash when the YAML has a network, and by a fixed key (`88491487`) when it has none (both versions). So credentials joined from the page on today's firmware are lost on every build whose config changed, and the generic firmware (no network) won't find them: WP8 step 1 can't carry Wi-Fi over. Once on the generic firmware, its saved network survives OTA.

**NVS keys of globals:** md5 of the global's id only (`globals/__init__.py`); a changed type or size reads as missing too.

**Needs hardware** (on a spare ESP32 with a DS18B20 if one turns up; otherwise on the controller in service, in the WP8 window, see Decisions):
- boot the spike: hotspot comes up, no login on the page with nothing stored; set Page Password → the next request asks for it, no reboot (2026.11); reboot → still asked;
- OTA: `esphome upload` with a password set at run time (`ota: password: ${ota_password}` + `-s ota_password …` at upload only), and with the API key (2026.11 Noise path);
- probes: with 2+ probes on the bus, Rescan Probes lists them, `set_address()` on boot reads the chosen one from the first update; the « More than one device » boot error is harmless;
- timezone: `set_global_tz()` from on_boot vs the same zone in YAML: same local time, same sunrise from `sun` at a set latitude/longitude, across a DST change (set the clock by hand);
- API: add the device to an HA 2026.11 test instance: it should set the key by itself (`Noise PSK saved` in the log), then reconnect encrypted; also the API Key text path (`save_noise_psk` from a set_action);
- update: `update.http_request` against a real HTTPS manifest (GitHub Pages or any HTTPS host), then install from it;
- 2026.11 stable: rebuild on the release (2026.11.0b6 was the newest on 2026-11-17, and still on 2026-11-18 when WP2 pinned it).

**WP2 adds** (same: a spare ESP32 with 2+ DS18B20s, or the WP8 window):
- first boot: hotspot at once, page without login, Setup State `page_password,wifi,position,probes,api_key`; OTA refuses an upload with no password (the random one is set);
- Page Password from the hotspot: next request asks for it; survives a reboot; Improv serial and « Join WiFi Network » save the network (Setup State drops `wifi`), survives a reboot and an OTA;
- Latitude/Longitude/Timezone: plan computed, sunrise matches the same values compiled in; Schedule Waiting For goes `position` → `timezone` → `--`; a DST change by hand;
- probes: Detected Probes lists all with readings; roles survive a reboot and read the right probe from the first update; an unassigned role reads unknown even with a single probe on the bus; Rescan after plugging one in adds an option (and HA after a reconnect);
- API: HA pairs and sets the key (Setup State drops `api_key`); API Key paste, Generate API Key, Forget API Key each behave;
- Factory Reset: back to setup mode on the hotspot, roles/position/timezone/history kept; `make ota` with `.ota-password` uploads.

## Open questions
- ~~Does HA 2026.11 provision a keyless device's API key by itself? (WP1)~~ Yes, from its source (spike log); to see on hardware.
- ~~Timezone parser: write our own small one, or have the page send the parsed fields? (WP2, WP3)~~ Our own (WP2): the page sends a POSIX string, the device parses and validates it.
- Enabling GitHub Pages on the repo (owner's call, WP5): Settings › Pages › Source: GitHub Actions, and the repository variable `PUBLISH_FIRMWARE_PAGES` = `true` (README › Releases). Worth doing once a release carries a firmware (after WP2), since WP6 and WP7 need the URL.
