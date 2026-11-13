# ESP32 - Pool controller

ESPHome firmware for an ESP32-WROOM that runs a swimming pool's variable-speed
pump: an autonomous on-device filtration schedule (computed from water
temperature and sunrise/sunset, plus manual override), a freeze-protection
safety rule that always wins, and three temperature sensors — all exposed to
Home Assistant, but not dependent on it. The device keeps running its
schedule whether or not HA is reachable.

See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for how the controller actually
works: wiring, control logic, and Home Assistant setup. This file covers the
repo itself — layout and tooling.

## Repo layout

| File | Purpose |
|---|---|
| `pool-controller.yaml` | The ESPHome device config — this *is* the firmware source. |
| `secrets.yaml` | Wi-Fi credentials, API encryption key, OTA password. Gitignored — create your own (see below). |
| `Makefile` | Validate / build / flash / OTA / status tooling. |
| `tools/webui-mock/` | Local mock of the device's web UI, for working on the page without flashing (see below). |
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
   # Local web UI at http://pool-controller.local/ (username: admin):
   pool_controller_web_password: "..."
   # Used by the autonomous filtration schedule for sunrise/sunset + local
   # midnight -- decimal degrees and an IANA zone name:
   pool_latitude: "..."
   pool_longitude: "..."
   pool_timezone: "Europe/Paris"
   ```

2. Check the `substitutions:` block at the top of `pool-controller.yaml` —
   the four relay GPIO pins and the OneWire bus pin — match your own wiring.
   See [POOL-CONTROLLER.md](POOL-CONTROLLER.md) for what each one does.

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
| `make mock-ui` | Serve a local mock of the device's web UI at http://localhost:8080/ (see below). `MOCK_PORT=` to change the port, `MOCK_INDEX=path.html` to serve your own page. |
| `make mock-ui-check` | Print the web UI layout (sections and order) and fail on any entity type the mock can't render. Runs in CI. |
| `make clean` | Remove the local build cache (`.esphome/`). |

`PORT` (serial) and `HOST` (network) both auto-detect and can be overridden
on the command line, e.g. `make flash PORT=/dev/cu.usbserial-XXXX` or
`make ota HOST=192.168.4.72`.

## Working on the web UI without flashing

`make mock-ui` runs [tools/webui-mock/mock_server.py](tools/webui-mock/mock_server.py)
in the same ESPHome image as `make build` and serves the device's web UI at
<http://localhost:8080/>. The UI is the page your firmware build embeds, decoded
from the image, so it always matches the ESPHome version you build with.

- **The layout comes from the YAML.** Entities, names, icons, number ranges and
  the `web_server` sorting groups are read from `pool-controller.yaml`. Save
  the file and the open page reloads with the change. No build, no flash.
- **The controls act like the device.** A small simulation behind the
  entities computes today's plan, the boosts, the Manual Override and its
  timeout, the Apply gate and filtration hours. Changing a setting moves the
  values the way it would on the device. The simulation is an approximation
  for UI work, not a test of the control logic. Sunrise/sunset are fixed
  (07:45 / 17:15), and the clock is your machine's.
- **Same protocol as the device.** The mock implements the `/events` stream
  and the REST endpoints the page calls, so `MOCK_INDEX=my-page.html make
  mock-ui` serves your own HTML against the same API. That's the way to
  prototype a custom page before deciding to put it on the device.
- **No login.** Unlike the device, the mock has no auth, to keep iteration
  quick.
- An entity the simulation doesn't know (e.g. one you just added) still
  shows up, with a static value. `make mock-ui-check` marks it
  `[static: not simulated]`. Add it to the `N` map in `mock_server.py` to make
  it move.

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
