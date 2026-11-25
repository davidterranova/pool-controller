#!/usr/bin/env python3
"""Tests for firmware_release.py: whether a release carries a new firmware.

Run: python3 -I tools/release/test_firmware_release.py"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("firmware_release", HERE / "firmware_release.py")
fr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fr)

MAKEFILE = "ESPHOME_VERSION ?= 2026.11.0b6\nESPHOME_IMAGE ?= x:$(ESPHOME_VERSION)\n"


class Paths(unittest.TestCase):
    def test_firmware(self):
        for p in ["pool-controller.yaml", "fill-meter.yaml", "updates.h", "components/x/__init__.py",
                  "webui/app.js", "webui/index.html", "webui/i18n-page/fr.json",
                  "webui/piscine-card.js"]:  # the symlink itself, re-pointed
            self.assertTrue(fr.is_firmware_path(p), p)

    def test_not_firmware(self):
        for p in ["secrets.yaml", "home-assistant/piscine-card.js", "home-assistant/i18n/fr.json",
                  "home-assistant/dashboard/x.yaml", "webui/test/hmac.test.mjs", "webui/dist/device.js",
                  "README.md", "Makefile", "docs/install/index.html", ".github/workflows/release.yml",
                  "tools/release/manifest.py", "hacs.json"]:
            self.assertFalse(fr.is_firmware_path(p), p)


class Decide(unittest.TestCase):
    def test_card_only(self):
        fw, reasons = fr.decide("v1.16.0", ["home-assistant/piscine-card.js", "README.md"], MAKEFILE, MAKEFILE, [], False)
        self.assertFalse(fw)
        self.assertEqual(reasons, [])

    def test_firmware_change(self):
        fw, reasons = fr.decide("v1.16.0", ["webui/app.js", "home-assistant/piscine-card.js"], MAKEFILE, MAKEFILE, [], False)
        self.assertTrue(fw)
        self.assertIn("webui/app.js", reasons[0])
        self.assertNotIn("piscine-card", reasons[0])

    def test_esphome_bump(self):
        fw, reasons = fr.decide("v1.16.0", ["Makefile"], MAKEFILE, MAKEFILE.replace("0b6", "1"), [], False)
        self.assertTrue(fw)
        self.assertIn("2026.11.0b6 -> 2026.11.1", reasons[0])

    def test_other_makefile_change(self):
        fw, _ = fr.decide("v1.16.0", ["Makefile"], MAKEFILE, MAKEFILE + "card: x\n", [], False)
        self.assertFalse(fw)

    def test_trailer(self):
        self.assertTrue(fr.decide("v1.16.0", [], MAKEFILE, MAKEFILE, ["", "Rebuild ", ""], False)[0])
        self.assertFalse(fr.decide("v1.16.0", [], MAKEFILE, MAKEFILE, ["", "no"], False)[0])

    def test_first_firmware(self):
        self.assertTrue(fr.decide("", [], "", "", [], False)[0])

    def test_force(self):
        self.assertTrue(fr.decide("v1.16.0", [], MAKEFILE, MAKEFILE, [], True)[0])


class Git(unittest.TestCase):
    """main() against a made-up repo: a firmware release, then a card-only change, then a firmware one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self._cwd = os.getcwd()
        os.chdir(self.repo)
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
        os.environ.update(env)
        self.git("init", "-q", "-b", "main")
        (self.repo / "home-assistant").mkdir()
        (self.repo / "webui").mkdir()
        (self.repo / "Makefile").write_text(MAKEFILE)
        (self.repo / "pool-controller.yaml").write_text("esphome:\n")
        (self.repo / "home-assistant/piscine-card.js").write_text('const VERSION = "1.0.0";\n')
        os.symlink("../home-assistant/piscine-card.js", self.repo / "webui/piscine-card.js")
        self.commit("first")
        self.git("tag", "v1.0.0")

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", *args], check=True, capture_output=True)

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def run_main(self, *argv):
        from contextlib import redirect_stdout
        import io
        out = io.StringIO()
        with redirect_stdout(out):
            rc = fr.main(list(argv))
        self.assertEqual(rc, 0)
        return out.getvalue().splitlines()[-1]

    def test_card_change_is_not_firmware(self):
        (self.repo / "home-assistant/piscine-card.js").write_text('const VERSION = "1.1.0";\n')
        self.commit("feat(card): x")
        self.assertEqual(self.run_main("--since", "v1.0.0"), "firmware=false")

    def test_trailer_asks_for_one(self):
        (self.repo / "home-assistant/piscine-card.js").write_text('const VERSION = "1.1.0";\n')
        self.commit("feat(card): x\n\nFirmware: rebuild")
        self.assertEqual(self.run_main("--since", "v1.0.0"), "firmware=true")

    def test_yaml_change_is_firmware(self):
        (self.repo / "pool-controller.yaml").write_text("esphome:\n  name: x\n")
        self.commit("feat: x")
        self.assertEqual(self.run_main("--since", "v1.0.0"), "firmware=true")

    def test_unknown_tag(self):
        import io
        from contextlib import redirect_stderr
        with redirect_stderr(io.StringIO()):
            self.assertEqual(fr.main(["--since", "v9.9.9"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2 if "-v" in sys.argv else 1)
