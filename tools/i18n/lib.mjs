// The dictionaries' checks, and the Markdown round-trip through Lokalise (docs/plans/i18n.md, I2): what
// tools/i18n/check.mjs, export.mjs and import.mjs run, and tools/tests/i18n-tools.test.mjs tests. Every function
// takes the repo's root, so the tests run them on made-up folders.
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import path from "node:path";
import { LANGS, FALLBACK, isPlural } from "../../home-assistant/i18n.js";
import { SURFACES, SAME_AS_ENGLISH } from "./surfaces.mjs";

export { LANGS, FALLBACK, SURFACES, SAME_AS_ENGLISH };

// ------------------------------------------------------------------ dictionaries

/** A dictionary → Map(key → string | plural object), or the problems that kept it from flattening. */
export function flatten(dict, prefix = "", out = new Map(), problems = []) {
  for (const [k, v] of Object.entries(dict || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" || isPlural(v)) out.set(key, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("other" in v || "one" in v) problems.push(`${key}: a plural needs only CLDR categories, \`other\` among them`);
      else flatten(v, key, out, problems);
    } else problems.push(`${key}: neither a text, a plural nor a group`);
  }
  return { map: out, problems };
}

/** The surface's dictionaries: { present, dicts: {lang: object}, flat: {lang: Map}, problems }. */
export function loadSurface(root, surface, langs = LANGS) {
  const dir = path.join(root, surface.dir);
  const res = { surface, present: existsSync(dir), dicts: {}, flat: {}, problems: [] };
  if (!res.present) return res;
  for (const lang of langs) {
    const file = path.join(dir, `${lang}.json`);
    if (!existsSync(file)) { res.problems.push(`${surface.dir}/${lang}.json is missing`); continue; }
    try {
      res.dicts[lang] = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      res.problems.push(`${surface.dir}/${lang}.json: ${e.message}`);
      continue;
    }
    const { map, problems } = flatten(res.dicts[lang]);
    res.flat[lang] = map;
    res.problems.push(...problems.map((p) => `${surface.dir}/${lang}.json: ${p}`));
  }
  return res;
}

/** The `{placeholders}` of a text, sorted. */
export const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** Its HTML tags (« b », « /b »), sorted: a translation keeps the same markup. */
export const tags = (s) => [...String(s).matchAll(/<\s*(\/?)\s*([a-zA-Z][\w-]*)[^>]*>/g)].map((m) => m[1] + m[2].toLowerCase()).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const uniq = (a) => [...new Set(a)].sort();
/** Every form of a value, as [form | null, text]. */
const forms = (v) => (typeof v === "string" ? [[null, v]] : Object.entries(v));
const allText = (v) => forms(v).map(([, t]) => t).join("\n");

/** The plural categories a language uses (« one », « many », « other » in French). */
const categories = (lang) => new Intl.PluralRules(lang).resolvedOptions().pluralCategories;

// ------------------------------------------------------------------ sources

/** The files a surface's `sources` globs name (one `*` in the file name), symlinks left out. */
export function listSources(root, globs) {
  const files = new Set();
  for (const g of globs) {
    const dir = path.dirname(g), base = path.basename(g);
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    let names = [];
    try { names = readdirSync(path.join(root, dir)); } catch { continue; }
    for (const n of names.sort()) {
      const rel = path.join(dir, n);
      if (re.test(n) && lstatSync(path.join(root, rel)).isFile()) files.add(rel);
    }
  }
  return [...files];
}

/** The keys a source uses: { keys: Set, prefixes: Set } (a prefix from t(`card.speed.${v}`)). */
export function scanUsage(text, usage) {
  const keys = new Set(), prefixes = new Set();
  if (usage === "template") {
    for (const m of text.matchAll(/\{\{\s*t:([\w.:-]+)\s*\}\}/g)) keys.add(m[1]);
    return { keys, prefixes };
  }
  for (const m of text.matchAll(/(?:^|[^\w$])_?t\(\s*(["'`])([\w.:-]+)\1/g)) keys.add(m[2]);
  for (const m of text.matchAll(/(?:^|[^\w$])_?t\(\s*`([\w.:-]*)\$\{/g)) prefixes.add(m[1]);
  return { keys, prefixes };
}

/**
 * French-looking literals left in a source: quoted strings on lines outside comments with French letters or
 * « », the sign of a text that hasn't moved to a dictionary yet. A heuristic: [{line, text}].
 */
export function frenchLiterals(text) {
  const found = [];
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  noBlocks.split("\n").forEach((line, i) => {
    const code = line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1").replace(/^\s*#.*$/, "");
    for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1|>([^<>]*[A-Za-zÀ-ÿ][^<>]*)</g)) {
      const s = m[2] ?? m[3];
      if (/[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŸŒÆ«»]/.test(s)) found.push({ line: i + 1, text: s.trim().slice(0, 80) });
    }
  });
  return found;
}

// ------------------------------------------------------------------ check

/**
 * Every surface's dictionaries against each other and against their sources. Returns
 * { errors: [], warnings: [], summary: [] }: errors fail make i18n-check.
 */
export function check(root, { surfaces = SURFACES, langs = LANGS, sameAsEnglish = SAME_AS_ENGLISH } = {}) {
  const errors = [], warnings = [], summary = [];
  const loaded = Object.fromEntries(surfaces.map((s) => [s.id, loadSurface(root, s, langs)]));
  const usage = {}; // surface id -> { keys: Map(key -> files), prefixes: Map(prefix -> files) }
  for (const s of surfaces) {
    const u = { keys: new Map(), prefixes: new Map(), files: listSources(root, s.sources) };
    for (const f of u.files) {
      const found = scanUsage(readFileSync(path.join(root, f), "utf8"), s.usage);
      for (const k of found.keys) u.keys.set(k, [...(u.keys.get(k) || []), f]);
      for (const p of found.prefixes) u.prefixes.set(p, [...(u.prefixes.get(p) || []), f]);
    }
    usage[s.id] = u;
  }

  for (const s of surfaces) {
    const L = loaded[s.id];
    if (!L.present) { summary.push(`${s.id}: no ${s.dir}/ yet, skipped`); continue; }
    errors.push(...L.problems);
    const en = L.flat[FALLBACK];
    if (!en) continue;

    for (const lang of langs.filter((l) => l !== FALLBACK && L.flat[l])) {
      const tr = L.flat[lang], cats = categories(lang);
      for (const key of en.keys()) if (!tr.has(key)) errors.push(`${s.id}: ${key} is missing in ${lang}`);
      for (const key of tr.keys()) if (!en.has(key)) errors.push(`${s.id}: ${key} is in ${lang} but not in ${FALLBACK}`);
      for (const [key, ev] of en) {
        const tv = tr.get(key);
        if (tv === undefined) continue;
        const where = `${s.id}: ${key} (${lang})`;
        if (isPlural(ev) !== isPlural(tv)) { errors.push(`${where}: ${isPlural(ev) ? "should be" : "should not be"} a plural, as in ${FALLBACK}`); continue; }
        if (isPlural(tv)) {
          for (const f of Object.keys(tv)) if (!cats.includes(f)) errors.push(`${where}: « ${f} » is not a plural form of ${lang} (${cats.join(", ")})`);
          for (const f of Object.keys(ev)) if (cats.includes(f) && !(f in tv)) errors.push(`${where}: the « ${f} » form is missing`);
        }
        const pe = uniq(placeholders(allText(ev))), pt = uniq(placeholders(allText(tv)));
        if (!same(pe, pt)) errors.push(`${where}: placeholders ${JSON.stringify(pt)} differ from ${FALLBACK}'s ${JSON.stringify(pe)}`);
        for (const [f, t] of forms(tv)) {
          const ref = f === null ? ev : ev[f] ?? ev.other;
          if (!same(tags(t), tags(ref))) errors.push(`${where}${f ? `#${f}` : ""}: markup ${JSON.stringify(tags(t))} differs from ${FALLBACK}'s ${JSON.stringify(tags(ref))}`);
        }
        for (const [f, t] of forms(tv)) {
          if (!t.trim() || /^\s*TODO\b/i.test(t)) errors.push(`${where}${f ? `#${f}` : ""}: empty or TODO`);
        }
        const letters = (t) => t.replace(/\{\w+\}|<[^>]*>/g, "").match(/\p{L}/u);
        if (allText(tv) === allText(ev) && letters(allText(ev)) && !sameAsEnglish.includes(`${s.id}:${key}`))
          errors.push(`${where}: same text as ${FALLBACK}, an untranslated copy? (or list it in SAME_AS_ENGLISH, tools/i18n/surfaces.mjs)`);
      }
    }
    for (const lang of langs) for (const [key, v] of L.flat[lang] || []) {
      if (lang === FALLBACK) for (const [f, t] of forms(v)) if (!t.trim()) errors.push(`${s.id}: ${key}${f ? `#${f}` : ""} (${lang}): empty`);
    }

    // Usage: the keys this surface's sources use must exist here (or in a surface it reads);
    // the keys no source uses (here or in a surface reading this one) are dead.
    const known = (k) => [s.id, ...s.reads].some((id) => loaded[id]?.flat[FALLBACK]?.has(k));
    for (const [k, files] of usage[s.id].keys) if (!known(k)) errors.push(`${s.id}: ${files[0]} uses ${k}, which isn't in ${s.dir}/${FALLBACK}.json`);
    const users = [s, ...surfaces.filter((o) => o.reads.includes(s.id))];
    const used = (k) => users.some((o) => usage[o.id].keys.has(k) || [...usage[o.id].prefixes.keys()].some((p) => p && k.startsWith(p)));
    const unused = [...en.keys()].filter((k) => !used(k));
    if (unused.length) (s.strict ? errors : warnings).push(`${s.id}: ${unused.length} key(s) no source uses yet: ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", …" : ""}`);

    let literals = 0;
    for (const f of usage[s.id].files) {
      if (s.usage !== "code") continue;
      const found = frenchLiterals(readFileSync(path.join(root, f), "utf8"));
      literals += found.length;
      if (s.strict) for (const x of found) errors.push(`${s.id}: ${f}:${x.line}: French text outside the dictionaries: ${x.text}`);
    }
    if (literals && !s.strict) warnings.push(`${s.id}: ${literals} French-looking literal(s) still in its sources (fails once the surface is strict)`);
    summary.push(`${s.id}: ${en.size} key(s) × ${langs.length} languages${s.strict ? ", strict" : ""}`);
  }
  return { errors, warnings, summary };
}

// ------------------------------------------------------------------ Markdown round-trip (Lokalise)

const MARK = "i18n:";
/** A text as a Markdown paragraph: Markdown's own characters escaped, line breaks as <br>. */
export function encodeText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]])/g, "\\$1")
    .replace(/\n/g, "<br>")
    .replace(/^(\s*)([#>+|-])/, "$1\\$2")
    .replace(/^(\s*\d+)\./, "$1\\.");
}
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", laquo: "«", raquo: "»" };
/** The reverse of encodeText, and what a translation tool may have changed: entities, escapes, wrapped lines. */
export function decodeText(s) {
  return String(s)
    .split("\n").map((l) => l.trim()).filter(Boolean).join(" ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, "$1");
}
const commentSafe = (s) => String(s).replace(/--/g, "‐‐").replace(/\n/g, " ");

/**
 * Every dictionary of every surface, in `from` (English), as one Markdown file for a translation tool:
 * one paragraph per text, its id and context in the HTML comment above it.
 */
export function exportMarkdown(root, { surfaces = SURFACES, from = FALLBACK, glossary = null } = {}) {
  const out = [];
  out.push("# Pool Controller: interface texts", "");
  out.push("<!--");
  out.push(`  Source language: ${from}. Translate the paragraphs only. Keep as they are: the HTML comments,`);
  out.push("  the words in braces such as {count} or {speed}, and the tags such as <b> and </b>.");
  if (glossary?.terms?.length) {
    out.push("", "  Glossary (en / fr / es):");
    for (const g of glossary.terms) out.push(`  - ${commentSafe(`${g.en} / ${g.fr} / ${g.es}${g.note ? ` (${g.note})` : ""}`)}`);
  }
  out.push("-->", "");
  let count = 0;
  for (const s of surfaces) {
    const L = loadSurface(root, s);
    const src = L.flat[from];
    if (!L.present || !src) continue;
    if (!src.size) continue;
    // Where each key shows: this surface's sources, and those of the surfaces that read its keys.
    const where = new Map();
    for (const o of [s, ...surfaces.filter((x) => x.reads.includes(s.id))])
      for (const f of listSources(root, o.sources))
        for (const k of scanUsage(readFileSync(path.join(root, f), "utf8"), o.usage).keys) where.set(k, [...(where.get(k) || []), f]);
    out.push(`## ${s.title}`, "");
    for (const [key, v] of src) {
      const fr = L.flat.fr?.get(key);
      for (const [f, text] of forms(v)) {
        const ctx = [`${MARK} ${s.id}:${key}${f ? `#${f}` : ""}`];
        if (f) ctx.push(`plural form « ${f} » ({count} is the number)`);
        ctx.push(`where: ${where.has(key) ? where.get(key).join(", ") : "not used yet"}`);
        const frText = fr === undefined ? undefined : typeof fr === "string" ? fr : fr[f] ?? fr.other;
        if (from !== "fr" && frText !== undefined) ctx.push(`fr: ${frText}`);
        out.push(`<!-- ${commentSafe(ctx.join(" | "))} -->`, encodeText(text), "");
        count++;
      }
    }
  }
  return { markdown: out.join("\n"), count };
}

/** A translated file → Map(id → text), id as exported (« card:card.temp.span_days#one »). */
export function parseMarkdown(md) {
  const entries = new Map();
  const re = new RegExp(`<!--\\s*${MARK}\\s*(\\S+?)\\s*(?:\\|[\\s\\S]*?)?-->`, "g");
  const marks = [...md.matchAll(re)];
  marks.forEach((m, i) => {
    let body = md.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : md.length);
    const stop = body.search(/^\s*(#{1,6}\s|<!--)/m);
    if (stop >= 0) body = body.slice(0, stop);
    entries.set(m[1], decodeText(body));
  });
  return entries;
}

/**
 * Writes a translated file's texts into each surface's `to` dictionary, in English's order. A text whose
 * placeholders or markup differ from English's is refused, and the draft kept. Returns
 * { changed: [{id, from, to}], refused: [{id, why}], missing: [id], unknown: [id], written: [file] }.
 */
export function importEntries(root, entries, { to, surfaces = SURFACES, dryRun = false } = {}) {
  const report = { changed: [], refused: [], missing: [], unknown: [], written: [] };
  const seen = new Set();
  for (const s of surfaces) {
    const L = loadSurface(root, s);
    const en = L.dicts[FALLBACK];
    if (!L.present || !en) continue;
    const draft = L.flat[to] || new Map();
    const take = (key, form, ref, old) => {
      const id = `${s.id}:${key}${form ? `#${form}` : ""}`;
      seen.add(id);
      if (!entries.has(id)) { if (old === undefined) report.missing.push(id); return old; }
      const t = entries.get(id);
      const why = !t.trim() ? "empty"
        : !same(placeholders(t), placeholders(ref)) ? `placeholders ${JSON.stringify(placeholders(t))} instead of ${JSON.stringify(placeholders(ref))}`
        : !same(tags(t), tags(ref)) ? `markup ${JSON.stringify(tags(t))} instead of ${JSON.stringify(tags(ref))}` : null;
      if (why) { report.refused.push({ id, why, text: t }); if (old === undefined) report.missing.push(id); return old; }
      if (t !== old) report.changed.push({ id, from: old, to: t });
      return t;
    };
    const build = (node, prefix) => {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "string") {
          const t = take(key, null, v, typeof draft.get(key) === "string" ? draft.get(key) : undefined);
          if (t !== undefined) out[k] = t;
        } else if (isPlural(v)) {
          const old = isPlural(draft.get(key)) ? draft.get(key) : {};
          const p = {};
          for (const [f, ref] of Object.entries(v)) {
            const t = take(key, f, ref, old[f]);
            if (t !== undefined) p[f] = t;
          }
          if (Object.keys(p).length) out[k] = p;
        } else out[k] = build(v, key);
      }
      return out;
    };
    const result = build(en, "");
    const file = path.join(s.dir, `${to}.json`);
    if (!dryRun) writeFileSync(path.join(root, file), `${JSON.stringify(result, null, 2)}\n`);
    report.written.push(file);
  }
  for (const id of entries.keys()) if (!seen.has(id)) report.unknown.push(id);
  return report;
}
