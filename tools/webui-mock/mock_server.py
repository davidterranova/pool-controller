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
its timeout, the Apply gate, filtration hours) so the controls react the way
they do on the device. It is an approximation for UI work only: the firmware
in pool-controller.yaml is the source of truth for the control logic.

Usage (from the repo root; `make mock-ui` wraps this):
    python3 tools/webui-mock/mock_server.py pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --index my-page.html pool-controller.yaml
    python3 tools/webui-mock/mock_server.py --check pool-controller.yaml

Needs PyYAML, and the `esphome` package for the stock page -- both present in
the ghcr.io/esphome/esphome image the Makefile runs this in.
"""

import argparse
import gzip
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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

import yaml

# Domains the mock renders, in the order ESPHome's entity iterator sends them.
SUPPORTED_DOMAINS = ["binary_sensor", "fan", "sensor", "switch", "button", "text_sensor", "number", "select"]
# Entity domains ESPHome has that the mock doesn't simulate; --check fails on them
# so a new one can't silently go missing from the mock.
UNSUPPORTED_DOMAINS = [
    "alarm_control_panel", "climate", "cover", "datetime", "event", "light", "lock",
    "media_player", "text", "update", "valve", "water_heater",
]
NUMBER_MODES = {"auto": 0, "box": 1, "slider": 2}
# Per-platform defaults for what the YAML doesn't spell out.
SENSOR_DEFAULTS = {
    "dallas_temp": {"unit_of_measurement": "°C", "accuracy_decimals": 1},
    "pulse_meter": {"unit_of_measurement": "pulses/min", "accuracy_decimals": 2},
}

# Mock sun times (seconds after local midnight). The real ones come from the
# sun: component and the pool's coordinates, which stay in secrets.yaml.
MOCK_SUNRISE = 7 * 3600 + 45 * 60
MOCK_SUNSET = 17 * 3600 + 15 * 60

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


def load_layout(path: str) -> Layout:
    with open(path, encoding="utf-8") as f:
        config = yaml.load(f, Loader=_Loader) or {}

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
            if domain == "sensor":
                # Sub-sensors such as pulse_meter's `total:` are full sensors of their own.
                for key, sub in item.items():
                    if isinstance(sub, dict) and sub.get("name") and not sub.get("internal"):
                        entities.append(make("sensor", f"{platform}.{key}", sub))

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
    "pool_temp": "Pool Return Temperature",
    "pad_temp": "Equipment Pad Temperature",
    "outdoor_temp": "Outdoor Temperature",
    "update_temps": "Update Temperature Sensors Now",
    "status": "Status",
    "flow": "Piscine - Débit remplissage",
    "volume": "Piscine - Volume total remplissage",
}
SIMULATED = set(N.values())


def _hhmm(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "--:--"


def _stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


class PoolSim:
    """A pocket version of evaluate_speed and friends, driven by wall-clock time."""

    def __init__(self, log):
        self.log = log
        self.started = time.time()
        self.numbers: dict[str, float] = {}
        self.selects: dict[str, str] = {}
        self.static: dict[str, object] = {}  # values for entities the sim doesn't model
        self.temps = {"pool_temp": 26.4, "pad_temp": 21.8, "outdoor_temp": 17.5}
        self.flow = 0.0
        self.volume = 18342.0
        self.active: dict[str, float] = {}
        self.blocks = (0, 0, 0, 0)
        self.sunset = 0
        self.computed_day = None
        self.last_recompute = 0.0
        self.override_since: float | None = None
        self.commanded = "Off"
        self.filtration_s = 0.0
        self.counted_day = None
        self.last_tick = time.time()
        self.last_drift = time.time()

    # -- entity bookkeeping

    def adopt(self, entities):
        """Seed values for entities seen for the first time (keeps existing ones across reloads)."""
        for e in entities:
            if e.domain == "number" and e.name not in self.numbers:
                self.numbers[e.name] = float(e.get("initial_value", e.get("min_value", 0)))
            elif e.domain == "select" and e.name not in self.selects:
                options = e.get("options", [])
                self.selects[e.name] = e.get("initial_option", options[0] if options else "")
            elif e.name not in SIMULATED and e.name not in self.static:
                self.static[e.name] = {"sensor": 0.0, "binary_sensor": False, "fan": False,
                                       "switch": False, "text_sensor": "--"}.get(e.domain)
        if not self.active:
            self.active = {k: self.num(k) for k in ("min", "max", "warm", "offset")}

    def num(self, key: str, default: float = 0.0) -> float:
        return self.numbers.get(N[key], default)

    @property
    def override(self) -> str:
        return self.selects.get(N["override"], "Auto")

    # -- schedule

    def recompute(self, now: float):
        temp = self.temps["pool_temp"]
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
        temp = self.temps["pool_temp"]
        if temp < 3.0:
            return "Low"
        if self.override != "Auto":
            return self.override
        speed = self.plan_at(now)
        if speed == "Off" and self.sunset and (now < self.blocks[0] or now >= self.sunset) and temp > 28.0:
            return "Low"
        return speed

    # -- time

    def tick(self):
        now = time.time()
        today = datetime.fromtimestamp(now).date()
        if self.computed_day != today:
            first = self.computed_day is None
            self.recompute(now)
            if first:
                # Start "Filtration Hours Today" where today's plan would have it.
                midnight = int(datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0).timestamp())
                self.filtration_s = sum(60 for t in range(midnight, int(now), 60) if self.plan_at(t) != "Off")
                self.counted_day = today
        # Override expiry (the 30s interval on the device).
        timeout = self.num("timeout")
        if self.override_since is not None and timeout > 0 and now - self.override_since >= timeout * 60:
            self.log(f"Manual Override '{self.override}' expired after {timeout:.0f} min -- back to Auto")
            self.set_override("Auto")
        # Filtration runtime.
        if self.counted_day != today:
            self.filtration_s = 0.0
            self.counted_day = today
        elif self.commanded != "Off":
            self.filtration_s += now - self.last_tick
        self.last_tick = now
        # Slow drift so the sensors look alive.
        if now - self.last_drift > 30:
            self.last_drift = now
            self.temps["pool_temp"] = min(29.5, max(24.0, self.temps["pool_temp"] + random.uniform(-0.05, 0.05)))
            self.temps["outdoor_temp"] += random.uniform(-0.1, 0.1)
        self.evaluate()

    def evaluate(self):
        desired = self.desired(int(time.time()))
        if desired != self.commanded:
            self.log(f"Pump: applying speed {desired}")
            self.commanded = desired

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
        elif name == N["update_temps"]:
            for k in self.temps:
                self.temps[k] += random.uniform(-0.1, 0.1)
        self.evaluate()

    def set_number(self, name: str, value: float):
        self.numbers[name] = value
        if name == N["timeout"] and self.override_since is not None:
            self.override_since = time.time()  # editing the timeout restarts the clock
        self.evaluate()

    def fan_action(self, action: str):
        # The web UI can't pick a preset (the device's fan JSON has none), so
        # "on" lands on the fan's on_state default: Manual Override "Low".
        on = {"turn_on": True, "turn_off": False, "toggle": self.commanded == "Off"}[action]
        self.set_override("Low" if on else "Off")

    # -- what each entity shows right now

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
            N["b1s"]: _hhmm(b1s), N["b1e"]: _hhmm(b1e), N["b2s"]: _hhmm(b2s), N["b2e"]: _hhmm(b2e),
            N["next_change"]: _hhmm(nxt),
            N["next_speed"]: nxt_speed if nxt else "--",
            N["next_boost_start"]: _hhmm(nbs),
            N["next_boost_end"]: _hhmm(nbe),
            N["last_recompute"]: _stamp(self.last_recompute) if self.last_recompute else "Never",
            N["not_computed"]: b1s == 0 and b2s == 0 and now - self.started > 300,
            N["pending"]: any(abs(self.num(k) - self.active[k]) > 0.01 for k in self.active),
            N["pool_temp"]: round(self.temps["pool_temp"], 2),
            N["pad_temp"]: round(self.temps["pad_temp"], 2),
            N["outdoor_temp"]: round(self.temps["outdoor_temp"], 2),
            N["status"]: True,
            N["flow"]: self.flow,
            N["volume"]: self.volume,
        }
        values.update(self.static)
        values.update(self.numbers)
        values.update(self.selects)
        return values


# --------------------------------------------------------------------------- protocol


def _fmt(value: float, decimals: int) -> str:
    return f"{value:.{max(decimals, 0)}f}"


def _step_decimals(step: float) -> int:
    text = f"{step:.6f}".rstrip("0")
    return len(text.split(".")[1]) if "." in text else 0


def entity_json(e: Entity, value, detail_all: bool) -> dict:
    """The JSON the device sends for an entity -- see web_server.cpp's *_json_ methods."""
    out = {"name_id": f"{e.domain}/{e.name}", "id": f"{e.domain}-{e.object_id}"}
    if detail_all:
        out.update(domain=e.domain, name=e.name, icon=e.get("icon", ""), entity_category=0)

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
            out["option"] = list(e.get("options", []))

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


# --------------------------------------------------------------------------- server


class MockServer:
    def __init__(self, config_path: str, index_path: str | None):
        self.config_path = config_path
        self.index_path = index_path
        self.lock = threading.RLock()
        self.clients: list[queue.Queue] = []
        self.reload_clients: list[queue.Queue] = []
        self.event_id = 0
        self.sim = PoolSim(self.log)
        self.layout = load_layout(config_path)
        self.sim.adopt(self.layout.entities)
        self.sim.tick()
        self.sent = self.sim.snapshot()
        self.stock = None if index_path else stock_index()

    # -- helpers

    def entity(self, domain: str, name: str) -> Entity | None:
        return next((e for e in self.layout.entities if e.domain == domain and e.name == name), None)

    def next_id(self) -> int:
        self.event_id += 1
        return self.event_id

    def broadcast(self, payload: bytes, reload: bool = False):
        for q in list(self.reload_clients if reload else self.clients):
            q.put(payload)

    def log(self, message: str):
        print(f"[sim] {message}", flush=True)
        self.broadcast(sse("log", f"\033[0;32m[I][mock]: {message}\033[0m", self.next_id()))

    def publish_changes(self):
        """Push a state event for every entity whose value moved since the last push."""
        with self.lock:
            snapshot = self.sim.snapshot()
            for e in self.layout.entities:
                value = snapshot.get(e.name)
                if self.sent.get(e.name) != value:
                    self.broadcast(sse("state", json.dumps(entity_json(e, value, False))))
            self.sent = snapshot

    def index_html(self) -> str:
        if self.index_path:
            with open(self.index_path, encoding="utf-8") as f:
                html = f.read()
        else:
            html = self.stock
        return html.replace("</body>", RELOAD_SNIPPET + "</body>", 1) if "</body>" in html else html + RELOAD_SNIPPET

    def initial_events(self) -> list[bytes]:
        with self.lock:
            config = {"title": self.layout.title, "comment": "local mock", "ota": False,
                      "log": self.layout.log, "lang": "en", "uptime": int(time.time() - self.sim.started)}
            events = [sse("ping", json.dumps(config), self.next_id(), retry=30000)]
            events += [sse("sorting_group", json.dumps({"name": n, "sorting_weight": w})) for n, w in self.layout.groups]
            snapshot = self.sim.snapshot()
            events += [sse("state", json.dumps(entity_json(e, snapshot.get(e.name), True))) for e in self.layout.entities]
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
                if option not in e.get("options", []):
                    self.log(f"'{name}': invalid option {option!r}")
                    return 200  # the device also answers 200 and rejects it in the call
                self.log(f"'{name}' set to {option}")
                if name == N["override"]:
                    self.sim.set_override(option)
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
                self.sim.set_number(name, value)
            elif domain == "fan" and action in ("turn_on", "turn_off", "toggle"):
                self.log(f"'{name}' {action}")
                if name == N["pump"]:
                    self.sim.fan_action(action)
                else:
                    self.sim.static[name] = {"turn_on": True, "turn_off": False}.get(action, not self.sim.static.get(name))
            elif domain == "switch" and action in ("turn_on", "turn_off", "toggle"):
                self.sim.static[name] = {"turn_on": True, "turn_off": False}.get(action, not self.sim.static.get(name))
            else:
                return 404
        self.publish_changes()
        return 200

    # -- background loops

    def ticker(self):
        last_ping = time.time()
        while True:
            time.sleep(1)
            with self.lock:
                self.sim.tick()
            self.publish_changes()
            if time.time() - last_ping >= 10:
                last_ping = time.time()
                uptime = json.dumps({"uptime": int(time.time() - self.sim.started)})
                self.broadcast(sse("ping", uptime, self.next_id(), retry=30000))

    def watcher(self):
        def mtimes():
            paths = [self.config_path, self.index_path, self.layout.css_include, self.layout.js_include]
            return {p: os.path.getmtime(p) for p in paths if p and os.path.exists(p)}

        seen = mtimes()
        while True:
            time.sleep(0.5)
            current = mtimes()
            if current == seen:
                continue
            seen = current
            try:
                layout = load_layout(self.config_path)
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

        def stream(self, clients: list, initial: list[bytes]):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q: queue.Queue = queue.Queue()
            for event in initial:
                q.put(event)
            clients.append(q)
            try:
                while True:
                    try:
                        payload = q.get(timeout=15)
                    except queue.Empty:
                        payload = b": keep-alive\n\n"
                    self.wfile.write(payload)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                clients.remove(q)
                self.close_connection = True

        def do_GET(self):  # noqa: N802 -- http.server API
            url = urlsplit(self.path)
            path = unquote(url.path)
            if path in ("/", "/index.html"):
                return self.send_body(200, mock.index_html().encode(), "text/html; charset=utf-8")
            if path == "/events":
                return self.stream(mock.clients, mock.initial_events())
            if path == "/__mock/reload":
                return self.stream(mock.reload_clients, [])
            for route, attr, ctype in (("/0.css", "css_include", "text/css"), ("/0.js", "js_include", "text/javascript")):
                include = getattr(mock.layout, attr)
                if path == route and include and os.path.exists(include):
                    with open(include, "rb") as f:
                        return self.send_body(200, f.read(), ctype)
            parts = path.strip("/").split("/")
            if len(parts) == 2:
                with mock.lock:
                    e = mock.entity(*parts)
                    if e:
                        detail_all = parse_qs(url.query).get("detail") == ["all"]
                        body = json.dumps(entity_json(e, mock.sim.snapshot().get(e.name), detail_all))
                        return self.send_body(200, body.encode(), "application/json")
            return self.send_body(404)

        def do_POST(self):  # noqa: N802 -- http.server API
            url = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            params = {**parse_qs(body), **parse_qs(url.query)}
            parts = [unquote(p) for p in url.path.strip("/").split("/")]
            status = mock.act(*parts, params) if len(parts) == 3 else 404
            self.send_body(status)

    return Handler


# --------------------------------------------------------------------------- entry points


def check(config_path: str) -> int:
    """Print the layout the page will show; fail on entities the mock can't render."""
    layout = load_layout(config_path)
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
    parser.add_argument("--index", help="serve this HTML file instead of ESPHome's stock v3 page")
    parser.add_argument("--check", action="store_true", help="print the layout and exit")
    args = parser.parse_args()

    if args.check:
        return check(args.config)

    # PID 1 in the container ignores SIGTERM by default, so `docker stop` would
    # otherwise wait out its timeout and SIGKILL.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    mock = MockServer(args.config, args.index)
    threading.Thread(target=mock.ticker, daemon=True).start()
    threading.Thread(target=mock.watcher, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(mock))
    server.daemon_threads = True
    print(f"[mock] {mock.layout.title}: {len(mock.layout.entities)} entities, serving on port {args.port}"
          f" ({'custom page ' + args.index if args.index else 'stock ESPHome v3 page'}). Ctrl-C to stop.",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
