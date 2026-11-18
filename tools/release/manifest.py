#!/usr/bin/env python3
"""Writes the firmware's manifest.json, beside its two images.

One file serves both readers:
  - ESP Web Tools (the browser install page) flashes `builds[].parts`, the
    factory image, at offset 0. No `new_install_prompt_erase`: a new install
    always erases the board, without asking, then goes straight to Wi-Fi
    (Improv);
  - ESPHome's `update: platform: http_request` reads `version` and the
    `builds[].ota` block, then OTA-installs `ota.path` after checking its md5.

Paths are relative to the manifest, so the same three files work wherever
they sit together: GitHub Pages under /firmware/, a release's assets, a
workflow artifact.

`version` must be the string the firmware reports as its project version
(the firmware_version substitution): it is what ESPHome compares.

Usage: manifest.py DIR --version v1.4.0 [--name ...] [--chip-family ESP32]
                   [--summary ...] [--release-url ...]
DIR holds firmware.ota.bin and firmware.factory.bin; manifest.json goes there.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

OTA = "firmware.ota.bin"
FACTORY = "firmware.factory.bin"


def digest(path, algo):
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    p = argparse.ArgumentParser(description="Write manifest.json for the firmware images in DIR.")
    p.add_argument("dir", type=Path)
    p.add_argument("--version", required=True)
    p.add_argument("--name", default="Pool Controller")
    p.add_argument("--chip-family", default="ESP32")
    p.add_argument("--summary", default="")
    p.add_argument("--release-url", default="")
    args = p.parse_args(argv)

    ota, factory = args.dir / OTA, args.dir / FACTORY
    for f in (ota, factory):
        if not f.is_file() or f.stat().st_size == 0:
            print(f"{f}: missing or empty", file=sys.stderr)
            return 1

    ota_block = {
        "path": OTA,
        "md5": digest(ota, "md5"),
        "sha256": digest(ota, "sha256"),
        "summary": args.summary or f"{args.name} {args.version}",
    }
    if args.release_url:
        ota_block["release_url"] = args.release_url

    manifest = {
        "name": args.name,
        "version": args.version,
        "home_assistant_domain": "esphome",
        "builds": [
            {
                "chipFamily": args.chip_family,
                "ota": ota_block,
                "parts": [{"path": FACTORY, "offset": 0}],
            }
        ],
    }
    out = args.dir / "manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(out.read_text(encoding="utf-8"), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
