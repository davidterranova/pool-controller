// node --test (make webui-test): tools/i18n/ha-files.mjs (make ha-files) on made-up folders: the texts put in as
// YAML double-quoted scalars, {{lang}} and {{file}}, the header, the French blueprint's kept path, and --check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, main, outputPath, render, jinja, HEADER } from "../i18n/ha-files.mjs";

const SURFACE = { id: "yaml", title: "HA", dir: "home-assistant/i18n-yaml", sources: [], usage: "template", reads: [], strict: false };
const DICTS = {
  en: { card: { name: "Pool", tricky: "Say \"hi\": a # b\nnext line \\ end", msg: "At {{ since }}" } },
  fr: { card: { name: "Piscine", tricky: "Dis « salut » : a # b\nligne \\ fin", msg: "À {{ since }}" } },
  es: { card: { name: "Piscina", tricky: "Di \"hola\": a # b\nlínea \\ fin", msg: "A las {{ since }}" } },
};
const TEMPLATE = [
  "# A comment, {{ jinja }} stays",
  "title: {{t:card.name}}",
  "list:",
  "  - {{t:card.tricky}}   # a comment after",
  "flow: [{{t:card.name}}, {{t:card.msg}}]",
  "url: https://example.org/{{file}}?lang={{lang}}",
  "jinja: \"{{ states('sensor.x') }}\"",
  "",
].join("\n");

/** A throwaway repo: dictionaries, and templates at the given paths. */
function repo({ dicts = DICTS, templates = { "home-assistant/dashboard/x.tmpl.yaml": TEMPLATE } } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-files-"));
  mkdirSync(path.join(root, SURFACE.dir), { recursive: true });
  for (const [lang, d] of Object.entries(dicts)) writeFileSync(path.join(root, SURFACE.dir, `${lang}.json`), JSON.stringify(d));
  for (const [f, text] of Object.entries(templates)) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}
const opts = { surface: SURFACE, langs: ["en", "fr", "es"], kept: {} };

/** The scalar after `key: ` on a line, read back as YAML reads a double-quoted scalar (JSON is a subset). */
const scalar = (text, prefix) =>
  JSON.parse(/^"(?:\\.|[^"\\])*"/.exec(text.split("\n").find((l) => l.startsWith(prefix)).slice(prefix.length))[0]);

test("build: one file per language, each text a double-quoted scalar that reads back as the text", () => {
  const { files, errors } = build(repo(), opts);
  assert.deepEqual(errors, []);
  assert.deepEqual(files.map((f) => f.path), ["en", "fr", "es"].map((l) => `home-assistant/dashboard/x.${l}.yaml`));
  for (const f of files) {
    const d = DICTS[f.lang].card;
    assert.equal(scalar(f.text, "title: "), d.name);
    assert.equal(scalar(f.text, "  - "), d.tricky, "a quote, a colon, a # and a line break stay inside the scalar");
    assert.match(f.text, /^ {2}- "[^\n]*" {3}# a comment after$/m, "the scalar is on one line, the comment after it");
    assert.equal(JSON.parse(f.text.split("\n").find((l) => l.startsWith("flow: ")).slice(6)).join("|"), `${d.name}|${d.msg}`);
  }
});

test("build: {{lang}} and {{file}}, and Home Assistant's own Jinja left alone", () => {
  const fr = build(repo(), opts).files.find((f) => f.lang === "fr").text;
  assert.match(fr, /^url: https:\/\/example\.org\/x\.fr\.yaml\?lang=fr$/m);
  assert.match(fr, /^# A comment, \{\{ jinja \}\} stays$/m);
  assert.match(fr, /^jinja: "\{\{ states\('sensor\.x'\) \}\}"$/m);
});

test("build: a header line names the template and the language", () => {
  const { files } = build(repo(), opts);
  for (const f of files) {
    const first = f.text.split("\n")[0];
    assert.ok(first.startsWith(`${HEADER} x.tmpl.yaml (${f.lang})`), first);
    assert.match(first, /make ha-files/);
  }
});

test("outputPath: <name>.<lang>.yaml, or the path a file keeps", () => {
  const kept = { "a/b/bp.tmpl.yaml": { fr: "bp.yaml" } };
  assert.equal(outputPath("a/b/bp.tmpl.yaml", "fr", kept), "a/b/bp.yaml");
  assert.equal(outputPath("a/b/bp.tmpl.yaml", "en", kept), "a/b/bp.en.yaml");
  assert.equal(outputPath("a/d.tmpl.yaml", "es", kept), "a/d.es.yaml");
  const root = repo({ templates: { "home-assistant/blueprints/bp.tmpl.yaml": "u: x/{{file}}\n" } });
  const { files } = build(root, { ...opts, kept: { "home-assistant/blueprints/bp.tmpl.yaml": { fr: "bp.yaml" } } });
  assert.match(files.find((f) => f.lang === "fr").text, /^u: x\/bp\.yaml$/m, "{{file}} is the kept name");
});

test("build: a key a dictionary lacks, a plural, a token inside other text", () => {
  const dicts = structuredClone(DICTS);
  delete dicts.es.card.name;
  dicts.en.card.n = { one: "{count} day", other: "{count} days" };
  const r = build(repo({ dicts, templates: { "home-assistant/x.tmpl.yaml": "a: {{t:card.name}}\nb: {{t:nope}}\nc: Hello {{t:card.msg}}\nd: {{t:card.n}}\n" } }), opts);
  assert.ok(r.errors.some((e) => e.includes("x.tmpl.yaml:1: card.name isn't in home-assistant/i18n-yaml/es.json")), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => e.includes("x.tmpl.yaml:2: nope isn't in home-assistant/i18n-yaml/en.json")));
  assert.ok(r.errors.some((e) => e.includes("x.tmpl.yaml:3: {{t:card.msg}} must be a whole YAML value")));
  assert.ok(r.errors.some((e) => e.includes("x.tmpl.yaml:4: card.n is a plural")));
  assert.equal(r.files.filter((f) => f.lang === "es").length, 0, "nothing for a language that misses a key");
});

test("build: a translation that changes Home Assistant's Jinja", () => {
  const dicts = structuredClone(DICTS);
  dicts.fr.card.msg = "À {{ depuis }}";
  const r = build(repo({ dicts }), opts);
  assert.ok(r.errors.some((e) => e.includes("fr.json: card.msg changes Home Assistant's template code")), r.errors.join("\n"));
  assert.deepEqual(jinja("a {{ x }} b {% if y %}c{% endif %}"), ["{% endif %}", "{% if y %}", "{{ x }}"]);
});

test("render: a text is never inside a quoted string of the template", () => {
  const r = render('a: "{{t:k}}"\n', { template: "t.tmpl.yaml", lang: "en", file: "t.en.yaml", texts: new Map([["k", "v"]]), dictDir: "d" });
  assert.equal(r.text, null);
  assert.match(r.errors[0], /must be a whole YAML value/);
});

/** main(), as make ha-files runs it in `root` (the made-up dictionaries sit where the repo's surface reads them). */
const run = (root, args) => {
  const lines = [];
  const code = main(root, args, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
};

test("main: writes the files, then --check passes; a drift or an edit fails --check", () => {
  const root = repo();
  assert.equal(run(root, ["--check"]).code, 1, "nothing written yet");
  assert.equal(run(root, []).code, 0);
  const fr = path.join(root, "home-assistant/dashboard/x.fr.yaml");
  assert.ok(existsSync(fr));
  assert.equal(run(root, ["--check"]).code, 0);

  writeFileSync(fr, readFileSync(fr, "utf8").replace("Piscine", "Bassin"));
  const edited = run(root, ["--check"]);
  assert.equal(edited.code, 1);
  assert.match(edited.out, /x\.fr\.yaml is out of date/);
  run(root, []);

  const dict = path.join(root, SURFACE.dir, "es.json");
  writeFileSync(dict, JSON.stringify({ card: { ...DICTS.es.card, name: "Alberca" } }));
  const drift = run(root, ["--check"]);
  assert.equal(drift.code, 1);
  assert.match(drift.out, /x\.es\.yaml is out of date/);
  assert.doesNotMatch(drift.out, /x\.fr\.yaml/);
});

test("main: a key the dictionaries lack fails, and writes nothing", () => {
  const root = repo({ templates: { "home-assistant/dashboard/x.tmpl.yaml": "a: {{t:card.missing}}\n" } });
  const r = run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /card\.missing isn't in/);
  assert.ok(!existsSync(path.join(root, "home-assistant/dashboard/x.en.yaml")));
  assert.equal(run(root, ["--check"]).code, 1);
});

test("main: a generated file no template gives any more fails", () => {
  const root = repo();
  run(root, []);
  writeFileSync(path.join(root, "home-assistant/dashboard/old.en.yaml"), `${HEADER} old.tmpl.yaml (en): …\na: 1\n`);
  const r = run(root, ["--check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /old\.en\.yaml is a generated file that no template gives any more/);
});
