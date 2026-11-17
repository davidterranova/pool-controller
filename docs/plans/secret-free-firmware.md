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
| 1 | Spike: confirm the runtime hooks on hardware with ESPHome 2026.11 | — | spike/wp1-runtime-hooks | in progress | |
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
| API encryption key | provisioned noise PSK, `api: encryption: {}` | `APIServer::save_noise_psk()` (only exists without a YAML key) | Home Assistant on pairing if it can (spike); otherwise the page: a key generated **in the browser** and set write-only (shown once there, to paste into HA), or pasted (migration) |
| OTA password | global, `ota: … password: ""` in YAML | `id(ota_id).set_auth_password()` on boot; random at first boot so OTA is never open | page |
| page password | global; `web_server: auth:` compiled with placeholders | `web_server_base` `set_auth_username/password()` before its setup; none stored = setup mode (spike: null username) | page, wizard step 1 |
| latitude / longitude | restored `number`s, rounded to 0.01° | `id(sun_id).set_latitude/longitude()` | page; card « Utiliser la position de Home Assistant » (`hass.config`) |
| timezone (IANA, converted at build) | restored `text`, POSIX TZ | `id(local_time).set_timezone()` | page (IANA→POSIX table, preset from the browser's zone); card (from `hass.config.time_zone`) |
| 3 DS18B20 `address:` | role→address globals | `set_address()` before the first read; bus scan via `one_wire` | page: detected probes with live readings, one role select each |

Rules:
- **Secrets are never entity states.** CVE-2026-71260 leaks password-mode text values through web_server. A secret's `set_action` writes to a global, and the entity only reports « défini / non défini ». This is the pattern `wifi_join_password` in `wifi-setup.yaml` already follows.
- **Global ids are stable forever.** NVS keys are a hash of id and type, so renaming one silently loses its value.
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
- [ ] ESPHome 2026.11 builds and runs this firmware (flash use with http_request + update + improv)
- [ ] web auth: credentials set before setup apply; a null username serves without auth (setup mode)
- [ ] `ota.esphome` with `password: ""` + `set_auth_password()` on boot; `make ota` with `-s ota_password` uploads
- [ ] `set_address()` on dallas_temp before the first update; `one_wire` lists the bus
- [ ] `set_timezone()` POSIX + sun `set_latitude/longitude()` give the same sunrise as the compiled values
- [ ] keyless API: does HA 2026.11 provision the key? `save_noise_psk()` from a set_action works either way
- [ ] `update.http_request` reads a GitHub Pages manifest over HTTPS (ESP-IDF cert bundle), OTA from it

### WP2: firmware settings
- [ ] new package `device-settings.yaml`: globals, contract entities, boot lambdas; `pool-controller.yaml` / `wifi-setup.yaml` lose every `!secret`
- [ ] `esphome: project: {name: davidterranova.pool-controller, version: ${firmware_version}}`; `improv_serial:`
- [ ] the schedule waits for a position and timezone (Schedule Not Computed says why); probes without a role read `unknown`
- [ ] webui mock simulates the contract (`MOCK_FRESH=1` = an unconfigured device); `make validate` / `mock-ui-check`

### WP3: controller's page
- [ ] mock-up first: a wizard while Setup State ≠ configured (page password → Wi-Fi → position/timezone → probes → Home Assistant)
- [ ] « Contrôleur »: Accès, Position, Sondes, Home Assistant, Réinitialiser, beside Wi-Fi and Firmware
- [ ] the API key generated with `crypto.getRandomValues`, shown once with « Copier »

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
- [ ] on the old firmware, join the Wi-Fi once from the page (credentials saved in NVS)
- [ ] `make ota` the generic build (last upload with the old password)
- [ ] on the page: page and OTA passwords, paste the old API key (HA reconnects unchanged), position, timezone, probe roles
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

## Open questions
- Does HA 2026.11 provision a keyless device's API key by itself? (WP1)
- Enabling GitHub Pages on the repo (owner's call, WP5).
