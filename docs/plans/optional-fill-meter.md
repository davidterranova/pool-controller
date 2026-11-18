# Optional fill meter: turn the « Remplissage » on or off, detect the meter, alarm on long fills

Tracking document. One session per work package (WP). Planned against main at v1.6.0, after the secret-free firmware ([secret-free-firmware.md](secret-free-firmware.md), done).

## Branches

The feature lives on **`feat/optional-fill-meter`**, branched from main. Nothing reaches main, and so no release or controller update happens, until the whole feature is ready.

```
main ── feat/optional-fill-meter ──┬── feat/optional-fill-meter-f1-firmware ──┐
                                   ├── feat/optional-fill-meter-f2-card ──────┤ PRs into the feature branch
                                   ├── … f3-page, f4-ha, f5-docs ─────────────┘
                                   └── one PR into main = one release = the update
```

To claim a WP:
1. Check `gh pr list --base feat/optional-fill-meter` and the table below.
2. Branch from `feat/optional-fill-meter` as `feat/optional-fill-meter-f<n>-<topic>`. In the first commit, set its row to `in progress` with the branch name.
3. Open the PR **into `feat/optional-fill-meter`**, not main. The PR that finishes the WP sets its row to `done` and links itself.
4. Merge it once CI is green. Then the next WP that depends on it rebases onto the feature branch.

The feature branch's other rules:
- **Version:**
  - Its first commit bumps VERSION to the next unreleased minor (1.7.0).
  - release.yml's check runs on every PR, whatever its base: it fails when the card or firmware changed and VERSION is already released. So the sub-PRs pass without each bumping it.
  - If main releases 1.7.0 first (PR #46 may), the next sync of main bumps it again.
- **Keeping up with main:** merge main into the feature branch whenever main moves, at least before the final PR. Expect conflicts with PR #46 (daily plan history): it edits the same `pool-controller.yaml`, card, `webui/` and mock files.
- **Going live:**
  1. When every WP is `done`, open one PR from `feat/optional-fill-meter` into main (release notes: see F5).
  2. When it merges, release.yml releases the version.
  3. Controllers then see it through their Firmware update entity, or install it automatically with Auto Update.
  4. HACS offers the card.
- **Mid-feature testing:** test a controller from the feature branch with `make ota` (development build), never through a release.

## Why

The fill-line water meter (AJN15TI, reed switch on `water_meter_pin`, GPIO33) is wired on this install, but not every pool has one. Today the firmware always counts it, and both widgets always show « Remplissage ». The meter should be optional:

- **Enable or disable it** from two places:
  - the controller's own page (Avancé › Réglages);
  - Home Assistant's device page (Settings › Devices › ESPHome › Pool Controller › Configuration). Not from the card.
- **When it is enabled:**
  - « Détecter le compteur » checks that the meter is wired and counting;
  - « Remplissage » shows in both widgets: the HA card and the controller's page;
  - a fill that runs longer than a set time (1 h by default) raises an alarm in Home Assistant. The time is set from the same two places.
  - The alarm repeats every 15 min until someone acknowledges it.
  - The card's status light turns amber and pulses while the alarm is on.
- **When it is disabled:** detection, « Remplissage » and the alarm are hidden everywhere, and nothing is counted.

## What « detect » means here

The meter is a passive dry contact with a pull-up, so it has no address. It also reads the same whether it is unplugged or just idle. The only proof it is wired is a pulse.

Detection is a **pulse test**:
1. Press « Détecter le compteur »: the controller starts listening.
2. Open the fill tap.
3. The controller reports `detected` once it counts `FILL_DETECT_LITRES` (3 L) within `FILL_DETECT_WINDOW` (5 min), or `not_detected` when the window ends.

Requiring 3 L, not one pulse, rules out a single bounce or glitch: at this tap's ~15 L/min the test passes in about 12 s. A **last pulse** time is also kept, so a meter that has gone quiet for weeks can be spotted without running a test. The pin stays a compile-time substitution: in the generic firmware it is part of the hardware's wiring, like the relays.

## Decisions

- **Default: on** (`RESTORE_DEFAULT_ON`): the first boot of a firmware with the switch keeps counting, so this install sees no change after the OTA. A new install without a meter turns it off once: the setup wizard asks (see « Interactions »).
- **Disabled means nothing counts.**
  - The pulses are ignored, so Fill Water Today doesn't grow.
  - The flow, volume and Fill Water Today read `unknown` (NaN), not 0.
  - A day closed while disabled is stored as unknown (`-` in Fill Water Days), not 0 L, so the 30-day chart doesn't show a fake dry spell.
  - Turning the meter off mid-fill ends Fill Running and clears the alarm and its acknowledgement.
- **Entities stay declared.** ESPHome can't remove entities at runtime, so HA keeps listing them on the device page, reading `unknown`. Hiding happens in the widgets and the dashboard.
- **« Fill running »:**
  - A fill starts with the first pulse after at least `FILL_GAP` (5 min, the same as pulse_meter's `timeout`) without one.
  - It runs while pulses keep arriving less than `FILL_GAP` apart.
  - The alarm turns on once a fill has run for Fill Alarm After minutes.
  - A slow leak at less than 1 L per 5 min isn't « running ».
  - The clock is `millis()`, like Manual Override's, so it survives a dead SNTP server and restarts on reboot.
- **Fill Alarm After = 0 turns the alarm off.**
- **The alarm lives on the controller**, so it works without HA (the controller's page shows it too).
  - It is a `device_class: problem` binary sensor, Fill Running Too Long.
  - The repo ships a generic blueprint that turns it into notifications: no entity id of this install, only entities and actions picked from selectors, like the rest of `home-assistant/`.
- **Acknowledgement is held on the controller**, so every place agrees on it.
  - Acknowledge Fill Alarm (button) sets Fill Alarm Acknowledged (binary sensor) until the fill ends.
  - It can be pressed from any of four places:
    - the card's banner;
    - the controller page's banner;
    - HA's device page;
    - the « Acquitter » action of the phone notification.
  - The alarm itself (Fill Running Too Long) stays on while the fill goes on. Acknowledging only stops the reminders and the light's pulse.
  - The next fill that runs too long alarms again.
- **Repeat: every 15 min** (the blueprint's `repeat` input, default 15) while the alarm is on and not acknowledged, then an optional « all clear » when it ends. Each reminder replaces the last (same notification `tag`), and acknowledging or the fill ending clears it from the phone.
- **Status light:**
  - The card's controller light (tile and panel header) goes **amber and pulses** while the alarm is on and not yet acknowledged.
  - Order: red (controller lost) > **amber pulsing (fill alarm)** > amber (quiet or briefly offline) > green.
  - While pulsing, the header line reads « Remplissage depuis 1 h 12 », and the light's button opens « Remplissage » instead of « Avancé › Contrôleur ».
  - Once acknowledged, the light goes back to its usual health colour; the banner stays (« acquittée ») until the fill ends.
  - With `prefers-reduced-motion` the card's global rule stops the animation: steady amber.
- **HA card:**
  - The « Réglages » tab gets no fill rows (as asked).
  - The `settings` variant gains a `fill_settings: true` option that adds them, set only by the controller's page.
  - The dashboard's settings component leaves the option off.
- **Older firmware:** a card or page reading a firmware without the switch (entity missing) behaves exactly as today, with « Remplissage » shown when the meter's entities are there and no fill alarm. So the card can ship before or after the firmware.

## Entity contract

Agreed up front, so the card, the page and the mock can proceed before the firmware. Names are the ESPHome `name`s; HA's ids follow from the device name (fresh install: `pool_controller_…`). They are new web_server sorting group `grp_fill` « Fill Meter ».

| Name | Type | Category | Notes |
|---|---|---|---|
| Fill Meter | switch (template, optimistic) | config | `restore_mode: RESTORE_DEFAULT_ON`; off clears Fill Running, Too Long, Acknowledged and the detection |
| Fill Alarm After | number (min, 0–1440, step 5, box) | config | default 60, `restore_value: true`, 0 = no alarm |
| Detect Fill Meter | button | config | starts the pulse test; ignored (logged) while the meter is off |
| Fill Meter Status | text_sensor | diagnostic | `off`, `untested`, `listening`, `detected`, `not_detected` |
| Fill Meter Last Pulse | text_sensor | diagnostic | local `YYYY-MM-DD HH:MM`, `--` never / no clock |
| Fill Running | binary_sensor | — | `device_class: running` |
| Fill Running Too Long | binary_sensor | — | `device_class: problem` |
| Acknowledge Fill Alarm | button | — | a control, not a setting; ignored (logged) with no alarm on |
| Fill Alarm Acknowledged | binary_sensor | — | on from the press until the fill ends (or the meter is turned off, or a reboot) |

Unchanged but now conditional: Piscine - Débit remplissage, Piscine - Volume total remplissage, Fill Water Today read `unknown` while the meter is off. Fill Water Days and Fill Water Months keep their history, and disabled days are `-`.

The detection result (`detected`, plus when) is kept in a restored global (`fill_meter_detected_at`, epoch seconds, 0 = never), so the status survives a reboot. A global's NVS key is the md5 of its id, and the switch's key is derived from its name, so **neither may be renamed later**: see the rule in [secret-free-firmware.md](secret-free-firmware.md).

## Status

| WP | What | Depends on | Branch | Status | PR |
|---|---|---|---|---|---|
| F1 | Firmware: switch, alarm + acknowledgement, detection, gating of the counters | — | | todo | |
| F2 | Card: hide « Remplissage », alarm banners, pulsing light, `fill_settings` rows | contract above | | todo | |
| F3 | Controller's page + mock: tab, Capteurs rows, Réglages, banner | contract; F1's YAML for the mock | | todo | |
| F4 | HA side: blueprint, dashboard, `ha-dashboard-check` | F1 (ids for `ha-dashboard-check`) | | todo | |
| F5 | Documentation pass: every file in « Documentation » below agrees with what merged | F1–F4 merged | | todo | |

| — | Feature branch: plan + VERSION 1.7.0 | — | feat/optional-fill-meter | in progress | (draft PR into main) |

F2 can start right away. F3 can start right away on the mock, once F1's entity declarations are pushed; it doesn't need F1's logic. F4 comes last, or alongside F1. Each WP updates the docs for what it changes (its « Docs » items). F5 is a final read-through across all of them, plus the cross-references.

The compatibility rule above makes any merge order into the feature branch safe.

## Work packages

### F1: firmware (`pool-controller.yaml`)
- [ ] `grp_fill` sorting group, and the contract entities with `entity_category` as listed: config ones appear under « Configuration » in HA's device page
- [ ] globals:
  - `fill_last_pulse_ms`, `fill_started_ms` and `fill_alarm_acked` (not restored);
  - `fill_last_pulse_epoch` (restored, for Last Pulse across reboots);
  - `fill_meter_detected_at` (restored);
  - `fill_detect_until_ms` and `fill_detect_litres` (not restored)
- [ ] `total.on_value`:
  - return early while Fill Meter is off;
  - otherwise stamp the last pulse (ms and epoch);
  - open a fill when the gap since the previous pulse was at least `FILL_GAP`;
  - add the litres to the running detection;
  - then count `fill_today` as now
- [ ] flow, volume and Fill Water Today: a `lambda` filter (or a check in the template's lambda) that returns `NAN` while off
- [ ] the existing 30 s `interval:`:
  - close a fill after `FILL_GAP` without a pulse, which also clears the acknowledgement;
  - update Fill Running and Too Long;
  - end a detection window (`not_detected`);
  - publish only on change, so the recorder isn't flooded
- [ ] Detect Fill Meter: status `listening`, arm the window; `detected` as soon as `FILL_DETECT_LITRES` are counted (stamp `fill_meter_detected_at`)
- [ ] Acknowledge Fill Alarm: sets `fill_alarm_acked` only while Fill Running Too Long is on
- [ ] midnight close in `filtration_accrue`: a day closed while off goes into Fill Water Days as `0xFFFF` and adds nothing to the month
- [ ] Fill Meter `on_turn_off`: clear running, too long, acknowledged and the detection window; publish NaN. `on_turn_on`: status `untested`, or `detected` if `fill_meter_detected_at` is set
- [ ] each step logged (`fill:` tag): fill start and end with litres and duration, alarm on/off, acknowledged, detection result
- [ ] the update gate (`updates.yaml` `update_gate`):
  - it reads Fill Running instead of `piscine_debit.state > 0`, so an install waits for the same fill the alarm sees;
  - while the meter is off nothing blocks an install;
  - `pool_updates::gate_blocker` takes a bool;
  - `tools/tests/updates_test.cpp` covers it
- [ ] constants `FILL_GAP` (5 min), `FILL_DETECT_LITRES` (3) and `FILL_DETECT_WINDOW` (5 min) sit next to the other literal thresholds
- [ ] `make validate`, `make build` (note the flash % in the PR), `make mock-ui-check`
- [ ] **Docs:** the POOL-CONTROLLER.md and README.md items for F1 in « Documentation »; YAML comments on each new entity and global, in the file's style (what, why, and what it guards against)

### F2: card (`home-assistant/piscine-card.js`)
- [ ] `DEFAULT_ENTITIES` gains:
  - `fillEnabled`, `fillAlarmAfter`, `fillDetect`, `fillStatus`, `fillLastPulse`, `fillRunning`, `fillTooLong`, `fillAck`, `fillAcked`;
  - this install's ids, like the rest (the known leftover coupling)
- [ ] `_fillOff()`: true only when `fillEnabled` exists and is `off`. While it is true:
  - `shown.water` is false in `_updatePanel` (tab hidden; a selected tab falls back to « Pompe »);
  - `variant: water` hides its host (`display:none`, `getCardSize` 0);
  - the fill rows of `fill_settings` are hidden except the switch
- [ ] alarm banners, while `fillTooLong` is on:
  - an `.alert` on « Pompe » next to stuck/plan: « Remplissage en cours depuis plus de N min » with the start time, and an « Acquitter » button (`button.press` on `fillAck`);
  - the same at the top of the water pane;
  - once `fillAcked`, the button gives way to « Alarme acquittée »
- [ ] **status light:**
  - `_light()` returns `h: "alarm"` when `fillTooLong` is on and `fillAcked` isn't, unless the controller is `lost`;
  - `.led.alarm` / `.clink.alarm`: `--c: var(--amber)` plus a continuous pulse (`@keyframes fillpulse`, ~1.6 s, the dot scaling and its ring fading out, like `ping` but looping);
  - no heartbeat ping while pulsing;
  - tooltip and header text « Remplissage depuis … »;
  - the button opens « Remplissage » while `alarm`;
  - the tile's dot follows (it shares `_renderLight`)
- [ ] water pane: « En cours depuis HH:MM » under Débit while `fillRunning` is on
- [ ] settings variant, `fill_settings: true`, adds a « Compteur d'eau · immédiat » section:
  - a **switch row** (new row type: a toggle calling `switch.turn_on/off`; on the device page, POST `switch/…/turn_on`);
  - shown only when on: « Détecter le compteur » (button row, status as its sub-line: « Détecté le … », « À l'écoute : ouvrez le robinet de remplissage… », « Aucune impulsion en 5 min : vérifiez le câblage »), dernière impulsion, and « Alarme après » (number row, « 0 = jamais »)
- [ ] the panel's « Réglages » tab does **not** pass `fill_settings`
- [ ] VERSION bump
- [ ] **Docs:** the card's header comment (the options, the hidden tab, the alarm, the light's new state and its order); the README.md « Home Assistant card » items in « Documentation »

### F3: controller's page (`webui/`) and the mock
- [ ] `esphome-hass.js` `E`: the nine contract entities, so they aren't listed under « Autres entités »
- [ ] `esphome-hass.js`: `switch` turn_on/off and `button.press` through `callService` (check both domains are mapped)
- [ ] `app.js`:
  - `TABS` and `route()` drop « remplissage » while Fill Meter is `off` (nav link hidden; `#remplissage` falls back to « Contrôle »), re-evaluated on change;
  - Capteurs internes: Débit and Volume rows hidden while off (a `hidden` predicate on `valueRow`);
  - Réglages: the settings variant gets `fill_settings: true` and the fill entities;
  - `#alerts`: a banner while Fill Running Too Long is on, with « Acquitter » (works with HA down)
- [ ] setup wizard (`webui/setup.js`, `setup-model.js`):
  - step 4 « Sondes » gains a « Compteur d'eau » block: « J'ai un compteur » runs the pulse test, « Pas de compteur » turns Fill Meter off;
  - not a Setup State item, so it never blocks « configured » and `SETUP_ITEMS` is unchanged;
  - `webui/test/setup-model.test.mjs` covers any new model logic
- [ ] Contrôleur › Réinitialiser:
  - the factory reset is selective, so the fill meter settings are **kept** with the others;
  - its « Restent » list names them: « les réglages (filtration, hors gel, compteur d'eau, mises à jour) »;
  - check that `device_settings.h`'s erase doesn't touch the new globals
- [ ] the page's card keeps `controller_light: false` (its header chip is the page's own link)
- [ ] `tools/webui-mock/mock_server.py`:
  - simulate the switch;
  - Detect: `listening`, then `detected` after a simulated fill of ~20 s;
  - the running, too-long and acknowledged sensors, and the Acknowledge button: a `--long-fill` flag runs a fill past Fill Alarm After;
  - `MOCK_FILL=off` starts with the meter off;
  - `make mock-ui-check` passes
- [ ] screenshots of both states (on/off) and of the alarm, before and after « Acquitter », in the PR
- [ ] **Docs:** the `app.js` header comment (the tab is conditional); the README.md « The device's page » and POOL-CONTROLLER.md « Local web UI » items in « Documentation »; the mock's flags in README.md « Working on the web UI without flashing » and the Makefile comment for `mock-ui`

### F4: Home Assistant side
- [ ] `home-assistant/blueprints/pool_fill_too_long.yaml` (automation blueprint). Inputs:
  - `alarm`: the problem sensor (entity selector: `integration: esphome`, `domain: binary_sensor`, `device_class: problem`);
  - `acknowledged`: the acknowledged sensor;
  - `ack_button`: the acknowledge button;
  - `repeat`: minutes between reminders (number, default **15**, min 5);
  - `notify_device`: a phone (device selector, `integration: mobile_app`, optional), notified with an actionable « Acquitter »;
  - `extra_actions`: anything else on each reminder (action selector, optional);
  - `all_clear_actions`: optional, run when the alarm ends
- [ ] blueprint logic:
  - triggers: the alarm turning on; HA starting with the alarm already on (so a restart doesn't drop the reminders); the `mobile_app_notification_action` event for its action id;
  - `mode: restart`;
  - while the alarm is on and not acknowledged: notify (fixed `tag`), then `wait_for_trigger` on acknowledged or the alarm ending, with `repeat` as timeout;
  - the action event presses `ack_button`;
  - on acknowledge or end: `clear_notification` with that `tag`, then the all-clear actions when it ended
- [ ] import link (`my.home-assistant.io/create-link/?redirect=blueprint_import`) in the dashboard README
- [ ] `dashboard.yaml`:
  - the fill component gets `visibility: state switch.pool_controller_fill_meter == on`;
  - alerts gain a « ⚠️ Remplissage anormalement long » markdown card on `binary_sensor.pool_controller_fill_running_too_long`, saying whether it is acknowledged, with a button card for « Acquitter »
- [ ] `tools/ha-dashboard-check.py`:
  - passes with the new ids;
  - parses the blueprint (its `!input` tag);
  - checks the blueprint's defaults, if any, name real entities
- [ ] **Docs:** the `home-assistant/dashboard/README.md` items in « Documentation »; the comments heading the dashboard's fill and alerts components; a description and per-input help in the blueprint itself (HA shows them on import)

### F5: documentation pass
- [ ] every row of « Documentation » below is ticked, and reads true against what merged (names, defaults, French labels as the widgets show them)
- [ ] cross-references: [secret-free-firmware.md](secret-free-firmware.md) (done, so a pointer only):
  - its WP3 points here for the « Compteur d'eau » wizard block;
  - its WP6 points here for the gate waiting on Fill Running
- [ ] this plan: every WP `done`, the open questions closed or moved to an issue
- [ ] the description of the final PR into main, which becomes the release notes of 1.7.0, says how to turn the meter off and where the alarm's blueprint is

## Documentation

What each file gains. The WP named does it; F5 checks it all at the end.

| File | Section | Change | WP |
|---|---|---|---|
| POOL-CONTROLLER.md | « What it does » | the fill meter is optional; it counts fills and alarms on long ones | F1 |
| POOL-CONTROLLER.md | « Hardware » | the meter is optional; pin `water_meter_pin`; what to do without one (turn Fill Meter off) | F1 |
| POOL-CONTROLLER.md | new « Fill meter » (after « Manual Override timeout and alert ») | enabling and disabling, and what « off » does to each entity and to the day record; the pulse test and its constants; what « running » means (`FILL_GAP`, slow leaks); the alarm and Fill Alarm After; acknowledgement and when it resets; behaviour on reboot | F1 |
| POOL-CONTROLLER.md | « First setup » | step 4's optional « Compteur d'eau » block | F3 |
| POOL-CONTROLLER.md | « Controller settings » | Fill Meter, Fill Alarm After and Detect Fill Meter: where they are (page Réglages, HA device page › Configuration), defaults | F1 |
| POOL-CONTROLLER.md | « Updates » | an install waits for Fill Running (no longer a non-zero flow); nothing waits while the meter is off | F1 |
| POOL-CONTROLLER.md | « Factory reset » | the fill meter settings are kept | F3 |
| POOL-CONTROLLER.md | « Why it doesn't depend on Home Assistant » | the alarm and its acknowledgement are on the controller; HA only notifies | F1 |
| POOL-CONTROLLER.md | « Home Assistant configuration » | the entity list: Fill Meter, Fill Alarm After and Detect under Configuration; Status and Last Pulse under Diagnostic; the alarm sensors; the blueprint | F1, F4 |
| POOL-CONTROLLER.md | « Suggested dashboard cards » | the fill section's visibility condition; the alarm card | F4 |
| POOL-CONTROLLER.md | « Local web UI » | the « Remplissage » tab is conditional; the fill rows in Réglages; the alarm banner | F3 |
| README.md | intro (feature list) | the optional fill meter with its alarm | F1 |
| README.md | « Home Assistant card » | « Remplissage » hidden while the meter is off; the alarm banners; the light's pulsing amber and its order; `fill_settings` | F2 |
| README.md | « The device's page » | the conditional tab, the Réglages section, the banner with « Acquitter » | F3 |
| README.md | « Working on the web UI without flashing » | `MOCK_FILL=off`, `--long-fill` | F3 |
| README.md | « Installing a controller » | the wizard asks about the meter | F3 |
| README.md | « Updating firmware after the first flash » | after the update the meter stays on; turn it off if there is none | F1 |
| home-assistant/dashboard/README.md | table of files | the blueprint | F4 |
| home-assistant/dashboard/README.md | « The card as a tile with a pop-up » | « Remplissage » needs the meter on; the light pulses on a fill alarm and its button then opens « Remplissage » | F2 |
| home-assistant/dashboard/README.md | new « Fill alarm notifications » | import the blueprint (my-link), its inputs, the 15-min repeat, the actionable « Acquitter », the all-clear; where Fill Meter and Fill Alarm After are in HA (device page › Configuration) | F4 |
| home-assistant/dashboard/README.md | « Entity ids » / « What the components show » | the new ids; why the fill section hides itself | F4 |
| home-assistant/piscine-card.js | header comment | see F2 | F2 |
| webui/app.js | header comment | see F3 | F3 |
| updates.yaml | header comment | the gate waits for Fill Running | F1 |
| docs/plans/secret-free-firmware.md | WP3, WP6 | a pointer here (see F5) | F5 |

## Interactions with what's already on main

These come from the secret-free firmware, which is done.

- **Settings:** the switch and Fill Alarm After are ordinary restored settings.
  - They are kept through OTA and through the selective factory reset.
  - They don't count in Setup State: the meter is optional.
- **Setup wizard:** the « Compteur d'eau » block in step 4 « Sondes » (F3). It covers the default-on case for a new install without a meter.
- **Update gate:** waits on Fill Running rather than on a non-zero flow (F1).
- **The release itself:** this is the first feature to ship through the update path.
  - Controllers with Auto Update install it on their next scheduled check, and the gate defers the install during a fill.
  - The default-on switch means this controller keeps counting through it.
- **PR #46 (daily plan history, open):** edits the same files. Whichever merges into main first, the other resolves the conflicts. The entities don't overlap.

## Verification
- [ ] each PR: `make validate`, `make mock-ui-check`, `make ha-dashboard-check`, CI green; its « Docs » items done
- [ ] mock:
  - off: no « Remplissage » tab, no Débit/Volume rows, no detection row;
  - on: everything back;
  - `--long-fill`: banner on the page; « Acquitter » turns it to « acquittée »
- [ ] hardware (this controller, after `make ota`):
  - the switch shows under Configuration in HA's device page, on by default;
  - Fill Water Today keeps counting
- [ ] detection with the tap open → `detected` within a minute; with no water for 5 min → `not_detected`
- [ ] alarm, with Fill Alarm After set to 5 min and the tap left open:
  - after 5 min: Fill Running Too Long turns on;
  - the card's light (tile and header) pulses amber, and its button opens « Remplissage »;
  - the banners show in the card and on the page;
  - the phone gets a notification, then another every 15 min, each replacing the last
- [ ] « Acquitter » from the phone notification:
  - the reminders stop;
  - the notification is cleared;
  - the light stops pulsing;
  - the banners read « acquittée »;
  - the same from the card, the page, and HA's device page
- [ ] tap closed: the alarm clears 5 min after the last pulse, the all-clear runs, the acknowledgement resets; the next long fill alarms again
- [ ] an HA restart during an unacknowledged alarm: the reminders resume
- [ ] off from HA:
  - the card's « Remplissage » tab and the dashboard's fill section disappear;
  - the page's tab disappears too;
  - the entities read `unknown`;
  - no alarm, no pulse;
  - the next midnight stores `-`
- [ ] off from the page: HA's switch follows. Then on again: everything returns. A reboot keeps both settings.
- [ ] F5: the docs read true against the merged behaviour

## Open questions
- ~~Detection thresholds~~ 3 L within 5 min (2026-11-18).
- ~~Light during the alarm~~ amber and pulsing until acknowledged (2026-11-18).
- ~~Repeat~~ every 15 min until acknowledged (2026-11-18).
- Should the controller's own page get a pulsing light too? Not planned: it has the banner, and its header chip is the page's link to the controller rather than a health light.
