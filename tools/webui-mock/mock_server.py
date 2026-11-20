#!/usr/bin/env python3
"""Local mock of the pool controller's web UI (ESPHome web_server v3).

Serves the exact page the firmware embeds -- extracted from the installed
ESPHome package, so it always matches the version `make build` uses -- and
speaks the same protocol the device does: a Server-Sent Events stream on
/events (config ping, sorting groups, every entity's full config, then state
updates) plus the REST endpoints the page calls (POST
/{domain}/{entity name}/{action}).

Entities, names, icons, number ranges and sorting groups are read from
pool-controller.yaml, and the page reloads itself whenever that file is saved,
so layout changes show up without a build or a flash. Behind the entities sits
a small simulation of the controller (daily plan, boosts, Manual Override and
its timeout, the Apply gate, filtration hours, firmware updates and their
install gate) so the controls react the way they do on the device. It is an approximation for UI work only: the firmware
in pool-controller.yaml is the source of truth for the control logic.

Usage (from the repo root; `make mock-ui` wraps this):
    python3 tools/webui-mock/mock_server.py pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --index my-page.html pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --check pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --extra my-package.yaml [--hotspot] pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --fresh [--idle 60] pool-controller.yaml

The config's own `packages:` (`name: !include file.yaml`) are loaded like ESPHome
does, for their entities and sorting groups. --extra loads one more package the
same way, for designing against entities the firmware doesn't have yet.
--hotspot starts the simulated device on its fallback hotspot, with no clock.
--no-release has no firmware published yet, so every update check fails (the
manifest on GitHub Pages is a 404), as before a project's first release.
--fill-off starts with the fill meter turned off (Fill Meter, fill-meter.yaml): no fill water, no alarm.
--long-fill starts with a fill already running past Fill Alarm After, so its alarm is on; it stops 3 min after
« Acquitter », and the alarm clears 5 min later, as on the device. « Détecter le compteur » opens the fill tap for
20 s, so the pulse test passes.
--fresh starts it as a controller straight out of the install: nothing set up
(Setup State lists everything), no network saved, so on its hotspot with no
clock.

The page login (docs/plans/page-login.md) is the device's: once a Page Password
is set during this run, every request needs a session (the pool_session cookie)
but for the page itself and the login endpoints, and a refused one gets a 401
with no WWW-Authenticate, so the page shows its own login screen. GET
/login/challenge, POST /login (nonce, HMAC-SHA256 proof), GET /login/session and
POST /logout; up to 4 sessions, each ended after 6 h idle (--idle SECONDS
shortens it); 5 failed logins in a row lock the login for 30 s, then 60 s, up to
15 min. A session that ends (idle, logout, Logout All Devices, a new Page
Password, Factory Reset) has its event streams closed. The configured mock (no
--fresh) has no password it knows, so it asks for none until one is set.

POST /__mock/reboot reboots the simulated controller: the pages' streams drop
and reconnect, sessions survive with their idle clocks restarted, as on the
device. ?version=v1.6.0 reboots it onto that firmware instead, as an update
would, and the page reloads itself.

Needs PyYAML, and the `esphome` package for the device's index page -- both present in
the ghcr.io/esphome/esphome image the Makefile runs this in.
"""

import argparse
import base64
import binascii
import functools
import gzip
import hashlib
import hmac
import json
import math
import os
import queue
import random
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

import yaml

# Domains the mock renders, in the order ESPHome's entity iterator sends them.
SUPPORTED_DOMAINS = ["binary_sensor", "fan", "sensor", "switch", "button", "text_sensor", "number", "datetime",
                     "text", "select", "update"]
# Entity domains ESPHome has that the mock doesn't simulate; --check fails on them
# so a new one can't silently go missing from the mock.
UNSUPPORTED_DOMAINS = [
    "alarm_control_panel", "climate", "cover", "event", "light", "lock",
    "media_player", "valve", "water_heater",
]
NUMBER_MODES = {"auto": 0, "box": 1, "slider": 2}
TEXT_MODES = {"text": 0, "password": 1}
# Per-platform defaults for what the YAML doesn't spell out.
SENSOR_DEFAULTS = {
    "dallas_temp": {"unit_of_measurement": "°C", "accuracy_decimals": 1},
    "pulse_meter": {"unit_of_measurement": "pulses/min", "accuracy_decimals": 2},
    "wifi_signal": {"unit_of_measurement": "dBm", "accuracy_decimals": 0},
}

# Mock sun times (seconds after local midnight). The real ones come from the
# sun: component and the pool's coordinates (Latitude, Longitude).
MOCK_SUNRISE = 7 * 3600 + 45 * 60
MOCK_SUNSET = 17 * 3600 + 15 * 60

# What the gate lets through: the page's shell and code, which draw the login screen (/index.html is the mock's own),
# and the login endpoints, by path and method.
PAGE_PATHS = ("/", "/index.html", "/0.js", "/0.css")
LOGIN_PATHS = {"/login/challenge": "GET", "/login": "POST", "/login/session": "GET", "/logout": "POST"}

# What a custom --index page may load from its own directory.
STATIC_TYPES = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json"}

RELOAD_SNIPPET = (
    "<script>(()=>{const s=new EventSource('/__mock/reload');"
    "s.addEventListener('reload',()=>location.reload());})();</script>"
)


# --------------------------------------------------------------------------- config


class _Loader(yaml.SafeLoader):
    """SafeLoader that accepts ESPHome's custom tags (!secret, !lambda, ...).

    Their values are never needed for the UI, so each one just loads as the
    plain scalar/list/mapping it wraps -- which also means secrets.yaml is not
    required to run the mock.
    """


def _tagged(loader, _suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_mapping(node, deep=True)


_Loader.add_multi_constructor("!", _tagged)


@dataclass
class Entity:
    domain: str
    name: str
    platform: str
    conf: dict
    group: str | None = None  # sorting group *name*, as the device sends it
    weight: float | None = None

    @property
    def object_id(self) -> str:
        return re.sub(r"[^-_0-9a-z]", "_", self.name.replace(" ", "_").lower())

    def get(self, key, default=None):
        return self.conf.get(key, SENSOR_DEFAULTS.get(self.platform, {}).get(key, default))


@dataclass
class Layout:
    title: str
    log: bool
    groups: list  # [(name, weight)] in config order
    entities: list  # [Entity] in iterator order
    unsupported: list  # ["domain: name"]
    css_include: str | None
    js_include: str | None
    packages: list  # the package files merged in, watched like the config
    web: dict  # the web_server block, for the index page it builds


def load_layout(path: str, extras: list[str] | None = None) -> Layout:
    with open(path, encoding="utf-8") as f:
        config = yaml.load(f, Loader=_Loader) or {}
    # `name: !include file.yaml` loads as the plain file name (see _Loader).
    included = [os.path.join(os.path.dirname(os.path.abspath(path)), v)
                for v in (config.get("packages") or {}).values() if isinstance(v, str)]
    packages = included + [e for e in extras or [] if os.path.abspath(e) not in included]
    for extra in packages:
        # A package's entities and sorting groups, appended like ESPHome's packages: merge would.
        with open(extra, encoding="utf-8") as f:
            package = yaml.load(f, Loader=_Loader) or {}
        for domain in SUPPORTED_DOMAINS + UNSUPPORTED_DOMAINS:
            if package.get(domain):
                config[domain] = list(config.get(domain) or []) + list(package[domain])
        groups = (package.get("web_server") or {}).get("sorting_groups")
        if groups:
            web = config.setdefault("web_server", {}) or {}
            web["sorting_groups"] = list(web.get("sorting_groups") or []) + list(groups)
            config["web_server"] = web

    core = config.get("esphome", {})
    web = config.get("web_server") or {}
    groups_by_id = {g["id"]: (g["name"], float(g.get("sorting_weight", 50))) for g in web.get("sorting_groups", [])}

    def make(domain, platform, conf):
        e = Entity(domain, str(conf["name"]), platform, conf)
        ws = conf.get("web_server") or {}
        if ws:
            e.weight = float(ws.get("sorting_weight", 50))
            if ws.get("sorting_group_id") in groups_by_id:
                e.group = groups_by_id[ws["sorting_group_id"]][0]
        return e

    entities = []
    for domain in SUPPORTED_DOMAINS:
        for item in config.get(domain) or []:
            platform = item.get("platform", "")
            if item.get("name") and not item.get("internal"):
                entities.append(make(domain, platform, item))
            if domain in ("sensor", "text_sensor"):
                # Sub-entities such as pulse_meter's `total:` or wifi_info's `ssid:` are full ones of their own.
                for key, sub in item.items():
                    if isinstance(sub, dict) and sub.get("name") and not sub.get("internal"):
                        entities.append(make(domain, f"{platform}.{key}", sub))

    unsupported = [
        f"{domain}: {item.get('name')}"
        for domain in UNSUPPORTED_DOMAINS
        for item in config.get(domain) or []
        if item.get("name") and not item.get("internal")
    ]

    base = os.path.dirname(os.path.abspath(path))
    return Layout(
        title=core.get("friendly_name") or core.get("name", "ESPHome"),
        log=bool(web.get("log", True)),
        groups=list(groups_by_id.values()),
        entities=entities,
        unsupported=unsupported,
        css_include=os.path.join(base, web["css_include"]) if web.get("css_include") else None,
        js_include=os.path.join(base, web["js_include"]) if web.get("js_include") else None,
        packages=packages,
        web=web,
    )


# --------------------------------------------------------------------------- simulation

# Entity names the simulation drives. Anything else in the YAML still shows up
# with a static default value (and --check lists it), so a new entity is
# visible in the mock straight away -- it just won't move until it's added here.
N = {
    "pump": "Pump",
    "override": "Manual Override",
    "timeout": "Manual Override Timeout",
    "ends": "Manual Override Ends At",
    "override_active": "Manual Override Active",
    "commanded": "Pump Commanded Speed",
    "planned": "Pump Planned Speed",
    "planned_hours": "Planned Filtration Hours",
    "hours_today": "Filtration Hours Today",
    "history": "Daily History",
    "plan_history": "Daily Plan History",
    "water_min": "Pool Water Min Today",
    "water_max": "Pool Water Max Today",
    "b1s": "Schedule Block 1 Start",
    "b1e": "Schedule Block 1 End",
    "b2s": "Schedule Block 2 Start",
    "b2e": "Schedule Block 2 End",
    "next_change": "Next Speed Change",
    "next_speed": "Next Planned Speed",
    "next_boost_start": "Next Boost Start",
    "next_boost_end": "Next Boost End",
    "last_recompute": "Last Recomputed At",
    "not_computed": "Schedule Not Computed",
    "recompute": "Recompute Schedule Now",
    "min": "Min Filtration Hours",
    "max": "Max Filtration Hours",
    "warm": "Warmest Part of Day Offset",
    "offset": "Filtration Hour Offset",
    "pending": "Filtration Config Pending",
    "apply": "Apply Filtration Config",
    "boost_dur": "Boost Pulse Duration",
    "boost_int": "Boost Pulse Interval",
    "boost_high": "High Boost Frequency",
    "freeze_at": "Freeze Protection Temperature",
    "pool_temp": "Pool Return Temperature",
    "pad_temp": "Equipment Pad Temperature",
    "outdoor_temp": "Outdoor Temperature",
    "update_temps": "Update Temperature Sensors Now",
    "status": "Status",
    "flow": "Piscine - Débit remplissage",
    "volume": "Piscine - Volume total remplissage",
    "fill_today": "Fill Water Today",
    "fill_days": "Fill Water Days",
    "fill_months": "Fill Water Months",
    "fill_import": "Fill Water Import",
    "fw_version": "Firmware Version",
    "esphome_version": "ESPHome Version",
}
# The Wi-Fi entities (wifi-setup.yaml, a package of the config).
W = {
    "mode": "WiFi Mode",
    "signal": "WiFi Signal",
    "ssid": "WiFi SSID",
    "bssid": "WiFi BSSID",
    "ip": "IP Address",
    "mac": "MAC Address",
    "disconnects": "WiFi Disconnects",
    "clients": "Hotspot Clients",
    "nearby": "WiFi Networks Nearby",
    "join_ssid": "New WiFi Network",
    "join_password": "New WiFi Password",
    "join": "Join WiFi Network",
    "clock": "Device Clock",
    "clock_source": "Clock Source",
}
# The controller's settings (device-settings.yaml, a package of the config).
S = {
    "setup_state": "Setup State",
    "page_password": "Page Password",
    "ota_password": "OTA Password",
    "api_key": "API Key",
    "generate_key": "Generate API Key",
    "forget_key": "Forget API Key",
    "latitude": "Latitude",
    "longitude": "Longitude",
    "timezone": "Timezone",
    "timezone_name": "Timezone Name",
    "detected": "Detected Probes",
    "pool_probe": "Pool Probe",
    "pad_probe": "Pad Probe",
    "outdoor_probe": "Outdoor Probe",
    "rescan": "Rescan Probes",
    "factory_reset": "Factory Reset",
    "logout_all": "Logout All Devices",
    "waiting_for": "Schedule Waiting For",
}
# Firmware updates (updates.yaml, a package of the config).
U = {
    "firmware": "Firmware",
    "status": "Update Status",
    "auto": "Auto Update",
    "interval": "Update Check Interval",
    "check": "Check for Update",
    "cancel": "Cancel Update",
}
# The fill meter as an option (fill-meter.yaml): FillSim below.
F = {
    "enabled": "Fill Meter",
    "alarm_after": "Fill Alarm After",
    "detect": "Detect Fill Meter",
    "status": "Fill Meter Status",
    "last_pulse": "Fill Meter Last Pulse",
    "running": "Fill Running",
    "too_long": "Fill Running Too Long",
    "ack": "Acknowledge Fill Alarm",
    "acked": "Fill Alarm Acknowledged",
}
SIMULATED = set(N.values()) | set(W.values()) | set(S.values()) | set(U.values()) | set(F.values())

# The simulated probe bus: made-up addresses, as ESPHome writes them (family
# code 28 last), and what each probe measures. A fourth one hangs loose on the
# bus, so the role selects have one more option than roles.
PROBES = {
    "8a00000012345628": "pool_temp",
    "3f0000006789ab28": "pad_temp",
    "c1000000abcdef28": "outdoor_temp",
    "5e0000004242c028": "spare",
}
ROLES = {"pool_probe": "pool_temp", "pad_probe": "pad_temp", "outdoor_probe": "outdoor_temp"}
NO_PROBE = "none"

# What the simulated device "sees" around it: (ssid, rssi dBm, bssid). Joining
# one of the last three fails, as it would with a wrong password.
NEARBY = [
    ("Maison", -61, "D4:3F:CB:12:9A:01"),
    ("Maison-Invités", -64, "D4:3F:CB:12:9A:05"),
    ("Livebox-7A2C", -79, "A0:1B:29:7A:2C:10"),
    ("Freebox-4F21E9", -84, "F4:CA:E5:4F:21:E9"),
    ("DIRECT-HP-Imprimante", -88, "86:2A:FD:31:0C:77"),
]
UNJOINABLE = {"Livebox-7A2C", "Freebox-4F21E9", "DIRECT-HP-Imprimante"}
JOIN_SECONDS = 5


class WifiSim:
    """The proposed Wi-Fi setup: station or fallback hotspot, joining a network, and the clock."""

    def __init__(self, log, hotspot: bool, saved: bool = True):
        self.log = log
        self.mode = "Hotspot" if hotspot else "Connected"
        self.network = None if hotspot else NEARBY[0]
        self.saved = saved  # a network saved in NVS (Setup State's `wifi`)
        self.rssi = float(NEARBY[0][1])
        self.disconnects = 0
        self.join_ssid = ""
        self.join_password = ""  # held, never published -- like the firmware's global
        self.joining: tuple[str, float, str] | None = None  # (ssid, done at, mode before)
        # No internet on the hotspot alone, so no SNTP: the clock starts unset.
        self.clock_source = "None" if hotspot else "SNTP"
        self.clock_offset = 0.0
        self.last_drift = time.time()

    @property
    def clock_ok(self) -> bool:
        return self.clock_source != "None"

    def now(self) -> float:
        return time.time() + self.clock_offset

    def join(self):
        ssid = self.join_ssid
        if not ssid:
            self.log("Wi-Fi: no network to join")
            return
        self.log(f"Wi-Fi: joining '{ssid}'")
        self.joining = (ssid, time.time() + JOIN_SECONDS, self.mode)
        if self.mode == "Connected":
            self.disconnects += 1
        self.mode = "Connecting"

    def set_clock(self, value: str):
        try:
            when = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").timestamp()
        except ValueError:
            self.log(f"'{W['clock']}': invalid value {value!r}")
            return
        self.clock_offset = when - time.time()
        if abs(self.clock_offset) < 120:
            self.clock_offset = 0.0  # the mock's own clock is right; don't drift the plan for a rounding
        self.clock_source = "Browser"
        self.log(f"Clock set from the page: {value}")

    def tick(self):
        now = time.time()
        if self.joining and now >= self.joining[1]:
            ssid, _done, before = self.joining
            self.joining = None
            password, self.join_password = self.join_password, ""
            match = next((n for n in NEARBY if n[0] == ssid), None)
            if match and ssid not in UNJOINABLE and len(password) >= 8:
                self.mode, self.network, self.rssi = "Connected", match, float(match[1])
                self.saved = True
                self.log(f"Wi-Fi: joined '{ssid}' and saved it")
                if self.clock_source != "SNTP":
                    self.clock_source, self.clock_offset = "SNTP", 0.0
                    self.log("Clock synchronized over the internet (SNTP)")
            else:
                self.mode = before
                self.log(f"Wi-Fi: couldn't join '{ssid}', keeping the previous network")
        if self.mode == "Connected" and now - self.last_drift > 10:
            self.last_drift = now
            self.rssi = min(-45.0, max(-90.0, self.rssi + random.uniform(-2, 2)))

    def forget(self):
        """Factory Reset: no network saved, so the device reboots onto its hotspot, with no clock."""
        self.saved = False
        self.mode, self.network, self.joining = "Hotspot", None, None
        self.clock_source, self.clock_offset = "None", 0.0

    def snapshot(self) -> dict:
        connected = self.mode == "Connected"
        clock = (datetime.fromtimestamp(self.now()).strftime("%Y-%m-%d %H:%M:00") if self.clock_ok
                 else "0-00-00 00:00:00")
        return {
            W["mode"]: self.mode,
            W["signal"]: round(self.rssi) if connected else None,
            W["ssid"]: self.network[0] if connected else "",
            W["bssid"]: self.network[2] if connected else "",
            W["ip"]: "192.168.1.47" if connected else "",
            W["mac"]: "24:6F:28:9C:41:D0",
            W["disconnects"]: float(self.disconnects),
            W["clients"]: 1.0 if self.mode == "Hotspot" else 0.0,
            W["nearby"]: "".join(f"{ssid}: {rssi}dB\n" for ssid, rssi, _b in NEARBY),
            W["join_ssid"]: self.join_ssid,
            W["join_password"]: "",
            W["clock"]: clock,
            W["clock_source"]: self.clock_source,
        }


def _posix_of(zone: str) -> str:
    """The POSIX TZ string of an IANA zone: the footer line of its TZif file."""
    try:
        with open(os.path.join("/usr/share/zoneinfo", zone), "rb") as f:
            footer = f.read().rstrip(b"\n").rsplit(b"\n", 1)[-1].decode()
        return footer if footer and not footer.startswith("TZif") else "UTC0"
    except (OSError, UnicodeDecodeError):
        return "UTC0"


def _valid_posix(text: str) -> bool:
    try:
        from aioesphomeapi.posix_tz import parse_posix_tz  # noqa: PLC0415 -- in the ESPHome image

        parse_posix_tz(text)
        return True
    except ImportError:
        return bool(re.fullmatch(r"(<[^>]+>|[A-Za-z]{3,})[-+]?\d[\d:]*([A-Za-z<].*)?", text))
    except ValueError:
        return False


def _api_key_ok(text: str) -> bool:
    """Base64 of 32 bytes, not all zero: what the device's API Key accepts."""
    if not re.fullmatch(r"[A-Za-z0-9+/]{43}=", text or ""):
        return False
    try:
        raw = base64.b64decode(text, validate=True)
    except binascii.Error:
        return False
    return len(raw) == 32 and any(raw)


class SettingsSim:
    """device-settings.yaml: the page login, API key, position, timezone, probe roles, Setup State."""

    def __init__(self, log, fresh: bool, idle_s: float = 6 * 3600):
        self.log = log
        # The login the mock asks for: only one set during this run (a configured mock never asks).
        self.page_password: str | None = None
        self.page_password_set = not fresh
        self.login = LoginSim(log, lambda: self.page_password, idle_s)
        self.api_key_set = not fresh
        self.key_generated = False  # Generate API Key's: nobody holds it, so Home Assistant never connects
        self.bus = list(PROBES)
        if fresh:
            self.latitude = self.longitude = None
            self.timezone = self.timezone_name = ""
            self.roles = {role: None for role in ROLES}
        else:
            # A public place, not anyone's pool: the mock's sun times are fixed anyway.
            self.latitude, self.longitude = 48.85, 2.35
            self.timezone_name = os.environ.get("TZ") or "Europe/Paris"
            self.timezone = _posix_of(self.timezone_name)
            self.roles = {role: next(a for a, what in PROBES.items() if what == measured)
                          for role, measured in ROLES.items()}

    @property
    def position_ok(self) -> bool:
        return self.latitude is not None and self.longitude is not None and bool(self.timezone)

    def options(self) -> list[str]:
        known = self.bus + [a for a in self.roles.values() if a and a not in self.bus]
        return [NO_PROBE] + known

    def set_page_password(self, value: str):
        """Every session ends with a new Page Password, this browser's too: the page logs in again with it."""
        self.page_password, self.page_password_set = value, True
        self.log(f"'{S['page_password']}' set; the page now asks for it")  # never echo it
        self.login.end_all("new Page Password")

    def set_role(self, name: str, option: str):
        role = next(r for r in ROLES if S[r] == name)
        address = None if option == NO_PROBE else option
        for other in ROLES:  # one role per probe: taking it from another role clears that one
            if other != role and address and self.roles[other] == address:
                self.roles[other] = None
                self.log(f"'{S[other]}' set to none (its probe went to '{name}')")
        self.roles[role] = address

    def set_position(self, name: str, value: float):
        value = round(value, 2)
        if name == S["latitude"]:
            self.latitude = value
        else:
            self.longitude = value

    def setup_state(self, wifi_saved: bool) -> str:
        missing = [item for item, ok in (
            ("page_password", self.page_password_set),
            ("wifi", wifi_saved),
            ("position", self.position_ok),
            ("probes", bool(self.roles["pool_probe"])),
            ("api_key", self.api_key_set),
        ) if not ok]
        return ",".join(missing) or "configured"

    def detected(self, temps: dict) -> str:
        known = self.options()[1:]
        if not known:
            return "--"
        reading = lambda a: f"{temps[PROBES[a]]:.1f}" if a in self.bus and PROBES.get(a) in temps else "--"  # noqa: E731
        return ", ".join(f"{a}: {reading(a)}" for a in known)

    def factory_reset(self):
        """Access and network go; roles, position and timezone stay."""
        self.page_password, self.page_password_set, self.api_key_set = None, False, False
        self.key_generated = False
        self.login.end_all("Factory Reset")

    def snapshot(self, wifi_saved: bool, temps: dict) -> dict:
        return {
            S["setup_state"]: self.setup_state(wifi_saved),
            S["page_password"]: "",  # write-only: never echoed, as on the device
            S["ota_password"]: "",
            S["api_key"]: "",
            S["latitude"]: self.latitude,
            S["longitude"]: self.longitude,
            S["timezone"]: self.timezone,
            S["timezone_name"]: self.timezone_name,
            S["detected"]: self.detected(temps),
            **{S[role]: address or NO_PROBE for role, address in self.roles.items()},
        }


# page_login's limits (components/page_login/).
LOGIN_NONCE_S = 60       # a challenge's nonce is good once, for this long
LOGIN_NONCES = 4         # the challenges kept; a newer one pushes the oldest out
LOGIN_SESSIONS = 4       # one per browser; a fifth login ends the one idle longest
LOGIN_FAILURES = 5       # failed logins in a row before the lockout
LOGIN_LOCKOUT_S = 30     # the first lockout, doubled with each further failure…
LOGIN_LOCKOUT_MAX_S = 900  # …up to this
SESSION_COOKIE = "pool_session"


class LoginSim:
    """page_login in Python: challenges, the login and its lockout, the sessions and their idle limit.

    The gate is on while a Page Password is set (`password()`). Clocks are monotonic, like the device's uptime: a
    session's idle clock is its last authenticated request (the event stream doesn't count), restarted at boot.
    """

    def __init__(self, log, password, idle_s: float):
        self.log = log
        self.password = password
        self.idle_s = idle_s
        self.nonces: dict[str, float] = {}  # nonce -> when it was drawn
        self.sessions: dict[str, float] = {}  # token -> last activity
        self.failures = 0  # failed logins in a row
        self.locked_until = 0.0
        self.lockout_s = 0  # the last lockout's length; the next one doubles it

    @property
    def gated(self) -> bool:
        return self.password() is not None

    def challenge(self) -> str:
        now = time.monotonic()
        self.nonces = {n: t for n, t in self.nonces.items() if now - t < LOGIN_NONCE_S}
        while len(self.nonces) >= LOGIN_NONCES:
            del self.nonces[min(self.nonces, key=self.nonces.get)]
        nonce = os.urandom(16).hex()
        self.nonces[nonce] = now
        return nonce

    def retry_after(self) -> int:
        return max(0, math.ceil(self.locked_until - time.monotonic()))

    def login(self, nonce: str, proof: str, previous: str | None) -> tuple[int, int, str | None]:
        """(status, retry_after, new token): 204 with a session, 401 refused, 429 locked out. The browser's previous
        session, if any, gives its place to the new one."""
        if self.retry_after():
            return 429, self.retry_after(), None
        drawn = self.nonces.pop(nonce, None)  # single-use, right or wrong
        expected = hmac.new(self.password().encode(), nonce.encode(), hashlib.sha256).hexdigest()
        if drawn is None or time.monotonic() - drawn >= LOGIN_NONCE_S or not hmac.compare_digest(proof.encode(), expected.encode()):
            self.failures += 1
            why = "wrong password" if drawn is not None else "unknown or expired challenge"
            if self.failures < LOGIN_FAILURES:
                self.log(f"Login refused: {why} ({self.failures} in a row)")
                return 401, 0, None
            self.lockout_s = min(LOGIN_LOCKOUT_MAX_S, self.lockout_s * 2 or LOGIN_LOCKOUT_S)
            self.locked_until = time.monotonic() + self.lockout_s
            self.log(f"Login refused: {why} ({self.failures} in a row); logins locked for {self.lockout_s} s")
            return 401, self.lockout_s, None
        self.failures, self.lockout_s = 0, 0
        self.sessions.pop(previous, None)
        if len(self.sessions) >= LOGIN_SESSIONS:
            oldest = min(self.sessions, key=self.sessions.get)
            del self.sessions[oldest]
            self.log(f"Session {oldest[:6]}… ended: the one idle longest, for a new login")
        token = os.urandom(16).hex()
        self.sessions[token] = time.monotonic()
        self.log(f"Login: session {token[:6]}… started ({len(self.sessions)} of {LOGIN_SESSIONS})")
        return 204, 0, token

    def check(self, token: str | None, refresh: bool = True) -> bool:
        """Whether a request with this cookie goes through the gate; a live session's idle clock restarts with it."""
        if not self.gated:
            return True
        self.expire()
        if token not in self.sessions:
            return False
        if refresh:
            self.sessions[token] = time.monotonic()
        return True

    def expire(self):
        now = time.monotonic()
        for token in [t for t, last in self.sessions.items() if now - last >= self.idle_s]:
            del self.sessions[token]
            self.log(f"Session {token[:6]}… ended: idle {self.idle_s:g} s")

    def logout(self, token: str | None):
        if self.sessions.pop(token, None) is not None:
            self.log(f"Logout: session {token[:6]}… ended")

    def end_all(self, why: str):
        if self.sessions:
            self.log(f"{why}: {len(self.sessions)} session(s) ended")
        self.sessions.clear()

    def boot(self):
        """At boot every session's idle clock restarts: a reboot or an update logs no one out."""
        now = time.monotonic()
        self.sessions = dict.fromkeys(self.sessions, now)
        self.nonces.clear()
        self.failures, self.locked_until, self.lockout_s = 0, 0.0, 0  # kept in RAM only


def _hhmm(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "--:--"


def _stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


class UpdateSim:
    """updates.yaml: the Firmware entity behind its install gate, the checks, Update Status.

    The device's timings, shortened: the first check a few seconds after start (a minute on the
    device), a check answers in 2 s, an install takes 15 s, then the controller "reboots" on the new
    version (the page's event stream drops, as on the device). A release is always waiting at start.
    Auto Update acts on scheduled checks only (updates.h's auto_update_step), and Cancel Update drops
    an install waiting at the gate.
    """

    LATEST = "v1.5.0"
    RELEASE_URL = "https://github.com/davidterranova/pool-controller/releases/tag/v1.5.0"
    CHECK_S = 2
    INSTALL_S = 15

    def __init__(self, log, installed: str = "v1.4.0", released: bool = True):
        self.log = log
        self.installed = installed
        self.released = released  # False: no manifest on GitHub Pages yet, every check fails
        self.latest: str | None = None
        self.state = "UNKNOWN"  # as web_server sends it: UNKNOWN, NO UPDATE, UPDATE AVAILABLE, INSTALLING
        self.error = False
        self.last_op = None  # "check" | "install": which one failed
        self.checking_until = 0.0
        self.next_check = time.time() + 5
        self.pending_origin: str | None = None
        self.waiting_for: str | None = None
        self.installing_until = 0.0
        self.auto_armed = False  # a scheduled check ran and Auto Update hasn't acted on it yet

    def check(self, origin: str, scheduled: bool = False):
        """A manual check disarms Auto Update: what it finds waits for an explicit install."""
        self.log(f"Checking for update ({origin}): https://pool-controller.kitesize.fr/firmware/manifest.json")
        self.checking_until = time.time() + self.CHECK_S
        self.last_op = "check"
        self.auto_armed = scheduled

    def cancel(self):
        if not self.pending_origin:
            self.log("Cancel Update: no install waiting")
            return
        self.log(f"Install of {self.latest} cancelled ({self.pending_origin}; was waiting: {self.waiting_for})")
        self.pending_origin = self.waiting_for = None

    def install_request(self, origin: str, blocker: str | None):
        if self.state == "INSTALLING" or self.pending_origin:
            self.log(f"Install ({origin}): already under way")
        elif self.state != "UPDATE AVAILABLE":
            self.log(f"Install ({origin}): no update available; check first")
        else:
            self.log(f"Install of {self.latest} requested ({origin})")
            self.pending_origin, self.waiting_for = origin, None
            self.gate(blocker)

    def gate(self, blocker: str | None):
        if not self.pending_origin:
            return
        if blocker:
            if blocker != self.waiting_for:
                self.log(f"Install of {self.latest} waits: {blocker} in progress")
            self.waiting_for = blocker
            return
        self.log(f"Installing {self.latest} ({self.pending_origin}), then rebooting")
        self.pending_origin = self.waiting_for = None
        self.state, self.last_op = "INSTALLING", "install"
        self.installing_until = time.time() + self.INSTALL_S

    def tick(self, auto: bool, hours: float, blocker: str | None) -> bool:
        """Advances checks and installs; True when the controller reboots onto the new firmware."""
        now = time.time()
        if self.checking_until and now >= self.checking_until and not self.released:
            self.checking_until, self.error = 0.0, True
            self.log("Update check failed: HTTP 404 (no release published yet)")
        if self.checking_until and now >= self.checking_until:
            self.checking_until = 0.0
            self.latest, self.error = self.LATEST, False
            self.state = "NO UPDATE" if self.latest == self.installed else "UPDATE AVAILABLE"
            self.log(f"Firmware {self.latest} available (installed: {self.installed})" if self.state == "UPDATE AVAILABLE"
                     else f"Firmware up to date ({self.installed})")
        if hours and now >= self.next_check:
            self.next_check = now + hours * 3600
            self.check(f"every {hours:g} h", scheduled=True)
        if self.auto_armed and not self.checking_until:  # the scheduled check has answered
            self.auto_armed = False
            if auto and not self.pending_origin and self.state == "UPDATE AVAILABLE":
                self.install_request("Auto Update", blocker)
        self.gate(blocker)
        if self.state == "INSTALLING" and now >= self.installing_until:
            self.installed, self.state = self.latest, "NO UPDATE"
            return True
        return False

    def boot_on(self, version: str):
        """Another firmware, put there some other way (make ota, /__mock/reboot): the Firmware entity follows."""
        self.installed = version
        if self.latest:
            self.state = "NO UPDATE" if self.latest == version else "UPDATE AVAILABLE"

    def status(self, blocker: str | None) -> str:
        """Update Status, as updates.h's status_text() words it."""
        if self.state == "INSTALLING":
            return "installation"
        if self.pending_origin and blocker:
            return f"en attente ({blocker})"
        if self.pending_origin:
            return "installation"
        if self.checking_until:
            return "vérification"
        if self.error:
            return "erreur (installation)" if self.last_op == "install" else "erreur (vérification)"
        return {"UPDATE AVAILABLE": "disponible", "NO UPDATE": "à jour"}.get(self.state, "non vérifié")

    def entity(self) -> dict:
        return {"state": self.state, "latest": self.latest or "", "installed": self.installed,
                "release_url": self.RELEASE_URL if self.latest else ""}


# fill_meter.h's constants, in seconds.
FILL_GAP_S = 300            # a fill ends after this long without a litre (pulse_meter's timeout)
FILL_DETECT_LITRES = 3      # the pulse test: this many litres…
FILL_DETECT_WINDOW_S = 300  # …within this long
FILL_TEST_TAP_S = 20        # the mock's tap the test opens: ~4.7 L at 14 L/min


class FillSim:
    """fill_meter.h in Python: fills, the long-fill alarm and its acknowledgement, the pulse test; plus the settings
    fill-meter.yaml keeps (Fill Meter, Fill Alarm After, whether the meter is proven, its last pulse)."""

    def __init__(self, log, enabled: bool = True, long_fill: bool = False, fresh: bool = False):
        self.log = log
        self.enabled = enabled
        self.alarm_minutes = 60
        self.detected = not fresh
        self.day_measured = enabled
        self.last_pulse_epoch: float | None = None
        self._reset()
        self.tap_until = 0.0
        # --long-fill: a fill that began Fill Alarm After + 1 min ago and keeps going until acknowledged.
        self.long_until = math.inf if long_fill and enabled else 0.0
        if self.long_until:
            now = time.time()
            self.running, self.any_pulse, self.litres = True, True, 14 * (self.alarm_minutes + 1)
            self.started, self.last_pulse = now - (self.alarm_minutes + 1) * 60, now
            self.last_pulse_epoch = now

    def _reset(self):
        self.running = False
        self.started = self.last_pulse = 0.0
        self.any_pulse = False
        self.litres = 0
        self.too_long = self.acked = False
        self.listening = False
        self.detect_until = 0.0
        self.detect_litres = 0
        self.detect_failed = False

    def tap_open(self, now: float) -> bool:
        """Whether the mock's own tap runs: --long-fill's, or the one a pulse test opened."""
        return now < self.long_until or now < self.tap_until

    def _end(self, now: float):
        if self.running:
            self.running = False
            self.log(f"[fill] Fill ended: {self.litres} L in {(self.last_pulse - self.started) / 60:.0f} min")
        if self.too_long:
            self.log("[fill] Fill alarm off")
        self.too_long = self.acked = False

    def on_litres(self, now: float, litres: int):
        if not self.running or not self.any_pulse or now - self.last_pulse >= FILL_GAP_S:
            self._end(now)
            self.running, self.started, self.litres = True, now, 0
            self.log("[fill] Fill started")
        self.last_pulse, self.any_pulse = now, True
        self.last_pulse_epoch = now
        self.litres += litres
        if self.listening:
            self.detect_litres += litres
            if self.detect_litres >= FILL_DETECT_LITRES:
                self.listening, self.detect_failed, self.detected = False, False, True
                self.log("[fill] Fill meter detected: it counts")
        elif not self.detected and self.litres >= FILL_DETECT_LITRES and now - self.started <= FILL_DETECT_WINDOW_S:
            self.detect_failed, self.detected = False, True
            self.log("[fill] Fill meter detected: it counts")

    def tick(self, now: float):
        if not self.enabled:
            return
        if self.running and now - self.last_pulse >= FILL_GAP_S:
            self._end(now)
        too_long = self.running and self.alarm_minutes > 0 and now - self.started >= self.alarm_minutes * 60
        if too_long != self.too_long:
            self.too_long = too_long
            self.log(f"[fill] Fill alarm: a fill has run for {self.alarm_minutes} min or more" if too_long else "[fill] Fill alarm off")
        if not self.too_long:
            self.acked = False
        if self.listening and now >= self.detect_until:
            self.listening, self.detect_failed, self.detected = False, True, False
            self.log(f"[fill] Fill meter test: fewer than {FILL_DETECT_LITRES} L in {FILL_DETECT_WINDOW_S // 60} min, check its wiring")

    def set_enabled(self, on: bool):
        if on == self.enabled:
            return
        self.enabled = on
        if on:
            self.day_measured = True
            self.log("[fill] Fill meter on")
        else:
            self._end(time.time())
            self._reset()
            self.tap_until = self.long_until = 0.0
            self.log("[fill] Fill meter off: its pulses are ignored until it is turned back on")

    def detect(self, now: float):
        if not self.enabled:
            self.log("[fill] Fill meter test: the meter is off, turn Fill Meter on first")
            return
        self.listening, self.detect_failed, self.detect_litres = True, False, 0
        self.detect_until = now + FILL_DETECT_WINDOW_S
        self.tap_until = now + FILL_TEST_TAP_S
        self.log(f"[fill] Fill meter test: listening for {FILL_DETECT_LITRES} L within {FILL_DETECT_WINDOW_S // 60} min "
                 f"(the mock opens the tap for {FILL_TEST_TAP_S} s)")

    def acknowledge(self, now: float):
        if not self.too_long or self.acked:
            self.log("[fill] Acknowledge Fill Alarm: no alarm to acknowledge")
            return
        self.acked = True
        self.log("[fill] Fill alarm acknowledged: no more reminders until this fill ends")
        if self.long_until == math.inf:
            self.long_until = now + 180  # --long-fill: someone closes the tap 3 min later

    def status(self) -> str:
        if not self.enabled:
            return "off"
        if self.listening:
            return "listening"
        if self.detect_failed:
            return "not_detected"
        return "detected" if self.detected else "untested"

    def snapshot(self) -> dict:
        last = datetime.fromtimestamp(self.last_pulse_epoch).strftime("%Y-%m-%d %H:%M") if self.last_pulse_epoch else "--"
        return {
            F["enabled"]: self.enabled,
            F["alarm_after"]: float(self.alarm_minutes),
            F["status"]: self.status(),
            F["last_pulse"]: last,
            F["running"]: self.enabled and self.running,
            F["too_long"]: self.too_long,
            F["acked"]: self.acked,
        }


class PoolSim:
    """A pocket version of evaluate_speed and friends, driven by wall-clock time."""

    def __init__(self, log, hotspot: bool = False, fresh: bool = False, released: bool = True,
                 fill_off: bool = False, long_fill: bool = False, idle_s: float = 6 * 3600):
        self.log = log
        self.fill = FillSim(log, enabled=not fill_off, long_fill=long_fill, fresh=fresh)
        self.fill_carry = 0.0  # litres not yet a whole pulse
        # A fresh controller has no network saved: it starts on its hotspot.
        self.wifi = WifiSim(log, hotspot or fresh, saved=not fresh)
        self.settings = SettingsSim(log, fresh, idle_s)
        self.updates = UpdateSim(log, released=released)
        self.rebooted = False  # set by an install: the server drops the page's event stream
        self.started = time.time()
        self.numbers: dict[str, float] = {}
        self.selects: dict[str, str] = {U["interval"]: "24 h"}
        self.static: dict[str, object] = {}  # values for entities the sim doesn't model
        # What each probe on the simulated bus measures (PROBES); Pool Return Temperature & co. read
        # the one their role holds (reading()).
        self.temps = {"pool_temp": 26.4, "pad_temp": 21.8, "outdoor_temp": 17.5, "spare": 19.2}
        self.flow = 0.0
        self.volume = 18342.0
        self.active: dict[str, float] = {}
        self.blocks = (0, 0, 0, 0)
        self.sunset = 0
        self.computed_day = None
        self.seeded = False  # Filtration Hours Today started where the first plan would have it
        self.last_recompute = 0.0
        self.override_since: float | None = None
        self.commanded = "Off"
        self.filtration_s = 0.0
        self.counted_day = None
        # Today's water min/max (pumping readings only, as on the device), and when the pump started.
        self.water_lo: float | None = None
        self.water_hi: float | None = None
        self.run_started: float | None = None
        # The last 7 closed days, newest first: (date, seconds, water min, water max, planned seconds or
        # None). Seeded with a plausible week -- one day missing as if the device had been off, one with
        # no water range as if the pump hadn't run, one well under its plan, the oldest two closed
        # before the firmware kept the plan -- so the page has something to show.
        today = datetime.now().date()
        self.history = []
        for d in range(1, 8):
            if d == 4:
                continue
            lo = round(25.4 + random.uniform(-0.6, 0.6), 1)
            measured = d != 6
            planned = random.uniform(5.0, 7.5) * 3600
            ran = 0.0 if not measured else planned * 0.6 if d == 2 else planned + random.uniform(-0.1, 0.4) * 3600
            self.history.append((today - timedelta(days=d), ran,
                                 lo if measured else None, round(lo + random.uniform(0.3, 0.9), 1) if measured else None,
                                 planned if d < 6 else None))
        # Fill water: the last 30 closed days and 12 months, newest first (None = unknown), seeded with a real
        # summer (~950 L every three days, then next to nothing); a fill of a few minutes every quarter hour, so
        # the page's Contrôle › Remplissage counts live.
        days = [0, 2, 19, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0]
        self.fill_days = days[:]
        self.fill_days[12] = None  # a day the device was off
        self.fill_months = [23, 30, 9538, 2913, None, None, None, None, None, None, None, None]  # this month's closed days first
        if fresh:  # straight out of the install: no day closed yet
            self.history = []
            self.fill_days, self.fill_months = [None] * 30, [None] * 12
        self.fill_today = 0.0
        self.fill_import_state = ""  # Fill Water Import: what the last import did, never the line
        self.last_tick = time.time()
        self.last_drift = time.time()

    # -- entity bookkeeping

    def adopt(self, entities):
        """Seed values for entities seen for the first time (keeps existing ones across reloads)."""
        for e in entities:
            if e.name in SIMULATED and e.name in S.values():
                continue  # SettingsSim holds them
            if e.domain == "number" and e.name not in self.numbers:
                self.numbers[e.name] = float(e.get("initial_value", e.get("min_value", 0)))
            elif e.domain == "select" and e.name not in self.selects:
                options = e.get("options", [])
                self.selects[e.name] = e.get("initial_option", options[0] if options else "")
            elif e.name not in SIMULATED and e.name not in self.static:
                self.static[e.name] = {"sensor": 0.0, "binary_sensor": False, "fan": False,
                                       "switch": False, "text_sensor": "--"}.get(e.domain)
        self.static.setdefault(U["auto"], True)  # Auto Update: on by default, as the firmware
        self.numbers[F["alarm_after"]] = float(self.fill.alarm_minutes)  # reads its global, no initial_value
        if not self.active:
            self.active = {k: self.num(k) for k in ("min", "max", "warm", "offset")}

    def num(self, key: str, default: float = 0.0) -> float:
        return self.numbers.get(N[key], default)

    @property
    def override(self) -> str:
        return self.selects.get(N["override"], "Auto")

    def reading(self, key: str) -> float | None:
        """A temperature sensor's value (pool_temp, ...): what the probe its role holds measures, so a
        probe given the wrong role reads the wrong place; unknown while the role has none, as on the device."""
        address = self.settings.roles[next(role for role, sensor in ROLES.items() if sensor == key)]
        return self.temps.get(PROBES.get(address)) if address else None

    def waiting_for(self) -> str | None:
        """Schedule Waiting For: why today's plan isn't computed, None once it is."""
        st = self.settings
        if st.latitude is None or st.longitude is None:
            return "position"
        if not st.timezone:
            return "timezone"
        if not self.wifi.clock_ok:
            return "clock"
        if self.computed_day == datetime.fromtimestamp(time.time()).date():
            return None
        return "pool probe" if not st.roles["pool_probe"] else "pool temperature"

    # -- schedule

    def recompute(self, now: float):
        temp = self.reading("pool_temp")
        if temp is None or not self.settings.position_ok:
            return  # as evaluate_speed: no plan without a pool reading, a position and a timezone
        hours = min(max(temp / 2.0, self.active["min"]), self.active["max"]) + self.active["offset"]
        midnight = int(datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        sunrise, sunset = midnight + MOCK_SUNRISE, midnight + MOCK_SUNSET
        warmest = (sunrise + sunset) // 2 + int(self.active["warm"] * 3600)
        total = int(hours * 3600)
        b1_len = total // 3
        b2_len = total - b1_len
        b1s, b1e = sunrise, sunrise + b1_len
        b2s, b2e = warmest - b2_len // 2, warmest + b2_len // 2
        if b2s <= b1e:
            b1e = b1s + total
            b2s = b2e = b1e
        end = midnight + 86400
        self.blocks = (b1s, min(b1e, end), min(b2s, end), min(b2e, end))
        self.sunset = sunset
        self.computed_day = datetime.fromtimestamp(now).date()
        self.last_recompute = now

    def plan_at(self, t: int) -> str:
        b1s, b1e, b2s, b2e = self.blocks
        if b1s <= t < b1e:
            start = b1s
        elif b2s <= t < b2e:
            start = b2s
        else:
            return "Off"
        interval = int(self.num("boost_int", 30) * 60)
        duration = int(self.num("boost_dur", 5) * 60)
        if interval > 0 and (t - start) % interval < duration:
            every_n = max(1, int(self.num("boost_high", 3)))
            return "High" if ((t - start) // interval) % every_n == 0 else "Medium"
        return "Low"

    def look_ahead(self, now: int):
        """Next boost start/end, next change and its speed -- Parts 2b-2d of evaluate_speed."""
        b1s, b1e, b2s, b2e = self.blocks
        interval = int(self.num("boost_int", 30) * 60)
        duration = int(self.num("boost_dur", 5) * 60)
        nbs = nbe = current_end = 0
        if interval > 0 and duration > 0:
            for s, e in ((b1s, b1e), (b2s, b2e)):
                if e <= s or now >= e:
                    continue
                if now < s:
                    cand = s
                else:
                    phase = (now - s) % interval
                    if phase < duration:
                        current_end = min(now - phase + duration, e)
                    cand = now - phase + interval
                if cand < e:
                    nbs, nbe = cand, min(cand + duration, e)
                    break
        nxt = min((c for c in (b1s, b1e, b2s, b2e, nbs, nbe, current_end) if c > now), default=0)
        return nbs, nbe, nxt, (self.plan_at(nxt) if nxt else "Off")

    def desired(self, now: int) -> str:
        temp = self.reading("pool_temp")
        if temp is not None and temp < self.num("freeze_at", 3.0):  # Freeze Protection Temperature
            return "Low"
        if self.override != "Auto":
            return self.override
        speed = self.plan_at(now)
        if (speed == "Off" and self.sunset and (now < self.blocks[0] or now >= self.sunset)
                and temp is not None and temp > 28.0):
            return "Low"
        return speed

    # -- time

    def tick(self):
        self.wifi.tick()
        self.tick_updates()
        now = time.time()
        today = datetime.fromtimestamp(now).date()
        if not self.wifi.clock_ok:
            # No clock, no plan: the device can't place the blocks, and doesn't count the day.
            self.last_tick = now
            self.evaluate()
            return
        if self.computed_day != today:
            first = not self.seeded
            self.recompute(now)  # a no-op until there's a pool reading, a position and a timezone
            if first and self.computed_day == today:
                self.seeded = True
                # Start "Filtration Hours Today" where today's plan would have it.
                midnight = int(datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0).timestamp())
                self.filtration_s = sum(60 for t in range(midnight, int(now), 60) if self.plan_at(t) != "Off")
                self.counted_day = today
                if self.filtration_s > 600:
                    # As if the pump's earlier runs today had measured the water.
                    self.water_lo = round(self.temps["pool_temp"] - 0.3, 1)
                    self.water_hi = round(self.temps["pool_temp"] + 0.1, 1)
        # Override expiry (the 30s interval on the device).
        timeout = self.num("timeout")
        if self.override_since is not None and timeout > 0 and now - self.override_since >= timeout * 60:
            self.log(f"Manual Override '{self.override}' expired after {timeout:.0f} min -- back to Auto")
            self.set_override("Auto")
        # Filtration runtime.
        if self.counted_day is None:
            self.counted_day = today
        if self.counted_day != today:
            b1s, b1e, b2s, b2e = self.blocks
            self.history = [(self.counted_day, self.filtration_s, self.water_lo, self.water_hi,
                             b1e - b1s + b2e - b2s)] + self.history[:6]
            # A day the meter was off all day is unknown, not 0 L (fill-meter.yaml)
            measured = self.fill.day_measured
            self.fill_days = [round(self.fill_today) if measured else None] + self.fill_days[:29]
            if today.month != self.counted_day.month:
                self.fill_months = [0] + self.fill_months[:11]
            if measured:
                self.fill_months[0] = (self.fill_months[0] or 0) + round(self.fill_today)
            self.fill.day_measured = self.fill.enabled
            self.fill_today = 0.0
            self.filtration_s = 0.0
            self.counted_day = today
            self.water_lo = self.water_hi = None
        elif self.commanded != "Off":
            self.filtration_s += now - self.last_tick
        # The fill valve: 3 min at 14 L/min every quarter hour, or the mock's own tap (FillSim.tap_open). With the meter
        # off, the water still flows but nothing counts it.
        valve = 14.0 if int(now) % 900 < 180 or self.fill.tap_open(now) else 0.0
        self.flow = valve if self.fill.enabled else 0.0
        if self.fill.enabled:
            self.fill_carry += valve * (now - self.last_tick) / 60
            litres = int(self.fill_carry)
            if litres:  # whole pulses, as the meter counts them (1 L each)
                self.fill_carry -= litres
                self.volume += litres
                self.fill_today += litres
                self.fill.on_litres(now, litres)
        self.fill.tick(now)
        self.last_tick = now
        # Slow drift so the sensors look alive.
        if now - self.last_drift > 30:
            self.last_drift = now
            self.temps["pool_temp"] = min(29.5, max(24.0, self.temps["pool_temp"] + random.uniform(-0.05, 0.05)))
            self.temps["outdoor_temp"] += random.uniform(-0.1, 0.1)
            # Today's min/max: only readings after 10 min of pumping (the sensor is on the return pipe).
            if self.run_started is not None and now - self.run_started >= 600:
                v = round(self.temps["pool_temp"], 1)
                self.water_lo = v if self.water_lo is None else min(self.water_lo, v)
                self.water_hi = v if self.water_hi is None else max(self.water_hi, v)
        self.evaluate()

    def evaluate(self):
        desired = self.desired(int(time.time()))
        if desired != self.commanded:
            self.log(f"Pump: applying speed {desired}")
            if (self.commanded == "Off") != (desired == "Off"):
                self.run_started = None if desired == "Off" else time.time()
            self.commanded = desired

    # -- firmware updates (updates.yaml)

    @property
    def update_blocker(self) -> str | None:
        """What an install waits for (updates.h's gate_blocker): the override first, then a fill."""
        if self.override != "Auto":
            return "mode manuel"
        return "remplissage" if self.fill.running else None  # Fill Running, as updates.h's gate

    def tick_updates(self):
        hours = {"À la demande": 0, "6 h": 6, "24 h": 24, "7 j": 168}.get(self.selects.get(U["interval"]), 24)
        online = self.wifi.mode == "Connected"  # the releases are on the internet
        if self.updates.tick(bool(self.static.get(U["auto"])), hours if online else 0, self.update_blocker):
            self.reboot()

    def reboot(self, version: str | None = None):
        """The controller restarts, onto another firmware with `version`: the server drops the pages' streams."""
        if version:
            self.updates.boot_on(version)
        self.log(f"Rebooted on {self.updates.installed}")
        self.started = time.time()
        self.settings.login.boot()
        self.rebooted = True

    def install(self, origin: str):
        self.updates.install_request(origin, self.update_blocker)

    # -- actions (what the REST endpoints call)

    def set_override(self, option: str):
        self.selects[N["override"]] = option
        self.override_since = None if option == "Auto" else time.time()
        self.evaluate()

    def press(self, name: str):
        if name == N["apply"]:
            self.active = {k: self.num(k) for k in ("min", "max", "warm", "offset")}
            self.recompute(time.time())
        elif name == N["recompute"]:
            self.recompute(time.time())
        elif name == W["join"]:
            self.wifi.join()
        elif name == U["cancel"]:
            self.updates.cancel()
        elif name == U["check"]:
            if self.wifi.mode == "Connected":
                self.updates.check("on request")
            else:
                self.log("Check for update (on request): no network")
        elif name == F["detect"]:
            self.fill.detect(time.time())
        elif name == F["ack"]:
            self.fill.acknowledge(time.time())
        elif name == N["update_temps"]:
            for k in self.temps:
                self.temps[k] += random.uniform(-0.1, 0.1)
        elif name == S["generate_key"]:
            if self.settings.api_key_set:
                self.log("Generate API Key: a key is already set; Forget API Key first")
            else:
                self.settings.api_key_set = self.settings.key_generated = True
                self.log("API key generated and saved")
        elif name == S["forget_key"]:
            self.settings.api_key_set = self.settings.key_generated = False
            self.log("API key forgotten")
        elif name == S["rescan"]:
            self.log(f"Probe scan: {len(self.settings.bus)} on the bus")
        elif name == S["logout_all"]:
            self.settings.login.end_all("Logout All Devices")
        elif name == S["factory_reset"]:
            self.log("Factory reset: forgetting the page and OTA passwords, the API key and the saved Wi-Fi")
            self.settings.factory_reset()
            self.wifi.forget()
            self.started = time.time()  # the reboot
            self.log("Rebooted into setup mode, on the hotspot")
        self.evaluate()

    def set_number(self, name: str, value: float):
        self.numbers[name] = value
        if name == F["alarm_after"]:
            self.fill.alarm_minutes = int(round(value))
            self.fill.tick(time.time())
        if name == N["timeout"] and self.override_since is not None:
            self.override_since = time.time()  # editing the timeout restarts the clock
        self.evaluate()

    def fan_action(self, action: str):
        # The web UI can't pick a preset (the device's fan JSON has none), so
        # "on" lands on the fan's on_state default: Manual Override "Low".
        on = {"turn_on": True, "turn_off": False, "toggle": self.commanded == "Off"}[action]
        self.set_override("Low" if on else "Off")

    # -- what each entity shows right now

    def import_fill(self, text: str):
        """Fill Water Import (fill_import.h): writes a Fill Water Days / Months line into the record, as the firmware
        does, and says what it did -- the entity's state, never the line."""
        today = datetime.now().date()
        try:
            line = parse_fill_line(text)
            done = apply_fill_line(line, today, self.fill_days, self.fill_months)
        except ValueError as err:
            self.log(f"Fill water import refused ({len(text)} characters): {err}")
            self.fill_import_state = f"refusé : {err}"
            return
        self.log(f"Fill water import: {done['written']} {'months' if line[0] else 'days'} written, {done['unknown']} unknown, "
                 f"{done['open']} open (today / this month), {done['outside']} older than the record, "
                 f"{done['clamped']} capped at 65534 L; this month's closed days: {self.fill_months[0]} L")
        unit = "mois" if line[0] else "jours" if done["written"] > 1 else "jour"
        self.fill_import_state = f"importé : {done['written']} {unit}"

    def snapshot(self) -> dict:
        now = time.time()
        b1s, b1e, b2s, b2e = self.blocks
        nbs, nbe, nxt, nxt_speed = self.look_ahead(int(now))
        timeout = self.num("timeout")
        ends = "--"
        if self.override_since is not None and timeout > 0:
            ends = _stamp(self.override_since + timeout * 60)
        values = {
            N["pump"]: self.commanded != "Off",
            N["override"]: self.override,
            N["ends"]: ends,
            N["override_active"]: (self.override_since is not None and timeout <= 0
                                   and now - self.override_since > 30 * 60),
            N["commanded"]: self.commanded,
            N["planned"]: self.plan_at(int(now)),
            N["planned_hours"]: (b1e - b1s + b2e - b2s) / 3600.0,
            N["hours_today"]: self.filtration_s / 3600.0,
            N["history"]: ", ".join(_history_day(*day[:4]) for day in self.history) or "--",
            N["plan_history"]: ", ".join(_plan_day(day[0], day[4]) for day in self.history if day[4] is not None) or "--",
            N["water_min"]: self.water_lo,
            N["water_max"]: self.water_hi,
            N["b1s"]: _hhmm(b1s), N["b1e"]: _hhmm(b1e), N["b2s"]: _hhmm(b2s), N["b2e"]: _hhmm(b2e),
            N["next_change"]: _hhmm(nxt),
            N["next_speed"]: nxt_speed if nxt else "--",
            N["next_boost_start"]: _hhmm(nbs),
            N["next_boost_end"]: _hhmm(nbe),
            N["last_recompute"]: _stamp(self.last_recompute) if self.last_recompute else "Never",
            N["not_computed"]: b1s == 0 and b2s == 0 and (now - self.started > 300
                                                           or self.waiting_for() in ("position", "timezone")),
            N["pending"]: any(abs(self.num(k) - self.active[k]) > 0.01 for k in self.active),
            N["pool_temp"]: _round(self.reading("pool_temp")),
            N["pad_temp"]: _round(self.reading("pad_temp")),
            N["outdoor_temp"]: _round(self.reading("outdoor_temp")),
            # The API link to HA: the home network, and a key HA holds (it sets one as it pairs, or was given it).
            N["status"]: (self.wifi.mode == "Connected" and self.settings.api_key_set
                          and not self.settings.key_generated),
            N["flow"]: self.flow if self.fill.enabled else None,
            N["volume"]: round(self.volume) if self.fill.enabled else None,
            N["fill_today"]: round(self.fill_today) if self.fill.enabled else None,
            N["fill_days"]: _fill_line(self.counted_day - timedelta(days=1) if self.counted_day else None, self.fill_days),
            N["fill_months"]: _fill_line(datetime.now().strftime("%Y-%m"), self.fill_months),
            N["fill_import"]: self.fill_import_state,
            # The release it runs: Firmware below updates it (updates.yaml).
            N["fw_version"]: self.updates.installed,
            N["esphome_version"]: "2026.7.2 2026-11-17 18:05:00 +0000",
        }
        values.update(self.wifi.snapshot())
        values.update(self.settings.snapshot(self.wifi.saved, self.temps))
        values[S["waiting_for"]] = self.waiting_for() or "--"
        values[U["firmware"]] = self.updates.entity()
        values[U["status"]] = self.updates.status(self.update_blocker)
        values[U["auto"]] = bool(self.static.get(U["auto"]))
        values.update(self.static)
        values.update(self.numbers)
        values.update(self.fill.snapshot())
        values.update(self.selects)
        return values


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def _fill_line(head, values) -> str:
    """Fill Water Days / Months as the device prints them: "2026-11-16: 0 19 - 940 …"."""
    if head is None:
        return "--"
    return f"{head}: " + " ".join("-" if v is None else str(v) for v in values)


FILL_DAYS, FILL_MONTHS, FILL_DAY_MAX = 30, 12, 0xFFFE


def parse_fill_line(text: str):
    """A Fill Water Days / Months line -> (months?, newest date, [litres or None]), with fill_import.h's parse() rules;
    ValueError(reason, in the firmware's words) otherwise."""
    m = re.fullmatch(r" *(\d{4})-(\d{2})(?:-(\d{2}))?:((?: +\S+)+) *", text or "")
    if not m:
        raise ValueError("format (attendu « 2026-11-17: 0 19 - 940 » ou « 2026-11: 23 950 »)")
    months = m.group(3) is None
    try:
        date = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3) or 1)).date()
    except ValueError:
        raise ValueError("date invalide") from None
    if date.year < 2000:
        raise ValueError("date invalide")
    tokens = m.group(4).split()
    if len(tokens) > (FILL_MONTHS if months else FILL_DAYS):
        raise ValueError("trop de valeurs (30 jours ou 12 mois au plus)")
    values = []
    for tok in tokens:
        if tok != "-" and not (re.fullmatch(r"\d{1,10}", tok) and int(tok) < 0xFFFFFFFF):
            raise ValueError("valeur invalide (litres entiers >= 0, ou -)")
        values.append(None if tok == "-" else int(tok))
    return months, date, values


def apply_fill_line(line, today, days: list, months: list) -> dict:
    """fill_import.h's apply() on the mock's record, which is always dated yesterday (days) and this month (months):
    every closed day or month of the line, then this month's total as its closed days. ValueError for a future line."""
    is_months, date, values = line
    yesterday = today - timedelta(days=1)
    month_no = lambda d: d.year * 12 + d.month - 1  # noqa: E731
    if (month_no(date) > month_no(today)) if is_months else date > today:
        raise ValueError("date dans le futur")
    done = {"written": 0, "unknown": 0, "open": 0, "outside": 0, "clamped": 0}
    for k, v in enumerate(values):
        idx = month_no(today) - (month_no(date) - k) if is_months else (yesterday - (date - timedelta(days=k))).days
        if (idx == 0) if is_months else idx < 0:
            done["open"] += 1
        elif v is None:
            done["unknown"] += 1
        elif idx >= (FILL_MONTHS if is_months else FILL_DAYS):
            done["outside"] += 1
        else:
            if not is_months and v > FILL_DAY_MAX:
                v, done["clamped"] = FILL_DAY_MAX, done["clamped"] + 1
            (months if is_months else days)[idx] = v
            done["written"] += 1
    months[0] = sum(v or 0 for i, v in enumerate(days) if (yesterday - timedelta(days=i)).month == today.month
                    and (yesterday - timedelta(days=i)).year == today.year)
    return done


def _history_day(day, sec, lo, hi) -> str:
    """One day of Daily History, as the device's lambda prints it."""
    out = f"{day.isoformat()}: {int(sec // 3600)}.{int(sec % 3600 // 60 * 100 // 60):02d} h"
    return out if lo is None or hi is None else f"{out} {lo:.1f}/{hi:.1f} °C"


def _plan_day(day, sec) -> str:
    """One day of Daily Plan History, as the device's lambda prints it (minutes, like the device keeps it)."""
    m = round(sec / 60)
    return f"{day.isoformat()}: {m // 60}.{m % 60 * 100 // 60:02d} h"


# --------------------------------------------------------------------------- protocol


def _fmt(value: float, decimals: int) -> str:
    return f"{value:.{max(decimals, 0)}f}"


def _step_decimals(step: float) -> int:
    text = f"{step:.6f}".rstrip("0")
    return len(text.split(".")[1]) if "." in text else 0


def entity_json(e: Entity, value, detail_all: bool, options: list | None = None) -> dict:
    """The JSON the device sends for an entity -- see web_server.cpp's *_json_ methods. `options`: a
    select's options when they're set at run time (the probe roles), rather than the YAML's."""
    out = {"id": f"{e.domain}/{e.name}"}  # ESPHome 2026.11: "domain/Name" in `id`, no `name_id` any more
    if detail_all:
        out.update(domain=e.domain, name=e.name, icon=e.get("icon", ""),
                   entity_category={"config": 1, "diagnostic": 2}.get(e.get("entity_category", ""), 0))

    if e.domain == "sensor":
        uom = e.get("unit_of_measurement", "")
        acc = int(e.get("accuracy_decimals", 1))
        if value is None or (isinstance(value, float) and math.isnan(value)):
            out.update(value=None, state="NA")
        else:
            out.update(value=value, state=f"{_fmt(value, acc)} {uom}".strip())
        if detail_all and uom:
            out["uom"] = uom
    elif e.domain == "text_sensor":
        out.update(value=value, state=value)
    elif e.domain in ("binary_sensor", "fan", "switch"):
        out.update(value=bool(value), state="ON" if value else "OFF")
        if detail_all and e.domain == "switch":
            out["assumed_state"] = False
    elif e.domain == "number":
        step = float(e.get("step", 1))
        acc = _step_decimals(step)
        uom = e.get("unit_of_measurement", "")
        if value is None or (isinstance(value, float) and math.isnan(value)):
            out.update(value="NaN", state="NA")
        else:
            out.update(value=_fmt(value, acc), state=f"{_fmt(value, acc)} {uom}".strip())
        if detail_all:
            out.update(min_value=_fmt(float(e.get("min_value", 0)), acc),
                       max_value=_fmt(float(e.get("max_value", 100)), acc),
                       step=_fmt(step, acc), mode=NUMBER_MODES.get(str(e.get("mode", "auto")).lower(), 0))
            if uom:
                out["uom"] = uom
    elif e.domain == "select":
        out.update(value=value, state=value)
        if detail_all:
            out["option"] = list(options if options is not None else e.get("options", []))
    elif e.domain == "text":
        mode = TEXT_MODES.get(str(e.get("mode", "text")).lower(), 0)
        # Password mode masks `state` only; `value` is sent as-is (hence the firmware never publishes one).
        out.update(value=value, state="********" if mode == 1 else value,
                   min_length=int(e.get("min_length", 0)), max_length=int(e.get("max_length", 255)),
                   pattern=e.get("pattern", ""))
        if detail_all:
            out["mode"] = mode
    elif e.domain == "datetime":
        out.update(value=value, state=value)
    elif e.domain == "update":
        # web_server's update_json_: the latest version and the state with every event, the rest on connect.
        value = value or {}
        out.update(value=value.get("latest", ""), state=value.get("state", "UNKNOWN"))
        if detail_all:
            out.update(current_version=value.get("installed", ""), title="Pool Controller", summary="",
                       release_url=value.get("release_url", ""))

    if detail_all and e.weight is not None:
        out["sorting_weight"] = e.weight
        if e.group:
            out["sorting_group"] = e.group
    return out


def sse(event: str, data: str, event_id: int | None = None, retry: int | None = None) -> bytes:
    lines = []
    if retry is not None:
        lines.append(f"retry: {retry}")
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines += [f"data: {line}" for line in data.split("\n")]
    return ("\n".join(lines) + "\n\n").encode()


@functools.cache
def stock_index() -> str:
    """The v3 page the firmware embeds, decoded from the installed ESPHome package."""
    import esphome  # noqa: PLC0415 -- only needed to locate the page

    header = os.path.join(os.path.dirname(esphome.__file__), "components", "web_server", "server_index_v3.h")
    with open(header, encoding="utf-8") as f:
        source = f.read()
    match = re.search(r"INDEX_GZ\[\] PROGMEM = \{(.*?)\};", source, re.S)
    if not match:
        sys.exit(f"Couldn't find INDEX_GZ in {header} -- has ESPHome changed how it embeds the page?")
    data = bytes(int(b, 16) for b in re.findall(r"0x[0-9a-fA-F]{2}", match.group(1)))
    return gzip.decompress(data).decode("utf-8")


def device_index(web: dict) -> str:
    """The index.html the firmware serves for this web_server block: ESPHome's stock page with
    `local: true`, else the small page ESPHome builds around css_include / js_include / the URLs."""
    if web.get("local"):
        return stock_index()
    from esphome.components.web_server import build_index_html  # noqa: PLC0415 -- container only

    return build_index_html({
        "css_include": web.get("css_include"),
        "js_include": web.get("js_include"),
        "css_url": web.get("css_url", ""),
        "js_url": web.get("js_url", "https://oi.esphome.io/v3/www.js"),
    })


# --------------------------------------------------------------------------- server


class Client(queue.Queue):
    """One open event stream: what's left to send it, and the session it was opened with (None without one)."""

    def __init__(self, session: str | None = None):
        super().__init__()
        self.session = session


class MockServer:
    def __init__(self, config_path: str, index_path: str | None, extras: list[str] | None = None,
                 hotspot: bool = False, fresh: bool = False, released: bool = True,
                 fill_off: bool = False, long_fill: bool = False, idle_s: float = 6 * 3600):
        self.config_path = config_path
        self.index_path = index_path
        self.extras = extras or []
        self.lock = threading.RLock()
        self.clients: list[Client] = []
        self.reload_clients: list[Client] = []
        self.event_id = 0
        self.sim = PoolSim(self.log, hotspot, fresh, released, fill_off, long_fill, idle_s)
        self.layout = load_layout(config_path, self.extras)
        self.sim.adopt(self.layout.entities)
        self.sim.tick()
        self.sent = self.sim.snapshot()

    # -- helpers

    def entity(self, domain: str, name: str) -> Entity | None:
        return next((e for e in self.layout.entities if e.domain == domain and e.name == name), None)

    def options(self, e: Entity) -> list | None:
        """A select's options when the device sets them at run time (the probe role selects)."""
        return self.sim.settings.options() if e.domain == "select" and e.name in (S[r] for r in ROLES) else None

    def json(self, e: Entity, value, detail_all: bool) -> dict:
        return entity_json(e, value, detail_all, self.options(e))

    def next_id(self) -> int:
        self.event_id += 1
        return self.event_id

    def broadcast(self, payload: bytes, reload: bool = False):
        for q in list(self.reload_clients if reload else self.clients):
            q.put(payload)

    def log(self, message: str):
        print(f"[sim] {message}", flush=True)
        self.broadcast(sse("log", f"\033[0;32m[I][mock]: {message}\033[0m", self.next_id()))

    def close_ended_streams(self):
        """The device closes the event streams of a session that ended, and those opened without one once the
        gate is on: the page's EventSource reconnects, gets the gate's 401, and the page shows its login screen."""
        login = self.sim.settings.login
        for client in list(self.clients):
            if not login.check(client.session, refresh=False):
                client.put(None)

    def publish_changes(self):
        """Push a state event for every entity whose value moved since the last push."""
        with self.lock:
            snapshot = self.sim.snapshot()
            for e in self.layout.entities:
                value = snapshot.get(e.name)
                if self.sent.get(e.name) != value:
                    self.broadcast(sse("state", json.dumps(self.json(e, value, False))))
            self.sent = snapshot

    def assets(self) -> list[str]:
        """Files next to a custom --index page (scripts, styles), served as-is and watched for changes."""
        if not self.index_path:
            return []
        root = os.path.dirname(os.path.abspath(self.index_path))
        return [os.path.join(d, f) for d, _dirs, files in os.walk(root, followlinks=True) for f in files
                if os.path.splitext(f)[1] in STATIC_TYPES]

    def asset(self, url_path: str) -> str | None:
        if not self.index_path:
            return None
        root = os.path.dirname(os.path.abspath(self.index_path))
        candidate = os.path.abspath(os.path.join(root, url_path.lstrip("/")))
        return candidate if candidate in self.assets() else None

    def index_html(self) -> str:
        if self.index_path:
            with open(self.index_path, encoding="utf-8") as f:
                html = f.read()
        else:
            html = device_index(self.layout.web)
        return html.replace("</body>", RELOAD_SNIPPET + "</body>", 1) if "</body>" in html else html + RELOAD_SNIPPET

    def initial_events(self) -> list[bytes]:
        with self.lock:
            config = {"title": self.layout.title, "comment": "local mock", "ota": False,
                      "log": self.layout.log, "lang": "en", "uptime": int(time.time() - self.sim.started)}
            events = [sse("ping", json.dumps(config), self.next_id(), retry=30000)]
            events += [sse("sorting_group", json.dumps({"name": n, "sorting_weight": w})) for n, w in self.layout.groups]
            snapshot = self.sim.snapshot()
            events += [sse("state", json.dumps(self.json(e, snapshot.get(e.name), True))) for e in self.layout.entities]
            return events

    # -- REST actions: (status, body)

    def act(self, domain: str, name: str, action: str, params: dict) -> int:
        with self.lock:
            e = self.entity(domain, name)
            if e is None:
                return 404
            arg = lambda key: (params.get(key) or [None])[0]  # noqa: E731
            if domain == "button" and action == "press":
                self.log(f"'{name}' pressed")
                self.sim.press(name)
            elif domain == "select" and action == "set":
                option = arg("option")
                options = self.options(e)
                if option not in (options if options is not None else e.get("options", [])):
                    self.log(f"'{name}': invalid option {option!r}")
                    return 200  # the device also answers 200 and rejects it in the call
                self.log(f"'{name}' set to {option}")
                if name == N["override"]:
                    self.sim.set_override(option)
                elif options is not None:
                    self.sim.settings.set_role(name, option)
                else:
                    self.sim.selects[name] = option
            elif domain == "number" and action == "set":
                try:
                    value = float(arg("value"))
                except (TypeError, ValueError):
                    return 200
                lo, hi = float(e.get("min_value", 0)), float(e.get("max_value", 100))
                if not lo <= value <= hi:
                    self.log(f"'{name}': value {value} out of range [{lo}, {hi}] -- ignored")
                    return 200
                self.log(f"'{name}' set to {value:g}")
                if name in (S["latitude"], S["longitude"]):
                    self.sim.settings.set_position(name, value)
                    self.sim.computed_day = None  # recomputed with it, as plan_settings_changed
                else:
                    self.sim.set_number(name, value)
            elif domain == "fan" and action in ("turn_on", "turn_off", "toggle"):
                self.log(f"'{name}' {action}")
                if name == N["pump"]:
                    self.sim.fan_action(action)
                else:
                    self.sim.static[name] = {"turn_on": True, "turn_off": False}.get(action, not self.sim.static.get(name))
            elif domain == "text" and action == "set":
                value = arg("value") or ""
                if not int(e.get("min_length", 0)) <= len(value) <= int(e.get("max_length", 255)):
                    self.log(f"'{name}': length {len(value)} out of range -- ignored")
                    return 200
                settings = self.sim.settings
                if name == S["page_password"]:
                    settings.set_page_password(value)
                elif name == S["ota_password"]:
                    self.log(f"'{name}' set")
                elif name == S["api_key"]:
                    if _api_key_ok(value):
                        settings.api_key_set, settings.key_generated = True, False
                        self.log("API key saved")
                    else:
                        self.log("API key refused: not base64 of 32 bytes, or all zero")
                elif name == S["timezone"]:
                    if _valid_posix(value):
                        settings.timezone = value
                        self.sim.computed_day = None
                        self.log(f"Timezone: {value}")
                    else:
                        self.log(f"Timezone refused, not a POSIX TZ string: {value!r}")
                elif name == S["timezone_name"]:
                    if re.fullmatch(r"[A-Za-z0-9/_+-]{1,64}", value):
                        settings.timezone_name = value
                    else:
                        self.log(f"Timezone name refused: {value!r}")
                elif name == W["join_password"]:
                    self.log(f"'{name}' set")  # never echo it
                    self.sim.wifi.join_password = value
                elif name == W["join_ssid"]:
                    self.log(f"'{name}' set to {value!r}")
                    self.sim.wifi.join_ssid = value
                elif name == N["fill_import"]:
                    self.sim.import_fill(value)
                else:
                    self.sim.static[name] = value
            elif domain == "datetime" and action == "set":
                value = arg("value")
                if not value:
                    return 409
                if name == W["clock"]:
                    self.sim.wifi.set_clock(value)
                else:
                    self.sim.static[name] = value
            elif domain == "switch" and action in ("turn_on", "turn_off", "toggle") and name == F["enabled"]:
                self.sim.fill.set_enabled({"turn_on": True, "turn_off": False}.get(action, not self.sim.fill.enabled))
            elif domain == "switch" and action in ("turn_on", "turn_off", "toggle"):
                self.sim.static[name] = {"turn_on": True, "turn_off": False}.get(action, not self.sim.static.get(name))
                if name == U["auto"]:
                    self.log(f"Auto Update {'on' if self.sim.static[name] else 'off'}")
            elif domain == "update" and action == "install":
                self.sim.install("Home Assistant ou la page")
            else:
                return 404
            self.close_ended_streams()  # after a new Page Password, Logout All Devices
        self.publish_changes()
        return 200

    def reboot(self, version: str | None):
        """/__mock/reboot: the ticker drops every stream within a second, as the device's restart does."""
        with self.lock:
            self.sim.reboot(version)

    # -- background loops

    def ticker(self):
        last_ping = time.time()
        while True:
            time.sleep(1)
            with self.lock:
                self.sim.tick()
                rebooted, self.sim.rebooted = self.sim.rebooted, False
                self.close_ended_streams()  # sessions gone idle
            if rebooted:
                self.broadcast(None)  # the reboot: every page loses its stream and reconnects
                with self.lock:
                    self.sent = self.sim.snapshot()
                continue
            self.publish_changes()
            if time.time() - last_ping >= 10:
                last_ping = time.time()
                uptime = json.dumps({"uptime": int(time.time() - self.sim.started)})
                self.broadcast(sse("ping", uptime, self.next_id(), retry=30000))

    def watcher(self):
        def mtimes():
            paths = [self.config_path, *self.extras, *self.layout.packages, self.index_path, self.layout.css_include, self.layout.js_include,
                     *self.assets()]
            return {p: os.path.getmtime(p) for p in paths if p and os.path.exists(p)}

        seen = mtimes()
        while True:
            time.sleep(0.5)
            current = mtimes()
            if current == seen:
                continue
            seen = current
            try:
                layout = load_layout(self.config_path, self.extras)
            except Exception as exc:  # noqa: BLE001 -- keep serving the last good layout
                print(f"[mock] {self.config_path} didn't load, keeping the previous layout: {exc}", flush=True)
                continue
            with self.lock:
                self.layout = layout
                self.sim.adopt(layout.entities)
                self.sent = self.sim.snapshot()
            print(f"[mock] reloaded: {len(layout.entities)} entities", flush=True)
            self.broadcast(sse("reload", "{}"), reload=True)


def make_handler(mock: MockServer):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet GETs; the sim logs every action itself
            pass

        def send_body(self, status: int, body: bytes = b"", content_type: str = "text/plain"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def stream(self, clients: list, initial: list[bytes], session: str | None = None):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = Client(session)
            for event in initial:
                q.put(event)
            clients.append(q)
            try:
                while True:
                    try:
                        payload = q.get(timeout=15)
                    except queue.Empty:
                        payload = b": keep-alive\n\n"
                    if payload is None:  # the simulated controller rebooted
                        break
                    self.wfile.write(payload)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                clients.remove(q)
                self.close_connection = True

        def session(self) -> str | None:
            """The pool_session cookie this request carries, if any."""
            match = re.search(rf"(?:^|;)\s*{SESSION_COOKIE}=([0-9a-f]{{32}})\s*(?:;|$)", self.headers.get("Cookie") or "")
            return match.group(1) if match else None

        def gate(self, path: str) -> bool:
            """page_login's gate: once a Page Password is set, a request needs a live session, except for the page
            itself (its shell and code hold no state, and draw the login screen) and the login endpoints. A refused
            one gets a 401 with no WWW-Authenticate, so the browser never shows its own dialog."""
            if self.command == "OPTIONS" or path in LOGIN_PATHS or path.startswith("/__mock/"):
                return True
            if self.command == "GET" and (path in PAGE_PATHS or mock.asset(path)):
                return True
            with mock.lock:
                # The event stream isn't activity: an open tab streams forever.
                if mock.sim.settings.login.check(self.session(), refresh=path != "/events"):
                    return True
            self.send_body(401, b"Login required")
            return False

        def json_body(self, status: int, payload: dict, headers: dict | None = None):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def no_content(self, cookie: str | None = None):
            """A 204; with `cookie`, the session cookie to set ("" expires it)."""
            self.send_response(204)
            if cookie is not None:
                self.send_header("Set-Cookie", f"{SESSION_COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Strict"
                                 + ("" if cookie else "; Max-Age=0"))
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def login_endpoint(self, path: str, form: dict) -> bool:
            """GET /login/challenge, POST /login, GET /login/session, POST /logout: each a 204 in setup mode."""
            if LOGIN_PATHS.get(path) != self.command:
                return False
            with mock.lock:
                login = mock.sim.settings.login
                if not login.gated:
                    self.no_content()
                elif path == "/login/challenge":
                    self.json_body(200, {"nonce": login.challenge()})
                elif path == "/login":
                    arg = lambda key: (form.get(key) or [""])[0]  # noqa: E731
                    status, retry, token = login.login(arg("nonce"), arg("proof"), self.session())
                    if token:
                        self.no_content(token)
                    else:
                        self.json_body(status, {"retry_after": retry}, {"Retry-After": str(retry)} if status == 429 else None)
                elif path == "/login/session":
                    if login.check(self.session()):
                        self.no_content()
                    else:
                        self.send_body(401, b"Login required")
                else:
                    login.logout(self.session())
                    mock.close_ended_streams()
                    self.no_content("")
            return True

        def do_GET(self):  # noqa: N802 -- http.server API
            url = urlsplit(self.path)
            path = unquote(url.path)
            if not self.gate(path) or self.login_endpoint(path, {}):
                return None
            if path in ("/", "/index.html"):
                return self.send_body(200, mock.index_html().encode(), "text/html; charset=utf-8")
            if path == "/events":
                return self.stream(mock.clients, mock.initial_events(), self.session())
            if path == "/__mock/reload":
                return self.stream(mock.reload_clients, [])
            for route, attr, ctype in (("/0.css", "css_include", "text/css"), ("/0.js", "js_include", "text/javascript")):
                include = getattr(mock.layout, attr)
                if path == route and include and os.path.exists(include):
                    with open(include, "rb") as f:
                        return self.send_body(200, f.read(), ctype)
            asset = mock.asset(path)
            if asset:
                with open(asset, "rb") as f:
                    return self.send_body(200, f.read(), STATIC_TYPES[os.path.splitext(asset)[1]])
            parts = path.strip("/").split("/")
            if len(parts) == 2:
                with mock.lock:
                    e = mock.entity(*parts)
                    if e:
                        detail_all = parse_qs(url.query).get("detail") == ["all"]
                        body = json.dumps(mock.json(e, mock.sim.snapshot().get(e.name), detail_all))
                        return self.send_body(200, body.encode(), "application/json")
            return self.send_body(404)

        def do_POST(self):  # noqa: N802 -- http.server API
            url = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            path = unquote(url.path)
            params = {**parse_qs(body), **parse_qs(url.query)}
            if not self.gate(path) or self.login_endpoint(path, parse_qs(body)):
                return
            if path == "/__mock/reboot":
                mock.reboot((params.get("version") or [None])[0])
                return self.no_content()
            parts = [unquote(p) for p in url.path.strip("/").split("/")]
            status = mock.act(*parts, params) if len(parts) == 3 else 404
            self.send_body(status)

    return Handler


# --------------------------------------------------------------------------- entry points


def check(config_path: str, extras: list[str] | None = None) -> int:
    """Print the layout the page will show; fail on entities the mock can't render."""
    layout = load_layout(config_path, extras)
    print(f"{layout.title}: {len(layout.entities)} entities\n")
    order = {name: i for i, (name, _w) in enumerate(sorted(layout.groups, key=lambda g: g[1]))}
    by_group: dict[str, list[Entity]] = {}
    for e in layout.entities:
        by_group.setdefault(e.group or "(no sorting group)", []).append(e)
    for group in sorted(by_group, key=lambda g: order.get(g, len(order))):
        print(group)
        for e in sorted(by_group[group], key=lambda x: (x.weight if x.weight is not None else 50, x.name.lower())):
            mark = "" if e.name in SIMULATED else "   [static: not simulated]"
            print(f"  {e.weight if e.weight is not None else '-':>6}  {e.domain:<14} {e.name}{mark}")
        print()
    if layout.unsupported:
        print("Entities in domains the mock doesn't render yet:")
        for item in layout.unsupported:
            print(f"  {item}")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("config", help="path to the ESPHome YAML (pool-controller.yaml)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--index", help="serve this HTML file instead of the page the firmware serves")
    parser.add_argument("--check", action="store_true", help="print the layout and exit")
    parser.add_argument("--extra", action="append", default=[],
                        help="also load this YAML package's entities (repeatable), e.g. wifi-setup.yaml")
    parser.add_argument("--hotspot", action="store_true",
                        help="start on the fallback hotspot, with no clock")
    parser.add_argument("--no-release", action="store_true",
                        help="no firmware published yet (no manifest on GitHub Pages): every update check fails")
    parser.add_argument("--fill-off", action="store_true",
                        help="start with the fill meter turned off (Fill Meter)")
    parser.add_argument("--long-fill", action="store_true",
                        help="start with a fill running past Fill Alarm After: its alarm is on")
    parser.add_argument("--fresh", action="store_true",
                        help="start as a controller not set up yet (on its hotspot, nothing set)")
    parser.add_argument("--idle", type=float, default=6 * 3600, metavar="SECONDS",
                        help="end a login session after this long without a request (the device: 6 h)")
    args = parser.parse_args()

    if args.check:
        return check(args.config, args.extra)

    # PID 1 in the container ignores SIGTERM by default, so `docker stop` would
    # otherwise wait out its timeout and SIGKILL.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    mock = MockServer(args.config, args.index, args.extra, args.hotspot, args.fresh, not args.no_release,
                      args.fill_off, args.long_fill, args.idle)
    threading.Thread(target=mock.ticker, daemon=True).start()
    threading.Thread(target=mock.watcher, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(mock))
    server.daemon_threads = True
    print(f"[mock] {mock.layout.title}: {len(mock.layout.entities)} entities, serving on port {args.port}"
          f" ({'custom page ' + args.index if args.index else 'the page the firmware serves'})"
          f"{', fresh (not set up)' if args.fresh else ''}. Ctrl-C to stop.",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
