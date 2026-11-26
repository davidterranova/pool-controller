"""Tests of shoot.py's check (make panel-preview-check), on made-up logs: python3 -I tools/panel-preview/test_shoot.py."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shoot  # noqa: E402

OK = """\x1b[0;32m[I][preview:063]: label: Haute · encore 1 h 12 min · Auto à 15:26\x1b[0m
[14:20:00][I][preview:063]: label: Changer
[14:20:00][I][preview:063]: label: —
[14:20:00][I][preview:070]: ready
"""


class CheckTest(unittest.TestCase):
    def test_a_clean_run_passes(self):
        self.assertEqual(shoot.problems_in(OK), [])

    def test_a_key_drawn_instead_of_its_text(self):
        found = shoot.problems_in("[I][preview:063]: label: panel.home.change\n[I][preview:063]: label: Off · common.speed.Low\n")
        self.assertEqual(len(found), 2)
        self.assertIn("« panel.home.change »", found[0])
        self.assertIn("« common.speed.Low »", found[1])

    def test_not_a_number(self):
        self.assertEqual(len(shoot.problems_in("[I][preview:063]: label: nan °C\n[I][preview:063]: label: -inf\n")), 2)
        # words that merely contain the letters are fine
        self.assertEqual(shoot.problems_in("[I][preview:063]: label: Information · financement\n"), [])

    def test_a_missing_text_and_an_error(self):
        found = shoot.problems_in("[W][panel:041]: no text for common.speed.Turbo\n[E][lvgl:100]: something broke\n")
        self.assertEqual(len(found), 2)

    def test_scenarios_come_from_preview_h(self):
        names = shoot.scenarios()
        self.assertIn("auto", names)
        self.assertEqual(len(names), len(set(names)))


if __name__ == "__main__":
    unittest.main()
