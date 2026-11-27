#!/usr/bin/env python3
"""transfer.py's tests (`make transfer-test`): the plan, the checks, and whole
runs against a pair of fake controllers on 127.0.0.1 (fake_controller.py).
Made-up values only: no key, no real controller."""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import transfer  # noqa: E402
from fake_controller import FakeController  # noqa: E402

# 2026-11-26 10:00 UTC, 11:00 in Paris.
NOW = 1795687200.0
PARIS = "CET-1CEST,M3.5.0,M10.5.0/3"
KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="

SOURCE = {
    "Min Filtration Hours": 3.0,
    "Max Filtration Hours": 10.5,
    "Warmest Part of Day Offset": 1.25,
    "Filtration Hour Offset": -1.5,
    "Boost Pulse Duration": 4.0,
    "Boost Pulse Interval": 20.0,
    "High Boost Frequency": 3.0,
    "Freeze Protection Temperature": 2.5,
    "Manual Override Timeout": 90.0,
    "Manual Override": "Low",
    "Timezone": PARIS,
    "Timezone Name": "Europe/Paris",
    "Latitude": 48.85,
    "Longitude": 2.35,
    "Pool Probe": "28ff000000000001",
    "Pad Probe": "28ff000000000002",
    "Outdoor Probe": "none",
    "Fill Meter": True,
    "Fill Alarm After": 45.0,
    "Fill Water Days": "2026-11-25: 0 19 - 940 0",
    "Fill Water Months": "2026-11: 959 1200 -",
    "Fill Water Today": 12.0,
    "Fill Water Import": None,
    "History Import": None,
    "Daily History": "2026-11-25: 6.42 h 25.9/26.6 °C, 2026-11-24: 6.70 h",
    "Daily Plan History": "2026-11-25: 6.50 h, 2026-11-24: 6.50 h",
    "Daily Outdoor History": "2026-11-25: -1.4/9.8 °C",
    "Daily Equipment Pad History": "--",
    "Filtration Hours Today": 1.5,
    "Pool Water Min Today": 25.9,
    "Pool Water Max Today": 26.2,
    "Outdoor Min Today": -0.5,
    "Outdoor Max Today": 7.1,
    "Equipment Pad Min Today": None,
    "Equipment Pad Max Today": None,
    "Auto Update": True,
    "Update Check Interval": "24h",
    "Page Password": None,
    "API Key": None,
    "Panel Language": None,
    "Manual Override Active": True,
}

# A fresh board: the defaults, an empty record, one of the source's probes on its bus.
TARGET = {
    "Min Filtration Hours": 2.0,
    "Max Filtration Hours": 12.0,
    "Warmest Part of Day Offset": 0.0,
    "Filtration Hour Offset": 0.0,
    "Boost Pulse Duration": 5.0,
    "Boost Pulse Interval": 30.0,
    "High Boost Frequency": 4.0,
    "Freeze Protection Temperature": 1.0,
    "Manual Override Timeout": 120.0,
    "Manual Override": "Auto",
    "Timezone": "",
    "Timezone Name": "",
    "Latitude": 0.0,
    "Longitude": 0.0,
    "Pool Probe": "none",
    "Pad Probe": "none",
    "Outdoor Probe": "none",
    "Fill Meter": False,
    "Fill Alarm After": 60.0,
    "Fill Water Days": "--",
    "Fill Water Months": "--",
    "Fill Water Today": None,
    "Daily History": "--",
    "Daily Plan History": "--",
    "Daily Outdoor History": "--",
    "Daily Equipment Pad History": "--",
    "Filtration Hours Today": 0.0,
    "Auto Update": False,
    "Update Check Interval": "on_request",
    "Panel Language": "en",
}

CONTRACT_ORDER = [
    "Min Filtration Hours", "Max Filtration Hours", "Warmest Part of Day Offset", "Filtration Hour Offset",
    "Boost Pulse Duration", "Boost Pulse Interval", "High Boost Frequency", "Apply Filtration Config",
    "Freeze Protection Temperature", "Manual Override Timeout",
    "Timezone", "Timezone Name", "Latitude", "Longitude",
    "Rescan Probes", "Pool Probe", "Pad Probe", "Outdoor Probe",
    "Fill Meter", "Fill Alarm After",
    "Fill Water Import", "Fill Water Import",
    "History Import", "History Import", "History Import", "History Import", "History Import",
]


def device(states: dict, entities=None) -> transfer.Device:
    """A Device as a Reader leaves it, without a connection."""

    class Info:
        def __init__(self, name):
            self.name = name

    dev = transfer.Device("test")
    for name in entities if entities is not None else states:
        dev.entities[name] = Info(name)
    dev.states = dict(states)
    return dev


class PlanTest(unittest.TestCase):
    def test_today_line(self):
        line = transfer.today_line(device(SOURCE), "2026-11-26")
        self.assertEqual(line, "today:2026-11-26 filtration=90 water=25.9/26.2 outdoor=-0.5/7.1 pad=- fill=12")

    def test_today_line_unknowns_and_an_older_source(self):
        states = {k: v for k, v in SOURCE.items() if not k.startswith("Equipment Pad")}
        states.update({"Fill Water Today": None, "Pool Water Max Today": None, "Filtration Hours Today": 24.2})
        line = transfer.today_line(device(states), "2026-11-26")
        self.assertEqual(line, "today:2026-11-26 filtration=1440 water=- outdoor=-0.5/7.1 fill=-")

    def test_float32_temperatures_print_as_the_firmware_does(self):
        self.assertEqual(transfer.today_range(25.899999618530273, -0.5000001), "25.9/-0.5")

    def test_local_date_is_the_controllers(self):
        late = 1795734000.0  # 2026-11-26 23:00 UTC: already the 27th in Paris
        self.assertEqual(transfer.local_date(PARIS, late), "2026-11-27")
        self.assertEqual(transfer.local_date("", late), "2026-11-26")

    def test_order_and_lines(self):
        steps, skipped = transfer.build_plan(device(SOURCE), "2026-11-26")
        self.assertEqual([s.name for s in steps], CONTRACT_ORDER)
        lines = [s.value for s in steps if s.imported]
        self.assertEqual(lines, [
            "2026-11-25: 0 19 - 940 0",
            "2026-11: 959 1200 -",
            "daily:2026-11-25: 6.42 h 25.9/26.6 °C, 2026-11-24: 6.70 h",
            "plan:2026-11-25: 6.50 h, 2026-11-24: 6.50 h",
            "outdoor:2026-11-25: -1.4/9.8 °C",
            "pad:--",
            "today:2026-11-26 filtration=90 water=25.9/26.2 outdoor=-0.5/7.1 pad=- fill=12",
        ])
        self.assertEqual(skipped, [])

    def test_never_moves_what_it_must_not(self):
        steps, _ = transfer.build_plan(device(SOURCE), "2026-11-26")
        names = {s.name for s in steps}
        for name in ("Manual Override", "Page Password", "API Key", "Panel Language", "Auto Update", "Update Check Interval"):
            self.assertNotIn(name, names)
        steps, _ = transfer.build_plan(device(SOURCE), "2026-11-26", with_updates=True)
        self.assertEqual([s.name for s in steps][-2:], ["Auto Update", "Update Check Interval"])

    def test_skips_what_the_source_lacks(self):
        states = dict(SOURCE, **{"Fill Water Days": "--", "Timezone Name": "", "Boost Pulse Duration": None})
        del states["Daily History"]
        steps, skipped = transfer.build_plan(device(states), "2026-11-26")
        names = [s.name for s in steps]
        self.assertNotIn("Timezone Name", names)
        self.assertNotIn("History Import", names)
        self.assertEqual(names.count("Fill Water Import"), 1)
        self.assertEqual(skipped, [
            "Boost Pulse Duration: unknown on the source",
            "Fill Water Days: none on the source yet",
            "the histories: the source has no Daily History",
        ])


class CheckTest(unittest.TestCase):
    def test_history_hours_within_a_minute(self):
        same = transfer.same_history
        self.assertTrue(same("2026-11-25: 6.42 h 25.9/26.6 °C", "2026-11-25: 6.42 h 25.9/26.6 °C"))
        self.assertTrue(same("2026-11-25: 6.43 h 25.9/26.6 °C", "2026-11-25: 6.41 h 25.9/26.6 °C"))
        self.assertFalse(same("2026-11-25: 6.45 h 25.9/26.6 °C", "2026-11-25: 6.42 h 25.9/26.6 °C"))
        self.assertFalse(same("2026-11-25: 6.42 h 25.9/26.7 °C", "2026-11-25: 6.42 h 25.9/26.6 °C"))
        self.assertFalse(same("2026-11-25: 6.42 h", "2026-11-25: 6.42 h, 2026-11-24: 6.70 h"))
        self.assertTrue(same("--", "--"))
        self.assertTrue(same("2026-11-25: -1.4/9.8 °C", "2026-11-25: -1.4/9.8 °C"))
        self.assertFalse(same(None, "--"))

    def test_numbers_compare_as_float32(self):
        self.assertTrue(transfer.same(48.849998474121094, 48.85))
        self.assertFalse(transfer.same(48.86, 48.85))
        self.assertTrue(transfer.same(True, True))
        self.assertFalse(transfer.same(1.0, True))


class KeyTest(unittest.TestCase):
    def test_from_the_environment_or_a_file(self):
        self.assertEqual(transfer.read_key("K", None, {"K": f" {KEY}\n"}), KEY)
        self.assertIsNone(transfer.read_key("K", None, {}))
        with tempfile.NamedTemporaryFile("w", suffix=".key") as f:
            f.write(KEY + "\n")
            f.flush()
            self.assertEqual(transfer.read_key("K", f.name, {"K": "ignored"}), KEY)

    def test_refuses_what_isnt_a_key_and_never_prints_it(self):
        with self.assertRaises(transfer.TransferError) as err:
            transfer.read_key("K", None, {"K": "not-a-key-but-a-secret"})
        self.assertNotIn("not-a-key-but-a-secret", str(err.exception))
        with self.assertRaises(transfer.TransferError):
            transfer.read_key("K", "/nonexistent/key", {})


class RunTest(unittest.TestCase):
    """Whole runs, transfer.main against two fake controllers."""

    def setUp(self):
        self.loop = asyncio.new_event_loop()
        self.source = FakeController("pool-controller", "AA:BB:CC:00:00:01", SOURCE, version="v1.17.0")
        self.target = FakeController("pool-panel-bench", "AA:BB:CC:00:00:02", TARGET, bus=["28ff000000000001"])

    def tearDown(self):
        self.loop.close()

    def run_main(self, *extra, apply=True, target=None):
        target = target or self.target

        async def go():
            await self.source.start()
            await target.start()
            argv = ["--from", "127.0.0.1", "--from-port", str(self.source.port), "--now", str(NOW),
                    "--settle", "0.2", "--timeout", "2", *extra]
            if apply:
                argv += ["--apply", "--to", "127.0.0.1", "--to-port", str(target.port)]
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = await asyncio.to_thread(transfer.main, argv)
            await self.source.stop()
            await target.stop()
            return code, out.getvalue(), err.getvalue()

        return self.loop.run_until_complete(go())

    def test_apply_writes_in_order_then_checks(self):
        code, out, err = self.run_main()
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.source.writes, [], "never writes to the source")
        names = [name for name, _ in self.target.writes]
        # The Pad Probe's probe isn't on the target's bus: not written.
        self.assertEqual(names, [n for n in CONTRACT_ORDER if n != "Pad Probe"])
        for name in ("Min Filtration Hours", "Latitude", "Timezone", "Pool Probe", "Fill Meter", "Daily History",
                     "Daily Outdoor History", "Fill Water Days", "Fill Water Months", "Outdoor Min Today"):
            self.assertTrue(transfer.same(self.target.states[name], SOURCE[name]) or
                            abs(self.target.states[name] - SOURCE[name]) < 1e-3, name)
        self.assertEqual(self.target.states["Manual Override"], "Auto")
        self.assertEqual(self.target.states["Panel Language"], "en")
        self.assertEqual(self.target.states["Auto Update"], False)
        self.assertIn("Pad Probe: 28ff000000000002: the probe isn't on the target's bus", out)
        self.assertIn("Page Password, OTA Password and API Key", out)
        self.assertIn("Checked:", out)

    def test_dry_run_writes_nothing(self):
        code, out, err = self.run_main(apply=False)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.source.writes, [])
        self.assertEqual(self.target.connections, 0)
        self.assertIn("Dry run: nothing written", out)
        for name in CONTRACT_ORDER:
            self.assertIn(name, out)
        self.assertIn("daily:2026-11-25: 6.42 h 25.9/26.6 °C", out)

    def test_with_updates(self):
        code, out, err = self.run_main("--with-updates")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.target.states["Auto Update"], True)
        self.assertEqual(self.target.states["Update Check Interval"], "24h")
        self.assertNotIn("pass --with-updates", out)

    def test_a_refused_import_fails_the_run(self):
        target = FakeController("pool-panel-bench", "AA:BB:CC:00:00:02", TARGET, refuse={"plan"})
        code, out, err = self.run_main(target=target)
        self.assertEqual(code, 1)
        self.assertIn("refused: History Import « plan:2026-11-25", err)
        self.assertIn("mismatch: Daily Plan History", err)
        self.assertEqual(self.source.writes, [])

    def test_a_target_that_doesnt_keep_a_value_fails_the_check(self):
        target = FakeController("pool-panel-bench", "AA:BB:CC:00:00:02", TARGET)
        target.entities["Fill Alarm After"] = ("number", {"min_value": 0, "max_value": 1440, "step": 5})
        original = target._command

        def stuck(name, value):  # a firmware that ignores Fill Alarm After
            if name == "Fill Alarm After":
                target.writes.append((name, value))
                return
            original(name, value)

        target._command = stuck
        code, out, err = self.run_main(target=target)
        self.assertEqual(code, 1)
        self.assertIn("Fill Alarm After: sent 45, the target shows 60", err)
        self.assertIn("mismatch: Fill Alarm After", err)

    def test_the_same_controller_twice_is_refused(self):
        target = FakeController("pool-controller", "AA:BB:CC:00:00:01", SOURCE)
        code, out, err = self.run_main(target=target)
        self.assertEqual(code, 1)
        self.assertIn("FROM and TO are the same controller", err)
        self.assertEqual(target.writes, [])

    def test_a_target_without_history_import(self):
        entities = {k: v for k, v in FakeController("x", "x", {}).entities.items() if k != "History Import"}
        target = FakeController("pool-panel-bench", "AA:BB:CC:00:00:02", TARGET, entities=entities)
        code, out, err = self.run_main(target=target)
        self.assertEqual(code, 1)
        self.assertIn("the target has no « History Import »", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
