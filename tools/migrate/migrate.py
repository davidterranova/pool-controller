#!/usr/bin/env python3
"""`make migrate`: a controller built with secrets.yaml moves to the generic
firmware in one OTA, keeping every setting and its Home Assistant pairing.

  generate   secrets.yaml + the old firmware's probe addresses ->
             .migrate/migration.yaml (mode 600), the generic firmware plus a
             boot step that fills every empty setting with them
             (migration.yaml.in, migration_seed.h)
  run        preflight, upload, check: what `make migrate` does after the build
  preflight  the controller answers with secrets.yaml's API key, and is idle
             (pump off, no manual override, no fill)
  check      waits for the controller, then checks it runs the migration
             build, answers with the same API key, Setup State `configured`
             and the pool temperature reading (`make migrate-check`)

Runs in the ESPHome image (PyYAML, aioesphomeapi, ESPHome's own timezone
conversion), with `python3 -I`. Never prints a secret.
See docs/plans/secret-free-firmware.md, WP8.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import math
import os
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "migration.yaml.in"

DEVICE_NAME = "pool-controller"
API_PORT = 6053

# secrets.yaml's keys, as the last secrets.yaml.template (v1.3.x) named them.
SECRET_KEYS = {
    "wifi_ssid": "Wi-Fi network",
    "wifi_password": "Wi-Fi password",
    "pool_controller_api_key": "API key",
    "pool_controller_web_password": "page password",
    "pool_controller_ota_password": "OTA password",
    "pool_latitude": "latitude",
    "pool_longitude": "longitude",
    "pool_timezone": "timezone",
}

# The old firmware's dallas_temp sensor ids -> the role each probe gets.
PROBE_ROLES = {
    "pool_return_temp": "pool",
    "pad_ambient_temp": "pad",
    "outdoor_temp": "outdoor",
}


class MigrationError(Exception):
    """A problem the user has to fix; the message says which. `rollback`: the
    controller may be left on the migration build, so the rollback is printed."""

    def __init__(self, message: str, rollback: bool = False):
        super().__init__(message)
        self.rollback = rollback


# ---------------------------------------------------------------- the inputs


def load_yaml(text: str) -> object:
    """YAML as plain data; ESPHome's tags (!secret, !include, !lambda...) read as None."""

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_multi_constructor("!", lambda loader, suffix, node: None)
    return yaml.load(text, Loader=Loader)  # noqa: S506 - SafeLoader subclass


@dataclass(frozen=True)
class OldSettings:
    """What the controller was built with until now."""

    wifi_ssid: str
    wifi_password: str
    api_key: str
    page_password: str
    ota_password: str
    latitude: float
    longitude: float
    timezone_posix: str
    timezone_name: str
    probes: dict = field(default_factory=dict)  # role -> address (int)


def api_key_ok(text: str) -> bool:
    """Home Assistant's form of the key, as the firmware's decode_api_key: base64 of 32 bytes, not all zero."""
    if len(text) != 44 or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", text):
        return False
    try:
        raw = base64.b64decode(text, validate=True)
    except ValueError:
        return False
    return len(raw) == 32 and any(raw)


def round_degrees(value: float) -> float:
    """To the hundredth of a degree (about 1 km), as the Latitude/Longitude entities keep it."""
    return round(value * 100.0) / 100.0


def esphome_timezone(value: str) -> str:
    """ESPHome's own conversion (time: timezone:), so the zone is the one the old build compiled in."""
    from esphome.components.time import validate_tz

    return validate_tz(value)


def timezone_pair(value: str, convert=esphome_timezone) -> tuple[str, str]:
    """secrets.yaml's zone -> (POSIX zone, IANA name). A POSIX zone given as is has no name."""
    posix = convert(value)
    return posix, (value if posix != value else "")


# The page's and OTA's password rule (device-settings.yaml: min_length 8, max_length 64).
PASSWORD_MIN = 8
# What the password globals can store (max_restore_data_length 65: 64 bytes +
# the length byte; their size can't change, see device-settings.yaml): a
# longer one can't be seeded at all, so it stays an error.
PASSWORD_MAX = 64


def password_warnings(settings: "OldSettings") -> list:
    """Passwords seeded as they are although the page's rule (8 to 64 characters)
    would refuse them: worth changing once migrated. (Over 64 bytes is an error
    in old_settings(): the controller couldn't store it.)"""
    return [
        f"the {label} has {len(value)} characters, under {PASSWORD_MIN}: seeded as it is, "
        f"the page will ask to change it ({PASSWORD_MIN} to {PASSWORD_MAX} characters)"
        for label, value in (("page password", settings.page_password), ("OTA password", settings.ota_password))
        if len(value) < PASSWORD_MIN
    ]


def text_secret(secrets: dict, key: str, errors: list, *, max_bytes: int, allow_empty: bool = False) -> str:
    value = secrets.get(key)
    if value is None:
        errors.append(f"secrets.yaml has no {key} ({SECRET_KEYS[key]})")
        return ""
    value = str(value)
    if not value and not allow_empty:
        errors.append(f"{key} ({SECRET_KEYS[key]}) is empty")
    elif len(value.encode()) > max_bytes:
        errors.append(f"{key} ({SECRET_KEYS[key]}) is longer than {max_bytes} bytes: the controller can't store it"
                      " (shorten it in secrets.yaml and `make ota` the old build first)")
    return value


def degrees_secret(secrets: dict, key: str, limit: float, errors: list) -> float:
    value = secrets.get(key)
    try:
        degrees = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key} ({SECRET_KEYS[key]}) is not a number of degrees")
        return math.nan
    if not math.isfinite(degrees) or abs(degrees) > limit:
        errors.append(f"{key} ({SECRET_KEYS[key]}) is outside ±{limit:g}°")
        return math.nan
    return round_degrees(degrees)


def probe_addresses(old_config: object) -> dict:
    """The old firmware's dallas_temp addresses, by role."""
    sensors = old_config.get("sensor") if isinstance(old_config, dict) else None
    found = {}
    for sensor in sensors or []:
        if not isinstance(sensor, dict) or sensor.get("platform") != "dallas_temp":
            continue
        role = PROBE_ROLES.get(sensor.get("id"))
        address = sensor.get("address")
        if role is None or address is None:
            continue
        if isinstance(address, str):
            address = int(address, 16)
        if not 0 < address < 2**64:
            raise MigrationError(f"{role} probe: {address!r} is not a 1-Wire address")
        found[role] = address
    return found


def old_settings(secrets: object, old_config: object, convert=esphome_timezone) -> OldSettings:
    """Checks every input, so a bad one fails here rather than on the controller."""
    if not isinstance(secrets, dict):
        raise MigrationError("secrets.yaml is not a mapping of key: value")
    errors: list = []
    wifi_ssid = text_secret(secrets, "wifi_ssid", errors, max_bytes=32)
    wifi_password = text_secret(secrets, "wifi_password", errors, max_bytes=64, allow_empty=True)
    api_key = text_secret(secrets, "pool_controller_api_key", errors, max_bytes=44)
    if api_key and not api_key_ok(api_key):
        errors.append("pool_controller_api_key is not Home Assistant's form of a key (base64 of 32 bytes)")
    page_password = text_secret(secrets, "pool_controller_web_password", errors, max_bytes=PASSWORD_MAX)
    ota_password = text_secret(secrets, "pool_controller_ota_password", errors, max_bytes=PASSWORD_MAX)
    latitude = degrees_secret(secrets, "pool_latitude", 90.0, errors)
    longitude = degrees_secret(secrets, "pool_longitude", 180.0, errors)
    timezone = text_secret(secrets, "pool_timezone", errors, max_bytes=64)
    posix, name = "", ""
    if timezone:
        try:
            posix, name = timezone_pair(timezone, convert)
        except Exception as err:  # ESPHome raises its own Invalid
            errors.append(f"pool_timezone: {err}")
    probes = probe_addresses(old_config)
    if "pool" not in probes:
        errors.append("the old firmware has no pool_return_temp address: the pool probe would get no role")
    if len(set(probes.values())) != len(probes):
        errors.append("the old firmware gives two roles the same probe")
    if errors:
        raise MigrationError("\n".join(errors))
    return OldSettings(
        wifi_ssid, wifi_password, api_key, page_password, ota_password,
        latitude, longitude, posix, name, probes,
    )


# ------------------------------------------------------------- the package


SAFE = re.compile(rb"[A-Za-z0-9 _.,/+=-]")


def cpp_string(value: str) -> str:
    """A C++ string literal of the UTF-8 bytes. Anything but a few plain characters
    becomes a 3-digit octal escape: no quote, backslash, `$` (ESPHome's substitutions)
    or newline reaches the YAML, and an octal escape never swallows the next character."""
    out = []
    for byte in value.encode():
        char = bytes([byte])
        out.append(char.decode() if SAFE.fullmatch(char) else f"\\{byte:03o}")
    return '"' + "".join(out) + '"'


def cpp_address(address: int | None) -> str:
    return f"0x{address:016X}ULL" if address else "0ULL"


def template_values(settings: OldSettings, run_id: int, from_ref: str) -> dict:
    if not 0 < run_id < 2**32:
        raise ValueError("run id must be a non-zero uint32")
    return {
        "FROM": from_ref,
        "WIFI_SSID": cpp_string(settings.wifi_ssid),
        "WIFI_PASSWORD": cpp_string(settings.wifi_password),
        "API_KEY": cpp_string(settings.api_key),
        "PAGE_PASSWORD": cpp_string(settings.page_password),
        "OTA_PASSWORD": cpp_string(settings.ota_password),
        "LATITUDE": f"{settings.latitude:.2f}",
        "LONGITUDE": f"{settings.longitude:.2f}",
        "TIMEZONE_POSIX": cpp_string(settings.timezone_posix),
        "TIMEZONE_NAME": cpp_string(settings.timezone_name),
        "POOL_PROBE": cpp_address(settings.probes.get("pool")),
        "PAD_PROBE": cpp_address(settings.probes.get("pad")),
        "OUTDOOR_PROBE": cpp_address(settings.probes.get("outdoor")),
        "RUN_ID": f"{run_id}UL",
    }


MARKER = re.compile(r"\{\{([A-Z_]+)\}\}")


def render(template: str, values: dict) -> str:
    """Fills every {{NAME}}; a name without a value is a bug, not an empty string."""
    missing = sorted(set(MARKER.findall(template)) - values.keys())
    if missing:
        raise KeyError(f"no value for {', '.join(missing)}")
    return MARKER.sub(lambda m: values[m.group(1)], template)


def summary(settings: OldSettings, from_ref: str) -> str:
    """What the package fills, for the terminal: no password or key."""
    probes = ", ".join(f"{role} {settings.probes[role]:016x}" for role in ("pool", "pad", "outdoor") if role in settings.probes)
    tz = settings.timezone_name or settings.timezone_posix
    return "\n".join([
        "On its first boot, the migration build fills each of these settings if it is empty:",
        f"  Wi-Fi          network « {settings.wifi_ssid} » and its password",
        "  API key        the current one: Home Assistant keeps its pairing",
        "  passwords      the current page and OTA passwords",
        f"  position       {settings.latitude:.2f}, {settings.longitude:.2f} (to 0.01°)",
        f"  timezone       {tz} -> {settings.timezone_posix}",
        f"  probes         {probes} (from {from_ref})",
    ])


def write_private(path: Path, text: str) -> None:
    """Written whole or not at all, readable by its owner only."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def generate(args) -> int:
    secrets = load_yaml(Path(args.secrets).read_text(encoding="utf-8"))
    old_text = sys.stdin.read() if args.old_config == "-" else Path(args.old_config).read_text(encoding="utf-8")
    settings = old_settings(secrets, load_yaml(old_text))
    run_id = random.SystemRandom().randrange(1, 2**32)
    text = render(TEMPLATE.read_text(encoding="utf-8"), template_values(settings, run_id, args.from_ref))
    write_private(Path(args.out), text)
    print(f"{args.out_display or args.out}: written (mode 600, local only).")
    print(summary(settings, args.from_ref))
    for warning in password_warnings(settings):
        print(f"warning: {warning}")
    return 0


# ---------------------------------------------------------- the controller


# (entity type, name) of what the checks read; names as in pool-controller.yaml.
SETUP_STATE = ("TextSensorInfo", "Setup State")
POOL_TEMPERATURE = ("SensorInfo", "Pool Return Temperature")
PUMP = ("FanInfo", "Pump")
OVERRIDE_ACTIVE = ("BinarySensorInfo", "Manual Override Active")
FILL_FLOW = ("SensorInfo", "Piscine - Débit remplissage")
WAITING_FOR = ("TextSensorInfo", "Schedule Waiting For")
FIRMWARE_VERSION = ("TextSensorInfo", "Firmware Version")


@dataclass
class Snapshot:
    """What the controller said: its device info and the states read so far."""

    name: str = ""
    project_version: str = ""
    esphome_version: str = ""
    entities: set = field(default_factory=set)  # (type, name)
    states: dict = field(default_factory=dict)  # (type, name) -> value, None = unknown


def state_value(state) -> object:
    """An aioesphomeapi state as plain data: None when the device has no value."""
    if getattr(state, "missing_state", False):
        return None
    value = getattr(state, "state", None)
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def idle_problems(snap: Snapshot) -> list:
    """Why now is a bad time to reboot the controller (the plan: pump off, no manual override, no fill)."""
    problems = []
    if snap.states.get(PUMP):
        problems.append("the pump is running")
    if snap.states.get(OVERRIDE_ACTIVE):
        problems.append("a manual override is active")
    flow = snap.states.get(FILL_FLOW)
    if isinstance(flow, (int, float)) and flow > 0:
        problems.append(f"a fill is running ({flow:.1f} L/min)")
    return problems


def migrated_problems(snap: Snapshot, expected_version: str | None) -> list:
    """What isn't as it should be once the migration build runs; empty = migrated."""
    problems = []
    if SETUP_STATE not in snap.entities:
        version = snap.states.get(FIRMWARE_VERSION) or snap.project_version or "unknown version"
        problems.append(f"the controller still runs its old firmware ({version}): the upload didn't take")
        return problems
    if expected_version and snap.project_version != expected_version:
        problems.append(f"the controller runs {snap.project_version!r}, not the migration build {expected_version!r}")
    setup = snap.states.get(SETUP_STATE)
    if setup != "configured":
        problems.append(f"Setup State reads {setup!r} (what is still missing), not 'configured'")
    if not isinstance(snap.states.get(POOL_TEMPERATURE), (int, float)):
        problems.append("Pool Return Temperature has no reading yet")
    return problems


async def read_controller(host: str, key: str, done, timeout: float) -> Snapshot:
    """Connects with the API key, as Home Assistant does, then collects states until
    done(snapshot), the connection drops or the timeout. Raises the connection's error."""
    from aioesphomeapi import APIClient

    client = APIClient(host, API_PORT, None, noise_psk=key, client_info="pool-controller make migrate",
                       expected_name=DEVICE_NAME)
    changed = asyncio.Event()
    stopped = False

    async def on_stop(expected_disconnect: bool) -> None:
        nonlocal stopped
        stopped = True
        changed.set()

    await asyncio.wait_for(client.connect(on_stop=on_stop, login=True), timeout=20)
    try:
        info, entities, _ = await client.device_info_and_list_entities()
        snap = Snapshot(info.name, info.project_version, info.esphome_version)
        by_key = {}
        for entity in entities:
            ident = (type(entity).__name__, entity.name)
            snap.entities.add(ident)
            by_key[entity.key] = ident

        def on_state(state) -> None:
            ident = by_key.get(state.key)
            if ident is not None:
                snap.states[ident] = state_value(state)
                changed.set()

        client.subscribe_states(on_state)
        deadline = time.monotonic() + timeout
        while not done(snap) and not stopped and time.monotonic() < deadline:
            changed.clear()
            try:
                await asyncio.wait_for(changed.wait(), timeout=max(0.1, deadline - time.monotonic()))
            except asyncio.TimeoutError:
                break
        if stopped and not done(snap):
            raise ConnectionError("the controller closed the connection")
        return snap
    finally:
        if not stopped:
            await client.disconnect()


def describe_error(err: BaseException) -> str:
    kind = type(err).__name__
    if "Encryption" in kind or "Handshake" in kind or "RequiresEncryption" in kind:
        return f"{kind}: the controller doesn't take secrets.yaml's API key (Home Assistant would ask to re-pair)"
    return f"{kind}: {err}" if str(err) else f"{kind}: no answer"


async def wait_for_controller(host: str, key: str, done, timeout: float, settle: float) -> Snapshot:
    """Retries until the controller answers with the migration build (it reboots
    after the upload; the old firmware may still answer for a moment)."""
    deadline = time.monotonic() + timeout
    last = None

    def note(message: str) -> None:
        nonlocal last
        if message != last:
            last = message
            print(f"  not yet: {message}", flush=True)

    while time.monotonic() < deadline:
        try:
            snap = await read_controller(host, key, lambda s: SETUP_STATE not in s.entities or done(s), settle)
        except Exception as err:  # every connection error means: not back yet
            note(describe_error(err))
        else:
            if SETUP_STATE in snap.entities:
                return snap
            note(f"the old firmware still answers ({snap.states.get(FIRMWARE_VERSION) or 'unknown version'})")
        await asyncio.sleep(3)
    raise MigrationError(f"the controller didn't come back on the migration build within {timeout:.0f} s (last: {last})",
                         rollback=True)


def read_key(secrets_path: str) -> str:
    secrets = load_yaml(Path(secrets_path).read_text(encoding="utf-8"))
    key = str((secrets or {}).get("pool_controller_api_key") or "")
    if not api_key_ok(key):
        raise MigrationError("secrets.yaml's pool_controller_api_key is missing or not a key")
    return key


def read_ota_password(secrets_path: str) -> str:
    secrets = load_yaml(Path(secrets_path).read_text(encoding="utf-8"))
    password = str((secrets or {}).get("pool_controller_ota_password") or "")
    if not password:
        raise MigrationError("secrets.yaml has no pool_controller_ota_password")
    return password


def rollback_text(host: str, from_ref: str) -> str:
    return "\n".join([
        "ROLLBACK: put back the last secrets.yaml build, as the controller was:",
        f"  git worktree add ../pool-controller-rollback {from_ref}",
        "  cp secrets.yaml ../pool-controller-rollback/",
        f"  make -C ../pool-controller-rollback ota HOST={host}",
        "If the controller isn't on the network any more, it opens its hotspot",
        "« pool-controller » after a minute: join it, then the same make with HOST=192.168.4.1.",
    ])


def preflight(args) -> int:
    key = read_key(args.secrets)
    print(f"Preflight: {args.host}, with secrets.yaml's API key…", flush=True)
    gate = (PUMP, OVERRIDE_ACTIVE, FILL_FLOW)
    try:
        snap = asyncio.run(read_controller(args.host, key, lambda s: all(i in s.states for i in gate if i in s.entities), 10))
    except Exception as err:  # nothing is uploaded yet: stop here
        raise MigrationError(f"the controller doesn't answer as expected, nothing uploaded: {describe_error(err)}") from err
    print(f"  {snap.name}: {snap.project_version or '?'} on ESPHome {snap.esphome_version}")
    if SETUP_STATE in snap.entities:
        print("  it already runs a secret-free build: the migration only fills what is still empty")
    problems = idle_problems(snap)
    if problems and not args.force:
        raise MigrationError("not now: " + "; ".join(problems) + ". Wait, or pass MIGRATE_FORCE=1.")
    for problem in problems:
        print(f"  warning: {problem} (MIGRATE_FORCE=1)")
    return 0


def check(args) -> int:
    key = read_key(args.secrets)
    print(f"Waiting for {args.host} with the same API key…", flush=True)
    snap = asyncio.run(wait_for_controller(
        args.host, key, lambda s: not migrated_problems(s, args.expect_version), args.timeout, args.settle))
    print(f"  back: {snap.name} {snap.project_version} on ESPHome {snap.esphome_version}; the API key is the same")
    for ident in (SETUP_STATE, POOL_TEMPERATURE, WAITING_FOR):
        if ident in snap.entities:
            print(f"  {ident[1]}: {snap.states.get(ident)}")
    problems = migrated_problems(snap, args.expect_version)
    if problems:
        raise MigrationError("\n".join(problems), rollback=True)
    print("Migrated: configured, same API key (Home Assistant keeps its pairing), pool temperature reading.")
    print("Once Home Assistant shows it connected, `make migrate-clean` deletes the build holding the secrets.")
    return 0


def upload(args) -> int:
    password = read_ota_password(args.secrets)
    # The password goes to `esphome upload` only (as `make ota`), inside this
    # container: never on the host's command line, never compiled in.
    cmd = ["esphome", "-s", "ota_password", password, "upload", args.config, "--device", args.host]
    print(f"Uploading {args.config} to {args.host} with today's OTA password…", flush=True)
    if subprocess.run(cmd, check=False).returncode != 0:
        raise MigrationError("the upload failed: the controller still runs its old firmware")
    return 0


def run(args) -> int:
    preflight(args)
    upload(args)
    return check(args)


# --------------------------------------------------------------------- main


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate")
    gen.add_argument("--secrets", required=True)
    gen.add_argument("--old-config", required=True, help="the old pool-controller.yaml, - for stdin")
    gen.add_argument("--from-ref", required=True, help="the git ref it comes from, for the record")
    gen.add_argument("--out", required=True)
    gen.add_argument("--out-display", help="the path to print, if --out is the container's")
    gen.set_defaults(func=generate)

    for name, func in (("preflight", preflight), ("check", check), ("run", run)):
        cmd = sub.add_parser(name)
        cmd.add_argument("--secrets", required=True)
        cmd.add_argument("--host", required=True)
        cmd.add_argument("--from-ref", required=True, help="the last secrets.yaml build, for the rollback")
        cmd.add_argument("--expect-version", help="the migration build's firmware_version")
        cmd.add_argument("--config", help="the migration build's config (run: uploaded)")
        cmd.add_argument("--force", action="store_true", help="migrate even if the controller is busy")
        cmd.add_argument("--timeout", type=float, default=180, help="seconds to wait for the controller")
        cmd.add_argument("--settle", type=float, default=180, help="seconds to wait for configured + a pool reading")
        cmd.set_defaults(func=func)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except MigrationError as err:
        print(f"\nmake migrate: {err}", file=sys.stderr)
        if err.rollback:
            print("\n" + rollback_text(args.host, args.from_ref), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
