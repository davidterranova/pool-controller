CONFIG := pool-controller.yaml
# The ESPHome every target below runs in, and so CI's builds and checks
# (firmware.yml, validate.yml): bump it here only. The firmware needs 2026.11
# (runtime web login, set_global_tz; see docs/plans/secret-free-firmware.md).
# 2026.11.0b6 is a beta: move to 2026.11.x stable once it's out, before the
# feat/secret-free-firmware branch reaches main.
ESPHOME_VERSION ?= 2026.11.0b6
ESPHOME_IMAGE ?= ghcr.io/esphome/esphome:$(ESPHOME_VERSION)
ESPHOME := docker run --rm -v "$(CURDIR):/config" $(ESPHOME_IMAGE)
# The commit the firmware is built from, as its Firmware Version entity reports it
# (the pool card and the controller's page show it): v1.3.0, v1.3.0-4-g1a2b3c4, …-dirty.
FW_VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
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

.PHONY: validate build firmware-test flash status kill-port ota ip logs webui webui-test card i18n-check i18n-export i18n-import mock-ui mock-webui mock-ui-check ha-dashboard-check card-preview card-shots card-preview-check migrate-build migrate migrate-check migrate-clean migrate-test clean

# Parses the YAML and checks component schemas, without compiling any C++.
validate: webui
	$(ESPHOME) config $(CONFIG)

# Validates, then fully compiles the firmware (catches errors inside lambdas
# too, which `validate` alone can't since those are raw C++).
build: webui
	$(ESPHOME) -s firmware_version $(FW_VERSION) compile $(CONFIG)

# Host tests of the firmware's pure C++ helpers (tools/tests/: updates.h's
# schedule, install gate and Update Status; fill_import.h's Fill Water
# Import; fill_meter.h's fills, long-fill alarm and pulse test;
# components/page_login's HMAC, sessions, nonces and lockout), with the
# ESPHome image's g++.
FIRMWARE_TESTS := updates_test fill_import_test fill_meter_test page_login_test
firmware-test:
	docker run --rm -v "$(CURDIR):/config" -w /config --entrypoint sh $(ESPHOME_IMAGE) -c \
		'set -e; for t in $(FIRMWARE_TESTS); do g++ -std=c++20 -Wall -Wextra -Werror -o /tmp/$$t tools/tests/$$t.cpp; /tmp/$$t; done'

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
# only works once the device has already joined Wi-Fi. The upload needs the
# controller's OTA Password (set on its page; nothing is compiled in): from
# OTA_PASSWORD=... or the untracked file .ota-password (gitignored), given to
# the upload only, never to the build.
OTA_PASSWORD ?= $(shell cat .ota-password 2>/dev/null)
ota: build
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	@test -n "$(OTA_PASSWORD)" || (echo "No OTA password: put the controller's OTA Password in .ota-password, or pass OTA_PASSWORD=..." && exit 1)
	@$(ESPHOME) -s ota_password "$(OTA_PASSWORD)" upload $(CONFIG) --device $(HOST)

# Moves a controller built with secrets.yaml (v1.3.x) to this firmware in one
# OTA, with nothing to set up and no re-pairing in Home Assistant
# (docs/plans/secret-free-firmware.md, WP8). migrate-build generates
# $(MIGRATE_CONFIG): this firmware plus a boot step that fills every EMPTY
# setting with what the controller was built with (secrets.yaml, and the probe
# addresses of $(MIGRATE_FROM)), then compiles it. It holds the secrets, so it
# and its build stay in $(MIGRATE_DIR)/ (gitignored, mode 700), never in a
# release; migrate-clean deletes them. migrate then checks the controller is
# idle, uploads with today's OTA password, waits for it and checks Setup State
# `configured`, the pool temperature and the same API key; on a failure it
# prints the rollback. Once migrated, it writes .ota-password (mode 600,
# gitignored) for the next `make ota`, unless that file holds another password
# (left alone, with a note). MIGRATE_FORCE=1 skips the idle check.
# migrate-check repeats the checks alone. The secrets are read inside the
# container only.
MIGRATE_DIR := .migrate
MIGRATE_CONFIG := $(MIGRATE_DIR)/migration.yaml
MIGRATE_SECRETS ?= secrets.yaml
# The last release built from secrets.yaml, i.e. what the controller runs: its
# pool-controller.yaml gives the probe addresses, and it is the rollback.
MIGRATE_FROM ?= v1.3.1
MIGRATE_PY = docker run --rm -i -v "$(CURDIR):/config" -v "$(abspath $(MIGRATE_SECRETS)):/run/migrate/secrets.yaml:ro" --entrypoint python3 $(ESPHOME_IMAGE) -I -B /config/tools/migrate/migrate.py
MIGRATE_DEVICE_ARGS = --secrets /run/migrate/secrets.yaml --host "$(HOST)" --from-ref "$(MIGRATE_FROM)" --expect-version "$(FW_VERSION)" --config $(MIGRATE_CONFIG) --ota-password-file /config/.ota-password $(if $(MIGRATE_FORCE),--force)
migrate-need-secrets = @test -f "$(MIGRATE_SECRETS)" || (echo "No $(MIGRATE_SECRETS): make migrate reads the controller's settings from it (MIGRATE_SECRETS=path)." && exit 1)
migrate-need-host = @test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)

migrate-build: webui
	$(migrate-need-secrets)
	@git cat-file -e "$(MIGRATE_FROM):pool-controller.yaml" 2>/dev/null || (echo "$(MIGRATE_FROM) has no pool-controller.yaml: set MIGRATE_FROM to the commit the controller was built from." && exit 1)
	@mkdir -p $(MIGRATE_DIR) && chmod 700 $(MIGRATE_DIR)
	@git show "$(MIGRATE_FROM):pool-controller.yaml" | $(MIGRATE_PY) generate --secrets /run/migrate/secrets.yaml --old-config - --from-ref "$(MIGRATE_FROM)" --out /config/$(MIGRATE_CONFIG) --out-display $(MIGRATE_CONFIG)
	$(ESPHOME) -s firmware_version $(FW_VERSION) compile $(MIGRATE_CONFIG)

migrate: migrate-build
	$(migrate-need-host)
	@$(MIGRATE_PY) run $(MIGRATE_DEVICE_ARGS)

migrate-check:
	$(migrate-need-secrets)
	$(migrate-need-host)
	@$(MIGRATE_PY) check $(MIGRATE_DEVICE_ARGS)

migrate-clean:
	rm -rf $(MIGRATE_DIR)

# migrate.py's own tests: made-up values, no secrets.yaml, no controller.
migrate-test:
	docker run --rm -v "$(CURDIR):/config" --entrypoint python3 $(ESPHOME_IMAGE) -I -B /config/tools/migrate/test_migrate.py

# Resolves the pool-controller's current IP via mDNS (same lookup `ota` uses).
ip:
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	@echo "$(HOSTNAME) -> $(HOST)"

# Streams the device's live log over Wi-Fi (native API, port 6053) -- no USB
# needed. Ctrl-C to stop. Useful for watching the boot-time OneWire scan and
# live sensor readings once the board's sealed up and USB isn't convenient.
logs:
	@test -n "$(HOST)" || (echo "Could not resolve $(HOSTNAME) -- is the device on Wi-Fi and reachable? Pass HOST=<ip> to override." && exit 1)
	docker run --rm -it -v "$(CURDIR):/config" $(ESPHOME_IMAGE) logs $(CONFIG) --device $(HOST) --states

# Local mock of the device's web UI (tools/webui-mock/), for iterating on the
# page without a build or a flash: http://localhost:$(MOCK_PORT)/. Serves the
# exact page this ESPHome image embeds, with entities and sorting groups read
# from $(CONFIG) and a small simulation behind them; saving $(CONFIG) reloads
# the page. Pass MOCK_INDEX=path/to/page.html to serve your own page instead.
# MOCK_TZ is the host's IANA zone, so the simulated schedule runs on your
# wall clock rather than the container's UTC.
MOCK_PORT ?= 8080
MOCK_TZ ?= $(shell readlink /etc/localtime 2>/dev/null | sed -E 's|.*/zoneinfo/||')
MOCK := docker run --rm -v "$(CURDIR):/config" -e TZ=$(MOCK_TZ) --entrypoint python3 $(ESPHOME_IMAGE) /config/tools/webui-mock/mock_server.py

mock-ui: webui
	$(subst docker run --rm,docker run --rm -it -p $(MOCK_PORT):8080,$(MOCK)) $(if $(MOCK_INDEX),--index /config/$(MOCK_INDEX)) $(MOCK_ARGS) /config/$(CONFIG)

# The device's page from its sources in webui/ (piscine-card + the Réglages
# and Réglages contrôleur tabs) against the same mock, rather than the bundle mock-ui
# serves: its files are served and watched like the YAML, so saving one
# reloads the page. MOCK_HOTSPOT=1 starts the device on its fallback
# hotspot, with no clock (a router outage). MOCK_FRESH=1 starts it as a new
# install: not set up (Setup State lists everything), no network saved, on its
# hotspot with no clock; once a Page Password is set, the page shows its login
# screen. MOCK_IDLE=60 ends a login session after 60 s without a request
# instead of 6 h. A curl -X POST to /__mock/reboot reboots the mock controller,
# with ?version=v1.6.0 onto another firmware (the page reloads itself).
# MOCK_NO_RELEASE=1: no firmware published yet, every update check fails.
# MOCK_FILL=off starts with the fill meter turned off; MOCK_LONG_FILL=1 with a
# fill already past Fill Alarm After, its alarm on (fill-meter.yaml).
mock-webui:
	$(MAKE) mock-ui MOCK_INDEX=webui/index.html MOCK_ARGS="$(if $(MOCK_HOTSPOT),--hotspot) $(if $(MOCK_FRESH),--fresh) $(if $(MOCK_NO_RELEASE),--no-release) $(if $(filter off,$(MOCK_FILL)),--fill-off) $(if $(MOCK_LONG_FILL),--long-fill) $(if $(MOCK_IDLE),--idle $(MOCK_IDLE))"

# Prints the page layout (sections, order, which entities the simulation
# drives) and fails if $(CONFIG) has an entity type the mock can't render.
mock-ui-check:
	$(MOCK) --check $(MOCK_ARGS) /config/$(CONFIG)

# Checks home-assistant/dashboard/ (the dashboard components and the scripts piscine-card calls) against
# $(CONFIG): every controller entity id it names must exist, as a fresh install names it, and its
# piscine-card must map every entity the card uses. Python in the ESPHome image, like the mock.
ha-dashboard-check:
	docker run --rm -v "$(CURDIR):/config" --entrypoint python3 $(ESPHOME_IMAGE) /config/tools/ha-dashboard-check.py /config/$(CONFIG) /config/home-assistant/dashboard

# The device's own page (webui/), bundled into the two files the firmware
# embeds: web_server's js_include and css_include in $(CONFIG). Rebuilt only
# when a source changes; validate, build (so ota and flash) and mock-ui
# depend on it. esbuild runs in a node container, like ESPHome in its own.
CARD_SRC := home-assistant/piscine-card.js home-assistant/i18n.js $(wildcard home-assistant/i18n/*.json)
WEBUI_SRC := $(wildcard webui/*.js webui/*.html webui/*.css webui/i18n-page/*.json) $(CARD_SRC)
ESBUILD := docker run --rm -v "$(CURDIR):/src" -w /src -e NPM_CONFIG_UPDATE_NOTIFIER=false node:22-alpine npx --yes esbuild@0.24.2

webui: webui/dist/device.js webui/dist/device.css

webui/dist/device.js: $(WEBUI_SRC)
	$(ESBUILD) webui/device.js --bundle --minify --format=esm --loader:.html=text --log-level=warning --outfile=$@

webui/dist/device.css: webui/app.css
	$(ESBUILD) webui/app.css --minify --log-level=warning --outfile=$@

# The card as a release ships it (release.yml): home-assistant/piscine-card.js and its texts (i18n.js,
# i18n/*.json) in one minified file, home-assistant/dist/piscine-card.js (gitignored), which HACS installs
# as the release's piscine-card.js, under a one-line header: its version, licence and source.
CARD_VERSION = $(shell sed -nE 's/^const VERSION = "([^"]+)";/\1/p' home-assistant/piscine-card.js)
card: home-assistant/dist/piscine-card.js

home-assistant/dist/piscine-card.js: $(CARD_SRC)
	$(ESBUILD) home-assistant/piscine-card.js --bundle --minify --format=esm --legal-comments=none --log-level=warning \
		"--banner:js=/*! piscine-card $(CARD_VERSION), the Pool Controller card for Home Assistant. MIT License. https://github.com/davidterranova/pool-controller */" --outfile=$@

# piscine-card's preview (tools/card-preview/): the card as it is, against a stand-in
# for Home Assistant, in named situations (scenarios.js), with no Home Assistant
# nor controller. card-preview serves it at http://localhost:$(CARD_PREVIEW_PORT)/tools/card-preview/.
# card-shots takes each situation's tile and panel at 390 and 760 px, light and
# dark, in French, English and Spanish, into tools/card-preview/shots/
# (SCENARIO=fill-alarm,normal for some; LANG=fr for one language);
# card-preview-check loads them all on every tab, in each language, and fails on
# an error, or on « undefined » / « NaN » / a dictionary key in the card. Both run Chromium in Playwright's image,
# with playwright-core installed once into .card-preview/.
CARD_PREVIEW_PORT ?= 8124
PLAYWRIGHT_VERSION := 1.52.0
PLAYWRIGHT := docker run --rm -v "$(CURDIR):/src" -w /src -e NPM_CONFIG_UPDATE_NOTIFIER=false \
	mcr.microsoft.com/playwright:v$(PLAYWRIGHT_VERSION)-noble sh -c \
	'test -d .card-preview/node_modules/playwright-core || npm i -s --no-audit --no-fund --prefix .card-preview playwright-core@$(PLAYWRIGHT_VERSION) >/dev/null; node tools/card-preview/shoot.mjs "$$@"' --

card-preview:
	@echo "piscine-card preview: http://localhost:$(CARD_PREVIEW_PORT)/tools/card-preview/"
	docker run --rm -it -p $(CARD_PREVIEW_PORT):8124 -v "$(CURDIR):/src:ro" -w /src --entrypoint python3 $(ESPHOME_IMAGE) -m http.server 8124

card-shots:
	$(PLAYWRIGHT) $(if $(SCENARIO),--only $(SCENARIO)) $(if $(LANG),--lang $(LANG))

# CARD_BUNDLE=1: against the release's minified card (make card) instead of its source, as CI does.
card-preview-check: $(if $(CARD_BUNDLE),card)
	$(PLAYWRIGHT) --check $(if $(CARD_BUNDLE),--bundle) $(if $(LANG),--lang $(LANG))

# Unit tests of the pages' pure modules (webui/test/: the setup's logic, the
# time zone table; tools/tests/install-page.test.mjs: the install page's
# states), with Node's own test runner, in the same node image.
webui-test:
	docker run --rm -v "$(CURDIR):/src" -w /src node:22-alpine node --test 'webui/test/*.test.mjs' 'tools/tests/*.test.mjs'

# The interface's texts (docs/plans/i18n.md; the surfaces in tools/i18n/surfaces.mjs), in the same node image.
#   i18n-check    every dictionary complete in every language and consistent with its sources; fails on an error
#   i18n-export   every text in English as one Markdown file, .i18n/translations.en.md, for any translation tool
#   i18n-import   the translated file back into each surface's <TO>.json: make i18n-import TO=es FILE=~/Downloads/x.md
#                 (DRY_RUN=1: only report). TO, not LANG: LANG is the shell's locale.
I18N_NODE := docker run --rm -v "$(CURDIR):/src" -w /src node:22-alpine node

i18n-check:
	$(I18N_NODE) tools/i18n/check.mjs

i18n-export:
	$(I18N_NODE) tools/i18n/export.mjs --out .i18n/translations.en.md

i18n-import:
	@test -n "$(TO)" && test -n "$(FILE)" || { echo "usage: make i18n-import TO=es FILE=path/to/translated.md [DRY_RUN=1]"; exit 2; }
	@mkdir -p .i18n && cp "$(FILE)" .i18n/import.$(TO).md
	$(I18N_NODE) tools/i18n/import.mjs --to $(TO) $(if $(DRY_RUN),--dry-run) .i18n/import.$(TO).md

clean:
	rm -rf .esphome webui/dist home-assistant/dist .i18n $(MIGRATE_DIR)
