"""The panel preview's screenshots and check (make panel-shots, make panel-preview-check).

Shots: runs the preview's program (preview.yaml, built for the host) once per language, screen and scenario under
Xvfb, waits for its `[preview] ready` line, and saves the screen as shots/<lang>-<screen>-<state>.png (480×320).
With --check it fails when a run shows a dictionary key instead of its text, « nan » / « inf », a text the panel
couldn't find (`no text for …`, panel_ui.h's on_missing), logs an error, never gets ready, or exits early.

Flows (--check, or --flows alone): the panel used as a person would, by taps on the screen (xdotool) and the
preview's commands (preview.h: the Auto button, a language, a dump of the labels), each step checked against the
log: Apply writes the timeout then the override, Cancel and sleep discard the sheet, a touch on a sleeping screen
only wakes it, the screen sleeps after Panel Sleep After, the Auto button sets Auto and wakes it, the override
expires back to Auto, Panel Language relabels at once. docs/plans/s3-panel.md, A4.

Runs in tools/panel-preview/Dockerfile's image, from the repo's root:
  python3 tools/panel-preview/shoot.py PROGRAM [--check] [--lang fr,es] [--only auto,off] [--screen home,sheet]
                                               [--flows | --no-flows]
"""

import argparse
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LANGS = ["en", "fr", "es"]
SCREENS = ["home", "sheet", "status"]
WIDTH, HEIGHT = 480, 320
READY_TIMEOUT_S = 30
ANSI = re.compile(r"\x1b\[[0-9;]*m")
# A key drawn instead of its text: panel.home.change, common.speed.Low, card.x.y, status.x.y
KEY = re.compile(r"\b(?:panel|common|card|status|page|setup)\.[A-Za-z_]+(?:\.[A-Za-z_:]+)*\b")
NOT_A_NUMBER = re.compile(r"\b(?:nan|inf)\b", re.IGNORECASE)
LABEL = re.compile(r"\[preview[^\]]*\]: label: (.*)$")


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
        m = LABEL.search(line)
        if m:
            text = m.group(1)
            for k in KEY.findall(text):
                found.append(f"key shown instead of its text: « {k} » in « {text} »")
            if NOT_A_NUMBER.search(text):
                found.append(f"not a number shown: « {text} »")
    return found


class Program:
    """The preview's program running under Xvfb: its log as it comes, taps and commands."""

    def __init__(self, program, display, **env):
        self.display = display
        full = dict(os.environ, DISPLAY=display, SDL_AUDIODRIVER="dummy", **env)
        self.proc = subprocess.Popen([program], env=full, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.lines = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            with self.lock:
                self.lines.append(ANSI.sub("", line.rstrip("\n")))

    def mark(self):
        with self.lock:
            return len(self.lines)

    def since(self, mark):
        with self.lock:
            return self.lines[mark:]

    def wait_for(self, pattern, since=0, timeout=10.0):
        """The first line from `since` on matching `pattern`, or None after `timeout` s (or once the program ends)."""
        rx = re.compile(pattern)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for line in self.since(since):
                if rx.search(line):
                    return line
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        return None

    def send(self, command):
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def tap(self, x, y):
        # Pressed long enough for LVGL's 30 ms input poll to see it, as a finger would be.
        env = dict(os.environ, DISPLAY=self.display)
        subprocess.run(["xdotool", "mousemove", str(x), str(y), "mousedown", "1"], env=env, check=True)
        time.sleep(0.15)
        subprocess.run(["xdotool", "mouseup", "1"], env=env, check=True)

    def labels(self):
        """The screen's labels now (the preview's `dump`)."""
        mark = self.mark()
        self.send("dump")
        if self.wait_for(r"\[preview[^\]]*\]: dumped", since=mark) is None:
            return None
        return [m.group(1) for line in self.since(mark) if (m := LABEL.search(line))]

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        return "\n".join(self.since(0))


def run_one(program, lang, screen, scenario, out, display):
    p = Program(program, display, PANEL_LANG=lang, PANEL_SCENARIO=scenario, PANEL_SCREEN=screen)
    ready = p.wait_for(r"\[preview[^\]]*\]: ready", timeout=READY_TIMEOUT_S)
    problems = []
    if ready:
        time.sleep(0.3)  # the frame after the dump
        from PIL import ImageGrab  # in the ESPHome image

        ImageGrab.grab(xdisplay=display).crop((0, 0, WIDTH, HEIGHT)).save(out)
    elif p.proc.poll() is not None:
        problems.append(f"the program exited ({p.proc.returncode}) before it was ready")
    else:
        problems.append(f"not ready within {READY_TIMEOUT_S} s")
    log = p.stop()
    return problems + problems_in(log), log


# ------------------------------------------------------------------ flows (A4)

# Where local-panel.yaml draws what a flow taps (screen coordinates, 480×320): the centres of its buttons.
AT = {
    "bar": (240, 19),
    "change": (398, 91),
    "auto": (55, 67), "off": (147, 67), "low": (239, 67), "medium": (331, 67), "high": (423, 67),
    "30": (66, 154), "60": (181, 154), "120": (296, 154), "never": (411, 154),
    "cancel": (123, 284), "apply": (357, 284),
    "back": (408, 28),
    "tile": (240, 270),
}

# A flow: the scenario, its environment, and its steps, each one of
#   ("tap", where)             a tap at AT[where]
#   ("send", command)          a preview command (preview.h)
#   ("expect", regex)          a log line matching it, after the previous expect (so in order)
#   ("absent", regex)          no line matching it since the flow started
#   ("label", regex)           the screen now has a label matching it
#   ("no_label", regex)        the screen now has no label matching it
#   ("wait", seconds)
FLOWS = [
    ("apply writes the timeout, then the override", "auto", {}, [
        ("tap", "change"), ("expect", r"Sheet open on Auto"),
        ("tap", "high"), ("tap", "30"), ("tap", "apply"),
        ("expect", r"\[panel.*Apply: Manual Override Timeout 30 min"),
        ("expect", r"\[panel.*Apply: Manual Override High"),
        ("expect", r"Manual Override is High"),
        ("label", r"^High · 30 min left · Auto at \d\d:\d\d$"),
    ]),
    ("Auto writes the override only", "manual_limit", {}, [
        ("tap", "change"), ("expect", r"Sheet open on High, 120 min"),
        ("tap", "auto"), ("tap", "apply"),
        ("expect", r"Apply: Manual Override Auto"), ("expect", r"Manual Override is Auto"),
        ("absent", r"Apply: Manual Override Timeout"),
        ("label", r"^Auto$"),
    ]),
    ("Cancel discards the sheet", "auto", {}, [
        ("tap", "change"), ("expect", r"Sheet open"),
        ("tap", "off"), ("tap", "never"), ("tap", "cancel"),
        ("expect", r"Sheet cancelled: nothing written"),
        ("absent", r"Apply:"),
        ("label", r"^Change$"), ("label", r"^Auto$"),
    ]),
    ("the screen sleeps, and a touch on it only wakes it", "auto", {"PANEL_SLEEP_S": "2"}, [
        ("expect", r"Sleep after 2 s with no touch$"), ("expect", r"backlight 0 %"),
        ("tap", "change"),
        ("expect", r"Touch while asleep: it only wakes the screen \(1 since boot\)"),
        ("expect", r"Wake: backlight on"),
        ("wait", 0.5),
        ("absent", r"Sheet open"),
        ("label", r"^Change$"),
    ]),
    ("sleep discards the sheet", "auto", {"PANEL_SLEEP_S": "3"}, [
        ("tap", "change"), ("expect", r"Sheet open"), ("tap", "high"),
        ("expect", r"Sleep after 3 s with no touch: the sheet is discarded"),
        ("tap", "tile"), ("expect", r"Wake: backlight on"),
        ("absent", r"Apply:"),
        ("label", r"^Change$"), ("no_label", r"^Pump mode$"),
    ]),
    ("the Auto button sets Auto and discards the sheet", "manual_limit", {}, [
        ("tap", "change"), ("expect", r"Sheet open"),
        ("send", "auto"),
        ("expect", r"Auto button: Manual Override High -> Auto"),
        ("expect", r"Manual Override is Auto"),
        ("expect", r"Auto button: the sheet is discarded"),
        ("label", r"^Auto$"), ("label", r"^Change$"),
    ]),
    ("the Auto button wakes the screen, which sleeps again", "manual_never", {"PANEL_SLEEP_S": "2"}, [
        ("expect", r"Sleep after 2 s"),
        ("send", "auto"),
        ("expect", r"Auto button: wakes the screen"), ("expect", r"Wake: backlight on"),
        ("expect", r"Sleep after 2 s"),
    ]),
    ("the override expires back to Auto, and the panel follows", "manual_limit", {"PANEL_LEFT_S": "6"}, [
        ("label", r"^High · 1 min left · Auto at \d\d:\d\d$"),
        ("expect", r"Manual Override expired: back to Auto"),
        ("wait", 0.3),
        ("label", r"^Auto$"),
    ]),
    ("Panel Language relabels at once", "auto", {}, [
        ("label", r"^Change$"),
        ("send", "lang fr"), ("expect", r"Panel Language: fr"),
        ("label", r"^Changer$"),
        ("send", "lang es"), ("expect", r"Panel Language: es"),
        ("label", r"^Cambiar$"),
    ]),
    ("Status opens from the status bar, Back returns", "auto", {}, [
        ("tap", "bar"), ("wait", 0.3),
        ("label", r"^Status$"), ("label", r"^Pool-Net$"), ("label", r"^Up to date$"),
        ("tap", "back"), ("wait", 0.3),
        ("label", r"^Change$"), ("no_label", r"^Status$"),
    ]),
]


def run_flow(program, display, scenario, env, steps):
    """The flow's problems ([] when it holds) and its log."""
    p = Program(program, display, PANEL_LANG="en", PANEL_SCENARIO=scenario, **env)
    problems = []
    if p.wait_for(r"\[preview[^\]]*\]: ready", timeout=READY_TIMEOUT_S) is None:
        problems.append("not ready")
    start = cursor = 0
    for step in steps if not problems else []:
        kind, arg = step
        if kind == "tap":
            time.sleep(0.2)  # LVGL has drawn what the last step changed
            p.tap(*AT[arg])
        elif kind == "send":
            p.send(arg)
        elif kind == "wait":
            time.sleep(arg)
        elif kind == "expect":
            found = None
            deadline = time.monotonic() + 10
            rx = re.compile(arg)
            while found is None and time.monotonic() < deadline and p.proc.poll() is None:
                for i, line in enumerate(p.since(cursor)):
                    if rx.search(line):
                        found = cursor + i
                        break
                else:
                    time.sleep(0.05)
            if found is None:
                problems.append(f"expected a log line « {arg} »")
                break
            cursor = found + 1
        elif kind == "absent":
            hit = [l for l in p.since(start) if re.search(arg, l)]
            if hit:
                problems.append(f"unexpected « {hit[0]} »")
        elif kind in ("label", "no_label"):
            time.sleep(0.2)
            labels = p.labels()
            if labels is None:
                problems.append("no dump")
                break
            has = any(re.search(arg, l) for l in labels)
            if has != (kind == "label"):
                problems.append(f"{'no' if kind == 'label' else 'a'} label « {arg} » on the screen: {labels}")
    log = p.stop()
    return problems + problems_in(log), log


# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("program")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--lang", default=",".join(LANGS))
    ap.add_argument("--only", default="")
    ap.add_argument("--screen", default=",".join(SCREENS))
    ap.add_argument("--flows", action="store_true", help="the flows alone, no shots")
    ap.add_argument("--no-flows", action="store_true", help="no flows, even with --check")
    ap.add_argument("--out", default=str(HERE / "shots"))
    args = ap.parse_args()

    names = scenarios()
    if not names:
        sys.exit("shoot.py: no scenario found in preview.h")
    only = [s for s in args.only.split(",") if s]
    unknown = [s for s in only if s not in names]
    if unknown:
        sys.exit(f"shoot.py: no scenario {', '.join(unknown)} (preview.h has {', '.join(names)})")
    screens = [s for s in args.screen.split(",") if s]
    bad = [s for s in screens if s not in SCREENS]
    if bad:
        sys.exit(f"shoot.py: no screen {', '.join(bad)} ({', '.join(SCREENS)})")
    langs = [l for l in args.lang.split(",") if l]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    display = ":99"
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{WIDTH}x{HEIGHT}x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    failed = total = 0
    try:
        if not args.flows:
            for lang in langs:
                for screen in screens:
                    for name in only or names:
                        total += 1
                        shot = out / f"{lang}-{screen}-{name}.png"
                        problems, log = run_one(args.program, lang, screen, name, shot, display)
                        status = "ok" if not problems else "FAIL"
                        print(f"{status:4} {shot.relative_to(out.parent) if shot.exists() else shot.name}", flush=True)
                        if problems:
                            failed += 1
                            for p in problems:
                                print(f"     {p}")
                            if not args.check:
                                print(log[-2000:])
        if (args.check or args.flows) and not args.no_flows:
            for title, scenario, env, steps in FLOWS:
                total += 1
                problems, log = run_flow(args.program, display, scenario, env, steps)
                print(f"{'ok' if not problems else 'FAIL':4} flow: {title}", flush=True)
                if problems:
                    failed += 1
                    for p in problems:
                        print(f"     {p}")
                    print("\n".join(l for l in log.splitlines() if "[panel" in l or "[preview" in l)[-3000:])
    finally:
        xvfb.terminate()
    print(f"panel preview: {total - failed}/{total} without a problem")
    if failed and args.check:
        sys.exit(1)


if __name__ == "__main__":
    main()
