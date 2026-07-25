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

.PHONY: validate build flash status kill-port ota ip clean

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

clean:
	rm -rf .esphome
