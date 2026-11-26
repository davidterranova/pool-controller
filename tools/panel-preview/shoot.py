"""The panel preview's screenshots and check (make panel-shots, make panel-preview-check).

Runs the preview's program (preview.yaml, built for the host) once per language and scenario under Xvfb, waits for
its `[preview] ready` line, and saves the screen as shots/<lang>-<screen>-<state>.png (480×320). With --check it
fails when a run shows a dictionary key instead of its text, « nan » / « inf », a text the panel couldn't find
(`no text for …`, panel_ui.h's on_missing), logs an error, never gets ready, or exits early.

Runs in tools/panel-preview/Dockerfile's image, from the repo's root:
  python3 tools/panel-preview/shoot.py PROGRAM [--check] [--lang fr,es] [--only auto,off]
"""

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LANGS = ["en", "fr", "es"]
SCREEN = "home"  # S4 adds the sheet and status screens
WIDTH, HEIGHT = 480, 320
READY_TIMEOUT_S = 30
ANSI = re.compile(r"\x1b\[[0-9;]*m")
# A key drawn instead of its text: panel.home.change, common.speed.Low, card.x.y, status.x.y
KEY = re.compile(r"\b(?:panel|common|card|status|page|setup)\.[A-Za-z_]+(?:\.[A-Za-z_:]+)*\b")
NOT_A_NUMBER = re.compile(r"\b(?:nan|inf)\b", re.IGNORECASE)


def scenarios():
    """The names in preview.h's SCENARIOS, so the list lives in one place."""
    text = (HERE / "preview.h").read_text(encoding="utf-8")
    block = text.split("// SCENARIOS", 1)[1].split("// end of SCENARIOS", 1)[0]
    return re.findall(r'^\s*\{"(\w+)",', block, re.M)


def problems_in(log):
    """What a run's log shows that a person shouldn't see."""
    found = []
    for line in log.splitlines():
        line = ANSI.sub("", line)
        if "[E][" in line:
            found.append(f"error: {line}")
        if "no text for" in line:
            found.append(f"missing text: {line}")
        m = re.search(r"\[preview[^\]]*\]: label: (.*)$", line)
        if m:
            text = m.group(1)
            for k in KEY.findall(text):
                found.append(f"key shown instead of its text: « {k} » in « {text} »")
            if NOT_A_NUMBER.search(text):
                found.append(f"not a number shown: « {text} »")
    return found


def run_one(program, lang, scenario, out, display):
    env = dict(os.environ, DISPLAY=display, PANEL_LANG=lang, PANEL_SCENARIO=scenario, SDL_AUDIODRIVER="dummy")
    proc = subprocess.Popen([program], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    log, ready = [], False
    deadline = time.monotonic() + READY_TIMEOUT_S
    os.set_blocking(proc.stdout.fileno(), False)
    while time.monotonic() < deadline and proc.poll() is None:
        chunk = proc.stdout.readline()
        if not chunk:
            time.sleep(0.05)
            continue
        log.append(chunk)
        if re.search(r"\[preview[^\]]*\]: ready", ANSI.sub("", chunk)):
            ready = True
            break
    problems = []
    if ready:
        time.sleep(0.3)  # the frame after the dump
        from PIL import ImageGrab  # in the ESPHome image

        ImageGrab.grab(xdisplay=display).crop((0, 0, WIDTH, HEIGHT)).save(out)
    elif proc.poll() is not None:
        problems.append(f"the program exited ({proc.returncode}) before it was ready")
    else:
        problems.append(f"not ready within {READY_TIMEOUT_S} s")
    proc.terminate()
    try:
        rest, _ = proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        rest, _ = proc.communicate()
    log.append(rest or "")
    text = "".join(log)
    return problems + problems_in(text), text


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("program")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--lang", default=",".join(LANGS))
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(HERE / "shots"))
    args = ap.parse_args()

    names = scenarios()
    if not names:
        sys.exit("shoot.py: no scenario found in preview.h")
    only = [s for s in args.only.split(",") if s]
    unknown = [s for s in only if s not in names]
    if unknown:
        sys.exit(f"shoot.py: no scenario {', '.join(unknown)} (preview.h has {', '.join(names)})")
    langs = [l for l in args.lang.split(",") if l]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    display = ":99"
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{WIDTH}x{HEIGHT}x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    failed = 0
    try:
        for lang in langs:
            for name in only or names:
                shot = out / f"{lang}-{SCREEN}-{name}.png"
                problems, log = run_one(args.program, lang, name, shot, display)
                status = "ok" if not problems else "FAIL"
                print(f"{status:4} {shot.relative_to(out.parent) if shot.exists() else shot.name}")
                if problems:
                    failed += 1
                    for p in problems:
                        print(f"     {p}")
                    if not args.check:
                        print(ANSI.sub("", log)[-2000:])
    finally:
        xvfb.terminate()
    total = len(langs) * len(only or names)
    print(f"panel preview: {total - failed}/{total} drawn without a problem")
    if failed and args.check:
        sys.exit(1)


if __name__ == "__main__":
    main()
