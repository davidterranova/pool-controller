# Pool Controller

How the device works: what's wired to what, the control logic, and how to
set it up in Home Assistant. For repo/tooling info, see
[README.md](README.md).

## What it does

Runs a variable-speed pool pump on a fixed schedule (three programs, each
with its own hours and speed), with a manual override and a freeze-
protection rule that always takes priority. It's designed to keep running
correctly even if Home Assistant is offline — HA is for configuration and
visibility, not a dependency for correct operation.

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

## Control logic

Re-evaluated every 30 seconds, highest priority wins:

1. **Freeze protection** — if `Pool Return Temperature` drops below 3°C,
   force `Low` speed. This overrides everything else, including manual
   override, unconditionally.
2. **Manual Override** (select, HA-editable) — if set to anything other
   than `Auto`, forces that speed.
3. **Schedule** — three programs (A, B, C), each with a `Start Hour` /
   `End Hour` (0–23) and a `Speed` (`Off`/`Low`/`Medium`/`High`), all
   HA-editable. If the current hour falls inside more than one program's
   window, the later one wins (C beats B beats A) — keep the windows
   non-overlapping in practice rather than relying on that tie-break.

A new speed is only pushed to the relays when it actually differs from the
last one commanded, so they aren't re-triggered every 30 seconds for no
reason.

## Why it doesn't depend on Home Assistant

- `api: reboot_timeout: 0s` — ESPHome's default behavior reboots the device
  if no API client (i.e. HA) connects for a while. That's disabled here on
  purpose, since this device has to keep running its schedule and freeze
  protection with or without HA.
- All schedule state (program hours/speeds, manual override) is set to
  `restore_value: true`, so it survives a power cycle without HA needing to
  re-push anything.

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
     Temperature
   - **Text sensor**: Pump Commanded Speed — whatever the device is
     currently telling the relays (useful to confirm the schedule logic is
     doing what you expect)
   - **Numbers**: Program A/B/C Start Hour, Program A/B/C End Hour
   - **Selects**: Program A/B/C Speed, Manual Override
   - **Fan**: Pump — a friendlier proxy for Manual Override (on/off +
     Low/Medium/High). Has no way to represent "Auto"; use the Manual
     Override select for that.
4. Once paired, HA's ESPHome integration can also push OTA updates directly
   — an alternative to running `make ota` from this repo.

### Suggested dashboard card

A single `entities` card (built-in, no HACS dependency) covering the
schedule, override, fan, and status in one place:

```yaml
type: entities
title: Pool Pump Schedule
entities:
  - entity: fan.pool_controller_pump
  - entity: select.pool_controller_manual_override
  - type: section
    label: Program A
  - entity: number.pool_controller_program_a_start_hour
    name: Start Hour
  - entity: number.pool_controller_program_a_end_hour
    name: End Hour
  - entity: select.pool_controller_program_a_speed
    name: Speed
  - type: section
    label: Program B
  - entity: number.pool_controller_program_b_start_hour
    name: Start Hour
  - entity: number.pool_controller_program_b_end_hour
    name: End Hour
  - entity: select.pool_controller_program_b_speed
    name: Speed
  - type: section
    label: Program C
  - entity: number.pool_controller_program_c_start_hour
    name: Start Hour
  - entity: number.pool_controller_program_c_end_hour
    name: End Hour
  - entity: select.pool_controller_program_c_speed
    name: Speed
  - type: section
    label: Status
  - entity: sensor.pool_controller_pool_return_temperature
  - entity: sensor.pool_controller_equipment_pad_temperature
  - entity: sensor.pool_controller_outdoor_temperature
  - entity: sensor.pool_controller_pump_commanded_speed
    name: Commanded Speed
```

Add it via Edit Dashboard → Add Card → Manual (or any card's "Edit in
YAML"). The entity IDs above are HA's usual naming convention for this
device, not a confirmed live read — if a row shows "Entity not available,"
check Developer Tools → States (filter `pool_controller`) and fix that line,
or delete and re-add it through the visual entity picker instead.

## Changing the freeze-protection threshold

The 3°C cutoff is a literal constant inside the schedule lambda (the
`interval:` block near the bottom of `pool-controller.yaml`), not a
substitution — edit it directly there if you need a different threshold.
