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
   than `Auto`, forces that speed.
3. **Autonomous schedule** — computed on-device, once per calendar day, from
   water temperature and today's sunrise/sunset:
   - **Filtration hours** = `Pool Return Temperature / 2`, clamped between
     `Min Filtration Hours` and `Max Filtration Hours` (both HA-editable,
     default 2h/16h).
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
     (default 5 min) at `High`, then drops back to `Low`. The boost phase is
     timed from the moment the *block itself* starts (not from whenever the
     schedule last regained control), which guarantees **every block always
     starts with a full boost** — Block 1 at sunrise, Block 2 at its own
     start, or the merged block at sunrise if the two were joined — before
     settling into the interval cadence for the rest of the block. This
     doesn't apply during freeze protection or manual override, and doesn't
     re-trigger if you release an override partway through an already-running
     block — the boost window stays anchored to the block's actual start
     time. Keep `Boost Pulse Duration` below `Boost Pulse Interval`, or the
     pump will stay at `High` for the whole block instead of pulsing.
   - The plan is computed **once per day and cached** — not continuously
     recalculated from the live temperature reading, which would make the
     block boundaries drift throughout the day. It's recomputed on a real
     day change, or immediately if you edit `Min`/`Max Filtration Hours` or
     `Warmest Part of Day Offset`. A same-day reboot (Wi-Fi watchdog, OTA,
     power blip) resumes the already-computed plan rather than recomputing
     it from whatever the temperature happens to be at that moment.
   - **Pump Planned Speed** always reflects what this schedule alone would
     be doing right now, even while overridden or freeze-protected — compare
     it against **Pump Commanded Speed** (the real, applied value) to see
     when and why they diverge.
   - **Schedule Block 1/2 Start/End** show today's computed windows
     (`--:--` if not yet computed). If Block 2 Start equals Block 1 End, the
     blocks were merged that day — not a bug.

A new speed is only pushed to the relays when it actually differs from the
last one commanded, so they aren't re-triggered every 30 seconds for no
reason.

## Why it doesn't depend on Home Assistant

- `api: reboot_timeout: 0s` — ESPHome's default behavior reboots the device
  if no API client (i.e. HA) connects for a while. That's disabled here on
  purpose, since this device has to keep running its schedule and freeze
  protection with or without HA.
- All schedule state (tunables, manual override, and the autonomous
  schedule's cached daily plan) is set to `restore_value: true`, so it
  survives a power cycle without HA needing to re-push anything, and without
  silently recomputing the day's plan from a different temperature mid-day.

## Home Assistant configuration

1. **Settings → Devices & Services → Add Integration → ESPHome.** It should
   auto-discover `pool-controller.local` via mDNS. If it doesn't show up,
   add it manually — get the current IP with `make ip` from this repo.
2. When prompted for the **encryption key**, use the exact value of
   `pool_controller_api_key` from `secrets.yaml` — that's the key compiled
   into the firmware, and it has to match for HA's encrypted API connection
   to succeed.
3. Once paired, these entities show up:
   - **Sensors**: Pool Return Temperature, Equipment Pad Temperature, Outdoor
     Temperature, Planned Filtration Hours
   - **Text sensors**: Pump Commanded Speed (what's actually applied), Pump
     Planned Speed (what the autonomous schedule alone says right now),
     Schedule Block 1/2 Start/End (today's computed windows)
   - **Numbers**: Min/Max Filtration Hours, Warmest Part of Day Offset,
     Boost Pulse Duration, Boost Pulse Interval
   - **Select**: Manual Override
   - **Fan**: Pump — a friendlier proxy for Manual Override (on/off +
     Low/Medium/High). Has no way to represent "Auto"; use the Manual
     Override select for that.
   - **Binary sensor**: Status — device online/connectivity, so you can tell
     "pump didn't run because the controller was offline" apart from "pump
     didn't run because the schedule said Off."
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
  - entity: number.pool_controller_boost_pulse_duration
  - entity: number.pool_controller_boost_pulse_interval
  - entity: sensor.pool_controller_planned_filtration_hours
  - entity: sensor.pool_controller_schedule_block_1_start
    name: Block 1 Start
  - entity: sensor.pool_controller_schedule_block_1_end
    name: Block 1 End
  - entity: sensor.pool_controller_schedule_block_2_start
    name: Block 2 Start
  - entity: sensor.pool_controller_schedule_block_2_end
    name: Block 2 End
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
```

**Plan vs. actual, as a graph** — requires the
[ApexCharts Card](https://github.com/RomRider/apexcharts-card) (install via
HACS). Overlays what the schedule planned against what was actually
commanded, both as real recorded history:

```yaml
type: custom:apexcharts-card
header:
  title: Pool Pump — Plan vs Actual
  show: true
graph_span: 24h
span:
  start: day
apex_config:
  stroke:
    curve: stepline
yaxis:
  - min: 0
    max: 3
    decimals: 0
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

Note: this plots what's already happened today (real recorded history), not
the not-yet-started remainder of today's plan as a shape. Extending it to
also draw the rest of today from the Block 1/2 Start/End sensors is possible
with ApexCharts' `data_generator`, but mixing a synthetic future series with
a real history series in the same chart has a known rendering glitch in that
card, so it's left as an optional exercise rather than shipped here.

Add either card via Edit Dashboard → Add Card → Manual (or any card's "Edit
in YAML"). The entity IDs above are HA's usual naming convention for this
device (both ESPHome `sensor:` and `text_sensor:` entities surface under the
`sensor.` domain in HA — there's no separate `text_sensor.` domain), not a
confirmed live read — if a row shows "Entity not available," check Developer
Tools → States (filter `pool_controller`) and fix that line, or delete and
re-add it through the visual entity picker instead.

## Changing the freeze-protection threshold

The 3°C cutoff is a literal constant inside the schedule lambda (the
`interval:` block near the bottom of `pool-controller.yaml`), not a
substitution — edit it directly there if you need a different threshold.
