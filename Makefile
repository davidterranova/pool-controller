CONFIG := pool-controller.yaml
ESPHOME := docker run --rm -v "$(CURDIR):/config" ghcr.io/esphome/esphome
BUILD_DIR := .esphome/build/pool-controller/build
ESPTOOL := /Users/davidterranova/.espressif/tools/python/v6.0.2/venv/bin/esptool

# Auto-detects the board's USB-serial port; override if you have more than
# one such device plugged in, e.g. `make flash PORT=/dev/cu.usbserial-XXXX`.
PORT ?= $(shell ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* /dev/cu.usbmodem* 2>/dev/null | head -n1)

# Resolved on the host (mDNS via macOS's built-in Bonjour) rather than inside
# the container -- Docker Desktop's networking doesn't reliably pass mDNS
# multicast traffic through, so we hand `esphome upload` a plain IP instead.
# Override with `make ota HOST=<ip>` if resolution fails but you know the IP.
HOSTNAME := pool-controller.local
HOST ?= $(shell ping -c1 $(HOSTNAME) 2>/dev/null | sed -nE 's/^PING [^ ]+ \(([0-9.]+)\).*/\1/p')

.PHONY: validate build flash status kill-port ota ip logs mock-ui mock-ui-check clean

# Parses the YAML and checks component schemas, without compiling any C++.
validate:
	$(ESPHOME) config $(CONFIG)

# Validates, then fully compiles the firmware (catches errors inside lambdas
# too, which `validate` alone can't since those are raw C++).
build:
	$(ESPHOME) compile $(CONFIG)

# Flashes over UART via esptool (bundled with the ESP-IDF install), not through
# Docker: Docker Desktop on macOS can't pass a host USB-serial device into the
# container. Offsets come from the build's own flasher_args.json.
flash: build
	@test -n "$(PORT)" || (echo "No ESP32 serial port found. Plug in the board or pass PORT=/dev/cu.xxxx explicitly." && exit 1)
	$(ESPTOOL) --chip esp32 --port $(PORT) --baud 460800 \
		--before default-reset --after hard-reset write-flash \
		--flash-mode dio --flash-size 4MB --flash-freq 40m \
		0x1000 $(BUILD_DIR)/bootloader/bootloader.bin \
		0x8000 $(BUILD_DIR)/partition_table/partition-table.bin \
		0x9000 $(BUILD_DIR)/ota_data_initial.bin \
		0x10000 $(BUILD_DIR)/pool-controller.bin

# Queries the connected board over UART: chip type, revision, MAC, and
# whether the port is even reachable.
status:
	@test -n "$(PORT)" || (echo "No ESP32 serial port found. Plug in the board or pass PORT=/dev/cu.xxxx explicitly." && exit 1)
	$(ESPTOOL) --port $(PORT) chip-id

# Kills whatever process (screen, monitor, another esptool run, ...) is
# holding the serial port open, so flash/status can grab it.
kill-port:
	@test -n "$(PORT)" || (echo "No ESP32 serial port found." && exit 1)
	@pids="$$(lsof -t $(PORT) 2>/dev/null)"; \
	if [ -n "$$pids" ]; then \
		echo "Killing process(es) holding $(PORT): $$pids"; \
		kill $$pids; \
	else \
		echo "$(PORT) is free."; \
	fi

# Pushes a rebuilt firmware over the network (port 3232) instead of USB --
# only works once the device has already joined Wi-Fi.
ota: build
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	$(ESPHOME) upload $(CONFIG) --device $(HOST)

# Resolves the pool-controller's current IP via mDNS (same lookup `ota` uses).
ip:
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	@echo "$(HOSTNAME) -> $(HOST)"

# Streams the device's live log over Wi-Fi (native API, port 6053) -- no USB
# needed. Ctrl-C to stop. Useful for watching the boot-time OneWire scan and
# live sensor readings once the board's sealed up and USB isn't convenient.
logs:
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	docker run --rm -it -v "$(CURDIR):/config" ghcr.io/esphome/esphome logs $(CONFIG) --device $(HOST) --states

# Local mock of the device's web UI (tools/webui-mock/), for iterating on the
# page without a build or a flash: http://localhost:$(MOCK_PORT)/. Serves the
# exact page this ESPHome image embeds, with entities and sorting groups read
# from $(CONFIG) and a small simulation behind them; saving $(CONFIG) reloads
# the page. Pass MOCK_INDEX=path/to/page.html to serve your own page instead.
# MOCK_TZ is the host's IANA zone, so the simulated schedule runs on your
# wall clock rather than the container's UTC.
MOCK_PORT ?= 8080
MOCK_TZ ?= $(shell readlink /etc/localtime 2>/dev/null | sed -E 's|.*/zoneinfo/||')
MOCK := docker run --rm -v "$(CURDIR):/config" -e TZ=$(MOCK_TZ) --entrypoint python3 ghcr.io/esphome/esphome /config/tools/webui-mock/mock_server.py

mock-ui:
	$(subst docker run --rm,docker run --rm -it -p $(MOCK_PORT):8080,$(MOCK)) $(if $(MOCK_INDEX),--index /config/$(MOCK_INDEX)) $(MOCK_ARGS) /config/$(CONFIG)

# Prints the page layout (sections, order, which entities the simulation
# drives) and fails if $(CONFIG) has an entity type the mock can't render.
mock-ui-check:
	$(MOCK) --check $(MOCK_ARGS) /config/$(CONFIG)

clean:
	rm -rf .esphome
