#!/usr/bin/env python3
"""Does this release carry a new firmware?

The card and the firmware share one version sequence (the card's VERSION, one
tag per release, as the Marketplace (HACS) needs), but a firmware is built and
published only when something in it changed since the last release that
carried one. A card-only release leaves the controllers alone: no download, no
reboot of the box that drives the pump.

What counts as the firmware:
  - the ESPHome config and its packages (*.yaml at the root, secrets.yaml aside);
  - their C++ includes (*.h at the root) and the local components (components/);
  - the device's own page (webui/, its tests aside). The page bundles the card
    through symlinks (webui/piscine-card.js, webui/i18n.js, webui/i18n), which
    a diff only reports when the link itself changes: a change to the card
    alone is not a change to the firmware, and reaches the page with the next
    firmware;
  - the ESPHome it is built with (ESPHOME_VERSION in the Makefile).

A firmware can also be asked for: a commit since that release with the trailer
`Firmware: rebuild` (to bring a card change to the device's page), or
`--force` (the Release workflow's manual run).

Usage:
  firmware_release.py --since <tag> [--head <rev>] [--force]
  firmware_release.py                (no release with a firmware yet)

Prints the reasons, and `firmware=true|false` as its last line (the workflow
appends it to $GITHUB_OUTPUT). Exit 0 either way; 2 on a usage or git error.
"""

import argparse
import re
import subprocess
import sys

TRAILER_KEY = "Firmware"
TRAILER_VALUE = "rebuild"
_ESPHOME_PIN = re.compile(r"^ESPHOME_VERSION\s*\?=\s*(\S+)\s*$", re.M)


def is_firmware_path(path):
    """Whether a path, as git prints it (relative to the repo's root), is part of the firmware."""
    if "/" not in path:
        return (path.endswith(".yaml") and path != "secrets.yaml") or path.endswith(".h")
    top, rest = path.split("/", 1)
    if top == "components":
        return True
    if top == "webui":
        return not (rest.startswith("test/") or rest.startswith("dist/"))
    return False


def esphome_pin(makefile):
    """The ESPHome the firmware is built with (the Makefile's ESPHOME_VERSION), or None."""
    m = _ESPHOME_PIN.search(makefile or "")
    return m.group(1) if m else None


def asks_for_firmware(trailer_values):
    """Whether one of the commits' `Firmware:` trailers asks for a rebuild."""
    return any(v.strip().lower() == TRAILER_VALUE for v in trailer_values)


def decide(since, changed, makefile_then, makefile_now, trailers, force):
    """-> (firmware: bool, reasons: [str]). `since` is the last release with a firmware ('' for none)."""
    if force:
        return True, ["asked for by hand (--force)"]
    if not since:
        return True, ["no release carries a firmware yet"]
    reasons = []
    fw = sorted(p for p in changed if is_firmware_path(p))
    if fw:
        reasons.append(f"the firmware changed since {since}: " + ", ".join(fw))
    then, now = esphome_pin(makefile_then), esphome_pin(makefile_now)
    if then != now:
        reasons.append(f"ESPHome changed since {since}: {then} -> {now}")
    if asks_for_firmware(trailers):
        reasons.append(f"a commit since {since} asks for one ({TRAILER_KEY}: {TRAILER_VALUE})")
    return bool(reasons), reasons


def _git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--since", default="", help="the last release that carried a firmware ('' for none)")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    changed, then, now, trailers = [], "", "", []
    if args.since and not args.force:
        try:
            changed = _git("diff", "--name-only", f"{args.since}...{args.head}").split()
            then = _git("show", f"{args.since}:Makefile")
            now = _git("show", f"{args.head}:Makefile")
            trailers = _git("log", f"--format=%(trailers:key={TRAILER_KEY},valueonly)",
                            f"{args.since}..{args.head}").splitlines()
        except subprocess.CalledProcessError as e:
            print(f"git {' '.join(e.cmd[1:])}: {e.stderr.strip()}", file=sys.stderr)
            return 2

    firmware, reasons = decide(args.since, changed, then, now, trailers, args.force)
    for r in reasons or [f"nothing in the firmware changed since {args.since}: this release carries the card only"]:
        print(r)
    print(f"firmware={'true' if firmware else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
