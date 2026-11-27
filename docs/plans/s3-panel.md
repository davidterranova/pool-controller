# ESP32-S3 controller with a touch panel: run the pool from the box, without a phone

Tracking document. One session per work package (WP).
- Planned against main at v1.15.1 on 2026-11-25.
- Re-planned the same day: VERSION 2.0.0, and three hardware phases. Main was at v1.16.0 by then.
- Re-planned on 2026-11-26 so the screen comes last in phase 1: the board, the Auto button and the whole panel's software go ahead without it, and only S6 waits for the display. Main was at v1.17.0.

## Phases

The feature grows on the bench in three hardware phases, then ships. Each phase ends with a **milestone**: its acceptance criteria are checked before the next phase wires anything new. Software-only WPs (marked « any time ») can run ahead of their phase.

Within phase 1, the display is wired last. Until then the panel is built and checked in the preview, and the board runs it with no screen attached.

| Phase | On the bench | Milestone | WPs |
|---|---|---|---|
| **1. Software, screen and Auto button** | The S3 board and the Auto button first (S2), the display last (S6). The relay, probe and meter pins stay unconnected | **M1:** the panel drives the controller's pump mode in three languages, Auto button included, seen on the controller's page and in the log | S1–S6 |
| **2. Relays** | + the relay board (contacts free or on LEDs) and one DS18B20, so the schedule and freeze protection have a temperature | **M2:** the S3 switches the relays exactly as the WROOM does: order, boot safety, schedule, override expiry, freeze protection | S7 |
| **3. Full install with water metering** | + the three probes, the water meter and the box; then the swap on the pool | **M3:** the S3 runs the pool for seven days, settings and histories carried over, Home Assistant unchanged | S8–S11 |
| **Release** | — | **2.0.0:** the S3 build published beside the WROOM's | S12–S13 |

## Branches

The feature lives on **`feat/s3-panel`**, branched from main. Nothing reaches main until all three phases and the release WPs are done, so no release happens and no controller in the field updates.

```
main (1.x keeps shipping) ── feat/s3-panel (2.0.0) ──┬── phase 1: s1-target, s2-board, s3-scaffold, s4-panel, s5-page, s6-screen ─┐
                                                     ├── phase 2: s7-relays ──────────────────────────────────────────────────────┤ PRs into the
                                                     ├── phase 3: s8-history, s9-transfer, s10-install, s11-swap ─────────────────┤ feature branch
                                                     ├── release: s12-publish, s13-docs ──────────────────────────────────────────┘
                                                     └── one PR into main = the 2.0.0 release
```

To claim a WP:
1. Check `gh pr list --base feat/s3-panel` and the Status table below.
2. Branch from `feat/s3-panel` as `feat/s3-panel-s<n>-<topic>`. In the first commit, set its row to `in progress` with the branch name.
3. Open the PR **into `feat/s3-panel`**, not main. The PR that finishes the WP ticks its done-when boxes, sets its row to `done` and links itself.
4. The user merges it once CI is green, or lets Claude merge it by saying so in the PR. Then the WPs that depend on it merge the feature branch in.
5. The PR that completes a phase also ticks that phase's milestone criteria, with their evidence.

The feature branch's other rules:
- **Version: 2.0.0.**
  - It's a major release: the product gains a second hardware target and a new surface. Nothing is renamed or removed for WROOM users.
  - Main keeps shipping the WROOM's 1.x features and fixes meanwhile (1.16.0 on 2026-11-25, then 1.16.x, 1.17…). They never collide with 2.0.0.
  - Every merge of main into this branch conflicts on the card's `const VERSION` line: keep `2.0.0`.
  - release.yml's check runs on every PR, whatever its base. It passes the WP PRs while 2.0.0 is unreleased.
- **Keeping up with main:**
  - Merge main into the feature branch whenever it releases, and always before the final PR. Then each open WP branch merges the feature branch in.
  - User-facing text a merge brings in is translated in that merge (`.claude/rules/translations.md`).
  - A 1.x change to `pool-controller.yaml` reaches the S3 build automatically, through the package include.
- **The live controller is read-only:**
  - Until the swap (S11), nothing on this branch is flashed to the pool's WROOM.
  - Tools may read it (S9's dry run), never write to it.
  - Every S3 build before S11 runs as the **bench** device: `make … BENCH=1` names it `pool-panel-bench` (`pool-panel-bench.local`), so it never clashes with `pool-controller.local`.
- **The bench S3 never fetches the WROOM's update:** the S3 build ships with Auto Update off and Update Check Interval `on_request` until S12 gives it its own manifest. ESPHome only checks that version strings differ (see [page-login.md](page-login.md)'s testing pitfall).
- **Mid-feature testing:**
  - The bench S3: `make flash-s3 BENCH=1` (USB) or `make ota-s3 BENCH=1`.
  - The panel without hardware: `make panel-shots` (S3).
  - The page: the mock (`make mock-ui`, S5).
  - Never through a release.
- **Going live:**
  1. When M1, M2 and M3 are reached and S12–S13 are `done`, open one PR from `feat/s3-panel` into main. Its description is the release notes (S13).
  2. Its merge releases **2.0.0**. WROOM controllers get History Import and the page's « Screen » section, hidden without a panel. CI publishes the S3 build and its manifest. HACS offers the card.
  3. The user merges it.

## Why

Without a phone or a computer, nothing at the box shows the pump's state or lets anyone change it. At the box, with no phone, a person needs to:
- switch between Auto and manual;
- in manual, choose Off, Low, Medium or High, **and for how long**: 30 min, 1 h, 2 h or with no time limit;
- read the three probes (water, equipment pad, outdoor);
- read the fill water.

The controller sits indoors, inside a bigger box, in a dedicated room or a crawl space. The air is humid, there is no direct sun, and nobody wears gloves to use it.

The current board (ESP32-WROOM, no PSRAM, 1.26 MB used of a 1.75 MB app slot) can't run a touch UI. An ESP32-S3 with PSRAM can, and leaves room for later pages, so the S3 becomes a second build target with a 3.5″ touchscreen. The WROOM build stays, and keeps getting its 1.x releases from main until 2.0.0 ships.

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
- **Prototype on the maintainer's pool first; publish for everyone after** it has run a pool.

**2026-11-23: the board**
- **An ESP32-S3 with 8 MB octal PSRAM and an external antenna.**
  - Wi-Fi at an equipment box is often weak: behind walls, in a crawl space, inside two boxes.
  - The new board sits behind a display's metal frame.
- **Target board: an ESP32-S3-DevKitC-1 N16R8 clone with an IPEX connector**, the one tested being Heemol's: 16 MB flash, 8 MB octal PSRAM.
  - The IPEX connector is disconnected out of the box, behind a 0 Ω resistor. It is bridged with a solder blob; a buyer reports +7 dB.
  - The module is a third-party one around a genuine Espressif ESP32-S3R8 chip. esptool reads the in-package 8 MB PSRAM from the chip's eFuses.
  - Espressif's DevKitC-1U-N8R8 is the no-rework alternative, hard to find at the time of writing.

**2026-11-25: settled with the user**
- **Display: an Elecrow DLS30035B1-compatible module** (sold as Ginobili): ST7796U over SPI, FT6336U capacitive touch on I²C, a 14-pin 2.54 mm header. Elecrow's drawing gives its dimensions (« Hardware »).
- **Moving to the new board carries the settings and the on-device histories:**
  - a transfer tool (S9);
  - a new History Import entity (S8) for the 7-day histories and today's running values;
  - the existing Fill Water Import for the fill days and months.
  - History Import goes in **every** build, since it helps any board replacement, not only this one.
- **Scope: panel v1, then publish the S3 build.**
  - Settings pages, charts and Wi-Fi join are later features (« Later »).
  - The panel shows « Fill this month » (this month's closed days plus today), not the meter's total, which restarts at 0 on every boot.
- **File layout: an S3 top-level config at the root that includes `pool-controller.yaml` as a package**, so the WROOM's files stay untouched:
  - It overrides only the board, the framework, PSRAM, the pins and the name. S1 checks that this works, else takes the smallest refactor.
  - The S3 files live at the root like the other packages. A feature branch never releases, and the final merge is the release that publishes the S3 build.
- **Panel language: a « Panel Language » select** (`en`, `fr`, `es`, default `en`). The setup wizard sets it to the page's language. The panel uses a 24-hour clock in every language, and a decimal comma in French and Spanish.

**2026-11-25: re-planned with the user**
- **VERSION 2.0.0**, a major. Main stays free for the WROOM's 1.x features and fixes. Main released 1.16.0 the same day, the version this branch first held.
- **Three hardware phases**:
  1. software, screen and Auto button;
  2. the relays;
  3. the full install with water metering, then the release.

  Each phase ends with a milestone checked on the bench before the next adds any wiring.

**2026-11-26: the screen comes last in phase 1**

The display can arrive after the board, so nothing in phase 1 waits for it but S6:
- **S2 brings up the board without a screen**: board checks, antenna, the Auto button, the full firmware as the bench device.
- **The Auto button belongs to the S3's hardware block, not to the panel.** From S2 it sets Auto with no screen at all. S4 adds waking the screen. That's the « independent of the touch controller » decision of 2026-11-21, built in from the start.
- **S4 builds the whole panel in the preview**, then runs it on the board with no screen attached. Its display and touch config is written from Elecrow's drawing: the ST7796 at 40 MHz, landscape, and no touch transform.
- **S6 wires the screen**, sets the rotation, the touch transform and the bus speed it shows, and checks the panel on it. That closes M1.
- The phases keep their order: the relays still wait for M1.

**2026-11-26: S1's spike** (ESPHome 2026.11.0b6, the Makefile's pin)
- **(a) The package override works with `pool-controller.yaml` untouched.**
  - `pool-controller-s3.yaml` includes it whole (`packages: core: !include pool-controller.yaml`). Its `esphome.includes`, `!include`s, nested packages, `components/` and `webui/dist/` resolve as they do for the WROOM, both files being at the root.
  - Substitutions set in the top-level file win over the package's (the pins, `device_name`); `-s device_name …` on the command line wins over both.
  - `!remove` drops the WROOM-only `minimum_chip_revision` and `sram1_as_iram`.
  - A list entry merges into the package's only as `id: !extend <id>`; a plain `id:` adds a second entry and the config fails (`globals:` needs `type`). The S3 file sets Auto Update's and Update Check Interval's initial values that way.
  - `esphome: build_path:` is relative to `.esphome/`: `build/pool-controller-s3` gives `.esphome/build/pool-controller-s3/`.
  - No refactor: every firmware source (`*.yaml`, `*.h`, `components/`, `webui/`) is identical to main's, so `esphome config pool-controller.yaml` is too (A2).
- **(b) ESP-IDF, not Arduino.** Both build the whole firmware with no change and no warning:

  | Framework | App (flash) | Static RAM | Build (cold toolchain) |
  |---|---|---|---|
  | ESP-IDF 5.5.6 | 1,261,599 B (15.5 % of the slot) | 123,863 B (36.2 % of 341,760) | 8 min |
  | Arduino (on IDF) | 1,277,979 B (15.7 %) | 123,347 B (36.1 %) | 6 min |

  ESP-IDF is 16 KB smaller, is what ESPHome recommends for LVGL on the S3, and the firmware uses no Arduino API. The WROOM stays on Arduino.
- **(c) An `http_request` update picks its build by `chipFamily`.** It takes the first build whose `chipFamily` equals the firmware's variant (`ESP32-S3` here, `ESP32` on the WROOM), and fails the check (« Failed to parse manifest JSON ») when none matches. ESP Web Tools picks the same way. So:
  - one manifest holding both builds works for both targets, and the WROOMs in the field ignore the S3's entry;
  - but a manifest has one `version`: with « firmware only when it changed » per target (S12), a release that rebuilds the S3 alone would show every WROOM a new version. One manifest per target avoids that. S12 decides, with this.
  - Until S12, should a bench S3 check the WROOM's manifest anyway, it finds no ESP32-S3 build and installs nothing.
- **(d) Partitions on 16 MB** (ESPHome's own table, no `partitions:` needed): otadata 0x9000 (8 KB), phy_init 0xb000 (4 KB), app0 0x10000 and app1 0x7d0000 (7,936 KB each), nvs 0xf90000 (448 KB). The app slot is 7.75 MB, so the firmware uses 15.5 % of it before LVGL. The nvs partition sits after both app slots, so `make flash-s3`'s factory image at 0x0 (1.3 MB) keeps the settings.
- **(e) `lvgl.pause` stops input: a first touch only wakes.** While paused, LVGL's touch listener hands LVGL no press (`touch_pressed_` stays false), and on release, with `resume_on_input` (on by default), LVGL resumes. No widget sees that touch. For S4:
  - resuming by touch doesn't light the backlight: do it in `lvgl: on_resume:`;
  - count ignored touches in the touchscreen's `on_touch` (the press, while still paused), not `on_release`, which runs after LVGL has resumed.
- **Static use before the panel:** 1.26 MB of flash, 124 KB of internal RAM, no PSRAM. PSRAM's size and mode show in the boot log only (S2), and its use once LVGL draws (S4).

**2026-11-26: S3, panel scaffolding**
- **Texts are checked at compile time.** `panel_ui.h`'s `T("panel.home.change")` looks the key up in `panel_i18n.h` with a `consteval` constructor: a key the header lacks doesn't build. The firmware builds with `-fno-exceptions`, so the failure is a call to an undefined function named `no_such_key_in_panel_i18n_h`, not a `throw`.
- **`panel_i18n.h` carries the panel's keys plus only the card's keys the panel uses**, by key or by `tr_prefix("prefix.", code)`. No plurals: the panel writes units (« {m} min »).
- **Formats come from the dictionaries** (`panel.fmt.*`: the decimal separator, « {value} {unit} » with a no-break space, « {h} h {m} min », « — »), so a new language needs no code.
- **Fonts:** `°` and `…` are already in `GF_Latin_Core`; only `³` is added. The generator reads the glyph sets from `tools/i18n/panel-glyphsets.json`, written from the ESPHome image's `esphome-glyphsets` (`make panel-glyphsets`).
- **The preview's scenarios are picked at run time** (`PANEL_SCENARIO`, `PANEL_LANG`; `tools/panel-preview/preview.h`), not as substitutions: a host build takes about 2.5 min, and one build serves every shot.
- **The ignored-touch burst:** 5 ignored touches within 10 min, reported once until they slow down.
- **`status.*` codes:** the card has no `status.*` keys (Update Status's codes are `card.fw.*` in the card, `page.fw.*` in the page). S4 adds the panel's own `panel.status.*` keys, or reads the card's through `tr_prefix`.
- **`local-panel.yaml`** is S3's real file (fonts, Panel Language, a placeholder home screen), not S1's stub. It names `panel_display` and `panel_touch`, so `pool-controller-s3.yaml` doesn't include it yet: S4 adds the hardware block and the `panel:` package together.

**2026-11-26: S2, the bench board**
- **The board read back** (esptool, then the bench firmware's boot log): ESP32-S3 (QFN56) rev v0.2, 8 MB embedded PSRAM, 16 MB Boya flash (quad in eFuse, DIO at boot), ESPHome's 16 MB partition table as S1's spike gave it. It came with ESP-IDF's TinyUSB console example, which holds the USB port: the first flash needs BOOT + RST by hand. After a flash, esptool's reset leaves it in download mode: press RST once.
- **No `flash_chip: boya`**, though ESPHome suggests it to save IRAM: it drops the other vendors' flash drivers, and the published S3 build must boot on any N16R8 clone.
- **The Auto button came with S4** (#92), in `pool-controller-s3.yaml`'s hardware block as this plan asks (GPIO 17, pull-up, inverted, debounced, logged under `panel`). S2 doesn't write a second one: it checks S4's on the bench.
- **The pin check** is `tools/spike/s3-pins.yaml`: every pin of the map as an input with its pull-up, touched to GND one by one. It reads the raw levels every 100 ms and logs the pins read low on a change and every 2 s, with GPIO0 (the BOOT button) as a reference that needs no wire. Its binary sensors' interrupts are a second reading.
- **Pin check, 2026-11-27: the silkscreen matches the map.** All 17 pins (12, 11, 10, 9, 8, 14, 1, 2, 21, 18, 17, 4, 5, 6, 7, 15, 16) read low in that order, one at a time, none with another. A first run saw nothing: a broken jumper wire, found by holding BOOT (`low: GPIO0`) and then 17 with another wire.
- **PSRAM: 8 MB, octal**, found and usable (`psram: Available: YES, Size: 8192 KB` with `mode: octal`). ESPHome's summary doesn't print the mode; a wrong mode would fail to find it.

## Open questions (each settled in its WP, then moved to Decisions)

- One manifest with both builds, or one per target (S12), with S1's finding (c).
- How Home Assistant keeps the entity ids across the swap (rehearsed on the bench board, then done in S11):
  - the ESPHome integration's device replacement, if it accepts a new MAC for the same name;
  - otherwise remove the old device, add the new one, and rename the ids back.
- Rotation direction and touch transform (S6), with the connector's side as the box will mount it (S10).
- Whether the board runs the LVGL build with no screen attached, with only the touch controller failed (S4). Expected: the SPI bus has no handshake, and a failed FT6336 setup marks only that component failed.
- Font sizes and their flash cost (S4). Default Panel Sleep After: 60 s (S4).

## Hardware

| Part | Choice | Phase | Notes |
|---|---|---|---|
| Board | ESP32-S3-DevKitC-1 N16R8 clone with IPEX (×2: bench and spare) | 1 (S2) | check PSRAM, flash and every pin's label at first boot (S2) |
| Antenna | IPEX→SMA bulkhead pigtail + 2.4 GHz 3 dBi dipole | 1 (S2) | bridge the antenna select resistor; bulkhead on the box's side |
| Display | Elecrow DLS30035B1-compatible, 3.5″ IPS 320×480 | 1, last (S6) | ST7796U (SPI), FT6336U (I²C), touch glass « G+F », 5 V with on-board level conversion, backlight 95 mA |
| Auto button | 16 mm momentary, stainless 316, IP67 | 1 (S2) | to GND, internal pull-up; any momentary switch will do on the bench |
| Relays | the same 8-channel opto relay board (active-low) | 2 | on the bench with free contacts or LEDs, then the pump's DI terminals in phase 3 |
| Probe (bench) | one DS18B20 + 4.7 kΩ pull-up | 2 | stands in for the pool probe on the bench |
| Probes, meter | the install's three DS18B20 and the reed-switch meter | 3 | moved from the WROOM at the swap |
| Box | the controller's box with a cutout, bezel, vent, bulkhead | 3 | see « Display » dimensions |
| Power | one 5 V supply, ≥ 2 A | 1 | S3 + display about 0.6 A at Wi-Fi peaks, plus the relay coils from phase 2 |

**Pin map (S3)**

| Signal | S3 GPIO | WROOM today | Wired in phase |
|---|---|---|---|
| Display SCK | 12 | — | 1 (S6) |
| Display SDI (MOSI) | 11 | — | 1 (S6) |
| Display SDO (MISO) | not connected | — | — |
| Display LCD_CS | 10 | — | 1 (S6) |
| Display LCD_RS (DC) | 9 | — | 1 (S6) |
| Display LCD_RST | 8 | — | 1 (S6) |
| Display LED (backlight, PWM) | 14 | — | 1 (S6) |
| Touch CTP_SDA / CTP_SCL | 1 / 2 | — | 1 (S6) |
| Touch CTP_INT / CTP_RST | 21 / 18 | — | 1 (S6) |
| Display SD_CS | tied to 3.3 V (the micro-SD slot stays empty) | — | 1 (S6) |
| Auto button | 17 | — | 1 (S2) |
| Relay V1 / V2 / V3 / Run | 4 / 5 / 6 / 7 | 26 / 25 / 14 / 27 | 2 |
| OneWire probes | 15 | 4 | 2 (one bench probe), 3 (all three) |
| Water meter | 16 | 33 (an octal-PSRAM pin on the S3) | 3 |

- Pins 10–13 are the S3's native FSPI pins, so the display bus runs at full speed.
- Spare: 13, 39, 40, 41, 42, 47. Pin 38 or 48 drives the onboard RGB LED, depending on the board's revision.
- Never used:
  - 0, 3, 45, 46 (boot straps);
  - 19, 20 (USB);
  - 26–37 (flash and octal PSRAM);
  - 43, 44 (the serial log).
- The relay pins are high-impedance at boot and the relay board's inputs float to off, so the relays stay open while the S3 starts, as they do today. Phase 2 proves it.
- In phase 1 the firmware still drives the relay pins and reads the probe and meter pins, with nothing connected. The readings stay unknown, and the panel has to show that state anyway.
- Until S6 the display's pins are unconnected too: the firmware draws to nothing, and the touch controller doesn't answer.

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
| `pool-controller-s3.yaml` | S3 top-level config: `packages:` `core: !include pool-controller.yaml` and `panel: !include local-panel.yaml`. The pin map as substitutions, `device_name` (default `pool-controller`), the `esp32:`/`psram:` overrides, and the display, touch, backlight and Auto-button hardware. The Auto button's press sets Auto here, so it works whatever the panel does | S3 |
| `local-panel.yaml` | The panel: fonts, LVGL pages, bindings, idle/wake (an Auto button press also wakes the screen), the panel's entities. It names its hardware only by id (`panel_display`, `panel_touch`, `panel_backlight`, `auto_button`), so the preview can stand in for it | S3, preview |
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
  - Five tiles: Water, Equipment pad, Outdoor, Fill today, Fill this month. The fill tiles are hidden while Fill Meter is off. A tile with no reading shows « — », as in phase 1.
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
| `pad:` | Daily Equipment Pad History's (added by S8: the contract predates that sensor) | the pad's min/max, for dates already in the record |
| `today:` | `YYYY-MM-DD filtration=<min> water=<lo>/<hi> outdoor=<lo>/<hi> fill=<L>`, optional `pad=<lo>/<hi>`, any order (`-` for unknown) | today's running values, only if the date is the device's today |

- **Outcome codes:**
  - `imported:daily:N`, `imported:plan:N`, `imported:outdoor:N`, `imported:pad:N`, `imported:today`;
  - `refused:no_clock`, `refused:format`, `refused:tag`, `refused:date`, `refused:value`, `refused:too_many`, `refused:future`, `refused:record_ahead`, `refused:not_today`.
- A refused line changes nothing.
- A `daily:` line never replaces a record holding newer days. It replaces the record's dates; the other series keep their value for a date that stays, and are unknown for a new one.
- `plan:`, `outdoor:` and `pad:` are each their series' whole truth: a record day the line leaves out becomes unknown, so the target prints the source's string exactly. A date not in the record refuses the line (`refused:date`).
- `today:` copies the source's values: `-` makes a min/max unknown and Fill Water Today 0; without `pad=` the pad's stay.
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
  - History Import (`daily`, `plan`, `outdoor`, `pad`, `today`).
- It then reads everything back and exits non-zero on any mismatch.
- It never writes to the source.
- It doesn't move, and says so at the end:
  - the passwords and the API key, which are write-only (the wizard sets them);
  - Wi-Fi;
  - the update settings, unless `--with-updates`;
  - the panel's settings.

## Acceptance criteria

Tick each one only with its evidence (PR, command, or the date of the hardware check). Each phase's milestone is reached when its block is ticked.

**M1: software, screen and Auto button (phase 1)**
- [ ] **A1 S3 build:**
  - `make validate-s3` and `make build-s3` pass locally and in CI.
  - Flash, RAM and PSRAM use noted in S1's PR.
- [ ] **A2 WROOM unchanged:**
  - `esphome config pool-controller.yaml` on the branch differs from main's only by History Import (from S8) and the version.
  - `make build` passes.
  - Its flash growth is noted in the final PR.
- [ ] **A3 Board health:**
  - On the target board, the boot log reports 8 MB octal PSRAM and 16 MB flash.
  - Every pin of the map toggles or reads as its silkscreen says.
  - The IPEX antenna's RSSI is compared with the PCB antenna's at the box's spot.
- [ ] **A4 Panel**, first in the preview against its stand-in entities (S4), then on the screen against the controller (S6):
  - Home shows the mode and the time left, agreeing with the controller's page.
  - Unconnected readings show « — ».
  - Apply writes the timeout, then the override (log), and the page follows.
  - Cancel and sleep discard the sheet.
  - A touch on a sleeping screen only wakes it.
  - The screen sleeps after Panel Sleep After.
  - The override expires back to Auto, and the panel follows.
- [ ] **A5 Auto button:**
  - returns to Auto on the board with no screen attached (S2), and still does once the panel runs (S4);
  - then with the screen awake, asleep, and with the touch flex unplugged (S6).
- [ ] **A6 Languages:**
  - `make panel-shots` gives every screen in every state (Auto, manual with a limit, manual Never, Off, fill meter off, freeze protection, no Wi-Fi, readings unknown) in en, fr and es (S4).
  - No clipped text, and the accents are drawn: in the shots (S4), then on the screen (S6).
  - `make i18n-check` passes with `panel` strict.
  - Panel Language switches the panel at once.
  - The page's « Screen » section works in the three languages (S5).

**M2: relays (phase 2)**
- [ ] **A7 Pump safety on the S3:**
  - Relays stay open while booting, flashing, restarting and losing power.
  - Break-before-make order on every speed change (LEDs, a multimeter on COM/NO, and the log).
  - Schedule, override expiry and freeze protection drive the relays as on the WROOM, freeze protection being triggered from the bench probe.
  - The panel's Water tile and the page agree.

**M3: full install with water metering (phase 3)**
- [ ] **A8 Water meter on the S3:**
  - Detect Fill Meter reports `detected`.
  - A real fill counts the same litres as the meter's dial, within 1 L.
  - Fill Running and the long-fill alarm work, and the panel's fill tiles follow.
- [ ] **A9 Radio in place:**
  - In its closed box, the S3's 24 h mean RSSI is ≥ the WROOM's at the same spot.
  - 0 Wi-Fi disconnects during the burn-in.
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

**Release**
- [ ] **A14 Published:**
  - A release build carries both firmwares, and the WROOM's manifest path is unchanged.
  - The install page installs the S3 build on a blank board (the spare).
  - An S3 controller finds and installs a newer build from its own manifest: a locally served one before the release, the real one after it.
- [ ] **A15 Tests:** green in CI:
  - `make firmware-test`, with `panel_ui_test` and `history_import_test`;
  - `make transfer-test`;
  - `make webui-test`;
  - `make mock-ui-check`;
  - `make i18n-check`;
  - `make ha-dashboard-check`;
  - `make panel-preview-check`.
- [ ] **A16 Docs:** every row of « Documentation » ticked.

## Status

| WP | Phase | What | Depends on | Branch | Status | PR |
|---|---|---|---|---|---|---|
| S1 | 1 | S3 target, Make targets, CI | — | `feat/s3-panel-s1-target` | done | [#88](https://github.com/davidterranova/pool-controller/pull/88) |
| S2 | 1 | Board bring-up without the screen: board checks, antenna, Auto button, the full firmware | S1, board delivered | `feat/s3-panel-s2-board` | in progress | — |
| S3 | 1 (any time) | Panel scaffolding: `panel_ui.h` + tests, translations pipeline, fonts, preview | contract | `feat/s3-panel-s3-scaffold` | done | [#89](https://github.com/davidterranova/pool-controller/pull/89) |
| S4 | 1 (no screen) | Panel UI (LVGL) in the preview, then on the board with no screen attached | S1, S3; S2 for the board check | — | todo | — |
| S5 | 1 (any time) | Controller page + mock: « Screen », wizard | contract | `feat/s3-panel-s5-page` | done | [#87](https://github.com/davidterranova/pool-controller/pull/87) |
| S6 | 1 | Screen on the bench: wiring, rotation, touch, the panel checked on it | S2, S4, display delivered | — | todo | — |
| S7 | 2 | Relays and a bench probe: pump safety on the S3 | M1 | — | todo | — |
| S8 | 3 (any time) | History Import (every build) | contract | `feat/s3-panel-s8-history` | in progress (bench check waits for hardware) | [#90](https://github.com/davidterranova/pool-controller/pull/90) |
| S9 | 3 (any time) | Transfer tool | S8 | — | todo | — |
| S10 | 3 | Probes, water meter, box: the full wiring on the bench | M2 | — | todo | — |
| S11 | 3 | Burn-in, swap and go-live on the pool | S9, S10 | — | todo | — |
| S12 | release | Publish the S3 build: CI, manifests, install page | M3 | — | todo | — |
| S13 | release | Documentation pass and final PR | S1–S12 | — | todo | — |

Only S6 waits for the display.
- S1, S3 and S5 need no hardware, nor do S8 and S9. S4 needs the board only for its last check.
- S2 needs the board alone.
- Suggested order for phase 1:
  - S1 first, with S3 and S5 alongside it in their own sessions;
  - S2 as soon as S1 builds;
  - S4 once S3's preview draws;
  - S6 when the display arrives.

## Work packages

### Phase 1: software, screen and Auto button

#### S1: S3 target, Make targets, CI
- [x] `pool-controller-s3.yaml`:
  - packages: `core: !include pool-controller.yaml`, plus a stub `local-panel.yaml` until S4;
  - substitutions: the pin map and `device_name`;
  - `esp32:` board `esp32-s3-devkitc-1`, `variant: esp32s3`, `flash_size: 16MB`, the framework the spike picks, with `!remove` on the WROOM-only advanced options (`minimum_chip_revision`, `sram1_as_iram`);
  - `psram:` `mode: octal`, `speed: 80MHz`;
  - Auto Update off and Update Check Interval `on_request` until S12.
- [x] Spike, with its findings recorded in Decisions:
  - (a) the package override (substitutions, `!remove`, the resolution of `esphome.includes` and `!include` from a second top-level file) leaves `pool-controller.yaml` untouched; if not, the smallest refactor, with A2's diff;
  - (b) ESP-IDF against Arduino on the S3: build both and pick;
  - (c) how `http_request` updates pick a manifest build;
  - (d) the partition table ESPHome generates for 16 MB, and the app slot size;
  - (e) whether `lvgl.pause` stops input processing, so the first touch only wakes.
- [x] Makefile: the S3 targets of the contract, with a build dir per config. Keep the WROOM targets as they are.
- [x] `validate.yml`: the secret guard on `pool-controller-s3.yaml`, `make validate-s3`, and `make build-s3` on PRs.
- [x] Done when:
  - A1 holds;
  - `esphome config pool-controller.yaml` is unchanged from main's;
  - CI is green.

  A1 holds but for its PSRAM figure: the build uses no PSRAM statically, and its size and use show on the board only (S2, then S4 with LVGL). Flash and RAM: Decisions (S1's spike) and [#88](https://github.com/davidterranova/pool-controller/pull/88).
- [x] **Docs:**
  - the header comment of `pool-controller-s3.yaml` (what it overrides and why);
  - the Makefile comments of the new targets;
  - README's build section mentions the S3 targets.

#### S2: board bring-up without the screen (hardware)
- [ ] Both boards:
  - the boot log shows the PSRAM size and mode, and the flash size;
  - a throwaway `tools/spike/s3-pins.yaml` blinks or reads every pin of the map, checked against the silkscreen. The display's pins are checked here too, with nothing on them yet;
  - results in the PR.
- [ ] Antenna:
  - bridge the 0 Ω select pad to the IPEX connector and fit the pigtail and dipole;
  - RSSI with the PCB antenna and with the IPEX one, 10 min each, at the box's spot.
- [ ] The Auto button, in `pool-controller-s3.yaml`'s hardware block (not in the panel):
  - GPIO 17, internal pull-up, inverted, debounced;
  - a press sets Manual Override to `Auto`, logged under the `panel` tag;
  - any momentary switch on the bench until the panel-mount one is fitted.
- [ ] Bench, phase 1: the board, the Auto button on 17, and the 5 V supply. Nothing on the display, relay, probe or meter pins.
- [ ] The full firmware, `make flash-s3 BENCH=1`:
  - the hotspot and the wizard;
  - the page's login;
  - a clean log, apart from the absent probes and meter;
  - a manual override set from the page, then the Auto button: the page shows Auto.
- [ ] Done when:
  - A3 holds;
  - A5's no-screen part holds.
- [ ] **Docs:** a draft of POOL-CONTROLLER.md's S3 hardware section (pin map, antenna mod, Auto button). S6 adds the display wiring, and S10 finishes it.

#### S3: panel scaffolding (helpers, translations, preview), any time
- [x] `panel_ui.h`, tested in `tools/tests/panel_ui_test.cpp`:
  - the sheet's state: staged mode and minutes, what Apply writes, the hint for each combination;
  - time left and « Auto at HH:MM » from the override's start and the timeout;
  - number and duration formats per language (decimal comma in fr/es, 24-hour clock, « — » for unknown);
  - the asleep-touch counter and its burst threshold.
- [x] Translations:
  - `i18n-panel/{en,fr,es}.json`;
  - a generator `tools/i18n/panel-header.mjs` → `panel_i18n.h`, plus `make panel-i18n`;
  - the `panel` surface in `surfaces.mjs`, with code usage, checked to see the C++ calls;
  - `make i18n-check` fails when `panel_i18n.h` is stale, as it does for the HA files;
  - « screen » in the glossary.
- [x] Fonts: Montserrat with `GF_Latin_Core` + `°³…`. The generator fails if a dictionary uses a character no font covers.
- [x] Preview (`tools/panel-preview/`):
  - a `host` + `sdl` build of `local-panel.yaml`, with stand-in entities under the firmware's ids, and scenarios picked at run time (Decisions, 2026-11-26: S3);
  - a Docker image (the ESPHome image + SDL2 + Xvfb);
  - `make panel-shots` → `tools/panel-preview/shots/<lang>-<screen>-<state>.png` at 480×320;
  - `make panel-preview-check` fails on a key shown instead of its text;
  - CI runs the check.
- [x] Done when:
  - the host tests pass;
  - the preview draws a placeholder screen in each language, in CI.
- [x] **Docs:**
  - the header comment of `panel_ui.h`;
  - README « Working on the panel without hardware »;
  - the panel in `.claude/rules/translations.md`'s « Where text goes ».

#### S4: panel UI (LVGL) in the preview, then on the board with no screen
- [ ] `local-panel.yaml`, built and checked in the preview (S3):
  - the contract's entities and LVGL pages (home, pump-mode sheet, status), bound by id;
  - `on_idle` after Panel Sleep After: backlight off and `lvgl.pause`;
  - a touch while paused only resumes and lights up;
  - the Auto button (S2) also wakes the screen;
  - a Panel Language change relabels every widget;
  - sleep discards the sheet;
  - every text from `panel_i18n.h`, with no literal.
- [ ] Display and touch in `pool-controller-s3.yaml`'s hardware block, written from Elecrow's drawing and the pin map. S6 corrects them on the screen:
  - `spi` (SCK 12, MOSI 11, no MISO);
  - `display` (ST7796, CS 10, DC 9, reset 8, landscape, 40 MHz), its LVGL buffer in PSRAM;
  - `touchscreen: ft63x6` on I²C 1/2 (INT 21, reset 18), with no transform;
  - `output: ledc` on 14 and the backlight as an internal light.
- [ ] `panel` log tag: wake, sleep, every Apply with what it wrote, the Auto button, ignored-touch bursts.
- [ ] On the bench board, with no screen attached (`make flash-s3 BENCH=1`):
  - it boots and runs LVGL, and the log shows only the touch controller failing (settles the open question; if the whole build stalls instead, the fix goes in this WP);
  - the page and the panel's entities work, and the Auto button still sets Auto;
  - flash, RAM and PSRAM use with LVGL, against S1's figures.
- [ ] Screenshots in the PR: every screen × state × language from `make panel-shots`.
- [ ] Done when:
  - A4 holds in the preview;
  - A6's preview part holds;
  - the board runs the panel build with no screen attached.
- [ ] **Docs:**
  - the header comment of `local-panel.yaml`: screens, behaviour, entities, and the stable globals;
  - POOL-CONTROLLER.md « Local touch panel »: how to use it.

#### S5: controller page and mock, any time
- [x] `webui/app.js`: « Controller settings » › « Screen » (« Réglages contrôleur » › « Écran »), shown only when the panel's entities exist:
  - Panel Language, shown as language names;
  - Panel Sleep After;
  - Panel Ignored Touches.
- [x] Setup wizard: when Panel Language exists, finishing the wizard sets it to the page's language.
- [x] `webui/esphome-hass.js` `E`: the new entities, so they aren't listed under « Other entities ». History Import stays off the page.
- [x] Mock:
  - a `--panel` flag in `tools/webui-mock/` adds the panel's entities;
  - `make mock-ui-check` reads `pool-controller-s3.yaml` too.
- [x] The page's keys in en, fr and es. Mock screenshots with and without the panel, in each language, at 390 px.
- [x] Done when `make webui-test`, `make mock-ui-check` and `make i18n-check` are green, with screenshots in the PR.
- [x] **Docs:**
  - the `app.js` header comment;
  - POOL-CONTROLLER.md « Local web UI »;
  - the mock's flag in README.

#### S6: the screen on the bench (hardware)
- [ ] Bench, phase 1 complete: the display wired per the pin map (SD_CS to 3.3 V, SDO unconnected), on the 5 V supply.
- [ ] On the screen, with the full firmware (`make flash-s3 BENCH=1`). If it stays blank, use a throwaway `tools/spike/s3-display.yaml` test pattern:
  - the landscape rotation, with the connector on the side the box will mount it, plus the colour order and inversion;
  - the touch transform (`swap_xy`/`mirror_*`), so taps land on the drawn targets;
  - SPI at 40 MHz, then tried at 80 MHz;
  - the backlight dims by PWM and goes off when asleep.
- [ ] S4's hardware block corrected with what the screen showed. The rotation, the transform and the bus speed go in Decisions.
- [ ] Against the bench controller:
  - A4, item by item;
  - A5 with the screen awake, asleep, and with the touch flex unplugged;
  - A6's on-screen part.
- [ ] One language on the bench, described in the PR.
- [ ] Done when:
  - A4, A5 and A6 hold on the screen;
  - with S1–S5 done, this PR ticks M1.
- [ ] **Docs:** the display wiring in POOL-CONTROLLER.md's S3 hardware draft.

**Milestone M1:** A1–A6 ticked. The PR completing phase 1 (normally S6's) says so here, with the date.

### Phase 2: relays

#### S7: relays and a bench probe
- [ ] Bench, phase 2:
  - the relay board on 4–7, its contacts free or on LEDs, with a multimeter on COM/NO;
  - one DS18B20 with 4.7 kΩ on 15, set as Pool Probe after Rescan Probes.
- [ ] Boot safety: relays stay open while flashing (`make flash-s3`), at power-up, on Restart, on a reset button press, and when the 5 V is cut and restored.
- [ ] Break-before-make: every speed change (Low ↔ Medium ↔ High ↔ Off, from the panel, the page and the schedule) opens the old speed relay before closing the new one, and Run only toggles to start or stop. Checked on the LEDs and in the log.
- [ ] The schedule:
  - with a short test plan (Min/Max Filtration Hours and offsets adjusted), the relays follow the planned blocks and the boost pulses;
  - Daily History closes the day at midnight.
- [ ] Override expiry: a 30 min override from the panel returns to Auto on time, and the relays follow.
- [ ] Freeze protection: Freeze Protection Temperature set above the bench probe's reading (or the probe in iced water) starts the pump, and overrides Off.
- [ ] Done when A7 holds.
- [ ] **Docs:** POOL-CONTROLLER.md's S3 hardware section: the relay wiring (same board, new pins).

**Milestone M2:** A7 ticked. The PR completing phase 2 says so here, with the date.

### Phase 3: full install with water metering

#### S8: History Import (every build), any time
- [x] `history-import.yaml`, included by `pool-controller.yaml`, and `history_import.h`, tested in `tools/tests/history_import_test.cpp`:
  - the contract's lines and codes;
  - writes the 7-day record and today's running values;
  - refuses a whole line on any error, and never overwrites newer days;
  - republishes Daily History, Daily Plan History, Daily Outdoor History and today's sensors.
- [x] Round trip: every string the firmware's own lambdas print parses back to the same record, hours within one minute.
- [ ] Done when:
  - [x] the tests are green;
  - [ ] on the bench S3 (waits for hardware), a `daily:` line copied from the live controller's Daily History (read-only) imports, and Daily History reads the same.
- [x] **Docs:**
  - the package's header comment: formats, codes, the globals it writes;
  - POOL-CONTROLLER.md « Moving to a new board ».

#### S9: transfer tool, any time after S8
- [ ] `tools/transfer/transfer.py`: the contract's `make transfer`, run in the ESPHome image with aioesphomeapi, as `tools/migrate/` does. The keys come from the environment or a file, never from the repo.
- [ ] `make transfer-test` (CI): a fake API server pair with made-up values. No real controller in CI.
- [ ] Done when A10 holds on the bench, with the live WROOM as a read-only source.
- [ ] **Docs:**
  - README « Moving a controller to a new board »;
  - the Makefile comment.

#### S10: probes, water meter and box (full wiring on the bench)
- [ ] The box:
  - a cutout for the touch glass, 85 × 55.5 mm (or a 74 × 50 mm window);
  - M3 holes at 92 × 49.5 mm and a gasketed bezel (PETG or ASA print);
  - a 16 mm hole for the Auto button;
  - the SMA bulkhead on the side, and an M12 breather vent low on the box;
  - silica gel;
  - conformal coating on the boards, with the connectors, the U.FL, the USB ports and the buttons masked.
- [ ] Full wiring, in the box:
  - the relay board;
  - the probe bus on 15, ready for the install's three probes;
  - the water meter input on 16, with the internal pull-up, as the WROOM's GPIO33 had;
  - the 5 V supply ≥ 2 A;
  - a labelled harness for the swap.
- [ ] Meter on the bench: a reed switch and a magnet (or a spare meter) count pulses, Detect Fill Meter's pulse test passes, and Fill Running and the long-fill alarm (Fill Alarm After shortened) fire.
- [ ] Done when:
  - the bench S3 runs ≥ 24 h in the closed box;
  - its RSSI at the box's spot meets A9;
  - photos are described in the PR.
- [ ] **Docs:** POOL-CONTROLLER.md's S3 hardware section, final: parts, pin map, antenna mod, enclosure dimensions, meter input.

#### S11: burn-in, swap and go-live
- [ ] Home Assistant rehearsal on the bench board:
  - add it under its bench name;
  - try the integration's device-replacement path, and record which way keeps the entity ids (Decisions);
  - remove it.
- [ ] Burn-in ≥ 72 h on the bench, in its box: no reboot, the panel used daily, a clean log.
- [ ] Rollback rehearsal (A13).
- [ ] The swap, with each step dated here:
  1. Export the controller's entity ids from Home Assistant.
  2. Run `make transfer FROM=pool-controller.local TO=pool-panel-bench.local` dry, then with `APPLY=1`.
  3. Rebuild the S3 with the default `device_name` (`make ota-s3 LIVE=1 HOST=<the bench board's IP>`: LIVE=1 lifts the guard that keeps `ota-s3` off the live controller). Power the WROOM off and keep it as it is.
  4. Move the wiring: relays to the pump's DI terminals, the three probes, the water meter. Then power on.
  5. Home Assistant: take the rehearsed path. Check that the HomeKit Bridge still exposes Pump.
  6. Check A7 on the pool, A4, A5 and A11.
  7. A8 at the first real fill.
- [ ] Seven days in place (A12). The WROOM stays ready for a rollback until the 2.0.0 release.
- [ ] Done when A8, A9, A11, A12 and A13 are ticked with dates.

**Milestone M3:** A8–A13 ticked. The PR completing phase 3 says so here, with the date.

### Release

#### S12: publish the S3 build
- [ ] `firmware.yml` builds both configs. `tools/release/manifest.py` and its tests write the manifests per S1's finding: either one manifest with both builds, or the WROOM's at its current path plus the S3's under `firmware/s3-panel/`. Release assets are named per target.
- [ ] « Firmware only when it changed » (1.17.0, `tools/release/firmware_release.py`) decides per target:
  - today every root `*.yaml` and `*.h` counts, so a panel-only change would hand every WROOM a new firmware it doesn't need;
  - the S3-only files (`pool-controller-s3.yaml`, `local-panel.yaml`, `panel_*.h`) rebuild the S3 alone, and everything else rebuilds both;
  - its tests cover both cases.
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

#### S13: documentation pass and final PR
- [ ] Every row of « Documentation » is ticked, and reads true against what merged.
- [ ] This plan: every WP `done`, the open questions closed.
- [ ] The final PR's description becomes the 2.0.0 release notes:
  - for WROOM users: what changes (History Import, `make transfer`, the page's « Screen » section hidden without a panel), and that nothing is renamed;
  - for S3 builders: the panel, the hardware, the install.

## Documentation

- [ ] README.md:
  - building the S3 targets;
  - « Working on the panel without hardware » (preview);
  - « Moving a controller to a new board » (transfer);
  - installing the S3 build.
- [ ] POOL-CONTROLLER.md:
  - Hardware › ESP32-S3 with touch panel: parts, pin map, antenna mod, display wiring, relays, meter input, enclosure;
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

- **Main keeps releasing 1.x** for the WROOM in production. Each release is merged into this branch, keeping VERSION 2.0.0. Its firmware changes reach the S3 build through the package include, and its texts are translated by then.
- **Translations are done on main**, so the panel is a translated surface from its first commit (`strict: true`).
- **The update gate:** an override set from the panel holds an install like any override (updates.yaml). Nothing changes there.
- **HomeKit and voice assistants:**
  - A bridged Pump fan can be switched off by a room or a scene.
  - The panel shows the resulting manual mode like any other.
  - The swap keeps the entity id, so a bridge keeps its accessory.
- **`make ota` testing pitfall:**
  - It concerns the WROOM: Auto Update reinstalls the release.
  - The S3 has updates off until S12, and the WROOM isn't flashed from this branch.

## Later (not in this feature)

- Settings pages behind an optional Panel PIN, set from the page: filtration, freeze, fill alarm, probes, firmware.
- Today's plan timeline and the history charts.
- Typing on the panel: Wi-Fi join with an on-screen keyboard, location and timezone, Fill Water Import.
- A Panel Brightness setting.
- The 4.0″ 480×320 display as a drop-in option.
