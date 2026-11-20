"""Check home-assistant/dashboard/ and home-assistant/blueprints/ against the firmware they are written for.

    python3 tools/ha-dashboard-check.py pool-controller.yaml home-assistant/dashboard [--list]

The files checked are the ones Home Assistant gets: each language's file that make ha-files generates from a
template (dashboard.<lang>.yaml, scripts.<lang>.yaml, a blueprint per language); the templates (*.tmpl.yaml)
themselves are skipped. They use the entity ids a fresh install gets: Home Assistant names an ESPHome entity
<domain>.<device>_<entity name>, slugified, with the device's friendly_name ("Pool Controller"). This fails when
  - a template lacks a file in one of the languages of LANGS (home-assistant/i18n.js): run make ha-files;
  - an id that names a controller entity (<domain>.pool_controller_…) matches no entity of the YAML
    (renamed, removed, internal, or a text_sensor written as text_sensor.… instead of sensor.…);
  - a piscine-card in the dashboard leaves out an entity of the card's DEFAULT_ENTITIES that is one
    particular install's id (most of them), not a fresh one's: a default that already is a fresh
    install's id needn't be mapped, and one the YAML doesn't have yet (the firmware's updates before
    they land) is only noted, since the card hides its rows;
  - a script the card calls, or a dashboard names, isn't in the same language's scripts.<lang>.yaml, or
    the languages' scripts differ in their ids (the card's API);
  - a blueprint of home-assistant/blueprints/ isn't one Home Assistant can import: no name or domain, a
    `!input` naming no declared input (inputs may sit in sections), a declared input used nowhere, a
    source_url that isn't its own path in the repo, or a controller id (its defaults) the YAML lacks.
--list prints every id a fresh install gets, to write the dashboard from.
"""

from __future__ import annotations

import os
import re
import sys
import unicodedata

import yaml

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "webui-mock"))
from mock_server import load_layout  # noqa: E402  (the mock's loader: ESPHome tags, packages)

HA_DOMAIN = {"text_sensor": "sensor"}  # ESPHome text sensors are sensors in Home Assistant
ID = re.compile(r"\b((?:sensor|binary_sensor|number|select|button|switch|fan|text|datetime|update|script|sun|input_[a-z_]+)\.[a-z0-9_]+)\b")


def slugify(text: str) -> str:
    """Home Assistant's slugify for entity ids: ASCII, lowercase, runs of anything else -> one "_"."""
    ascii_ = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", ascii_.lower()).strip("_")


def firmware_ids(config: str) -> tuple[str, set[str]]:
    layout = load_layout(config)
    device = slugify(layout.title)
    return device, {f"{HA_DOMAIN.get(e.domain, e.domain)}.{device}_{slugify(e.name)}" for e in layout.entities}


def strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)


def cards(node):
    if isinstance(node, dict):
        if str(node.get("type", "")).startswith("custom:piscine-card"):
            yield node
        for v in node.values():
            yield from cards(v)
    elif isinstance(node, list):
        for v in node:
            yield from cards(v)


def card_defaults(card_js: str) -> dict[str, str]:
    body = re.search(r"const DEFAULT_ENTITIES = \{(.*?)\n\};", open(card_js, encoding="utf-8").read(), re.S).group(1)
    return dict(re.findall(r'^\s*(\w+): "([^"]+)",', body, re.M))


class Input(str):
    """A blueprint's `!input name`: the name, as a string apart."""


class BlueprintLoader(yaml.SafeLoader):
    pass


BlueprintLoader.add_constructor("!input", lambda loader, node: Input(loader.construct_scalar(node)))


def inputs_used(node):
    if isinstance(node, Input):
        yield str(node)
    elif isinstance(node, dict):
        for v in node.values():
            yield from inputs_used(v)
    elif isinstance(node, list):
        for v in node:
            yield from inputs_used(v)


def declared_inputs(inputs: dict) -> dict:
    """Name -> declaration, sections (an `input:` of their own) flattened."""
    out = {}
    for k, v in (inputs or {}).items():
        if isinstance(v, dict) and "input" in v:
            out.update(declared_inputs(v["input"]))
        else:
            out[k] = v or {}
    return out


SOURCE = "https://github.com/davidterranova/pool-controller/blob/main/"


def check_blueprint(path: str, rel: str, device: str, known: set[str]) -> tuple[list[str], int]:
    name = os.path.basename(path)
    with open(path, encoding="utf-8") as f:
        doc = yaml.load(f, Loader=BlueprintLoader)  # noqa: S506 (SafeLoader plus !input)
    meta = (doc or {}).get("blueprint") or {}
    errors = [f"{name}: blueprint.{k} is missing" for k in ("name", "domain", "input") if not meta.get(k)]
    if meta.get("domain") not in (None, "automation", "script"):
        errors.append(f"{name}: blueprint.domain {meta['domain']} is neither automation nor script")
    if meta.get("source_url") != SOURCE + rel:
        errors.append(f"{name}: source_url should be {SOURCE + rel} (what Home Assistant re-imports from)")
    declared = declared_inputs(meta.get("input"))
    used = set(inputs_used({k: v for k, v in doc.items() if k != "blueprint"}))
    errors += [f"{name}: !input {i} is not declared under blueprint.input" for i in sorted(used - set(declared))]
    errors += [f"{name}: input {i} is declared but never used" for i in sorted(set(declared) - used)]
    ids = {m for s in strings(doc) for m in ID.findall(s) if m.split(".", 1)[1].startswith(device + "_")}
    errors += [f"{name}: {i} is not an entity of the firmware" for i in sorted(ids - known)]
    return errors, len(ids)


TEMPLATE = ".tmpl.yaml"
# make ha-files' header (tools/i18n/ha-files.mjs): « # Generated by make ha-files from <template> (<lang>): … »
GENERATED = re.compile(r"^# Generated by make ha-files from (\S+) \((\w+)\)")


def languages(i18n_js: str) -> list[str]:
    """LANGS of home-assistant/i18n.js, so a new language needs no change here."""
    text = open(i18n_js, encoding="utf-8").read()
    return re.findall(r'"(\w+)"', re.search(r"export const LANGS = \[(.*?)\]", text).group(1))


def generated(path: str) -> tuple[str, str] | None:
    """(template, language) of a file make ha-files wrote, from its first line; None for any other file."""
    with open(path, encoding="utf-8") as f:
        m = GENERATED.match(f.readline())
    return (m.group(1), m.group(2)) if m else None


def yaml_files(folder: str) -> list[tuple[str, str, tuple[str, str] | None]]:
    """(name, path, (template, language) or None) of each YAML file Home Assistant gets: templates left out."""
    if not os.path.isdir(folder):
        return []
    names = sorted(n for n in os.listdir(folder) if n.endswith(".yaml") and not n.endswith(TEMPLATE))
    return [(n, os.path.join(folder, n), generated(os.path.join(folder, n))) for n in names]


def missing_languages(folder: str, files, langs: list[str]) -> list[str]:
    """Each template of `folder` must have a generated file in every language."""
    have: dict[str, set[str]] = {}
    for _, _, gen in files:
        if gen:
            have.setdefault(gen[0], set()).add(gen[1])
    templates = sorted(n for n in os.listdir(folder) if n.endswith(TEMPLATE)) if os.path.isdir(folder) else []
    return [f"{t} has no {lang} file: run make ha-files" for t in templates for lang in langs
            if lang not in have.get(t, set())]


def main() -> int:
    config, folder = sys.argv[1], sys.argv[2]
    device, known = firmware_ids(config)
    if "--list" in sys.argv:
        print("\n".join(sorted(known)))
        return 0

    root = os.path.dirname(os.path.abspath(config))
    langs = languages(os.path.join(root, "home-assistant", "i18n.js"))
    defaults = card_defaults(os.path.join(root, "home-assistant", "piscine-card.js"))
    fresh = {k for k, v in defaults.items() if v.split(".", 1)[1].startswith(device + "_")}
    card_scripts = {v for v in defaults.values() if v.startswith("script.")}
    files = yaml_files(folder)
    blueprints = os.path.join(root, "home-assistant", "blueprints")
    blueprint_files = yaml_files(blueprints)
    errors = missing_languages(folder, files, langs) + missing_languages(blueprints, blueprint_files, langs)

    scripts: dict[str, set[str]] = {}  # language -> the script ids of its scripts.<lang>.yaml
    for name, path, gen in files:
        if gen and gen[0] == "scripts" + TEMPLATE:
            with open(path, encoding="utf-8") as f:
                scripts[gen[1]] = {f"script.{k}" for k in (yaml.safe_load(f) or {})}
    first = scripts.get(langs[0])
    for lang, ids in sorted(scripts.items()):
        errors += [f"scripts.tmpl.yaml ({lang}): {i}, which the card calls, is not defined" for i in sorted(card_scripts - ids)]
        if first is not None and ids != first:
            errors.append(f"scripts.tmpl.yaml ({lang}): its script ids differ from {langs[0]}'s (they are the card's API)")

    used = 0
    for name, path, gen in files:
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        # a language's file calls that language's scripts; a hand-written one, those every language has
        defined = scripts.get(gen[1], set()) if gen else set.intersection(*scripts.values()) if scripts else set()
        ids = {m for s in strings(doc) for m in ID.findall(s)}
        for i in sorted(ids):
            if i.split(".", 1)[1].startswith(device + "_"):
                used += 1
                if i not in known:
                    errors.append(f"{name}: {i} is not an entity of {os.path.basename(config)}")
            elif i.startswith("script.") and i not in defined:
                errors.append(f"{name}: {i} is not defined in {('the ' + gen[1] + ' file') if gen else 'every language file'} of scripts.tmpl.yaml")
        for card in cards(doc):
            missing = sorted(set(defaults) - fresh - set(card.get("entities") or {}))
            if missing:
                errors.append(f"{name}: a piscine-card leaves out entities {', '.join(missing)} "
                              "(its defaults are one install's ids: map every one)")
    for name, path, _ in blueprint_files:
        found, n = check_blueprint(path, f"home-assistant/blueprints/{name}", device, known)
        errors += found
        used += n
    for e in errors:
        print(f"ERROR {e}")
    ahead = sorted(k for k in fresh if defaults[k] not in known)
    if ahead:
        print(f"NOTE piscine-card's defaults for {', '.join(ahead)} name no entity of {os.path.basename(config)}: "
              "the card hides their rows until the firmware has them")
    print(f"{len(files) + len(blueprint_files)} files ({', '.join(langs)}): {used} controller entity references checked "
          f"against {len(known)} entities of {os.path.basename(config)}{': OK' if not errors else f', {len(errors)} error(s)'}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
