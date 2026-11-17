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
| 2 | Firmware: settings package, no `!secret` left | 1 | | todo | |
| 3 | Controller's page: setup wizard, « Contrôleur » sections | contract below (UI on the mock); 2 to finish | | todo | |
| 4 | Card: Firmware section on the update entity, position/timezone from HA | contract below; 6 to finish | | todo | |
| 5 | CI: releases carry the firmware, manifest + files on GitHub Pages | 2 (for a real build) | | todo | |
| 6 | Firmware: updates (http_request OTA + update entity + auto-update) | 1, 5 (manifest URL) | | todo | |
| 7 | Install page (ESP Web Tools) + docs | 5 | | todo | |
| 8 | Migration of an existing controller built with secrets.yaml | 2, 3, 6 | | todo | |

Parallel from day one: 0, 1, the mock-ups of 3 and 4, and 5's workflow (tested on a dummy build).

## What leaves the build

| Compiled today | Becomes (NVS) | Applied by | Set from |
|---|---|---|---|
| `wifi_ssid/password` | ESPHome's saved Wi-Fi credentials | the wifi component | install page (Improv serial); the page's « Rejoindre un réseau » (exists); the hotspot fallback stays |
| API encryption key | provisioned noise PSK, `api: encryption: {}` | `APIServer::save_noise_psk()` (only exists without a YAML key) | Home Assistant on pairing: it generates and sets the key itself (WP1, from HA's source); the page only for a pasted key (migration) or a key generated **in the browser** for use without HA (shown once there) |
| OTA password | global, `ota: … password: ""` in YAML | `id(ota_id).set_auth_password()` on boot; random at first boot so OTA is never open. From 2026.11 the API key also authenticates OTA (Noise), the password only guards plaintext uploads | page |
| page password | global; `web_server: auth:` compiled with placeholders | `web_server_base` `set_auth_username/password()` on boot; 2026.11 stores the `const char *` and reads it per request, so a change applies at once; null username = setup mode | page, wizard step 1 |
| latitude / longitude | restored `number`s, rounded to 0.01° | `id(sun_id).set_latitude/longitude()` | page; card « Utiliser la position de Home Assistant » (`hass.config`) |
| timezone (IANA, converted at build) | restored `text`, POSIX TZ | 2026.11 has no `set_timezone()`: our own small POSIX parser (an `includes:` header) fills a `time::ParsedTimezone`, then `time::set_global_tz()`; YAML keeps `timezone: UTC0` | page (IANA→POSIX table, preset from the browser's zone); card (from `hass.config.time_zone`) |
| 3 DS18B20 `address:` | role→address globals | `set_address()` before the first read; bus scan via `one_wire` | page: detected probes with live readings, one role select each |

Rules:
- **Secrets are never entity states.** CVE-2026-71260 leaks password-mode text values through web_server. A secret's `set_action` writes to a global, and the entity only reports « défini / non défini ». This is the pattern `wifi_join_password` in `wifi-setup.yaml` already follows.
- **Global ids are stable forever.** A global's NVS key is the md5 of its id, so renaming one silently loses its value (and so does changing its type or size).
- **No `provisioning:` block.** Its window closing stops the hotspot until a power cycle (WP1). The API stays open on the LAN until a key is set, so the wizard gets to Home Assistant early.
- **`web_server: local: false`** stays explicit: from 2026.11 an « AP only » Wi-Fi config (no network in YAML) would otherwise embed the stock page and serve it as a captive portal, outside auth.
- **Factory reset:** ESPHome's `factory_reset` button, with a confirmation on the page, wipes NVS and returns to setup mode.

## Entity contract

These are agreed up front, so 3, 4 and the mock can proceed before 2 and 6. Names are the ESPHome `name`s. HA's ids follow from the device name.

| Name | Type | Notes |
|---|---|---|
| Setup State | text_sensor | `configured` or the missing items: `page_password,api_key,position,probes` |
| Page Password | text (password mode, write-only) | write → global; state never holds it |
| OTA Password | text (write-only) | idem |
| API Key | text (write-only) | base64 32 bytes, validated, then `save_noise_psk` |
| Latitude, Longitude | number (°, 0.01) | restored |
| Timezone | text | POSIX TZ, restored |
| Detected Probes | text_sensor | `28ff…: 13.6, 28aa…: 14.9, …` (address: °C) |
| Pool Probe, Pad Probe, Outdoor Probe | select | options = detected addresses + `none` |
| Rescan Probes | button | |
| Auto Update | switch | restored |
| Update Check Interval | number (h, 0 = by hand) | restored |
| Firmware | update (http_request) | installed / latest / release URL; install action |
| Check for Update | button | |
| Factory Reset | button | page asks for confirmation |

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
- [ ] new package `device-settings.yaml`: globals, contract entities, boot lambdas (`on_boot` priority 700: after globals restore, before dallas_temp and web_server); `pool-controller.yaml` / `wifi-setup.yaml` lose every `!secret`
- [ ] ESPHome pinned to 2026.11.x (the hooks above assume it); a POSIX TZ parser header for `time::set_global_tz()`; `web_server: local: false`; no `provisioning:`
- [ ] `esphome: project: {name: davidterranova.pool-controller, version: ${firmware_version}}`; `improv_serial:`
- [ ] the schedule waits for a position and timezone (Schedule Not Computed says why); probes without a role read `unknown`
- [ ] webui mock simulates the contract (`MOCK_FRESH=1` = an unconfigured device); `make validate` / `mock-ui-check`

### WP3: controller's page
- [ ] mock-up first: a wizard while Setup State ≠ configured (page password → Wi-Fi → position/timezone → probes → Home Assistant)
- [ ] « Contrôleur »: Accès, Position, Sondes, Home Assistant, Réinitialiser, beside Wi-Fi and Firmware
- [ ] the Home Assistant step says « ajoutez l'appareil dans Home Assistant » (HA sets the key); API Key (paste, or generated with `crypto.getRandomValues` and shown once with « Copier ») is the fallback

### WP4: card
- [ ] Avancé › Firmware on the update entity: installed / latest, notes link, « Installer » (`update.install`), Auto Update + interval rows; retire `checkFirmware` / `FIRMWARE_FILES` (keep `parseVersion`)
- [ ] « Utiliser la position et le fuseau de Home Assistant » (Latitude, Longitude, Timezone)
- [ ] harness: a fake update entity in each state; VERSION bump

### WP5: CI releases
- [ ] one project version: a change to the card **or** firmware sources needs a new VERSION (extend card.yml's check)
- [ ] on release: compile with pinned ESPHome, no secrets, `-s firmware_version vX.Y.Z`; attach `firmware.ota.bin`, `firmware.factory.bin`, `manifest.json` (ESP-Web-Tools format + `ota` block: path, md5, release_url)
- [ ] publish them to GitHub Pages under `/firmware/` (stable URL, no redirect); the repo setting is the owner's call
- [ ] `validate.yml` drops the placeholder-secrets step

### WP6: updates
- [ ] new package `updates.yaml`: `http_request:` (verify_ssl), `ota: platform: http_request`, `update: platform: http_request` (source = Pages manifest, `update_interval: never`)
- [ ] a 1-min `interval:` checks every Update Check Interval hours; with Auto Update on, it installs, deferred while a manual override or a fill runs; each step logged
- [ ] HA's native Update entity installs too; the page gets « Vérifier » / « Installer »

### WP7: install page + docs
- [ ] `docs/install/index.html` on Pages: ESP Web Tools (Chrome/Edge, USB), Improv Wi-Fi, then « ouvrez http://pool-controller.local pour terminer »
- [ ] README, POOL-CONTROLLER: first setup, updates, factory reset, dev builds (no secrets.yaml; `make ota` takes the OTA password from an untracked file); `secrets.yaml.template` goes

### WP8: migrating a controller built with secrets.yaml (no re-pairing in HA)
- [ ] ~~on the old firmware, join the Wi-Fi once from the page~~ won't carry over (WP1: saved credentials are keyed by the config hash while the YAML has a network); after the OTA, join the network again from the hotspot page, or first OTA a one-off bridge build that saves them under the generic key (needs hardware)
- [ ] `make ota` the generic build (last upload with the old password)
- [ ] on the page: page and OTA passwords, paste the old API key (HA reconnects unchanged; meanwhile **don't** confirm HA's « encryption removed » reauth), position, timezone, probe roles
- [ ] HA's entities, the card and its light check out; then delete secrets.yaml

## Verification (the WP closing each item ticks it)
- [ ] each PR: `make validate`, `make mock-ui-check`, `make ha-dashboard-check`, CI green
- [ ] fresh board: install from the Pages page, complete setup, pair with HA
- [ ] reboot and OTA keep every setting
- [ ] a test release is found and installed: automatically on schedule, with « Installer » on the page, and from HA's Update entity
- [ ] factory reset brings back setup mode
- [ ] migration (WP8) on a controller in service

## Decisions
- Audience: anyone with the hardware (CI-built firmware, browser install page).
- Updates: the user chooses automatic (with a check interval) or on request; HA's Update entity can install when paired.
- Probes: detected on the bus, roles assigned on the page.
- This file: `docs/plans/`, updated by each WP's PR.

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

**Needs hardware** (spike build + a spare ESP32 with a DS18B20, never the controller in service):
- boot the spike: hotspot comes up, no login on the page with nothing stored; set Page Password → the next request asks for it, no reboot (2026.11); reboot → still asked;
- OTA: `esphome upload` with a password set at run time (`ota: password: ${ota_password}` + `-s ota_password …` at upload only), and with the API key (2026.11 Noise path);
- probes: with 2+ probes on the bus, Rescan Probes lists them, `set_address()` on boot reads the chosen one from the first update; the « More than one device » boot error is harmless;
- timezone: `set_global_tz()` from on_boot vs the same zone in YAML: same local time, same sunrise from `sun` at a set latitude/longitude, across a DST change (set the clock by hand);
- API: add the device to an HA 2026.11 test instance: it should set the key by itself (`Noise PSK saved` in the log), then reconnect encrypted; also the API Key text path (`save_noise_psk` from a set_action);
- update: `update.http_request` against a real HTTPS manifest (GitHub Pages or any HTTPS host), then install from it;
- 2026.11 stable: rebuild on the release (2026.11.0b6 was the newest on 2026-11-17).

## Open questions
- ~~Does HA 2026.11 provision a keyless device's API key by itself? (WP1)~~ Yes, from its source (spike log); to see on hardware.
- Timezone parser: write our own small one, or have the page send the parsed fields? (WP2, WP3)
- Enabling GitHub Pages on the repo (owner's call, WP5).
