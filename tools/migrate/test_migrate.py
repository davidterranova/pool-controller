#!/usr/bin/env python3
"""Tests for migrate.py's pure parts (`make migrate-test`): inputs, the generated
package, and the checks' verdicts. No controller, no secrets.yaml: every value
here is made up."""

import importlib.util
import math
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("migrate", HERE / "migrate.py")
migrate = importlib.util.module_from_spec(_spec)
sys.modules["migrate"] = migrate
_spec.loader.exec_module(migrate)

KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="  # bytes 0..31, made up
ZERO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

SECRETS = {
    "wifi_ssid": "Test Net",
    "wifi_password": "test-wifi-pass",
    "pool_controller_api_key": KEY,
    "pool_controller_web_password": "test-page-pass",
    "pool_controller_ota_password": "test-ota-pass",
    "pool_latitude": "12.3456",
    "pool_longitude": -4.567,
    "pool_timezone": "Europe/Paris",
}

OLD_CONFIG = """
wifi:
  ssid: !secret wifi_ssid
sensor:
  - platform: dallas_temp
    id: pool_return_temp
    address: 0x1100000000000028   # a comment
    filters:
      - lambda: !lambda 'return x;'
  - platform: dallas_temp
    id: pad_ambient_temp
    address: "0x2200000000000028"
  - platform: dallas_temp
    id: outdoor_temp
    address: 0x3300000000000028
  - platform: pulse_meter
    id: flow
"""


def fake_tz(value):
    return {"Europe/Paris": "CET-1CEST,M3.5.0,M10.5.0/3"}.get(value, value)


def unescape_cpp(literal):
    """The bytes a C++ literal made by cpp_string holds."""
    assert literal[0] == literal[-1] == '"'
    body = literal[1:-1]
    return re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m.group(1), 8)]), body.encode())


class Inputs(unittest.TestCase):
    def test_api_key(self):
        self.assertTrue(migrate.api_key_ok(KEY))
        self.assertFalse(migrate.api_key_ok(ZERO_KEY))
        self.assertFalse(migrate.api_key_ok(KEY[:-1]))
        self.assertFalse(migrate.api_key_ok(KEY[:-2] + "==="[:2]))
        self.assertFalse(migrate.api_key_ok("!" + KEY[1:]))

    def test_probe_addresses(self):
        probes = migrate.probe_addresses(migrate.load_yaml(OLD_CONFIG))
        self.assertEqual(probes, {"pool": 0x1100000000000028, "pad": 0x2200000000000028, "outdoor": 0x3300000000000028})

    def test_probe_addresses_none(self):
        self.assertEqual(migrate.probe_addresses(migrate.load_yaml("sensor:\n  - platform: dallas_temp\n    id: pool_return_temp\n")), {})

    def test_old_settings(self):
        s = migrate.old_settings(SECRETS, migrate.load_yaml(OLD_CONFIG), fake_tz)
        self.assertEqual((s.latitude, s.longitude), (12.35, -4.57))
        self.assertEqual((s.timezone_posix, s.timezone_name), ("CET-1CEST,M3.5.0,M10.5.0/3", "Europe/Paris"))
        self.assertEqual(s.probes["pool"], 0x1100000000000028)

    def test_posix_zone_has_no_name(self):
        self.assertEqual(migrate.timezone_pair("CET-1CEST,M3.5.0,M10.5.0/3", fake_tz), ("CET-1CEST,M3.5.0,M10.5.0/3", ""))

    def test_every_problem_at_once(self):
        bad = dict(SECRETS, wifi_ssid="x" * 33, pool_latitude="north", pool_controller_api_key=ZERO_KEY)
        del bad["pool_controller_ota_password"]
        with self.assertRaises(migrate.MigrationError) as ctx:
            migrate.old_settings(bad, migrate.load_yaml("sensor: []"), fake_tz)
        message = str(ctx.exception)
        for expected in ("wifi_ssid", "pool_latitude", "pool_controller_api_key", "pool_controller_ota_password", "pool probe"):
            self.assertIn(expected, message)

    def test_open_network(self):
        s = migrate.old_settings(dict(SECRETS, wifi_password=""), migrate.load_yaml(OLD_CONFIG), fake_tz)
        self.assertEqual(s.wifi_password, "")

    def test_short_passwords_warn_and_seed(self):
        s = migrate.old_settings(dict(SECRETS, pool_controller_web_password="short", pool_controller_ota_password="1234567"),
                                 migrate.load_yaml(OLD_CONFIG), fake_tz)
        self.assertEqual((s.page_password, s.ota_password), ("short", "1234567"))
        warnings = migrate.password_warnings(s)
        self.assertEqual(len(warnings), 2)
        self.assertIn("page password has 5 characters", warnings[0])
        self.assertIn("change it after the migration", warnings[0])
        for warning in warnings:  # never the password itself
            self.assertNotIn("short", warning)
            self.assertNotIn("1234567", warning)
        self.assertEqual(migrate.password_warnings(migrate.old_settings(SECRETS, migrate.load_yaml(OLD_CONFIG), fake_tz)), [])
        self.assertEqual(migrate.password_warnings(migrate.old_settings(
            dict(SECRETS, pool_controller_web_password="x" * 64), migrate.load_yaml(OLD_CONFIG), fake_tz)), [])

    def test_password_the_controller_cant_store(self):
        with self.assertRaises(migrate.MigrationError) as ctx:
            migrate.old_settings(dict(SECRETS, pool_controller_ota_password="x" * 65), migrate.load_yaml(OLD_CONFIG), fake_tz)
        self.assertIn("can't store it", str(ctx.exception))

    def test_one_probe_two_roles(self):
        config = OLD_CONFIG.replace("0x3300000000000028", "0x1100000000000028")
        with self.assertRaises(migrate.MigrationError):
            migrate.old_settings(SECRETS, migrate.load_yaml(config), fake_tz)

    def test_esphome_timezone(self):
        try:
            import esphome  # noqa: F401
        except ImportError:
            self.skipTest("ESPHome isn't installed here (runs in its image)")
        self.assertEqual(migrate.esphome_timezone("Europe/Paris"), "CET-1CEST,M3.5.0,M10.5.0/3")


class Package(unittest.TestCase):
    def test_cpp_string_round_trip(self):
        for value in ["plain", 'q"uote', "back\\slash", "$HOME ${x}", "new\nline", "été ✓", "??=", "tab\t", ""]:
            literal = migrate.cpp_string(value)
            self.assertNotRegex(literal[1:-1], r'["$\n\t?]')
            self.assertEqual(unescape_cpp(literal), value.encode())

    def test_octal_never_swallows_a_digit(self):
        # "\0441" must read as "$" then "1", which a 3-digit escape guarantees.
        self.assertEqual(migrate.cpp_string("$1"), '"\\0441"')

    def test_render_needs_every_value(self):
        with self.assertRaises(KeyError):
            migrate.render("{{A}} {{B}}", {"A": "1"})
        self.assertEqual(migrate.render("{{A}}-{{A}}", {"A": "1"}), "1-1")

    def test_generated_package(self):
        s = migrate.old_settings(SECRETS, migrate.load_yaml(OLD_CONFIG), fake_tz)
        text = migrate.render(migrate.TEMPLATE.read_text(), migrate.template_values(s, 123, "v1.3.1"))
        self.assertNotIn("{{", text)
        # No ESPHome substitution can reach a value: the only `$` would be ours.
        self.assertNotIn("$", text)
        config = migrate.load_yaml(text)
        self.assertEqual([b["priority"] for b in config["esphome"]["on_boot"]], [750, -100])
        self.assertEqual(config["globals"][0]["id"], "migration_run")
        self.assertIn("0x1100000000000028ULL", text)
        self.assertIn("123UL", text)
        self.assertIn('"Europe/Paris"', text)

    def test_run_id(self):
        s = migrate.old_settings(SECRETS, migrate.load_yaml(OLD_CONFIG), fake_tz)
        for bad in (0, 2**32):
            with self.assertRaises(ValueError):
                migrate.template_values(s, bad, "v1.3.1")

    def test_summary_holds_no_secret(self):
        s = migrate.old_settings(SECRETS, migrate.load_yaml(OLD_CONFIG), fake_tz)
        text = migrate.summary(s, "v1.3.1")
        for secret in (KEY, "test-wifi-pass", "test-page-pass", "test-ota-pass"):
            self.assertNotIn(secret, text)

    def test_write_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "migration.yaml"
            migrate.write_private(path, "x")
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(path.parent).st_mode) & 0o077, 0)
            migrate.write_private(path, "y")
            self.assertEqual(path.read_text(), "y")
            self.assertEqual(os.listdir(path.parent), ["migration.yaml"])


def snapshot(states, version="v1.4.0-2-gabcdef0", new_firmware=True):
    snap = migrate.Snapshot("pool-controller", version, "2026.11.0b6")
    snap.entities = set(states) | ({migrate.SETUP_STATE} if new_firmware else set())
    snap.states = dict(states)
    return snap


class Checks(unittest.TestCase):
    def test_idle(self):
        idle = {migrate.PUMP: False, migrate.OVERRIDE_ACTIVE: False, migrate.FILL_FLOW: 0.0}
        self.assertEqual(migrate.idle_problems(snapshot(idle)), [])
        self.assertEqual(migrate.idle_problems(snapshot({migrate.FILL_FLOW: None})), [])
        busy = {migrate.PUMP: True, migrate.OVERRIDE_ACTIVE: True, migrate.FILL_FLOW: 12.5}
        self.assertEqual(len(migrate.idle_problems(snapshot(busy))), 3)

    def test_migrated(self):
        good = {migrate.SETUP_STATE: "configured", migrate.POOL_TEMPERATURE: 14.2}
        self.assertEqual(migrate.migrated_problems(snapshot(good), "v1.4.0-2-gabcdef0"), [])
        self.assertEqual(migrate.migrated_problems(snapshot(good), None), [])

    def test_not_migrated(self):
        self.assertEqual(len(migrate.migrated_problems(snapshot({}, new_firmware=False), "v1")), 1)
        missing = {migrate.SETUP_STATE: "probes,api_key", migrate.POOL_TEMPERATURE: None}
        problems = migrate.migrated_problems(snapshot(missing), "v1.4.0-2-gabcdef0")
        self.assertEqual(len(problems), 2)
        self.assertIn("probes,api_key", problems[0])
        good = {migrate.SETUP_STATE: "configured", migrate.POOL_TEMPERATURE: 14.2}
        self.assertEqual(len(migrate.migrated_problems(snapshot(good, version="dev"), "v1.4.0-2-gabcdef0")), 1)

    def test_state_value(self):
        class State:
            def __init__(self, state, missing=False):
                self.state, self.missing_state = state, missing

        self.assertIsNone(migrate.state_value(State(math.nan)))
        self.assertIsNone(migrate.state_value(State("configured", missing=True)))
        self.assertEqual(migrate.state_value(State("configured")), "configured")

    def test_ota_password_file_action(self):
        self.assertEqual(migrate.ota_password_file_action(None, "pw-123456"), "write")
        self.assertEqual(migrate.ota_password_file_action("pw-123456\n", "pw-123456"), "same")
        self.assertEqual(migrate.ota_password_file_action("pw-123456", "pw-123456"), "same")
        self.assertEqual(migrate.ota_password_file_action("another-one", "pw-123456"), "different")

    def test_save_ota_password(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".ota-password"
            migrate.save_ota_password(path, "pw-123456")
            self.assertEqual(path.read_text(), "pw-123456")
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            migrate.save_ota_password(path, "pw-123456")  # same: untouched
            self.assertEqual(path.read_text(), "pw-123456")
            path.write_text("someone-elses\n")
            migrate.save_ota_password(path, "pw-123456")  # different: left alone
            self.assertEqual(path.read_text(), "someone-elses\n")

    def test_rollback_names_the_old_build(self):
        text = migrate.rollback_text("192.0.2.10", "v1.3.1")
        self.assertIn("v1.3.1", text)
        self.assertIn("ota HOST=192.0.2.10", text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
