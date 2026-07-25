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
- **GPIO4** — OneWire bus for two DS18B20 temperature sensors:
  - `Pool Return Temperature` (address `0x1c3c01d075640128`)
  - `Equipment Pad Temperature` (address `0x3c2c01d0756a0328`)

  ESPHome does **not** enable GPIO4's internal pull-up for this bus — you
  need an external ~4.7kΩ resistor between the data line and 3.3V, or the
  sensors won't respond. If you rewire the bus with different DS18B20 units,
  their addresses will differ from the ones above: boot the device with a
  USB monitor attached (`idf.py monitor` or `screen /dev/cu.xxxx 115200`)
  and read the addresses it logs at startup, then update the `address:`
  fields in `pool-controller.yaml`.

- **No pump wiring on the ESP32 itself.** Speed control happens over Wi-Fi:
  the ESP32 sends HTTP requests to four networked Shelly (Gen2 RPC-API)
  relay modules, each wired to one input on the pump's control panel:

  | Relay | Config variable | Default IP | Pump terminal |
  |---|---|---|---|
  | 1 | `shelly_v1_ip` | `192.168.0.181` | DI1 — Speed V1 (Low) |
  | 2 | `shelly_v2_ip` | `192.168.0.182` | DI2 — Speed V2 (Medium) |
  | 3 | `shelly_v3_ip` | `192.168.0.183` | DI3 — Speed V3 (High) |
  | 4 | `shelly_run_ip` | `192.168.0.184` | DI4 — Run/Stop |

  These are set in the `substitutions:` block at the top of
  `pool-controller.yaml` — edit them for your own relays.

### Relay sequencing

Every speed change goes through a break-before-make sequence
(the `apply_speed` script), not a direct switch:

1. Open the Run relay, wait 500ms.
2. Open **all three** speed relays, wait 300ms.
3. Close the one relay for the target speed (skipped entirely if the target
   is "Off"), wait 300ms.
4. Close the Run relay again.

This guarantees two speed lines are never briefly closed together, and the
pump is never left running while its speed input changes underneath it.

### Network topology — check this if pump commands seem to do nothing

The ESP32 lives on the IoT VLAN; the Shelly relay IPs above are on a
separate subnet (the main LAN). For relay commands to actually arrive,
your router needs to allow traffic from the ESP32's network to wherever the
Shellys really are — IoT VLANs are commonly locked down from the main LAN
by default. Failures here are silent from the device's perspective: each
relay script only logs `relay_vX command failed` and moves on, so if the
pump never responds, check the boot/runtime log for that message before
assuming it's a wiring or Shelly-side problem.

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
last one commanded, so the Shellys aren't re-triggered every 30 seconds for
no reason.

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
   - **Sensors**: Pool Return Temperature, Equipment Pad Temperature
   - **Text sensor**: Pump Commanded Speed — whatever the device is
     currently telling the relays (useful to confirm the schedule logic is
     doing what you expect)
   - **Numbers**: Program A/B/C Start Hour, Program A/B/C End Hour
   - **Selects**: Program A/B/C Speed, Manual Override
4. A simple dashboard card with the three programs' numbers/selects,
   Manual Override, and the two temperature sensors + Pump Commanded Speed
   covers everything you'd need day-to-day.
5. Once paired, HA's ESPHome integration can also push OTA updates directly
   — an alternative to running `make ota` from this repo.

## Changing the freeze-protection threshold

The 3°C cutoff is a literal constant inside the schedule lambda (the
`interval:` block near the bottom of `pool-controller.yaml`), not a
substitution — edit it directly there if you need a different threshold.
