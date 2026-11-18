#!/usr/bin/env python3
"""Tests for manifest.py: the manifest ESP Web Tools (the install page) and
ESPHome's update check both read. Made-up images in a temporary directory.

Run: python3 -I tools/release/test_manifest.py"""

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("manifest", HERE / "manifest.py")
manifest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(manifest)

OTA_BYTES = b"made-up ota image"
FACTORY_BYTES = b"made-up factory image"


def write_images(d):
    (d / manifest.OTA).write_bytes(OTA_BYTES)
    (d / manifest.FACTORY).write_bytes(FACTORY_BYTES)


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = manifest.main(argv)
    return rc, err.getvalue()


class Manifest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def written(self, *extra):
        write_images(self.dir)
        rc, err = run([str(self.dir), "--version", "v1.5.0", *extra])
        self.assertEqual(rc, 0, err)
        return json.loads((self.dir / "manifest.json").read_text(encoding="utf-8"))

    def test_esp_web_tools_part(self):
        m = self.written()
        self.assertEqual(m["name"], "Pool Controller")
        self.assertEqual(m["version"], "v1.5.0")
        self.assertEqual(m["home_assistant_domain"], "esphome")
        (build,) = m["builds"]
        self.assertEqual(build["chipFamily"], "ESP32")
        self.assertEqual(build["parts"], [{"path": "firmware.factory.bin", "offset": 0}])

    def test_new_install_always_erases(self):
        # No prompt: ESP Web Tools erases on a new install, then asks for Wi-Fi.
        self.assertNotIn("new_install_prompt_erase", self.written())

    def test_ota_block(self):
        ota = self.written("--summary", "Pool Controller v1.5.0",
                           "--release-url", "https://example.invalid/releases/tag/v1.5.0")["builds"][0]["ota"]
        self.assertEqual(ota["path"], "firmware.ota.bin")
        self.assertEqual(ota["md5"], hashlib.md5(OTA_BYTES).hexdigest())
        self.assertEqual(ota["sha256"], hashlib.sha256(OTA_BYTES).hexdigest())
        self.assertEqual(ota["summary"], "Pool Controller v1.5.0")
        self.assertEqual(ota["release_url"], "https://example.invalid/releases/tag/v1.5.0")

    def test_defaults_without_summary_or_release_url(self):
        ota = self.written()["builds"][0]["ota"]
        self.assertEqual(ota["summary"], "Pool Controller v1.5.0")
        self.assertNotIn("release_url", ota)

    def test_paths_are_relative(self):
        build = self.written()["builds"][0]
        for path in [build["ota"]["path"]] + [p["path"] for p in build["parts"]]:
            self.assertNotIn("/", path)

    def test_missing_image_fails(self):
        (self.dir / manifest.OTA).write_bytes(OTA_BYTES)
        rc, err = run([str(self.dir), "--version", "v1.5.0"])
        self.assertEqual(rc, 1)
        self.assertIn(manifest.FACTORY, err)
        self.assertFalse((self.dir / "manifest.json").exists())

    def test_empty_image_fails(self):
        write_images(self.dir)
        (self.dir / manifest.OTA).write_bytes(b"")
        rc, _ = run([str(self.dir), "--version", "v1.5.0"])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
