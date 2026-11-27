// panel_i18n.h, the touch panel's texts compiled in (docs/plans/s3-panel.md, S3): generated from i18n-panel/{en,fr,es}.json
// and the keys of the surfaces the panel reads (`card`: the speeds, common.mode.*) that its sources use, by key or by
// a tr_prefix("prefix.", code) prefix. The board carries no dictionary it doesn't draw.
//
//   node tools/i18n/panel-header.mjs           writes panel_i18n.h (make panel-i18n)
//   node tools/i18n/panel-header.mjs --check   fails when panel_i18n.h isn't what the dictionaries give (make i18n-check)
//
// It refuses (exit 1, nothing written):
//   - a text missing in a language, or a plural (the panel writes units, never plural words);
//   - a character no panel font covers: every font of local-panel.yaml draws every text, so each one's glyphsets
//     (tools/i18n/panel-glyphsets.json) plus its glyphs must hold every character of every text.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, FALLBACK, SURFACES, loadSurface, listSources, scanUsage } from "./lib.mjs";
import { isPlural } from "../../home-assistant/i18n.js";

export const HEADER = "panel_i18n.h";
export const PANEL_YAML = "local-panel.yaml";

/**
 * The fonts of local-panel.yaml's `font:` block, as [{ id, glyphsets: [], glyphs: "" }]. A small reader for the
 * shape that file uses (one `- file:` item per font, glyphsets as a flow list, glyphs as a quoted string), not YAML.
 */
export function readFonts(yaml) {
  const fonts = [];
  let inFont = false, cur = null;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) { inFont = /^font:\s*$/.test(line); cur = null; continue; }
    if (!inFont || !line.trim()) continue;
    if (/^\s*-\s/.test(line)) { cur = { id: null, glyphsets: [], glyphs: "" }; fonts.push(cur); }
    if (!cur) continue;
    const m = line.match(/^\s*(?:-\s+)?(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "id") cur.id = v.trim();
    if (k === "glyphsets") cur.glyphsets = v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (k === "glyphs") cur.glyphs = JSON.parse(v.trim().replace(/^'(.*)'$/, (x, s) => JSON.stringify(s)));
  }
  return fonts;
}

/** The characters each font covers: Map(font id → Set), or the problems (an unknown glyph set). */
export function coverage(fonts, glyphsets) {
  const problems = [], covered = new Map();
  for (const f of fonts) {
    const set = new Set([...f.glyphs]);
    for (const g of f.glyphsets) {
      if (!(g in glyphsets)) { problems.push(`${PANEL_YAML}: font ${f.id}: glyph set ${g} isn't in tools/i18n/panel-glyphsets.json`); continue; }
      for (const c of glyphsets[g]) set.add(c);
    }
    covered.set(f.id, set);
  }
  return { covered, problems };
}

/** A C string literal of `s` (UTF-8 kept as is: the compiler and LVGL take it). */
export const cString = (s) =>
  `"${[...s].map((c) => ({ "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\t": "\\t" })[c] ?? (c < " " ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}""` : c)).join("")}"`;

/** The header's entries: [{ key, texts: [en, fr, es] }] sorted by key, or the problems. */
export function entries(root, { surfaces = SURFACES, langs = LANGS } = {}) {
  const problems = [];
  const panel = surfaces.find((s) => s.id === "panel");
  const P = loadSurface(root, panel, langs);
  if (!P.present) return { list: [], problems: [`${panel.dir}/ is missing`] };
  problems.push(...P.problems);

  // What the panel's sources use of the surfaces it reads.
  const keys = new Set(), prefixes = new Set();
  for (const f of listSources(root, panel.sources)) {
    const u = scanUsage(readFileSync(path.join(root, f), "utf8"), panel.usage);
    u.keys.forEach((k) => keys.add(k));
    u.prefixes.forEach((p) => prefixes.add(p));
  }
  const pick = new Map(); // key -> flat per language
  const add = (flat, key) => pick.set(key, flat);
  for (const k of P.flat[FALLBACK]?.keys() || []) add(P.flat, k);
  for (const id of panel.reads) {
    const R = loadSurface(root, surfaces.find((s) => s.id === id), langs);
    for (const k of R.flat[FALLBACK]?.keys() || [])
      if (keys.has(k) || [...prefixes].some((p) => p && k.startsWith(p))) {
        if (pick.has(k)) problems.push(`${k} is in ${panel.dir} and in ${id}: one key, one text`);
        else add(R.flat, k);
      }
  }

  const list = [];
  for (const [key, flat] of pick) {
    const texts = langs.map((l) => flat[l]?.get(key));
    if (texts.some((t) => t === undefined)) { problems.push(`${key}: missing in ${langs.filter((l, i) => texts[i] === undefined).join(", ")}`); continue; }
    if (texts.some((t) => isPlural(t))) { problems.push(`${key}: a plural; the panel's texts have none (write « {n} min », not « {count} minutes »)`); continue; }
    list.push({ key, texts });
  }
  // Byte order, as strcmp sorts: panel_ui.h's find_key searches it.
  list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { list, problems };
}

/** The characters of `list`'s texts that a font lacks: ["panel.x (fr): « ŷ » not in panel_font_m"]. */
export function uncovered(list, covered, langs = LANGS) {
  const problems = [];
  for (const { key, texts } of list)
    texts.forEach((t, i) => {
      const chars = new Set([...t.replace(/\{\w+\}/g, "")].filter((c) => c !== "\n"));
      for (const [font, set] of covered) {
        const lost = [...chars].filter((c) => !set.has(c));
        if (lost.length) problems.push(`${key} (${langs[i]}): ${lost.map((c) => `« ${c} » (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`).join(", ")} not in font ${font}`);
      }
    });
  return problems;
}

/** panel_i18n.h's text. */
export function render(list, langs = LANGS) {
  const out = [
    "#pragma once",
    "// GENERATED by tools/i18n/panel-header.mjs (make panel-i18n) from i18n-panel/{en,fr,es}.json and the card's keys",
    "// the panel uses. Never edit: change the dictionaries, then run make panel-i18n. make i18n-check fails when this",
    "// file is stale. Read through panel_ui.h (T, tr_prefix), never directly.",
    "",
    "#include <cstdint>",
    "",
    "namespace panel_i18n {",
    "",
    `enum Lang : uint8_t { ${langs.map((l, i) => `${l.toUpperCase()} = ${i}`).join(", ")} };`,
    `inline constexpr int LANG_COUNT = ${langs.length};`,
    `inline constexpr const char *LANG_CODES[LANG_COUNT] = {${langs.map((l) => cString(l)).join(", ")}};`,
    "",
    `inline constexpr int KEY_COUNT = ${list.length};`,
    "",
    "// Sorted by byte, for panel_ui::find_key.",
    "inline constexpr const char *KEYS[KEY_COUNT] = {",
    ...list.map((e) => `    ${cString(e.key)},`),
    "};",
    "",
    `// TEXTS[key][lang], in KEYS' order: ${langs.join(", ")}.`,
    "inline constexpr const char *TEXTS[KEY_COUNT][LANG_COUNT] = {",
    ...list.map((e) => `    {${e.texts.map(cString).join(", ")}},  // ${e.key}`),
    "};",
    "",
    "}  // namespace panel_i18n",
    "",
  ];
  return out.join("\n");
}

/** The header, or the problems that keep it from being written. */
export function build(root, opts = {}) {
  const { list, problems } = entries(root, opts);
  const yamlFile = path.join(root, PANEL_YAML);
  if (!existsSync(yamlFile)) problems.push(`${PANEL_YAML} is missing: its fonts say which characters the panel can draw`);
  else {
    const fonts = readFonts(readFileSync(yamlFile, "utf8"));
    if (!fonts.length) problems.push(`${PANEL_YAML} has no font`);
    const glyphsets = JSON.parse(readFileSync(path.join(root, "tools/i18n/panel-glyphsets.json"), "utf8"));
    const { covered, problems: p } = coverage(fonts, glyphsets);
    problems.push(...p, ...uncovered(list, covered, opts.langs));
  }
  return { text: render(list, opts.langs), count: list.length, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const checkOnly = process.argv.includes("--check");
  const { text, count, problems } = build(root);
  if (problems.length) {
    console.error(`${HEADER}: not generated:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const file = path.join(root, HEADER);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (checkOnly) {
    if (current !== text) {
      console.error(`${HEADER} is stale: run make panel-i18n`);
      process.exit(1);
    }
    console.log(`${HEADER}: up to date (${count} texts)`);
  } else {
    if (current !== text) writeFileSync(file, text);
    console.log(`${HEADER}: ${count} texts × ${LANGS.length} languages${current === text ? ", unchanged" : ""}`);
  }
}
