# ESP32-S3 controller with a touch panel: run the pool from the box, without a phone

Tracking document. One session per work package (WP). Planned against main at v1.15.0 on 2026-11-25.

## Branches

The feature lives on **`feat/s3-panel`**, branched from main. Nothing reaches main until the whole feature is ready, so no release happens and no controller in the field updates. Its first commit holds this plan and the VERSION bump to 1.16.0.

```
main ── feat/s3-panel ──┬── feat/s3-panel-s1-target ─────┐
                        ├── feat/s3-panel-s3-scaffold ───┤ PRs into the feature branch
                        ├── … s2 … s11 ──────────────────┘
                        └── one PR into main = one release (1.16.0) = the S3 build published
```

To claim a WP:
1. Check `gh pr list --base feat/s3-panel` and the Status table below.
2. Branch from `feat/s3-panel` as `feat/s3-panel-s<n>-<topic>`. In the first commit, set its row to `in progress` with the branch name.
3. Open the PR **into `feat/s3-panel`**, not main. The PR that finishes the WP ticks its done-when boxes, sets its row to `done` and links itself.
4. The user merges it once CI is green, or lets Claude merge it by saying so in the PR. Then the WPs that depend on it merge the feature branch in.

The feature branch's other rules:
- **Version:**
  - VERSION is 1.16.0, the next unreleased minor. Main is at 1.15.0, and 1.15.1 (a card docs patch) may ship first without changing this.
  - release.yml's check runs on every PR, whatever its base. It fails when the card or a root `*.yaml`/`*.h` changed and VERSION is already released, so WP PRs pass without each bumping it.
  - If main releases 1.16.0 first, the next sync of main bumps it again.
- **Keeping up with main:**
  - Merge main into the feature branch whenever main moves, and always before the final PR. Then each open WP branch merges the feature branch in.
  - User-facing text a merge brings in is translated in that merge (`.claude/rules/translations.md`).
- **The live controller is read-only:**
  - Until the swap (S9), nothing on this branch is flashed to the pool's WROOM.
  - Tools may read it (S7's dry run), never write to it.
  - Every S3 build before S9 runs as the **bench** device: `make … BENCH=1` names it `pool-panel-bench` (`pool-panel-bench.local`), so it never clashes with `pool-controller.local`.
- **The bench S3 never fetches the WROOM's update:** the S3 build ships with Auto Update off and Update Check Interval `on_request` until S10 gives it its own manifest. ESPHome only checks that version strings differ (see [page-login.md](page-login.md)'s testing pitfall).
- **Mid-feature testing:**
  - The bench S3: `make flash-s3 BENCH=1` (USB) or `make ota-s3 BENCH=1`.
  - The panel without hardware: `make panel-shots` (S3).
  - The page: the mock (`make mock-ui`, S5).
  - Never through a release.
- **Going live:**
  1. When every WP is `done` and every acceptance criterion is ticked, open one PR from `feat/s3-panel` into main. Its description is the release notes (S11).
  2. Its merge releases 1.16.0. WROOM controllers get History Import and the page's « Screen » section, hidden without a panel. CI publishes the S3 build and its manifest.
  3. The user merges it.

## Why

Without a phone or a computer, nothing at the box shows the pump's state or lets anyone change it. At the box, with no phone, a person needs to:
- switch between Auto and manual;
- in manual, choose Off, Low, Medium or High, **and for how long**: 30 min, 1 h, 2 h or with no time limit;
- read the three probes (water, equipment pad, outdoor);
- read the fill water.

The controller sits indoors, inside a bigger box, in a dedicated room or a crawl space. The air is humid, there is no direct sun, and nobody wears gloves to use it.

The current board (ESP32-WROOM, no PSRAM, 1.26 MB used of a 1.75 MB app slot) can't run a touch UI. An ESP32-S3 with PSRAM can, and leaves room for later pages, so the S3 becomes a second build target with a 3.5″ touchscreen. The WROOM build stays as it is for everyone who runs it.

## Decisions

The options were evaluated in two iterations (2026-11-21: buttons + display against touchscreens, under the first and then the revised constraints).

**2026-11-21: what to build**
- **A capacitive touchscreen**, not buttons.
  - Iteration 1 rejected touch for spray, sun, gloves and the lack of PSRAM. The real install has none of those, and a board with PSRAM is fine.
  - With a duration to pick, two buttons need 6–10 presses across three menus. One touch sheet takes three taps.
- **3.5″, 480×320, IPS, landscape.**
  - The mode row's buttons come out about 13 mm wide, above the ~10 mm comfort limit.
  - The 4.0″ 480×320 ST7796 is a drop-in upgrade with the same firmware if the text turns out too small.
- **One physical Auto button** on a GPIO, independent of the touch controller. It sets Auto at any time, even with the screen asleep, fogged or unplugged.
- **The pump-mode sheet writes what the dashboard already writes:**
  - Manual Override Timeout first (30, 60, 120 or 0 = never), then Manual Override. Auto writes Manual Override only.
  - No new firmware logic decides how long an override lasts: the expiry, the « Manual Override Active » alert and « Manual Override Ends At » keep working.
- **Humidity is the risk left**, handled in layers:
  - a touch on a sleeping screen only wakes it;
  - changes need « Apply »;
  - the Auto button always works;
  - a breather vent, silica gel and conformal coating;
  - a counter of touches ignored while asleep (Panel Ignored Touches) shows condensation before it becomes a problem.
- **Prototype on this install first; publish for everyone after** it has run the pool.

**2026-11-23: the board**
- **An ESP32-S3 with 8 MB octal PSRAM and an external antenna.**
  - The controller's Wi-Fi at the box is weak: about −73 dBm on average on this install, with dips to −82.
  - The new board sits behind a display's metal frame.
- **Target board: an ESP32-S3-DevKitC-1 N16R8 clone with an IPEX connector**, the one tested being Heemol's: 16 MB flash, 8 MB octal PSRAM.
  - The IPEX connector is disconnected out of the box, behind a 0 Ω resistor. It is bridged with a solder blob; a buyer reports +7 dB.
  - The module is a third-party one around a genuine Espressif ESP32-S3R8 chip. esptool reads the in-package 8 MB PSRAM from the chip's eFuses.
  - Espressif's DevKitC-1U-N8R8 is the no-rework alternative, hard to find at the time of writing.

**2026-11-25: settled with the user**
- **Display: an Elecrow DLS30035B1-compatible module** (sold as Ginobili): ST7796U over SPI, FT6336U capacitive touch on I²C, a 14-pin 2.54 mm header. Elecrow's drawing gives its dimensions (« Hardware »).
- **Moving to the new board carries the settings and the on-device histories:**
  - a transfer tool (S7);
  - a new History Import entity (S6) for the 7-day histories and today's running values;
  - the existing Fill Water Import for the fill days and months.
  - History Import goes in **every** build, since it helps any board replacement, not only this one.
- **Scope: panel v1, then publish the S3 build.**
  - Settings pages, charts and Wi-Fi join are later features (« Later »).
  - The panel shows « Fill this month » (this month's closed days plus today), not the meter's total, which restarts at 0 on every boot.
- **File layout: an S3 top-level config at the root that includes `pool-controller.yaml` as a package**, so the WROOM's files stay untouched:
  - It overrides only the board, the framework, PSRAM, the pins and the name. S1 checks that this works, else takes the smallest refactor.
  - The S3 files live at the root like the other packages. A feature branch never releases, and the final merge is the release that publishes the S3 build.
- **Panel language: a « Panel Language » select** (`en`, `fr`, `es`, default `en`). The setup wizard sets it to the page's language. The panel uses a 24-hour clock in every language, and a decimal comma in French and Spanish.

## Open questions (each settled in its WP, then moved to Decisions)

- ESP-IDF or Arduino on the S3 (S1). Default: ESP-IDF, which ESPHome recommends for LVGL on the S3. The firmware uses no Arduino-only API, and its web server already runs on ESP-IDF's.
- How `update: platform: http_request` picks a build in a manifest, by `chipFamily` or the first one (S1). This decides whether S10 ships one manifest with both builds or one manifest per target.
- How Home Assistant keeps the entity ids across the swap (S2 rehearses it, S9 does it):
  - the ESPHome integration's device replacement, if it accepts a new MAC for the same name;
  - otherwise remove the old device, add the new one, and rename the ids back.
- Rotation direction and touch transform (S2), once the mounting side of the connector is known (S8).
- Font sizes and their flash cost (S4). Default Panel Sleep After: 60 s (S4).

## Hardware

| Part | Choice | Notes |
|---|---|---|
| Board | ESP32-S3-DevKitC-1 N16R8 clone with IPEX (×2: bench and spare) | check PSRAM, flash and every pin's label at first boot (S2) |
| Antenna | IPEX→SMA bulkhead pigtail + 2.4 GHz 3 dBi dipole | bridge the antenna select resistor; bulkhead on the box's side |
| Display | Elecrow DLS30035B1-compatible, 3.5″ IPS 320×480 | ST7796U (SPI), FT6336U (I²C), touch glass « G+F », 5 V with on-board level conversion, backlight 95 mA |
| Auto button | 16 mm momentary, stainless 316, IP67 | to GND, internal pull-up |
| Relays, probes, meter | unchanged | the 8-channel opto relay board (active-low), the DS18B20 bus with its 4.7 kΩ pull-up, the reed-switch meter |
| Power | one 5 V supply, ≥ 2 A | S3 + display about 0.6 A at Wi-Fi peaks, plus the relay coils |

**Pin map (S3)**

| Signal | S3 GPIO | WROOM today |
|---|---|---|
| Display SCK | 12 | — |
| Display SDI (MOSI) | 11 | — |
| Display SDO (MISO) | not connected | — |
| Display LCD_CS | 10 | — |
| Display LCD_RS (DC) | 9 | — |
| Display LCD_RST | 8 | — |
| Display LED (backlight, PWM) | 14 | — |
| Touch CTP_SDA / CTP_SCL | 1 / 2 | — |
| Touch CTP_INT / CTP_RST | 21 / 18 | — |
| Display SD_CS | tied to 3.3 V (the micro-SD slot stays empty) | — |
| Relay V1 / V2 / V3 / Run | 4 / 5 / 6 / 7 | 26 / 25 / 14 / 27 |
| OneWire probes | 15 | 4 |
| Water meter | 16 | 33 (an octal-PSRAM pin on the S3) |
| Auto button | 17 | — |

- Pins 10–13 are the S3's native FSPI pins, so the display bus runs at full speed.
- Spare: 13, 39, 40, 41, 42, 47. Pin 38 or 48 drives the onboard RGB LED, depending on the board's revision.
- Never used:
  - 0, 3, 45, 46 (boot straps);
  - 19, 20 (USB);
  - 26–37 (flash and octal PSRAM);
  - 43, 44 (the serial log).
- The relay pins are high-impedance at boot and the relay board's inputs float to off, so the relays stay open while the S3 starts, as they do today.

**Display (Elecrow drawing DLS30035B1, V1.0)**
- PCB 98.0 × 55.5 mm, touch glass 84.96 × 55.50 mm, active area 73.44 × 48.96 mm.
- Four Ø3.2 mm holes at 92.0 × 49.5 mm.
- About 13 mm deep with the header.
- Operating range: LCD −30…80 °C, touch −20…70 °C.
- Header order: 1 VCC, 2 GND, 3 LCD_CS, 4 LCD_RST, 5 LCD_RS, 6 SDI(MOSI), 7 SCK, 8 LED, 9 SDO(MISO), 10 CTP_SCL, 11 CTP_RST, 12 CTP_SDA, 13 CTP_INT, 14 SD_CS.

## Contract

Agreed up front, so the WPs can run in parallel.

**Files**

| File | What | Builds |
|---|---|---|
| `pool-controller-s3.yaml` | S3 top-level config: `packages:` `core: !include pool-controller.yaml`, `panel: !include local-panel.yaml`, `history: !include history-import.yaml` comes through core. The pin map as substitutions, `device_name` (default `pool-controller`), the `esp32:`/`psram:` overrides, and the display, touch, backlight and Auto-button hardware | S3 |
| `local-panel.yaml` | The panel: fonts, LVGL pages, bindings, idle/wake, the Auto button's action, the panel's entities. It names its hardware only by id (`panel_display`, `panel_touch`, `panel_backlight`, `auto_button`), so the preview can stand in for it | S3, preview |
| `panel_ui.h` | Pure helpers, no ESPHome header: the sheet's state, time left, number and duration formats per language, the asleep-touch counter | S3, host tests |
| `panel_i18n.h` | **Generated** from `i18n-panel/{en,fr,es}.json` (`make panel-i18n`); never edited | S3, preview |
| `history-import.yaml`, `history_import.h` | History Import, included by `pool-controller.yaml` | every build |
| `tools/panel-preview/` | `host` + `sdl` build of `local-panel.yaml` with stand-in entities, Docker image (ESPHome + SDL2 + Xvfb), screenshot script | dev, CI |
| `tools/transfer/` | `make transfer`, `make transfer-test` | dev, CI |
| `tools/tests/panel_ui_test.cpp`, `tools/tests/history_import_test.cpp` | Host tests, added to `FIRMWARE_TESTS` | CI |

**Make targets**
- `validate-s3`, `build-s3`.
- `flash-s3`: esptool `--chip esp32s3`, factory image at 0x0.
- `ota-s3`, `logs-s3`.
- `BENCH=1` → `-s device_name pool-panel-bench`, host `pool-panel-bench.local`.
- `panel-i18n`, `panel-shots`, `panel-preview-check`, `transfer`, `transfer-test`.
- The existing targets keep building `pool-controller.yaml`.

**New entities**

Names are English and never renamed once published. Every global's NVS key is the md5 of its id, so `panel_lang` and `panel_sleep_s` may never be renamed.

| Name | Type | Category | Build | Notes |
|---|---|---|---|---|
| Panel Language | select | config | S3 | options `en`, `fr`, `es` (codes); restored global `panel_lang`, default `en`; a change relabels the panel at once |
| Panel Sleep After | number (s, 15–600, step 15, box) | config | S3 | restored global `panel_sleep_s`, default 60 |
| Panel Ignored Touches | sensor | diagnostic | S3 | touches ignored while asleep since boot; a burst (S3 sets the threshold) also logs a warning |
| History Import | text (max 255) | config | every build | kept off the page, like Fill Water Import; its state is a code (below) |

**The panel's screens**
- **Home:**
  - A status bar: the time, Wi-Fi, and badges for freeze protection, the fill alarm and no Wi-Fi, taken from the firmware's codes.
  - The mode card:
    - in Auto, the speed now and the next change (« Medium until 16:00 »);
    - in manual, the speed and the time left (« High · 1 h 12 min left · Auto at 15:32 », or « no time limit »).
  - **Change** opens the sheet.
  - Five tiles: Water, Equipment pad, Outdoor, Fill today, Fill this month. The fill tiles are hidden while Fill Meter is off.
  - Tapping the status bar opens Status.
- **Pump mode sheet:**
  - Auto · Off · Low · Medium · High.
  - Then « For » 30 min · 1 h · 2 h · Never, disabled for Auto.
  - A hint line:
    - Off + Never: « Filtration stays off until you change it or the controller restarts. Freeze protection still starts the pump. »;
    - Never: « A restart returns to Auto. »;
    - otherwise « … until HH:MM, then back to Auto ».
  - Cancel · Apply. The sheet opens on the current mode and the current Manual Override Timeout.
- **Status:** Wi-Fi network and signal, IP address with a QR code of the page's address, firmware version, uptime, Update Status and Setup State (codes, translated).
- **Behaviour:**
  - The backlight goes off after Panel Sleep After and LVGL pauses.
  - A touch while paused only resumes and lights up.
  - Sleep discards a staged sheet.
  - The Auto button sets Auto and wakes the screen.
  - Every Apply logs what it wrote, in order (`panel` tag).

**History Import's lines**

Each line is tagged, because Daily History and Daily Plan History share a format.

| Tag | Body | Writes |
|---|---|---|
| `daily:` | Daily History's own line (« 2026-11-13: 6.42 h 25.9/26.6 °C, … ») | the 7-day record's dates, filtration minutes and water min/max |
| `plan:` | Daily Plan History's | planned minutes, for dates already in the record |
| `outdoor:` | Daily Outdoor History's | outdoor min/max, for dates already in the record |
| `today:` | `YYYY-MM-DD filtration=<min> water=<lo>/<hi> outdoor=<lo>/<hi> fill=<L>` (`-` for unknown) | today's running values, only if the date is the device's today |

- **Outcome codes:**
  - `imported:daily:N`, `imported:plan:N`, `imported:outdoor:N`, `imported:today`;
  - `refused:no_clock`, `refused:format`, `refused:tag`, `refused:date`, `refused:value`, `refused:too_many`, `refused:future`, `refused:record_ahead`, `refused:not_today`.
- A refused line changes nothing.
- A `daily:` line never replaces a record holding newer days.
- Hours parse back to within one minute, because the sensors print hundredths of an hour.
- Like Fill Water Import's codes, these show in Home Assistant's device page only, so no UI translates them.

**Translations**
- A new surface `panel` in `tools/i18n/surfaces.mjs`:
  - dir `i18n-panel`;
  - sources `local-panel.yaml` and `panel_ui.h`;
  - reads `card` for the speeds, `common.mode.*` and the `status.*` codes;
  - `strict: true` from its first commit.
- Keys are named after where they show: `panel.home.*`, `panel.sheet.*`, `panel.status.*`.
- The glossary gains « screen » (« écran », « pantalla »).
- Montserrat, LVGL's face, comes with the `GF_Latin_Core` glyph set plus `°³…`. LVGL's built-in fonts have no accents.

**`make transfer`**
- Usage: `make transfer FROM=<host> TO=<host> [FROM_KEY=… TO_KEY=…] [APPLY=1]`.
- Without `APPLY`, it reads the source and prints what it would write.
- With `APPLY`, it writes, in this order:
  - the schedule numbers, then Apply Filtration Config;
  - Freeze Protection Temperature and Manual Override Timeout;
  - Timezone, Latitude, Longitude;
  - Pool/Pad/Outdoor Probe, after a Rescan Probes on the target;
  - Fill Meter and Fill Alarm After;
  - Fill Water Import (days, months);
  - History Import (`daily`, `plan`, `outdoor`, `today`).
- It then reads everything back and exits non-zero on any mismatch.
- It never writes to the source.
- It doesn't move, and says so at the end:
  - the passwords and the API key, which are write-only (the wizard sets them);
  - Wi-Fi;
  - the update settings, unless `--with-updates`;
  - the panel's settings.

## Acceptance criteria

Tick each one only with its evidence (PR, command, or the date of the hardware check).

- [ ] **A1 S3 build:**
  - `make validate-s3` and `make build-s3` pass locally and in CI.
  - Flash, RAM and PSRAM use noted in S1's PR.
- [ ] **A2 WROOM unchanged except the planned shared changes:**
  - `esphome config pool-controller.yaml` on the branch differs from main's only by History Import and the version.
  - `make build` passes.
  - Its flash growth is noted in the final PR.
- [ ] **A3 Board health:**
  - On the target board, the boot log reports 8 MB octal PSRAM and 16 MB flash.
  - Every pin of the map toggles or reads as its silkscreen says (S2's blink test).
- [ ] **A4 Radio:**
  - With the IPEX antenna active, the S3's 24 h mean RSSI at the box is ≥ the WROOM's at the same spot.
  - 0 Wi-Fi disconnects during the burn-in.
- [ ] **A5 Pump safety on the S3:**
  - Relays stay open while booting, flashing and resetting.
  - Break-before-make order on every speed change (observed on LEDs, and in the log).
  - Schedule, override expiry and freeze protection behave as on the WROOM.
- [ ] **A6 Panel:**
  - Home shows the mode, the time left and the readings, agreeing with the page.
  - Apply writes the timeout, then the override (log).
  - Cancel and sleep discard the sheet.
  - A touch on a sleeping screen only wakes it.
  - The screen sleeps after Panel Sleep After.
  - Checked on hardware.
- [ ] **A7 Auto button:** returns to Auto with the screen awake, asleep, and with the touch flex unplugged.
- [ ] **A8 Languages:**
  - `make panel-shots` gives every screen in every state (Auto, manual with a limit, manual Never, Off, fill meter off, freeze protection, no Wi-Fi) in en, fr and es.
  - No clipped text, and the accents are drawn.
  - `make i18n-check` passes with `panel` strict.
  - Panel Language switches the panel at once.
- [ ] **A9 Tests:** green in CI:
  - `make firmware-test`, with `panel_ui_test` and `history_import_test`;
  - `make transfer-test`;
  - `make webui-test`;
  - `make mock-ui-check`;
  - `make i18n-check`;
  - `make ha-dashboard-check`;
  - `make panel-preview-check`.
- [ ] **A10 Transfer:**
  - The dry run lists every setting and history.
  - After `APPLY`, the verify step reports every setting equal and every history string equal to the source's (hours within one minute).
- [ ] **A11 Home Assistant continuity:**
  - After the swap, the controller's entity ids are the ones it had.
  - Recorder history and long-term statistics continue on the same entities.
  - Automations, dashboards and the HomeKit-bridged Pump work.
- [ ] **A12 Seven days on the pool:**
  - No unplanned reboot.
  - No ignored-touch burst.
  - Daily History's hours match Daily Plan History's.
- [ ] **A13 Rollback rehearsed:** the WROOM, left as it was, takes over again when swapped back (bench rehearsal before going live).
- [ ] **A14 Published:**
  - A release build carries both firmwares, and the WROOM's manifest path is unchanged.
  - The install page installs the S3 build on a blank board (the spare).
  - An S3 controller finds and installs a newer build from its own manifest: a locally served one before the release, the real one after it.
- [ ] **A15 Docs:** every row of « Documentation » ticked.

## Status

| WP | What | Depends on | Branch | Status | PR |
|---|---|---|---|---|---|
| S1 | S3 target, Make targets, CI | — | — | todo | — |
| S2 | Bench bring-up: board checks, antenna, display, full firmware on the bench, HA rehearsal | S1, hardware delivered | — | todo | — |
| S3 | Panel scaffolding: `panel_ui.h` + tests, translations pipeline, fonts, preview | contract | — | todo | — |
| S4 | Panel UI (LVGL) | S1, S3 (S2 for the on-device checks) | — | todo | — |
| S5 | Controller page + mock: « Screen », wizard | contract | — | todo | — |
| S6 | History Import (every build) | contract | — | todo | — |
| S7 | Transfer tool | S6 | — | todo | — |
| S8 | Enclosure and wiring | S2, S4 | — | todo | — |
| S9 | Burn-in, swap and go-live on the pool | S4–S8 | — | todo | — |
| S10 | Publish the S3 build: CI, manifests, install page | S9 | — | todo | — |
| S11 | Documentation pass and final PR | S1–S10 | — | todo | — |

S1, S3, S5 and S6 can start in parallel, before the hardware arrives.

## Work packages

### S1: S3 target, Make targets, CI
- [ ] `pool-controller-s3.yaml`:
  - packages: `core: !include pool-controller.yaml`, plus a stub `local-panel.yaml` until S4;
  - substitutions: the pin map and `device_name`;
  - `esp32:` board `esp32-s3-devkitc-1`, `variant: esp32s3`, `flash_size: 16MB`, the framework the spike picks, with `!remove` on the WROOM-only advanced options (`minimum_chip_revision`, `sram1_as_iram`);
  - `psram:` `mode: octal`, `speed: 80MHz`;
  - Auto Update off and Update Check Interval `on_request` until S10.
- [ ] Spike, with its findings recorded in Decisions:
  - (a) the package override (substitutions, `!remove`, the resolution of `esphome.includes` and `!include` from a second top-level file) leaves `pool-controller.yaml` untouched; if not, the smallest refactor, with A2's diff;
  - (b) ESP-IDF against Arduino on the S3: build both and pick;
  - (c) how `http_request` updates pick a manifest build;
  - (d) the partition table ESPHome generates for 16 MB, and the app slot size;
  - (e) whether `lvgl.pause` stops input processing, so the first touch only wakes.
- [ ] Makefile: the S3 targets of the contract, with a build dir per config. Keep the WROOM targets as they are.
- [ ] `validate.yml`: the secret guard on `pool-controller-s3.yaml`, `make validate-s3`, and `make build-s3` on PRs.
- [ ] Done when:
  - A1 holds;
  - `esphome config pool-controller.yaml` is unchanged from main's;
  - CI is green.
- [ ] **Docs:**
  - the header comment of `pool-controller-s3.yaml` (what it overrides and why);
  - the Makefile comments of the new targets;
  - README's build section mentions the S3 targets.

### S2: bench bring-up (hardware)
- [ ] Both boards:
  - the boot log shows the PSRAM size and mode, and the flash size;
  - a throwaway `tools/spike/s3-pins.yaml` blinks or reads every pin of the map, checked against the silkscreen;
  - results in the PR.
- [ ] Antenna:
  - bridge the 0 Ω select pad to the IPEX connector and fit the pigtail and dipole;
  - RSSI with the PCB antenna and with the IPEX one, 10 min each, at the box's spot.
- [ ] Display, with a throwaway `tools/spike/s3-display.yaml`:
  - a test pattern and the landscape rotation, with the connector on the mounting side;
  - the touch transform (`swap_xy`/`mirror_*`), so taps land on the drawn targets;
  - SPI at 40 MHz, then tried at 80 MHz.
- [ ] Bench harness:
  - the relay board on pins 4–7, with nothing on its contacts;
  - one DS18B20 with 4.7 kΩ on 15;
  - a push button standing in for the meter on 16;
  - the Auto button on 17;
  - the display per the pin map, with SD_CS to 3.3 V.
- [ ] The full firmware, `make flash-s3 BENCH=1`:
  - the hotspot and the wizard;
  - probes found by Rescan Probes;
  - relay order on speed changes (LEDs);
  - meter pulses counted;
  - the page's login;
  - a clean log.
- [ ] Home Assistant rehearsal for S9:
  - add the bench board under its bench name;
  - try the integration's device-replacement path on it, and record which way keeps entity ids;
  - remove it.
- [ ] Done when:
  - A3 holds;
  - A5 holds on the bench;
  - the antenna comparison is recorded;
  - the rotation and touch transform are recorded in Decisions.
- [ ] **Docs:** a draft of POOL-CONTROLLER.md's S3 hardware section (pin map, antenna mod, display wiring), finished in S8.

### S3: panel scaffolding (helpers, translations, preview)
- [ ] `panel_ui.h`, tested in `tools/tests/panel_ui_test.cpp`:
  - the sheet's state: staged mode and minutes, what Apply writes, the hint for each combination;
  - time left and « Auto at HH:MM » from the override's start and the timeout;
  - number and duration formats per language (decimal comma in fr/es, 24-hour clock);
  - the asleep-touch counter and its burst threshold.
- [ ] Translations:
  - `i18n-panel/{en,fr,es}.json`;
  - a generator `tools/i18n/panel-header.mjs` → `panel_i18n.h`, plus `make panel-i18n`;
  - the `panel` surface in `surfaces.mjs`, with code usage, checked to see the C++ calls;
  - `make i18n-check` fails when `panel_i18n.h` is stale, as it does for the HA files;
  - « screen » in the glossary.
- [ ] Fonts: Montserrat with `GF_Latin_Core` + `°³…`. The generator fails if a dictionary uses a character no font covers.
- [ ] Preview (`tools/panel-preview/`):
  - a `host` + `sdl` build of `local-panel.yaml`, with stand-in entities under the firmware's ids, and scenarios as substitutions;
  - a Docker image (the ESPHome image + SDL2 + Xvfb);
  - `make panel-shots` → `tools/panel-preview/shots/<lang>-<screen>-<state>.png` at 480×320;
  - `make panel-preview-check` fails on a key shown instead of its text;
  - CI runs the check.
- [ ] Done when:
  - the host tests pass;
  - the preview draws a placeholder screen in each language, in CI.
- [ ] **Docs:**
  - the header comment of `panel_ui.h`;
  - README « Working on the panel without hardware »;
  - the panel in `.claude/rules/translations.md`'s « Where text goes ».

### S4: panel UI (LVGL)
- [ ] `local-panel.yaml`:
  - the contract's entities and LVGL pages (home, pump-mode sheet, status), bound by id;
  - `on_idle` after Panel Sleep After: backlight off and `lvgl.pause`;
  - a touch while paused only resumes and lights up;
  - the Auto button: `select.set` Auto, and wakes the screen;
  - a Panel Language change relabels every widget;
  - sleep discards the sheet;
  - every text from `panel_i18n.h`, with no literal.
- [ ] Hardware block in `pool-controller-s3.yaml`:
  - `spi`;
  - `display` (ST7796, S2's rotation);
  - `touchscreen: ft63x6` (S2's transform, INT 21, reset 18);
  - `output: ledc` and the backlight as an internal light;
  - the Auto button (pull-up, debounce).
- [ ] `panel` log tag: wake, sleep, every Apply with what it wrote, the Auto button, ignored-touch bursts.
- [ ] Screenshots in the PR:
  - every screen × state × language from `make panel-shots`;
  - one language on the hardware, described.
- [ ] Done when:
  - A6 holds;
  - A7 holds;
  - A8 holds in the preview and on the hardware.
- [ ] **Docs:**
  - the header comment of `local-panel.yaml`: screens, behaviour, entities, and the stable globals;
  - POOL-CONTROLLER.md « Local touch panel »: how to use it.

### S5: controller page and mock
- [ ] `webui/app.js`: « Controller settings » › « Screen » (« Réglages contrôleur » › « Écran »), shown only when the panel's entities exist:
  - Panel Language, shown as language names;
  - Panel Sleep After;
  - Panel Ignored Touches.
- [ ] Setup wizard: when Panel Language exists, finishing the wizard sets it to the page's language.
- [ ] `webui/esphome-hass.js` `E`: the new entities, so they aren't listed under « Other entities ». History Import stays off the page.
- [ ] Mock:
  - a `--panel` flag in `tools/webui-mock/` adds the panel's entities;
  - `make mock-ui-check` reads `pool-controller-s3.yaml` too.
- [ ] The page's keys in en, fr and es. Mock screenshots with and without the panel, in each language, at 390 px.
- [ ] Done when `make webui-test`, `make mock-ui-check` and `make i18n-check` are green, with screenshots in the PR.
- [ ] **Docs:**
  - the `app.js` header comment;
  - POOL-CONTROLLER.md « Local web UI »;
  - the mock's flag in README.

### S6: History Import (every build)
- [ ] `history-import.yaml`, included by `pool-controller.yaml`, and `history_import.h`, tested in `tools/tests/history_import_test.cpp`:
  - the contract's lines and codes;
  - writes the 7-day record and today's running values;
  - refuses a whole line on any error, and never overwrites newer days;
  - republishes Daily History, Daily Plan History, Daily Outdoor History and today's sensors.
- [ ] Round trip: every string the firmware's own lambdas print parses back to the same record, hours within one minute.
- [ ] Done when:
  - the tests are green;
  - on the bench S3, a `daily:` line copied from the live controller's Daily History (read-only) imports, and Daily History reads the same.
- [ ] **Docs:**
  - the package's header comment: formats, codes, the globals it writes;
  - POOL-CONTROLLER.md « Moving to a new board ».

### S7: transfer tool
- [ ] `tools/transfer/transfer.py`: the contract's `make transfer`, run in the ESPHome image with aioesphomeapi, as `tools/migrate/` does. The keys come from the environment or a file, never from the repo.
- [ ] `make transfer-test` (CI): a fake API server pair with made-up values. No real controller in CI.
- [ ] Done when A10 holds on the bench, with the live WROOM as a read-only source.
- [ ] **Docs:**
  - README « Moving a controller to a new board »;
  - the Makefile comment.

### S8: enclosure and wiring
- [ ] The box:
  - a cutout for the touch glass, 85 × 55.5 mm (or a 74 × 50 mm window);
  - M3 holes at 92 × 49.5 mm and a gasketed bezel (PETG or ASA print);
  - a 16 mm hole for the Auto button;
  - the SMA bulkhead on the side, and an M12 breather vent low on the box;
  - silica gel;
  - conformal coating on the boards, with the connectors, the U.FL, the USB ports and the buttons masked.
- [ ] The harness: relay board, probes, meter and the 5 V supply, each wire labelled.
- [ ] Done when:
  - the bench S3 runs ≥ 24 h in the closed box;
  - the RSSI meets A4;
  - photos are described in the PR.
- [ ] **Docs:** POOL-CONTROLLER.md's S3 hardware section, final: parts, pin map, antenna mod, enclosure dimensions.

### S9: burn-in, swap and go-live
- [ ] Burn-in ≥ 72 h on the bench, in its box: no reboot, the panel used daily, a clean log.
- [ ] Rollback rehearsal (A13).
- [ ] The swap, with each step dated here:
  1. Export the controller's entity ids from Home Assistant.
  2. Run `make transfer FROM=pool-controller.local TO=pool-panel-bench.local` dry, then with `APPLY=1`.
  3. Rebuild the S3 with the default `device_name` (`make ota-s3`). Power the WROOM off and keep it as it is.
  4. Move the wiring, then power on.
  5. Home Assistant: take the path rehearsed in S2. Check that the HomeKit Bridge still exposes Pump.
  6. Check A5 on the pool, A6, A7 and A11.
- [ ] Seven days in place (A12). The WROOM stays ready for a rollback until S10's release.
- [ ] Done when A4, A5, A11, A12 and A13 are ticked with dates.

### S10: publish the S3 build
- [ ] `firmware.yml` builds both configs. `tools/release/manifest.py` and its tests write the manifests per S1's finding: either one manifest with both builds, or the WROOM's at its current path plus the S3's under `firmware/s3-panel/`. Release assets are named per target.
- [ ] The S3 build's updates come on (the WROOM's defaults), with its `firmware_manifest_url` set to its own manifest.
- [ ] Install page:
  - the S3 option and what it needs (board, display, wiring), in en/fr/es;
  - no markup in the texts;
  - `{placeholders}` for links.
- [ ] Tests:
  - a bench S3 installs a newer build from a manifest served locally (`python3 -m http.server`);
  - the spare board installs from the install page served locally.
- [ ] Done when A14's local part holds. Its release part is recorded after the merge.
- [ ] **Docs:**
  - README's install section;
  - the install page's texts;
  - POOL-CONTROLLER.md « Firmware updates » (the S3's manifest).

### S11: documentation pass and final PR
- [ ] Every row of « Documentation » is ticked, and reads true against what merged.
- [ ] This plan: every WP `done`, the open questions closed.
- [ ] The final PR's description becomes the 1.16.0 release notes:
  - for WROOM users: History Import, `make transfer`, the page's « Screen » section (hidden without a panel);
  - for S3 builders: the panel, the hardware, the install.

## Documentation

- [ ] README.md:
  - building the S3 targets;
  - « Working on the panel without hardware » (preview);
  - « Moving a controller to a new board » (transfer);
  - installing the S3 build.
- [ ] POOL-CONTROLLER.md:
  - Hardware › ESP32-S3 with touch panel: parts, pin map, antenna mod, display wiring, enclosure;
  - « Local touch panel »;
  - « Moving to a new board »;
  - « Firmware updates » (the S3's manifest);
  - « Local web UI » (« Screen »).
- [ ] The install page's texts (`docs/install/i18n/`).
- [ ] Header comments:
  - `pool-controller-s3.yaml`, `local-panel.yaml`, `history-import.yaml`;
  - `panel_ui.h`, `history_import.h`;
  - `tools/transfer/`, `tools/panel-preview/`;
  - the Makefile targets.
- [ ] `.claude/rules/translations.md`: the panel under « Where text goes » (`i18n-panel/`, `panel_i18n.h` generated, no literal).

## Interactions with what's already on main

- **Translations are done on main**, so the panel is a translated surface from its first commit (`strict: true`).
- **The update gate:** an override set from the panel holds an install like any override (updates.yaml). Nothing changes there.
- **HomeKit:**
  - The Pump fan is bridged to Apple Home, and Apple Home can latch an override off (a known behaviour on this install).
  - The panel shows the resulting manual mode like any other.
  - The swap keeps the entity id, so the bridge keeps its accessory.
- **`make ota` testing pitfall:**
  - It concerns the WROOM: Auto Update reinstalls the release.
  - The S3 has updates off until S10, and the WROOM isn't flashed from this branch.
- **Another feature branch** merging first takes 1.16.0: this branch then moves to the next unreleased minor at its next sync.

## Later (not in this feature)

- Settings pages behind an optional Panel PIN, set from the page: filtration, freeze, fill alarm, probes, firmware.
- Today's plan timeline and the history charts.
- Typing on the panel: Wi-Fi join with an on-screen keyboard, location and timezone, Fill Water Import.
- A Panel Brightness setting.
- The 4.0″ 480×320 display as a drop-in option.
