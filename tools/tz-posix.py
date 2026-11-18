#!/usr/bin/env python3
"""Regenerates piscine-card's IANA -> POSIX TZ table (TZ_POSIX) from tzdata.

    python3 tools/tz-posix.py [--zoneinfo /usr/share/zoneinfo] [--check]

The controller applies a POSIX TZ string (its Timezone text) and only shows the
IANA name beside it (Timezone Name). Home Assistant knows its zone by IANA name
(hass.config.time_zone), so the card converts it with this table: every zone
and link tzdata lists (tzdata.zi), grouped by the POSIX string each one's TZif
file ends with (RFC 8536's footer, the rule in force from now on).

Rewrites the block between the TZ_POSIX markers in home-assistant/piscine-card.js;
--check only says whether it is up to date (exit 1 if not). Run it after a tzdata
release that changes a rule, and bump the card's VERSION.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

CARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "home-assistant", "piscine-card.js")
BEGIN, END = "/* TZ_POSIX begin", "/* TZ_POSIX end */"


def footer(path: str) -> str | None:
    """The POSIX TZ string at the end of a TZif v2+ file, None for a v1 file or an empty footer."""
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"TZif") or data[4:5] in (b"\0", b""):
        return None
    tz = data.rstrip(b"\n").rsplit(b"\n", 1)[-1].decode("ascii")
    return tz or None


def zone_names(zoneinfo: str) -> list[str]:
    """Every zone (Z) and link (L) name in tzdata.zi, the names Home Assistant can hold."""
    names = set()
    with open(os.path.join(zoneinfo, "tzdata.zi"), encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if parts and parts[0] == "Z":
                names.add(parts[1])
            elif parts and parts[0] == "L":
                names.add(parts[2])
    return sorted(names)


def block(zoneinfo: str) -> str:
    with open(os.path.join(zoneinfo, "+VERSION"), encoding="utf-8") as f:
        version = f.read().strip()
    groups: dict[str, list[str]] = {}
    for name in zone_names(zoneinfo):
        path = os.path.join(zoneinfo, name)
        tz = os.path.isfile(path) and footer(path)
        if tz:
            groups.setdefault(tz, []).append(name)
    lines = [f'  "{tz}": "{" ".join(names)}",' for tz, names in sorted(groups.items(), key=lambda g: g[1][0])]
    return (f"{BEGIN}: tools/tz-posix.py, tzdata {version}, {sum(map(len, groups.values()))} zones; don't edit by hand */\n"
            "const TZ_POSIX = {\n" + "\n".join(lines) + "\n};\n" + END)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--zoneinfo", default="/usr/share/zoneinfo")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    with open(CARD, encoding="utf-8") as f:
        card = f.read()
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)
    if not pattern.search(card):
        print(f"no TZ_POSIX block in {CARD}", file=sys.stderr)
        return 2
    new = pattern.sub(lambda _: block(args.zoneinfo), card, count=1)
    if args.check:
        print("TZ_POSIX up to date" if new == card else "TZ_POSIX differs from this tzdata")
        return 0 if new == card else 1
    if new != card:
        with open(CARD, "w", encoding="utf-8") as f:
            f.write(new)
    print("TZ_POSIX " + ("rewritten" if new != card else "already up to date"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
