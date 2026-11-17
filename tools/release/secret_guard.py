#!/usr/bin/env python3
"""Fails if the firmware still compiles in a value from secrets.yaml.

A published firmware must hold nothing personal, so a release only carries
one built from sources with no `!secret` left. This lists every `!secret`
outside a comment in the given ESPHome config, in the files it `!include`s
(recursively, `!include file` and `!include {file: ...}` forms) and in the
*.yaml packages beside it, then exits 1 if there is any, 0 otherwise.

The release build also runs without a secrets.yaml, so a `!secret` this
missed would fail the compile rather than ship.

Usage: secret_guard.py pool-controller.yaml
"""

import re
import sys
from pathlib import Path

SECRET = re.compile(r"!secret\b")
COMMENT = re.compile(r"(^|\s)#")
INCLUDE = re.compile(r"!include\s+(?:\{\s*file:\s*)?([^\s,{}#]+)")
INCLUDE_BLOCK = re.compile(r"!include\s*$")
FILE_KEY = re.compile(r"^\s*file:\s*([^\s#]+)")


def code(line):
    """The line without its YAML comment."""
    m = COMMENT.search(line)
    return line[: m.start()] if m else line


def scan(path, seen, hits):
    path = path.resolve()
    if path in seen or not path.is_file():
        return
    seen.add(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    for n, line in enumerate(lines, 1):
        text = code(line)
        if SECRET.search(text):
            hits.append((path, n, line.strip()))
        included = INCLUDE.search(text)
        if not included and INCLUDE_BLOCK.search(text):
            # `key: !include` with `file:` on the next lines
            for nxt in lines[n : n + 3]:
                included = FILE_KEY.match(code(nxt))
                if included:
                    break
        if included:
            target = included.group(1).strip("'\"")
            if "://" not in target:
                scan(path.parent / target, seen, hits)


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    config = Path(argv[1])
    if not config.is_file():
        print(f"{config}: not found", file=sys.stderr)
        return 2
    seen, hits = set(), []
    scan(config, seen, hits)
    for package in sorted(config.resolve().parent.glob("*.yaml")):
        if package.name != "secrets.yaml":
            scan(package, seen, hits)
    root = config.resolve().parent
    for path, n, line in hits:
        print(f"{path.relative_to(root)}:{n}: {line}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
