# esp-swimmingpool

ESPHome firmware for an ESP32-WROOM that runs a swimming pool's variable-speed
pump: a fixed on-device schedule (three programs + manual override), a
freeze-protection safety rule that always wins, and two temperature sensors —
all exposed to Home Assistant, but not dependent on it. The device keeps
running its schedule whether or not HA is reachable.

See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for how the controller actually
works: wiring, control logic, and Home Assistant setup. This file covers the
repo itself — layout and tooling.

## Repo layout

| File | Purpose |
|---|---|
| `pool-controller.yaml` | The ESPHome device config — this *is* the firmware source. |
| `secrets.yaml` | Wi-Fi credentials, API encryption key, OTA password. Gitignored — create your own (see below). |
| `Makefile` | Validate / build / flash / OTA / status tooling. |
| `.gitignore` | Excludes `secrets.yaml`, `.esphome/` (build cache), `.vscode/`. |

## Toolchain

- **Docker** — `validate`, `build`, and `ota` run the official
  `ghcr.io/esphome/esphome` image, so no local Python/ESPHome install is
  needed for those.
- **esptool** (bundled with a local ESP-IDF install) — used only for the
  initial USB flash. Docker Desktop on macOS can't pass a host USB-serial
  device through to a Linux container, so `make flash` shells out to the
  host's esptool directly instead of going through Docker.

## First-time setup

1. Create `secrets.yaml` in this directory (gitignored, never commit it):

   ```yaml
   wifi_ssid: "..."
   wifi_password: "..."
   # Must be base64-encoded, 32 random bytes:
   #   python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
   pool_controller_api_key: "..."
   pool_controller_ota_password: "..."
   ```

2. Edit the `substitutions:` block at the top of `pool-controller.yaml` —
   at minimum the four Shelly relay IPs — for your own network. See
   [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for what each one does.

3. `make validate` — parses the YAML and checks component schemas (fast, no
   compile).

4. `make build` — compiles the firmware. The first run downloads the
   ESP32 Arduino/ESP-IDF toolchain inside the container (~1GB), so budget
   several minutes; later builds are quick.

5. Plug the board in over USB and `make flash`.

6. Pair it with Home Assistant — see
   [POOL-CONTROLLER.md](POOL-CONTROLLER.md#home-assistant-configuration).

## Makefile targets

| Target | What it does |
|---|---|
| `make validate` | Parse + schema-check `pool-controller.yaml`, no compile. |
| `make build` | Compile the firmware (also catches errors inside C++ lambdas, which `validate` can't). |
| `make flash` | Rebuild, then flash over USB via esptool. Auto-detects the serial port; override with `PORT=/dev/cu.xxxx`. |
| `make status` | Query the connected board over USB: chip type, revision, MAC address. |
| `make kill-port` | Kill whatever process (a leftover `screen`/monitor session, usually) is holding the serial port open. |
| `make ota` | Rebuild, then push the firmware over Wi-Fi instead of USB. Only works once the device has already joined Wi-Fi at least once. |
| `make ip` | Resolve and print the device's current IP via mDNS. |
| `make clean` | Remove the local build cache (`.esphome/`). |

`PORT` (serial) and `HOST` (network) both auto-detect and can be overridden
on the command line, e.g. `make flash PORT=/dev/cu.usbserial-XXXX` or
`make ota HOST=192.168.4.72`.

## Updating firmware after the first flash

Once the device has joined Wi-Fi, prefer `make ota` over `make flash` — no
cable needed. `make flash` (USB) is only required for the very first flash,
or if the device is stuck in a state where it can't reach Wi-Fi at all (e.g.
a bad password baked into a previous build).

## Troubleshooting

- **`esptool` fails with "port is busy"**: something else has the port open
  — usually a `screen` or `idf.py monitor` session left running from
  checking the boot log. Run `make kill-port`, then retry.
- **`make flash` says no port found**: check the board is plugged in and
  showing up under `ls /dev/cu.*`.
- **Wi-Fi `4-Way Handshake Timeout` in the boot log**: almost always a wrong
  password in `secrets.yaml` — the ESP32 finds and associates with the SSID
  fine, but the pairwise key derived from the password doesn't match what
  the AP expects.
- **`make ota` can't resolve the hostname**: the device isn't on Wi-Fi yet
  (first flash must go over USB), or mDNS hasn't propagated yet. Pass
  `HOST=<ip>` explicitly if you know it.
