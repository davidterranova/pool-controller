// node --test (make webui-test): tools/i18n/ on made-up folders: make i18n-check's rules, and the Markdown
// round-trip through a translation tool (make i18n-export, make i18n-import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  check, exportMarkdown, parseMarkdown, importEntries, frenchLiterals, scanUsage, encodeText, decodeText, listSources,
} from "../i18n/lib.mjs";

const SURFACE = { id: "ui", title: "UI", dir: "i18n", sources: ["src/*.js"], usage: "code", reads: [], strict: false };

/** A throwaway repo: dictionaries per language, and source files. */
function repo({ en, fr, es, sources = {}, surface = SURFACE }) {
  const root = mkdtempSync(path.join(tmpdir(), "i18n-"));
  mkdirSync(path.join(root, surface.dir), { recursive: true });
  for (const [lang, d] of Object.entries({ en, fr, es })) if (d) writeFileSync(path.join(root, surface.dir, `${lang}.json`), JSON.stringify(d));
  mkdirSync(path.join(root, "src"), { recursive: true });
  for (const [f, text] of Object.entries(sources)) writeFileSync(path.join(root, "src", f), text);
  return root;
}
const run = (root, opts = {}) => check(root, { surfaces: [SURFACE], sameAsEnglish: [], ...opts });

const EN = { g: { hi: "Hi {name}", n: { one: "{count} day", other: "{count} days" }, b: "Now <b>{speed}</b>" } };
const FR = { g: { hi: "Salut {name}", n: { one: "{count} jour", other: "{count} jours" }, b: "Maintenant <b>{speed}</b>" } };
const ES = { g: { hi: "Hola {name}", n: { one: "{count} día", other: "{count} días" }, b: "Ahora <b>{speed}</b>" } };
const USES = { "a.js": 't("g.hi"); this._t(\'g.b\'); c._t(`g.n`, {count});' };

test("check: complete, consistent dictionaries pass", () => {
  const r = run(repo({ en: EN, fr: FR, es: ES, sources: USES }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("check: a key missing, or extra, in a language", () => {
  const r = run(repo({ en: EN, fr: { g: { ...FR.g, extra: "x" } }, es: { g: { hi: ES.g.hi, n: ES.g.n } }, sources: USES }));
  assert.ok(r.errors.some((e) => e.includes("g.b is missing in es")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("g.extra is in fr but not in en")));
});

test("check: placeholders, markup, plural shape and forms must match English", () => {
  const r = run(repo({
    en: EN,
    fr: { g: { hi: "Salut {nom}", n: { other: "{count} jours" }, b: "Maintenant {speed}" } },
    es: { g: { hi: "Hola {name}", n: "{count} días", b: ES.g.b } },
    sources: USES,
  }));
  assert.ok(r.errors.some((e) => e.includes("g.hi (fr): placeholders")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("g.n (fr): the « one » form is missing")));
  assert.ok(r.errors.some((e) => e.includes("g.b (fr): markup")));
  assert.ok(r.errors.some((e) => e.includes("g.n (es): should be a plural")));
});

test("check: a form a language doesn't have, an empty text, a TODO, a copy of English", () => {
  const r = run(repo({
    en: EN,
    fr: { g: { ...FR.g, n: { one: "{count} jour", two: "{count} x", other: "{count} jours" } } },
    es: { g: { hi: "Hi {name}", n: { one: "", other: "{count} días" }, b: "TODO <b>{speed}</b>" } },
    sources: USES,
  }));
  assert.ok(r.errors.some((e) => e.includes("« two » is not a plural form of fr")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("g.n (es)#one: empty")));
  assert.ok(r.errors.some((e) => e.includes("g.b (es): empty or TODO")));
  assert.ok(r.errors.some((e) => e.includes("g.hi (es): same text as en")));
});

test("check: a copy of English is fine when listed, or when it has no words", () => {
  const en = { a: "Auto", n: "{count}" }, fr = { a: "Auto", n: "{count}" }, es = { a: "Auto", n: "{count}" };
  const r = run(repo({ en, fr, es, sources: { "a.js": 't("a"); t("n")' } }), { sameAsEnglish: ["ui:a"] });
  assert.deepEqual(r.errors, []);
});

test("check: a key used but missing fails; unused keys and French literals warn, then fail when strict", () => {
  const sources = { "a.js": 't("g.hi"); t("g.nope"); const s = "Vérifiez le robinet";' };
  const root = repo({ en: EN, fr: FR, es: ES, sources });
  const r = run(root);
  assert.ok(r.errors.some((e) => e.includes("uses g.nope")), r.errors.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("2 key(s) no source uses yet")), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("1 French-looking literal")));
  const strict = run(root, { surfaces: [{ ...SURFACE, strict: true }] });
  assert.ok(strict.errors.some((e) => e.includes("no source uses yet")));
  assert.ok(strict.errors.some((e) => e.includes("a.js:1: French text outside the dictionaries: Vérifiez le robinet")));
});

test("check: a key used through a prefix counts as used; a surface can use the keys of one it reads", () => {
  const root = repo({ en: { s: { Low: "Low" } }, fr: { s: { Low: "Basse" } }, es: { s: { Low: "Baja" } }, sources: {} });
  mkdirSync(path.join(root, "page", "i18n"), { recursive: true });
  for (const l of ["en", "fr", "es"]) writeFileSync(path.join(root, "page", "i18n", `${l}.json`), "{}");
  mkdirSync(path.join(root, "page", "src"), { recursive: true });
  writeFileSync(path.join(root, "page", "src", "p.js"), "t(`s.${v}`); t('s.Low');");
  const page = { id: "page", title: "Page", dir: "page/i18n", sources: ["page/src/*.js"], usage: "code", reads: ["ui"], strict: true };
  const r = check(root, { surfaces: [{ ...SURFACE, strict: true }, page], sameAsEnglish: [] });
  assert.deepEqual(r.errors, []);
});

test("check: a missing folder is skipped; a missing language file or bad JSON fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "i18n-"));
  assert.deepEqual(run(root).errors, []);
  mkdirSync(path.join(root, "i18n"));
  writeFileSync(path.join(root, "i18n", "en.json"), "{}");
  writeFileSync(path.join(root, "i18n", "fr.json"), "{ nope");
  const r = run(root);
  assert.ok(r.errors.some((e) => e.includes("es.json is missing")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("fr.json:")));
});

test("scanUsage finds t() keys, prefixes and {{t:key}} templates", () => {
  const u = scanUsage('t("a.b"); this._t(\'c\', {x}); x.t(`d.${k}`); at("no"); _t(`e`)', "code");
  assert.deepEqual([...u.keys].sort(), ["a.b", "c", "e"]);
  assert.deepEqual([...u.prefixes], ["d."]);
  assert.deepEqual([...scanUsage("name: {{t:dash.title}}\nx: {{ t:y }}", "template").keys], ["dash.title", "y"]);
});

test("frenchLiterals: quoted or HTML text with French letters, not comments", () => {
  const found = frenchLiterals([
    "/* « Réglages » in a comment */",
    "const a = \"Arrêt\"; // « commentaire »",
    "const url = 'http://x'; const b = `Pompe arrêtée`;",
    "<p>Vérifier</p> <!-- « non » -->",
    "const c = \"Pump stopped\";",
  ].join("\n"));
  assert.deepEqual(found.map((f) => [f.line, f.text]), [[2, "Arrêt"], [3, "Pompe arrêtée"], [4, "Vérifier"]]);
});

test("listSources leaves symlinks out", () => {
  const root = repo({ en: {}, fr: {}, es: {}, sources: { "a.js": "", "b.css": "" } });
  symlinkSync(path.join(root, "src", "a.js"), path.join(root, "src", "link.js"));
  assert.deepEqual(listSources(root, ["src/*.js"]), [path.join("src", "a.js")]);
});

test("encodeText / decodeText survive Markdown and what a translation tool does to it", () => {
  for (const s of ["Now <b>{speed}</b>", "*bold* _x_ [y] `z`", "# not a heading", "- not a list", "1. not a list",
    "line one\nline two", "a \\ backslash", "« Appliquer » · 9 538 L"]) {
    assert.equal(decodeText(encodeText(s)), s);
  }
  assert.equal(decodeText("Ahora &lt;b&gt;{speed}&lt;/b&gt; &amp; m&#225;s"), "Ahora <b>{speed}</b> & más");
  assert.equal(decodeText("a wrapped\n   line"), "a wrapped line");
  assert.equal(decodeText("\\{count\\} días"), "{count} días");
});

test("round-trip: export then import of the same file changes nothing", () => {
  const root = repo({ en: EN, fr: FR, es: ES, sources: USES });
  const { markdown, count } = exportMarkdown(root, { surfaces: [SURFACE], from: "es" });
  assert.equal(count, 4);
  const before = readFileSync(path.join(root, "i18n", "es.json"), "utf8");
  const r = importEntries(root, parseMarkdown(markdown), { to: "es", surfaces: [SURFACE] });
  assert.deepEqual([r.changed, r.refused, r.missing, r.unknown], [[], [], [], []]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "i18n", "es.json"), "utf8")), JSON.parse(before));
});

test("export: English, each text's id, plural form, where it is used and the French, in comments", () => {
  const root = repo({ en: EN, fr: FR, es: ES, sources: USES });
  const { markdown } = exportMarkdown(root, { surfaces: [SURFACE], glossary: { terms: [{ en: "Low", fr: "Basse", es: "Baja" }] } });
  assert.match(markdown, /<!-- i18n: ui:g\.hi \| where: src\/a\.js \| fr: Salut \{name\} -->\nHi \{name\}\n/);
  assert.match(markdown, /<!-- i18n: ui:g\.n#one \| plural form « one »[^>]*-->\n\{count\} day\n/);
  assert.match(markdown, /Low \/ Basse \/ Baja/);
  assert.match(markdown, /^## UI$/m);
});

test("import: a translation as a tool returns it, into a new language file, in English's order", () => {
  const root = repo({ en: EN, fr: FR, sources: USES });
  const { markdown } = exportMarkdown(root, { surfaces: [SURFACE] });
  // What a tool hands back: headings and the glossary translated, paragraphs translated, comments kept.
  const translated = markdown
    .replace("# Pool Controller: interface texts", "# Pool Controller: textos de la interfaz")
    .replace("## UI", "## IU")
    .replace("\nHi {name}\n", "\nHola {name}\n")
    .replace("\n{count} day\n", "\n{count} día\n")
    .replace("\n{count} days\n", "\n{count}\n   días\n")
    .replace("\nNow <b>{speed}</b>\n", "\nAhora &lt;b&gt;{speed}&lt;/b&gt;\n");
  const r = importEntries(root, parseMarkdown(translated), { to: "es", surfaces: [SURFACE] });
  assert.deepEqual([r.refused, r.missing, r.unknown], [[], [], []]);
  assert.equal(r.changed.length, 4);
  const es = readFileSync(path.join(root, "i18n", "es.json"), "utf8");
  assert.deepEqual(JSON.parse(es), { g: { hi: "Hola {name}", n: { one: "{count} día", other: "{count} días" }, b: "Ahora <b>{speed}</b>" } });
  assert.deepEqual(Object.keys(JSON.parse(es).g), ["hi", "n", "b"]);
});

test("import: a changed placeholder or tag is refused and the draft kept; missing and unknown ids are listed", () => {
  const root = repo({ en: EN, fr: FR, es: ES, sources: USES });
  const entries = new Map([
    ["ui:g.hi", "Hola {nombre}"],
    ["ui:g.b", "Ahora {speed}"],
    ["ui:g.n#one", "{count} jornada"],
    ["ui:g.gone", "x"],
  ]);
  const r = importEntries(root, entries, { to: "es", surfaces: [SURFACE] });
  assert.deepEqual(r.refused.map((x) => x.id), ["ui:g.hi", "ui:g.b"]);
  assert.deepEqual(r.changed.map((x) => x.id), ["ui:g.n#one"]);
  assert.deepEqual(r.missing, [], "the draft covers what the file lacks");
  assert.deepEqual(r.unknown, ["ui:g.gone"]);
  const es = JSON.parse(readFileSync(path.join(root, "i18n", "es.json"), "utf8"));
  assert.equal(es.g.hi, "Hola {name}");
  assert.equal(es.g.n.one, "{count} jornada");
  rmSync(path.join(root, "i18n", "es.json"));
  const fresh = importEntries(root, new Map([["ui:g.hi", "Hola {name}"]]), { to: "es", surfaces: [SURFACE], dryRun: true });
  assert.deepEqual(fresh.missing, ["ui:g.n#one", "ui:g.n#other", "ui:g.b"]);
});
