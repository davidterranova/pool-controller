# Pool Controller

How the device works: what's wired to what, the control logic, and how to
set it up in Home Assistant. For repo/tooling info, see
[README.md](README.md).

## What it does

Runs a variable-speed pool pump on an autonomous daily filtration schedule —
computed on-device from water temperature and today's sunrise/sunset, not
set by hand — with a manual override and a freeze-protection rule that
always takes priority. It's designed to keep running correctly even if Home
Assistant is offline — HA is for configuration and visibility, not a
dependency for correct operation.

## Hardware

- **Board**: ESP32-WROOM (`esp32dev`, Arduino framework).
- **GPIO4** — OneWire bus for three DS18B20 temperature sensors, wired as a
  genuine daisy-chain (each sensor's leads spliced in-line between the
  previous and next, not a star/hub of separate stubs):
  - `Pool Return Temperature` (address `0x52000000518FE928`)
  - `Equipment Pad Temperature` (address `0xFF00000026007028`)
  - `Outdoor Temperature` (address `0xFC00000051AD2428`)

  ESPHome does **not** enable GPIO4's internal pull-up for this bus — you
  need an external ~3–4.7kΩ resistor between the data line and 3.3V, or the
  sensors won't respond. If you rewire the bus with different DS18B20 units,
  their addresses will differ from the ones above: boot the device with a
  USB monitor attached (`idf.py monitor` or `screen /dev/cu.xxxx 115200`),
  or `make logs` over Wi-Fi, and read the addresses it logs at startup, then
  update the `address:` fields in `pool-controller.yaml`.

  **Counterfeit sensors break the whole bus, not just themselves.** Adding
  the third sensor initially caused total bus failure (`Found no devices!`)
  regardless of wiring, pull-up value, topology, or which physical unit sat
  in that slot — but never affected the other two as long as only two were
  connected. That signature (instant, total failure the moment a third
  device joins, not gradual CRC flakiness) turned out to be a counterfeit/
  clone DS18B20 that didn't correctly implement the 1-Wire ROM-search bit-
  arbitration protocol: it can work fine alone, but corrupts reset/search
  timing for every device sharing the bus once it has to arbitrate with
  others. Swapping in a sensor from a different source fixed it outright.
  If you ever see the same symptom (2 sensors solid, 3+ instantly dead, no
  wiring fix helps), suspect the newest sensor's authenticity before
  re-wiring again.

- **Pump speed relays, driven directly via GPIO** — no networked relays,
  no Wi-Fi dependency for pump control at all. An [Elegoo 8-channel 5V
  relay module with optocoupler](https://www.amazon.fr/dp/B06XL1F53G) (or
  the functionally identical SainSmart-style board sold under other names)
  is wired straight to four ESP32 GPIOs. Only 4 of its 8 channels are used;
  the rest are spare for future projects.

  | Relay | Config variable | GPIO | Pump terminal |
  |---|---|---|---|
  | 1 | `relay_v1_pin` | `GPIO26` | DI1 — Speed V1 (Low) |
  | 2 | `relay_v2_pin` | `GPIO25` | DI2 — Speed V2 (Medium) |
  | 3 | `relay_v3_pin` | `GPIO14` | DI3 — Speed V3 (High) |
  | 4 | `relay_run_pin` | `GPIO27` | DI4 — Run/Stop |

  These are set in the `substitutions:` block at the top of
  `pool-controller.yaml` — edit them if your wiring uses different GPIOs.
  Each relay is wired to its channel's `COM`/`NO` contacts, not `NC` — if
  the ESP32 loses power or crashes, every relay de-energizes back to open,
  matching the pump's default "everything off" state rather than leaving a
  speed or run signal latched active.

  Two things about this board that aren't obvious from a datasheet skim:

  - **Active-LOW trigger.** Pulling an `IN` pin to GND *closes* that relay;
    driving it HIGH keeps it open — backwards from what most people expect.
    That's why every `switch:` entry for these relays has `inverted: true`
    on its pin — ESPHome's `switch.turn_on` still means "logically on" from
    there.
  - **JD-VCC jumper.** A jumper cap bridges `VCC` and `JD-VCC` on the
    board. Leave it in place — bridged, one 5V feed (shared with the
    ESP32's own supply) powers both the opto-isolator side and the relay
    coils. Removing it allows powering them from separate supplies for
    full galvanic isolation, which isn't needed here since these relays
    only switch the pump's low-voltage DI lines, never mains.

  These four switches are `internal: true` in the config — no HA entity is
  created for them. They're only ever driven through `apply_speed`'s
  break-before-make sequencing below; exposing them individually in HA
  would let someone bypass that sequencing by accident.

### Relay sequencing

Every speed change goes through a break-before-make sequence
(the `apply_speed` script), not a direct switch:

1. Open the Run relay, wait 500ms.
2. Open **all three** speed relays unconditionally — including when the
   target is "Off" itself, so switching to Off can't leave whatever speed
   was previously selected still energized.
3. If the target isn't "Off": wait 300ms, close the one relay for the
   target speed, wait 300ms, then close the Run relay again.

Each speed branch also clears the other two relays itself, redundant with
the unconditional step above — the "never two speed relays on at once"
guarantee holds within each branch on its own, not dependent on remembering
a preceding step elsewhere in the script. Combined with the break-before-make
sequencing, the pump is never left running while its speed input changes
underneath it either.

Manual Override changes apply immediately (an `on_value:` trigger executes
the same evaluation the 30s interval runs), rather than waiting for the next
polling tick — the 30s interval still exists for the freeze-protection and
schedule checks, which have no "changed" event of their own to react to.

## Location & clock

The autonomous filtration schedule needs today's sunrise/sunset and true
local midnight, so three more values live in `secrets.yaml` (not
`pool-controller.yaml` itself — together they reveal the pool's approximate
location, unlike the relay-pin substitutions which are just wiring choices):

- `pool_latitude` / `pool_longitude` — decimal degrees, used by ESPHome's
  `sun:` component to compute today's sunrise/sunset.
- `pool_timezone` — an IANA zone name (e.g. `"Europe/Paris"`), used by the
  `time:` component.

**This also fixes a pre-existing bug.** Before this, `time:` had no
`timezone:` set at all, so the device's clock ran in plain UTC — no error,
no warning, just silently wrong outside the UTC timezone. If the pool isn't
in UTC, the old Program A/B/C schedule was actually running at your
programmed hour *plus your UTC offset*, not local wall-clock time. Setting
`pool_timezone` fixes this going forward.

## Control logic

Re-evaluated every 30 seconds, highest priority wins:

1. **Freeze protection** — if `Pool Return Temperature` drops below 3°C,
   force `Low` speed. This overrides everything else, including manual
   override, unconditionally.
2. **Manual Override** (select, HA-editable) — if set to anything other
   than `Auto`, forces that speed. It **ends on its own** after **Manual
   Override Timeout** minutes (number, HA-editable, default 60, step 5, up
   to 480): on the next 30-second tick past the deadline the controller puts
   the select back to `Auto` itself, with or without Home Assistant. Setting
   the timeout to `0` makes the override open-ended again — then only a hand
   or a reboot returns it to `Auto` (see *Why it doesn't depend on Home
   Assistant* below). The timeout applies to every way of setting an
   override, not just the select: the `Pump` fan entity maps a fan-off to
   Manual Override `Off`, and an Apple Home room/scene "off" once did
   exactly that and parked the pump for 16 hours across a night and the
   following morning — with the timeout non-zero, that override would have
   expired. Picking a different speed, or editing the timeout, restarts the
   clock from that moment. **Manual Override Active** (binary sensor,
   `device_class: problem`) covers the open-ended case: it turns on once a
   timeout-`0` override has been off `Auto` for more than 30 minutes, so
   that state is visible instead of silent. See *Manual Override timeout
   and alert* below.
3. **Autonomous schedule** — computed on-device, once per calendar day, from
   water temperature and today's sunrise/sunset:
   - **Filtration hours** = `Pool Return Temperature / 2`, clamped between
     `Min Filtration Hours` and `Max Filtration Hours` (both HA-editable,
     default 2h/16h), then `Filtration Hour Offset` (HA-editable, default 0,
     up to 6h) is added on top. The offset is applied *after* the clamp, so
     it's genuinely additive — useful for pushing extra turnover (e.g.
     algae) beyond what `Max Filtration Hours` would otherwise allow, rather
     than being absorbed by that ceiling.
   - **Staged, not live**: `Min`/`Max Filtration Hours`, `Warmest Part of Day
     Offset`, and `Filtration Hour Offset` don't take effect the moment you
     change them — the schedule engine reads its own internal copy of each,
     which only updates when you press **Apply Filtration Config**. This
     guards against a fat-fingered slider drag silently reshaping today's
     plan. **Filtration Config Pending** turns on whenever one of the four
     numbers differs from what's actually applied, as a reminder to press
     Apply (or dial the number back to discard the edit). Boost Pulse
     Duration/Interval and High Boost Frequency are unaffected by this —
     they still apply instantly, since they're safe, easily-reversible live
     tweaks rather than something that reshapes the whole day's plan.
   - **Split into two blocks**: 1/3 of those hours starting at sunrise, the
     remaining 2/3 centered on `solar noon + Warmest Part of Day Offset`
     (HA-editable, default 2.5h — the real lag between solar noon and the
     day's actual warmest period is climate/location-dependent, hence
     tunable rather than fixed). If the two blocks would touch or overlap,
     they're merged into one continuous block instead, so you still get
     exactly the computed number of hours rather than double-counting the
     overlap.
   - **Boost pulse**: while a block is running, every `Boost Pulse Interval`
     (default 30 min) the pump spends the first `Boost Pulse Duration`
     (default 5 min) at an elevated speed, then drops back to `Low`. Most
     pulses run at `Medium` — the pump's power draw scales roughly with
     speed cubed, so `Medium` recovers most of the circulation benefit for a
     fraction of `High`'s energy cost — and every `High Boost Frequency`-th
     pulse (default 3, i.e. every third pulse) escalates to `High` instead,
     for a periodic stronger turnover/skim. Set `High Boost Frequency` to 1
     to make every pulse `High` (the old behavior). The boost phase is
     timed from the moment the *block itself* starts (not from whenever the
     schedule last regained control), which guarantees **every block always
     starts with a full `High` boost** — Block 1 at sunrise, Block 2 at its
     own start, or the merged block at sunrise if the two were joined —
     before settling into the Medium/High cadence for the rest of the
     block. This doesn't apply during freeze protection or manual override,
     and doesn't re-trigger if you release an override partway through an
     already-running block — the boost window stays anchored to the
     block's actual start time. Keep `Boost Pulse Duration` below
     `Boost Pulse Interval`, or the pump will stay at its boost speed for
     the whole block instead of pulsing.
   - The plan is computed **once per day and cached** — not continuously
     recalculated from the live temperature reading, which would make the
     block boundaries drift throughout the day. It's recomputed on a real
     day change, immediately when you press **Apply Filtration Config**
     (see above) to confirm an edit to one of the four schedule-shaping
     numbers, or on demand via the **Recompute Schedule Now** button, which
     re-derives the plan from the currently-*applied* tunables and the
     latest temperature reading without touching any pending, unapplied
     edits. A same-day reboot (Wi-Fi watchdog, OTA, power blip) resumes the
     already-computed plan rather than recomputing it from whatever the
     temperature happens to be at that moment.
   - **Pump Planned Speed** always reflects what this schedule alone would
     be doing right now, even while overridden or freeze-protected — compare
     it against **Pump Commanded Speed** (the real, applied value) to see
     when and why they diverge.
   - **Schedule Block 1/2 Start/End** show today's computed windows
     (`--:--` if not yet computed). If Block 2 Start equals Block 1 End, the
     blocks were merged that day — not a bug.
   - **Next Boost Start/End** show the next upcoming boost pulse (`Medium`
     or `High`, per the escalation cadence above; `--:--` if none remain
     today — the current block is over, or boost pulses are disabled via a
     zero `Boost Pulse Interval`/`Duration`).
     Recomputed every 30s tick, same as **Pump Planned Speed** — a look-ahead
     companion to it, not a stored forecast of every remaining pulse today.
   - **Next Speed Change** shows the single earliest upcoming transition —
     whichever comes first among today's remaining block starts/ends and the
     next boost pulse's own start/end (`--:--` if nothing more is scheduled
     today). If the pump is currently mid-pulse, this is the pulse's own end
     (the drop back to `Low`), not the *following* pulse's start — so it
     always answers "when does the pump's speed next change", not "when's
     the next boost". A one-entity answer to that question, instead of
     comparing **Schedule Block 1/2 Start/End** and **Next Boost Start/End**
     by hand. Like those, it reflects the autonomous plan alone and keeps
     advancing even under freeze protection or a manual override.
   - **Next Planned Speed** shows what speed that change is *to* — e.g.
     `High` for a block's opening boost, `Off` for a block ending, `Medium`
     or `High` for a mid-block boost pulse starting, `Low` for one ending
     (`--` alongside Next Speed Change's `--:--` when nothing more is
     scheduled today). Pairs with Next Speed Change so a dashboard can show
     "Next change: 14:30 → High" as one line.
   - **Last Recomputed At** shows exactly when the plan above was last
     (re)computed — the day-rollover recompute, an **Apply Filtration
     Config** press, or a **Recompute Schedule Now** press. Exists so a
     press is always confirmable even when it lands on a byte-for-byte
     identical plan (e.g. filtration hours already clamped at the same
     `Max Filtration Hours` ceiling) — that's a correct, expected no-op, not
     the button silently failing to do anything.
   - **Daily History** (diagnostic) lists, for each of the last 7 completed
     days, newest first, how long the pump actually ran and the pool's
     min/max temperature — e.g. `2026-11-13: 6.42 h 25.9/26.6 °C,
     2026-11-12: 6.70 h` — or `--` before the first midnight. The range is
     left out for a day the pump never ran long enough to measure the water
     (see Pool Water Min/Max Today below). The device closes each day into
     it at midnight, from the same tally as Filtration Hours Today, and
     keeps it across reboots (one flash write a day). A day the device was
     off, or had no clock, is missing rather than shown as zero. It exists
     for the device's own web page, which has no other way to answer "did
     it filter enough this week?".
   - **Pool Water Min Today / Pool Water Max Today** are the lowest and
     highest Pool Return Temperature since midnight, counting only readings
     taken after 10 minutes of pumping: the sensor sits on the return pipe,
     so with the pump stopped it reads the pipe cooling or warming toward
     the equipment pad, not the pool. Unknown until the pump has run 10
     minutes today; kept across reboots; closed into Daily History at
     midnight.
4. **Hot-night keep-alive** — only reached when the autonomous schedule
   above says `Off` (i.e. outside both blocks) and only overnight, before
   today's sunrise or after today's sunset: if `Pool Return Temperature` is
   still above 28°C, run at `Low` instead of stopping, rather than leaving
   the pool sitting hot and stagnant until Block 1 picks up again at
   sunrise. Below Manual Override and Freeze Protection, so explicitly
   overriding to `Off` (or anything else) still wins over this. Always
   `Low` — never a boost pulse — since boost pulses are timed from a
   block's own start and this deliberately isn't a block; the point is a
   steady overnight trickle, not a scaled-down daytime block. Checked
   against the live temperature every 30s tick (unlike the once-daily
   cached filtration-hours plan above), so it starts and stops with the
   water actually crossing 28°C rather than holding a stale verdict from
   this morning's recompute. **Pump Planned Speed** does *not* reflect this
   tier — it stays `Off` outside the blocks even on a hot night, so
   comparing it against **Pump Commanded Speed** still shows the
   divergence, the same way it already does for freeze protection and
   manual override.

A new speed is only pushed to the relays when it actually differs from the
last one commanded, so they aren't re-triggered every 30 seconds for no
reason.

## Why it doesn't depend on Home Assistant

- `api: reboot_timeout: 0s` — ESPHome's default behavior reboots the device
  if no API client (i.e. HA) connects for a while. That's disabled here on
  purpose, since this device has to keep running its schedule and freeze
  protection with or without HA.
- The schedule tunables and the autonomous schedule's cached daily plan are
  set to `restore_value: true`, so they survive a power cycle without HA
  needing to re-push anything, and without silently recomputing the day's
  plan from a different temperature mid-day.
- **Manual Override is the deliberate exception** — it always comes back as
  `Auto` after a reboot (Wi-Fi watchdog, OTA, power blip), rather than
  restoring whatever speed/Off it was last set to. This guarantees freeze
  protection and the autonomous schedule regain control on their own after
  an unattended power event, instead of the pump silently staying wherever a
  stale manual override left it until someone happens to check the
  dashboard.
  - **Its expiry is on-device too.** Manual Override Timeout is a number
    persisted on the controller and the deadline is checked against the
    device's own `millis()` clock on the 30-second interval — not an HA
    timer and automation writing `Auto` back. An HA-side timer was the first
    cut, and it guarded the pump exactly as long as HA and the Wi-Fi link
    were up: the one moment it had to act was the one moment it could be
    missing. With the clock here, HA only ever chooses the duration.
  - **This alone isn't sufficient**, because of a second interaction: the
    **Pump** fan entity (the friendlier proxy for Manual Override) has no
    restore state of its own, so it always boots into a default "off"
    state — and its `on_state` handler unconditionally syncs whatever the
    fan is showing into Manual Override, including that one-time boot-time
    "off". Left alone, that would immediately clobber Manual Override's
    `Auto` boot default a fraction of a second after it's set, before
    anyone ever sees it. `esphome: on_boot:` sets a `boot_guard_active`
    global at startup that suppresses this one specific sync for a few
    seconds, just long enough for every entity's own initial/restored
    state to settle — real user interactions with the fan afterwards sync
    normally, same as before.
  - Once the guard clears, `on_boot:` also triggers an immediate speed
    evaluation instead of waiting for the next 30-second interval tick.
    Relays always restore to off on boot, so without this, a reboot could
    leave the pump idle for up to 30 seconds even when the restored
    schedule or freeze protection call for it to be running right now.

- **A local web UI on the device itself.** `web_server:` serves
  `http://pool-controller.local/` straight from the ESP32 — every control
  and reading from the HA entities card, so the pump can still be checked
  and driven while HA or the link to it is down. See
  [Local web UI](#local-web-ui).

## Home Assistant configuration

1. **Settings → Devices & Services → Add Integration → ESPHome.** It should
   auto-discover `pool-controller.local` via mDNS. If it doesn't show up,
   add it manually — get the current IP with `make ip` from this repo.
2. When prompted for the **encryption key**, use the exact value of
   `pool_controller_api_key` from `secrets.yaml` — that's the key compiled
   into the firmware, and it has to match for HA's encrypted API connection
   to succeed.
3. Once paired, these entities show up:
   - **Sensors**: Pool Return Temperature, Pool Water Min/Max Today,
     Equipment Pad Temperature, Outdoor Temperature, Planned Filtration Hours
   - **Text sensors**: Pump Commanded Speed (what's actually applied), Pump
     Planned Speed (what the autonomous schedule alone says right now),
     Schedule Block 1/2 Start/End (today's computed windows), Next Boost
     Start/End (when the next boost pulse is coming), Next Speed Change and
     Next Planned Speed (the single next upcoming transition, whichever
     kind, and what it changes to), Last Recomputed At (proof a recompute —
     automatic or button-triggered — actually ran), Manual Override Ends
     At (the device's own deadline for the current override, full
     date+time; `--` in Auto or with the timeout at `0`)
   - **Numbers**: Min/Max Filtration Hours, Warmest Part of Day Offset,
     Filtration Hour Offset — these four are *staged*: editing one just
     updates the number itself; it doesn't reshape today's plan until
     **Apply Filtration Config** is pressed (see below). Boost Pulse
     Duration, Boost Pulse Interval, High Boost Frequency — these three
     still apply instantly, unaffected by the staging above. Manual
     Override Timeout — minutes before a Manual Override returns to `Auto`
     on its own, `0` for never; applies instantly, and editing it during an
     override restarts that override's clock from now.
   - **Select**: Manual Override
   - **Button**: Apply Filtration Config — copies the four staged numbers
     above into the schedule engine's active values and forces an immediate
     recompute; the only way those four numbers take effect. Recompute
     Schedule Now — forces an immediate re-run of the daily schedule calc
     using the current temperature reading and the currently-*applied*
     tunables (not any pending, unapplied number edits), instead of waiting
     for midnight. Update Temperature Sensors Now — forces an immediate read
     of all three DS18B20 sensors instead of waiting for their own poll
     interval; useful right before Recompute Schedule Now, so that button's
     plan is based on a fresh reading
   - **Fan**: Pump — a friendlier proxy for Manual Override (on/off +
     Low/Medium/High). Has no way to represent "Auto"; use the Manual
     Override select for that.
   - **Binary sensors**: Status — device online/connectivity, so you can
     tell "pump didn't run because the controller was offline" apart from
     "pump didn't run because the schedule said Off." Filtration Config
     Pending — on whenever a staged number above differs from what's
     actually applied, i.e. there's an edit waiting on Apply Filtration
     Config. Schedule Not Computed — on if the daily plan still hasn't been
     computed a few minutes after boot, meaning the temperature reading or
     sunrise/sunset lookup keeps failing and the pump could otherwise sit
     off indefinitely with no other warning. Manual Override Active — on
     when an open-ended Manual Override (timeout `0`) has been on something
     other than `Auto` for over 30 minutes (see below); a timed override
     never raises it, since the controller ends that one itself.
4. Once paired, HA's ESPHome integration can also push OTA updates directly
   — an alternative to running `make ota` from this repo.

### Suggested dashboard cards

**Schedule & status** — a single `entities` card (built-in, no HACS
dependency):

```yaml
type: entities
title: Pool Pump Schedule
entities:
  - entity: fan.pool_controller_pump
  - entity: select.pool_controller_manual_override
  - type: section
    label: Autonomous Schedule
  - entity: number.pool_controller_min_filtration_hours
  - entity: number.pool_controller_max_filtration_hours
  - entity: number.pool_controller_warmest_part_of_day_offset
  - entity: number.pool_controller_filtration_hour_offset
  - entity: binary_sensor.pool_controller_filtration_config_pending
    name: Config Pending
  - entity: button.pool_controller_apply_filtration_config
    name: Apply Config
  - entity: number.pool_controller_boost_pulse_duration
  - entity: number.pool_controller_boost_pulse_interval
  - entity: number.pool_controller_high_boost_frequency
  - entity: button.pool_controller_recompute_schedule_now
    name: Recompute Now
  - entity: button.pool_controller_update_temperature_sensors_now
    name: Update Temperatures Now
  - entity: sensor.pool_controller_planned_filtration_hours
  - entity: sensor.pool_controller_schedule_block_1_start
    name: Block 1 Start
  - entity: sensor.pool_controller_schedule_block_1_end
    name: Block 1 End
  - entity: sensor.pool_controller_schedule_block_2_start
    name: Block 2 Start
  - entity: sensor.pool_controller_schedule_block_2_end
    name: Block 2 End
  - entity: sensor.pool_controller_next_boost_start
    name: Next Boost Start
  - entity: sensor.pool_controller_next_boost_end
    name: Next Boost End
  - entity: sensor.pool_controller_next_speed_change
    name: Next Speed Change
  - entity: sensor.pool_controller_next_planned_speed
    name: Next Planned Speed
  - entity: sensor.pool_controller_last_recomputed_at
    name: Last Recomputed At
  - type: section
    label: Status
  - entity: sensor.pool_controller_pool_return_temperature
  - entity: sensor.pool_controller_equipment_pad_temperature
  - entity: sensor.pool_controller_outdoor_temperature
  - entity: sensor.pool_controller_pump_commanded_speed
    name: Commanded Speed
  - entity: sensor.pool_controller_pump_planned_speed
    name: Planned Speed
  - entity: binary_sensor.pool_controller_status
    name: Online
  - entity: binary_sensor.pool_controller_schedule_not_computed
    name: Schedule Not Computed
```

**Plan vs. actual, as a graph** — requires the
[ApexCharts Card](https://github.com/RomRider/apexcharts-card) (install via
HACS). Overlays what the schedule planned against what was actually
commanded, both as real recorded history:

```yaml
type: custom:apexcharts-card
grid_options:
  columns: full
  rows: auto
header:
  title: Pool Pump — Plan vs Actual
  show: true
graph_span: 24h
now:
  show: true
  label: Now
  color: "#ff5252"
apex_config:
  stroke:
    curve: stepline
  chart:
    height: 200
yaxis:
  - min: 0
    max: 3
    decimals: 0
    apex_config:
      labels:
        formatter: |
          EVAL:(val) => ["Off", "Low", "Medium", "High"][Math.round(val)] || ""
series:
  - entity: sensor.pool_controller_pump_planned_speed
    name: Planned
    curve: stepline
    transform: 'return {"Off":0,"Low":1,"Medium":2,"High":3}[x] ?? 0;'
  - entity: sensor.pool_controller_pump_commanded_speed
    name: Actual
    curve: stepline
    transform: 'return {"Off":0,"Low":1,"Medium":2,"High":3}[x] ?? 0;'
```

`grid_options: {columns: full, rows: auto}` is for a `sections`-type
dashboard view: put this card alone in a section with `column_span: 4` (or
your view's full `max_columns`) so it gets its own full-width row instead of
being squeezed into a shared one — `rows: auto` then sizes the section to
the chart's real rendered height instead of an under/over-estimated fixed
row count. `apex_config.chart.height: 200` keeps the plot itself compact;
drop it (or raise it) for a taller chart.

`graph_span: 24h` with no `span:` override is a **rolling window ending at
"now"**, not a midnight-anchored one — deliberately, after trying the
midnight-anchored version (`span: {start: day}`) first. That version's fixed
day-long window reaches hours into the future once the current time is past
midnight, and since Home Assistant has no recorded history for the future,
apexcharts-card fills that unplottable stretch with a flat line pinned to
`Off` rather than leaving it blank — visually implying "the plan says off
for the rest of the day" when it doesn't. The rolling window never asks for
data past "now", so that artifact can't happen; the tradeoff is the chart
no longer always starts exactly at midnight.

This still only ever plots what's already happened (real recorded history)
— even with the rolling window, there's no way to show the not-yet-started
remainder of today's plan as a shape. Extending it to draw the rest of
today from the Block 1/2 Start/End sensors is possible with ApexCharts'
`data_generator`, but mixing a synthetic future series with a real history
series in the same chart has a known rendering glitch in that card, so it's
left as an optional exercise rather than shipped here. For the two things
that glitch would otherwise be working around — "when's the next boost
pulse" and "when does it shut off later today" — use the **Next Boost
Start/End** and **Schedule Block 1/2 End** text sensors instead, either as
a heading badge on the chart's section or in the entities card above.
Firmware-computed, so no client-side schedule math to keep in sync with
`evaluate_speed`, and no chart-glitch risk.

Add either card via Edit Dashboard → Add Card → Manual (or any card's "Edit
in YAML"). The entity IDs above are HA's usual naming convention for this
device (both ESPHome `sensor:` and `text_sensor:` entities surface under the
`sensor.` domain in HA — there's no separate `text_sensor.` domain), not a
confirmed live read — if a row shows "Entity not available," check Developer
Tools → States (filter `pool_controller`) and fix that line, or delete and
re-add it through the visual entity picker instead.

## Local web UI

The controller serves its own page at `http://pool-controller.local/` (or
the device's IP), via ESPHome's
[`web_server`](https://esphome.io/components/web_server.html) component —
no Home Assistant involved. Log in as `admin` with
`pool_controller_web_password` from `secrets.yaml` (digest auth).

The page is our own, not ESPHome's stock one: it has the look of the Home
Assistant dashboard and runs HA's pool card unchanged (see the README, "The
device's page"). Three tabs:

| Tab | What's in it |
|---|---|
| **Contrôle** | The pool card's panel (pump state, today's plan timeline, Auto/Manuel, forced speed and duration), the temperatures with today's pool min/max, the fill-water meter |
| **Avancé** | Filtration settings with their Apply gate, today's plan in detail, the last 7 days (Daily History), the device's sensors, its live log |
| **Wi-Fi** | The connection and its statistics, joining another network, the device's clock (see "Wi-Fi and the fallback hotspot" below) |

The `sorting_groups:` under `web_server:` (Pump, Today's Plan, Filtration
Settings, Sensors, Wi-Fi) and each entity's `web_server: {sorting_group_id,
sorting_weight}` still travel with every entity; they lay out ESPHome's
stock page if you go back to it, and `make mock-ui-check` prints them.

What to know:

- **Same entities, same rules.** The page drives exactly the entities HA
  does. A Manual Override picked here goes through the select like any
  other, so freeze protection still wins, the override timeout still ends
  it, and the relays still go through `apply_speed`'s break-before-make
  sequencing. The four schedule-shaping numbers are still staged until
  Apply Filtration Config. The relays themselves are `internal: true` and
  never appear on the page.
- **Live values only, no history.** The device has no recorder, so the
  plan-vs-actual graph stays an HA thing; the page shows the current state
  and updates it live.
- **Works offline.** The page is built into the firmware (`make webui`,
  about 35 KB) and fetches nothing from the internet, so it works on the
  fallback hotspot too.
- **LAN only.** Digest auth keeps the password off the wire, but the page is
  plain HTTP — fine on a trusted home network, not something to expose to
  the internet. There's no firmware upload from the page; OTA stays on
  `make ota` / HA's ESPHome integration.
- It also exposes ESPHome's REST API and `/events` stream on the same port,
  behind the same login, if you ever want to script against the device
  without HA.

### Wi-Fi and the fallback hotspot

From [wifi-setup.yaml](wifi-setup.yaml), a package of the firmware:

- **Fallback hotspot.** After 1 minute without a Wi-Fi connection (new
  install, router down, changed password), the device opens an **open**
  network named `pool-controller` and keeps trying its own network
  meanwhile. Its page answers at http://192.168.4.1, behind the same login.
  Anyone in range can join the hotspot itself; the page, the API and OTA
  each still need their own password. A WPA2 password for the hotspot is
  one commented line in the package.
- **Joining a network from the page** (Wi-Fi tab): the device tries the new
  network for 30 s and saves it only if it connects, otherwise it stays on
  the current one. A saved network takes precedence over the one in
  `secrets.yaml`. The password is never sent back to a page or to HA.
- **Clock without internet.** On the hotspot alone there's no SNTP, so no
  daily plan (freeze protection still runs). The page sets the device's
  clock to the browser's time when it has none, and says so; `Clock
  Source` tells which it is (`SNTP`, `Browser` or `None`).
- **Reboot watchdog.** ESPHome turns `wifi: reboot_timeout` off once a
  hotspot is configured, so the package brings its own: reboot after
  15 min without Wi-Fi, unless someone is connected to the hotspot.
- Diagnostic entities, in HA too: WiFi Mode, Signal, SSID, BSSID, IP and
  MAC Address, Networks Nearby, Disconnects, Hotspot Clients, Clock Source.

## Changing the freeze-protection threshold

The 3°C cutoff is a literal constant inside the schedule lambda (the
`interval:` block near the bottom of `pool-controller.yaml`), not a
substitution — edit it directly there if you need a different threshold.

## Changing the hot-night keep-alive threshold

Same deal as the freeze-protection threshold above: the 28°C cutoff for the
hot-night keep-alive tier (see Control logic) is a literal constant in the
same schedule lambda, not a substitution — edit it directly there if your
climate calls for a different value.

## Manual Override timeout and alert

A Manual Override has one clock, the `millis()` stamp taken when the select
leaves `Auto`, and two consumers of it:

- **Manual Override Timeout** (number, default 60 min, `0` = never) — the
  *correction*. The 30-second `interval:` block at the bottom of
  `pool-controller.yaml` compares the stamp against the timeout and, once
  past it, writes `Auto` back into the select exactly as a hand would, so
  the fan display, the alert clock and Home Assistant all follow through the
  normal path. The expiry lands within 30 s of the deadline. It is not
  inside `evaluate_speed` on purpose: writing the select fires its
  `on_value`, which runs `evaluate_speed` itself, and a script can't be
  re-entered from its own lambda.
- **Manual Override Active** (binary sensor) — the *alert*, for the
  open-ended case only. It turns on once a timeout-`0` override has been up
  for 30 minutes; a timed override never raises it, since the device is
  about to end it anyway and a reminder half-way through a chosen 1 h or
  2 h run would be noise. The 30-minute delay is a literal constant in that
  binary sensor's lambda, same as the two thresholds above: short enough to
  catch an override left behind the same evening, long enough not to nag
  during deliberate hands-on work — running the pump up to `High` to vacuum
  or backwash and then putting it back to `Auto`.

The clock *restamps* whenever a different non-`Auto` speed is picked and
whenever the timeout itself is edited, so what's measured is time since the
last deliberate interaction rather than since the override chain first
started: "two more hours" set mid-override means two hours from that
moment. Because it's `millis()` and not a wall clock, it survives a dead
SNTP server, and it resets on reboot — which is correct, since a reboot puts
Manual Override back to `Auto` anyway.

The timeout number is persisted (`restore_value: true`), so whatever
duration was last chosen — from a dashboard picker or by hand — is the one
that applies to the next override, whichever entity set it.

**Manual Override Ends At** (text sensor) publishes that deadline as a
local date+time for dashboards — a "back to Auto at 18:30" line, or the
extent of the override on a day timeline — computed on the device from the
same stamp, so it can never disagree with when the expiry actually fires.
It reads `--` in `Auto`, with the timeout at `0`, or before SNTP has synced.
