#!/usr/bin/env python3
"""`make transfer`: copies one controller's settings and on-device histories to
another, when a board is replaced (docs/plans/s3-panel.md, S9).

  dry run (default)  reads the source and prints every write it would make
  --apply            writes them to the target, in the contract's order, then
                     reads everything back over a new connection and exits
                     non-zero on any mismatch

The order of the writes:
  1. the schedule numbers, then Apply Filtration Config;
  2. Freeze Protection Temperature and Manual Override Timeout;
  3. Timezone (and its name), Latitude, Longitude;
  4. Pool/Pad/Outdoor Probe, after a Rescan Probes on the target;
  5. Fill Meter and Fill Alarm After;
  6. Fill Water Import: Fill Water Days, then Fill Water Months;
  7. History Import: daily:, plan:, outdoor:, pad:, today:;
  8. with --with-updates: Auto Update and Update Check Interval.

It never writes to the source: the source is opened through a reader that has
no write method. It doesn't move the passwords and the API key (write-only:
the wizard sets them), Wi-Fi, the update settings (unless --with-updates) or
the panel's settings, and says so at the end.

The keys (each controller's API encryption key, as Home Assistant has it) come
from the environment (TRANSFER_FROM_KEY, TRANSFER_TO_KEY) or a file
(--from-key-file, --to-key-file), never from the command line or the repo. No
key: the API is open (a controller not paired yet). Never prints a key.

Runs in the ESPHome image (aioesphomeapi), with `python3 -I`, like
tools/migrate/. Its tests (test_transfer.py, `make transfer-test`) run it
against a pair of fake controllers speaking the native API (fake_controller.py).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

API_PORT = 6053
CLIENT_INFO = "pool-controller make transfer"

# ------------------------------------------------------------- what moves
# Entity names as the firmware publishes them (English, never renamed).

SCHEDULE_NUMBERS = (
    "Min Filtration Hours",
    "Max Filtration Hours",
    "Warmest Part of Day Offset",
    "Filtration Hour Offset",
    "Boost Pulse Duration",
    "Boost Pulse Interval",
    "High Boost Frequency",
)
APPLY_FILTRATION = "Apply Filtration Config"
PROTECTION_NUMBERS = ("Freeze Protection Temperature", "Manual Override Timeout")
TIMEZONE = "Timezone"
TIMEZONE_NAME = "Timezone Name"
POSITION_NUMBERS = ("Latitude", "Longitude")
RESCAN_PROBES = "Rescan Probes"
PROBE_SELECTS = ("Pool Probe", "Pad Probe", "Outdoor Probe")
FILL_METER = "Fill Meter"
FILL_ALARM_AFTER = "Fill Alarm After"
FILL_IMPORT = "Fill Water Import"
FILL_DAYS = "Fill Water Days"
FILL_MONTHS = "Fill Water Months"
HISTORY_IMPORT = "History Import"
# History Import's tags, each with the sensor whose string it carries.
HISTORY_SENSORS = (
    ("daily", "Daily History"),
    ("plan", "Daily Plan History"),
    ("outdoor", "Daily Outdoor History"),
    ("pad", "Daily Equipment Pad History"),
)
FILTRATION_TODAY = "Filtration Hours Today"
FILL_TODAY = "Fill Water Today"
# today:'s ranges: key -> (min sensor, max sensor).
TODAY_RANGES = (
    ("water", "Pool Water Min Today", "Pool Water Max Today"),
    ("outdoor", "Outdoor Min Today", "Outdoor Max Today"),
    ("pad", "Equipment Pad Min Today", "Equipment Pad Max Today"),
)
AUTO_UPDATE = "Auto Update"
UPDATE_INTERVAL = "Update Check Interval"

NOT_MOVED = (
    "Page Password, OTA Password and API Key: write-only, the target's setup wizard sets them",
    "Wi-Fi: the target joins its network on its own (its hotspot, or New WiFi Network)",
    "Panel Language and Panel Sleep After: the panel's own settings",
)
NOT_MOVED_UPDATES = "Auto Update and Update Check Interval: pass --with-updates (make transfer WITH_UPDATES=1) to move them"


class TransferError(Exception):
    """A problem the user has to fix; the message says which."""


# ------------------------------------------------------------------ keys


def api_key_ok(text: str) -> bool:
    """Home Assistant's form of the key, as the firmware's decode_api_key: base64 of 32 bytes, not all zero."""
    if len(text) != 44 or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", text):
        return False
    try:
        raw = base64.b64decode(text, validate=True)
    except ValueError:
        return False
    return len(raw) == 32 and any(raw)


def read_key(env_name: str, file_path: str | None, environ=os.environ, label: str = "") -> str | None:
    """The key from its file, else from the environment; None when neither holds one (an open API).
    `label`: the make variable the user sets (FROM_KEY), for the message."""
    if file_path:
        try:
            key = Path(file_path).read_text(encoding="utf-8").strip()
        except OSError as err:
            raise TransferError(f"can't read the key file {file_path}: {err.strerror}") from err
        source = f"the key file {file_path}"
    else:
        key = (environ.get(env_name) or "").strip()
        source = label or env_name
    if not key:
        return None
    if not api_key_ok(key):
        raise TransferError(f"{source} doesn't hold an API key (base64 of 32 bytes, as Home Assistant shows it)")
    return key


# --------------------------------------------------------------- the device


def state_value(state) -> object:
    """An aioesphomeapi state as plain data: None when the device has no value."""
    if getattr(state, "missing_state", False):
        return None
    value = getattr(state, "state", None)
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


@dataclass
class Device:
    """What a controller said over one connection: its identity, entities and states."""

    host: str
    name: str = ""
    mac: str = ""
    version: str = ""
    entities: dict = field(default_factory=dict)  # name -> aioesphomeapi EntityInfo
    states: dict = field(default_factory=dict)  # name -> value (None = unknown)
    updates: dict = field(default_factory=dict)  # name -> state messages received

    def kind(self, name: str) -> str:
        """The entity's type, as aioesphomeapi names it without « Info » (NumberInfo -> Number)."""
        entity = self.entities.get(name)
        return type(entity).__name__.removesuffix("Info") if entity is not None else ""

    def has(self, name: str) -> bool:
        return name in self.entities

    def label(self) -> str:
        return f"{self.name or '?'} ({self.host}, {self.version or 'unknown version'})"


class Reader:
    """A read-only connection. It has no write method: the source is only ever opened through one."""

    def __init__(self, host: str, key: str | None, port: int = API_PORT):
        self.host, self.key, self.port = host, key, port
        self.client = None
        self.device = Device(host)
        self._changed = asyncio.Event()
        self._stopped = False

    async def __aenter__(self):
        await self.open()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def open(self) -> Device:
        from aioesphomeapi import APIClient

        self.client = APIClient(self.host, self.port, None, noise_psk=self.key, client_info=CLIENT_INFO)

        async def on_stop(expected_disconnect: bool) -> None:
            self._stopped = True
            self._changed.set()

        try:
            await asyncio.wait_for(self.client.connect(on_stop=on_stop, login=True), timeout=20)
        except Exception as err:
            raise TransferError(f"{self.host}: {describe_error(err)}") from err
        info, entities, _ = await self.client.device_info_and_list_entities()
        dev = self.device
        dev.name, dev.mac, dev.version = info.name, info.mac_address, info.project_version
        by_key = {}
        for entity in entities:
            dev.entities[entity.name] = entity
            by_key[entity.key] = entity.name

        def on_state(state) -> None:
            name = by_key.get(state.key)
            if name is not None:
                dev.states[name] = state_value(state)
                dev.updates[name] = dev.updates.get(name, 0) + 1
                self._changed.set()

        self.client.subscribe_states(on_state)
        return dev

    async def wait(self, done, timeout: float) -> bool:
        """Waits until done(device), the connection drops or the timeout."""
        deadline = time.monotonic() + timeout
        while not done(self.device):
            if self._stopped:
                raise TransferError(f"{self.host} closed the connection")
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), timeout=left)
            except asyncio.TimeoutError:
                return done(self.device)
        return True

    async def read_all(self, timeout: float = 10) -> Device:
        """Every entity's first state (the device sends them all on subscribing)."""
        stateful = [n for n, e in self.device.entities.items() if type(e).__name__ != "ButtonInfo"]
        await self.wait(lambda d: all(n in d.states for n in stateful), timeout)
        return self.device

    async def close(self) -> None:
        if self.client is not None and not self._stopped:
            await self.client.disconnect()


class Writer(Reader):
    """A connection to the target, which also writes."""

    def _entity(self, name: str):
        entity = self.device.entities.get(name)
        if entity is None:
            raise TransferError(f"the target has no « {name} »: is it on this branch's firmware?")
        return entity

    def send(self, name: str, value) -> None:
        entity = self._entity(name)
        kind = self.device.kind(name)
        if kind == "Number":
            self.client.number_command(entity.key, float(value))
        elif kind == "Select":
            self.client.select_command(entity.key, str(value))
        elif kind == "Text":
            self.client.text_command(entity.key, str(value))
        elif kind == "Switch":
            self.client.switch_command(entity.key, bool(value))
        elif kind == "Button":
            self.client.button_command(entity.key)
        else:
            raise TransferError(f"« {name} » is a {kind or 'missing entity'}, not something to write")


def describe_error(err: BaseException) -> str:
    kind = type(err).__name__
    if "Encryption" in kind or "Handshake" in kind or "RequiresEncryption" in kind or "InvalidAuth" in kind:
        return f"{kind}: wrong or missing API key (FROM_KEY / TO_KEY, or FROM_KEY_FILE / TO_KEY_FILE)"
    return f"{kind}: {err}" if str(err) else f"{kind}: no answer"


# ----------------------------------------------------------------- the plan


@dataclass(frozen=True)
class Step:
    """One write: a value for an entity, a button press, or an import line (whose outcome code is checked)."""

    group: str
    name: str
    value: object = None  # None for a button press
    imported: bool = False  # Fill Water Import / History Import: the entity's next state is the outcome code


def number_text(value: float) -> str:
    return f"{value:g}"


def temp_text(value: float) -> str:
    return f"{round(value * 10) / 10:.1f}"


def today_range(lo, hi) -> str:
    """`lo/hi` as the firmware prints tenths, or `-` when either is unknown."""
    if lo is None or hi is None:
        return "-"
    return f"{temp_text(lo)}/{temp_text(hi)}"


def today_line(source: Device, date: str) -> str:
    """History Import's today: line from the source's running values."""
    hours = source.states.get(FILTRATION_TODAY)
    minutes = min(24 * 60, max(0, round(hours * 60))) if isinstance(hours, (int, float)) else 0
    parts = [f"today:{date}", f"filtration={minutes}"]
    for key, lo, hi in TODAY_RANGES:
        if key == "pad" and not (source.has(lo) and source.has(hi)):
            continue  # an older source without the pad's sensors: the target keeps its own
        parts.append(f"{key}={today_range(source.states.get(lo), source.states.get(hi))}")
    fill = source.states.get(FILL_TODAY)
    parts.append(f"fill={round(fill) if isinstance(fill, (int, float)) else '-'}")
    return " ".join(parts)


def local_date(posix_tz: str | None, now: float | None = None) -> str:
    """Today's date in the controller's zone (its Timezone entity, a POSIX TZ string), as History Import wants it."""
    saved = os.environ.get("TZ")
    try:
        os.environ["TZ"] = posix_tz or "UTC0"
        time.tzset()
        return time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))
    finally:
        if saved is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved
        time.tzset()


def build_plan(source: Device, today: str, with_updates: bool = False) -> tuple[list, list]:
    """(steps, skipped): every write, in the contract's order, and what the source can't give (with why)."""
    steps: list = []
    skipped: list = []

    def value_of(group: str, name: str) -> None:
        if not source.has(name):
            skipped.append(f"{name}: the source has no such entity")
        elif source.states.get(name) is None:
            skipped.append(f"{name}: unknown on the source")
        else:
            steps.append(Step(group, name, source.states[name]))

    for name in SCHEDULE_NUMBERS:
        value_of("schedule", name)
    steps.append(Step("schedule", APPLY_FILTRATION))
    for name in PROTECTION_NUMBERS:
        value_of("protection", name)
    value_of("location", TIMEZONE)
    if source.states.get(TIMEZONE_NAME):  # empty: the target refuses an empty name, and the zone still moves
        steps.append(Step("location", TIMEZONE_NAME, source.states[TIMEZONE_NAME]))
    for name in POSITION_NUMBERS:
        value_of("location", name)
    steps.append(Step("probes", RESCAN_PROBES))
    for name in PROBE_SELECTS:
        value_of("probes", name)
    value_of("fill", FILL_METER)
    value_of("fill", FILL_ALARM_AFTER)
    for name in (FILL_DAYS, FILL_MONTHS):
        line = source.states.get(name)
        if not source.has(name):
            skipped.append(f"{name}: the source has no such entity")
        elif not line or line == "--":
            skipped.append(f"{name}: none on the source yet")
        else:
            steps.append(Step("fill water", FILL_IMPORT, line, imported=True))
    if source.has(HISTORY_SENSORS[0][1]):
        for tag, name in HISTORY_SENSORS:
            if source.has(name):
                steps.append(Step("history", HISTORY_IMPORT, f"{tag}:{source.states.get(name) or '--'}", imported=True))
            else:
                skipped.append(f"{name}: the source has no such entity")
        steps.append(Step("history", HISTORY_IMPORT, today_line(source, today), imported=True))
    else:
        skipped.append("the histories: the source has no Daily History")
    if with_updates:
        value_of("updates", AUTO_UPDATE)
        value_of("updates", UPDATE_INTERVAL)
    return steps, skipped


def show(value) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, float):
        return number_text(value)
    return f"« {value} »"


def describe_step(step: Step) -> str:
    if step.value is None:
        return f"press {step.name}"
    return f"{step.name} = {show(step.value)}"


# ------------------------------------------------------------ the transfer


@dataclass
class Report:
    """What the transfer did, for the summary and the exit status."""

    refused: list = field(default_factory=list)  # a write the target didn't take
    off_bus: list = field(default_factory=list)  # a probe role whose probe isn't on the target's bus
    mismatches: list = field(default_factory=list)

    def ok(self) -> bool:
        return not self.refused and not self.mismatches


def option_value(device: Device, name: str) -> list:
    return list(getattr(device.entities.get(name), "options", []) or [])


async def write_step(target: Writer, step: Step, report: Report, timeout: float) -> None:
    """Sends one write and waits for the target to show it (or the import's outcome code)."""
    dev = target.device
    if step.value is None:
        target.send(step.name, None)
        return
    if step.imported:
        before = dev.updates.get(step.name, 0)
        max_length = getattr(dev.entities.get(step.name), "max_length", 255) or 255
        if len(step.value.encode()) > max_length:
            report.refused.append(f"{step.name} {step.value[:40]}…: {len(step.value.encode())} bytes, over its {max_length}")
            return
        target.send(step.name, step.value)
        await target.wait(lambda d: d.updates.get(step.name, 0) > before, timeout)
        outcome = dev.states.get(step.name) if dev.updates.get(step.name, 0) > before else None
        print(f"    -> {outcome or 'no answer'}")
        if not (isinstance(outcome, str) and outcome.startswith("imported:")):
            report.refused.append(f"{step.name} « {step.value} »: {outcome or 'no answer within %g s' % timeout}")
        return
    target.send(step.name, step.value)
    if not await target.wait(lambda d: same(d.states.get(step.name), step.value), timeout):
        report.refused.append(f"{step.name}: sent {show(step.value)}, the target shows {show(dev.states.get(step.name))}")


def same(actual, expected) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual == expected
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return abs(actual - expected) <= 1e-6 * max(1.0, abs(expected))  # float32 over the API
    return actual == expected


async def apply(args, source: Device, steps: list, report: Report, to_key: str | None) -> float:
    """Writes the steps to the target. Returns when the histories were written (time.time()), for the check."""
    written_at = time.time()
    target = Writer(args.to_host, to_key, args.to_port)
    await target.open()
    try:
        await target.read_all()
        refuse_same_device(source, target.device)
        print(f"\nWriting to {target.device.label()}:")
        group = None
        probes_done = False
        for step in steps:
            if step.group != group:
                group = step.group
                print(f"  {group}")
            if step.group == "probes" and step.name in PROBE_SELECTS and not probes_done:
                # A select's options are listed once per connection, and Rescan Probes changes them.
                await asyncio.sleep(args.settle)
                await target.close()
                target = Writer(args.to_host, to_key, args.to_port)
                await target.open()
                await target.read_all()
                probes_done = True
            if step.group == "probes" and step.name in PROBE_SELECTS and step.value != "none":
                if step.value not in option_value(target.device, step.name):
                    print(f"    {step.name} = {show(step.value)}: not on the target's bus, left as it is")
                    report.off_bus.append(f"{step.name}: {step.value}")
                    continue
            print(f"    {describe_step(step)}")
            if step.group == "history" and step.value.startswith("today:"):
                written_at = time.time()
            await write_step(target, step, report, args.timeout)
        # The last writes reach the device before the connection closes.
        await asyncio.sleep(args.settle)
    finally:
        await target.close()
    return written_at


def refuse_same_device(source: Device, target: Device) -> None:
    if source.mac and source.mac == target.mac:
        raise TransferError(f"FROM and TO are the same controller ({source.name}, {source.mac}): nothing written")


# ------------------------------------------------------------------ checking


HISTORY_DAY = re.compile(r"(\d{4}-\d{2}-\d{2}): (?:(\d+\.\d{2}) h)?\s*(.*)")


def history_days(text) -> list | None:
    """A history string as [(date, hours or None, rest)], or None when it doesn't read."""
    if text in (None, ""):
        return None
    if text == "--":
        return []
    days = []
    for part in str(text).split(", "):
        m = HISTORY_DAY.fullmatch(part)
        if not m:
            return None
        days.append((m.group(1), float(m.group(2)) if m.group(2) else None, m.group(3)))
    return days


def same_history(actual, expected) -> bool:
    """Equal strings, hours within one minute (the sensors print hundredths of an hour)."""
    a, e = history_days(actual), history_days(expected)
    if a is None or e is None:
        return actual == expected
    if len(a) != len(e):
        return False
    for (ad, ah, ar), (ed, eh, er) in zip(a, e):
        if ad != ed or ar != er or (ah is None) != (eh is None):
            return False
        if ah is not None and abs(ah - eh) * 60 > 1 + 0.6:  # a minute, plus the hundredths' rounding
            return False
    return True


def expected_today(source: Device) -> dict:
    """The target's today sensors once today: is imported (None: unknown)."""
    want = {}
    for key, lo, hi in TODAY_RANGES:
        if key == "pad" and not (source.has(lo) and source.has(hi)):
            continue
        a, b = source.states.get(lo), source.states.get(hi)
        known = a is not None and b is not None
        want[lo] = round(a * 10) / 10 if known else None
        want[hi] = round(b * 10) / 10 if known else None
    return want


def check(source: Device, target: Device, steps: list, report: Report, elapsed_min: float) -> None:
    """Compares the target, read on a new connection, with what was written."""

    def mismatch(name: str, actual, expected) -> None:
        report.mismatches.append(f"{name}: the target shows {show(actual)}, the source {show(expected)}")

    off_bus = {entry.split(":")[0] for entry in report.off_bus}
    for step in steps:
        if step.value is None or step.imported or step.name in off_bus:
            continue
        if not same(target.states.get(step.name), step.value):
            mismatch(step.name, target.states.get(step.name), step.value)
    imported = {s.value.split(":", 1)[0] for s in steps if s.name == HISTORY_IMPORT}
    for tag, name in HISTORY_SENSORS:
        if tag in imported and not same_history(target.states.get(name), source.states.get(name) or "--"):
            mismatch(name, target.states.get(name), source.states.get(name))
    for name in (FILL_DAYS, FILL_MONTHS):
        if any(s.name == FILL_IMPORT and s.value == source.states.get(name) for s in steps):
            if target.states.get(name) != source.states.get(name):
                mismatch(name, target.states.get(name), source.states.get(name))
    if "today" in imported:
        for name, want in expected_today(source).items():
            got = target.states.get(name)
            if not ((got is None and want is None) or (got is not None and want is not None and abs(got - want) < 0.05)):
                mismatch(name, got, want)
        hours = source.states.get(FILTRATION_TODAY) or 0.0
        got = target.states.get(FILTRATION_TODAY)
        # The target's pump may run between the import and this read.
        if not isinstance(got, (int, float)) or not (-1 <= (got - hours) * 60 <= 1 + elapsed_min):
            mismatch(FILTRATION_TODAY, got, hours)
        fill = source.states.get(FILL_TODAY)
        got = target.states.get(FILL_TODAY)
        if (fill is None) != (got is None) or (fill is not None and round(fill) != round(got)):
            mismatch(FILL_TODAY, got, fill)


# ---------------------------------------------------------------------- main


def not_moved(with_updates: bool) -> list:
    return list(NOT_MOVED) + ([] if with_updates else [NOT_MOVED_UPDATES])


async def run(args) -> int:
    from_key = read_key("TRANSFER_FROM_KEY", args.from_key_file, label="FROM_KEY")
    to_key = read_key("TRANSFER_TO_KEY", args.to_key_file, label="TO_KEY") if args.apply else None
    print(f"Reading {args.from_host}…", flush=True)
    async with Reader(args.from_host, from_key, args.from_port) as reader:
        source = await reader.read_all()
    print(f"Source: {source.label()}")
    today = local_date(source.states.get(TIMEZONE), args.now)
    steps, skipped = build_plan(source, today, args.with_updates)

    print("\nIt would write, in this order:" if not args.apply else "\nThe writes, in this order:")
    group = None
    for step in steps:
        if step.group != group:
            group = step.group
            print(f"  {group}")
        print(f"    {describe_step(step)}")
    for line in skipped:
        print(f"  skipped: {line}")

    report = Report()
    if args.apply:
        written_at = await apply(args, source, steps, report, to_key)
        print("\nReading the target back…", flush=True)
        async with Reader(args.to_host, to_key, args.to_port) as reader:
            target = await reader.read_all()
        check(source, target, steps, report, (time.time() - written_at) / 60)

    print("\nNot moved:")
    for line in not_moved(args.with_updates):
        print(f"  - {line}")
    for line in report.off_bus:
        print(f"  - {line}: the probe isn't on the target's bus. Once it is wired there, "
              "press Rescan Probes and pick it on the target's page (Probes)")
    if not args.apply:
        print("\nDry run: nothing written. Add APPLY=1 to write to the target.")
        return 0
    for line in report.refused:
        print(f"refused: {line}", file=sys.stderr)
    for line in report.mismatches:
        print(f"mismatch: {line}", file=sys.stderr)
    if not report.ok():
        print(f"\nmake transfer: {len(report.refused)} write(s) refused, {len(report.mismatches)} mismatch(es).",
              file=sys.stderr)
        return 1
    print("\nChecked: every setting moved is equal on the target, and every history string is the source's.")
    return 0


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="from_host", required=True, help="the source controller (read only)")
    parser.add_argument("--to", dest="to_host", help="the target controller (needed with --apply)")
    parser.add_argument("--apply", action="store_true", help="write to the target, then check it")
    parser.add_argument("--with-updates", action="store_true", help="also move Auto Update and Update Check Interval")
    parser.add_argument("--from-key-file", help="a file holding the source's API key (else TRANSFER_FROM_KEY)")
    parser.add_argument("--to-key-file", help="a file holding the target's API key (else TRANSFER_TO_KEY)")
    parser.add_argument("--from-port", type=int, default=API_PORT, help=argparse.SUPPRESS)
    parser.add_argument("--to-port", type=int, default=API_PORT, help=argparse.SUPPRESS)
    parser.add_argument("--timeout", type=float, default=10, help="seconds to wait for the target to take a write")
    parser.add_argument("--settle", type=float, default=2, help=argparse.SUPPRESS)
    parser.add_argument("--now", type=float, help=argparse.SUPPRESS)  # tests: the clock today: is dated with
    args = parser.parse_args(argv)
    if args.apply and not args.to_host:
        parser.error("--apply needs --to")
    try:
        return asyncio.run(run(args))
    except TransferError as err:
        print(f"\nmake transfer: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
