// node --test (make webui-test): tools/i18n/panel-header.mjs, which writes panel_i18n.h (make panel-i18n), on
// made-up folders: what it takes from the dictionaries, what it refuses, and its fonts' coverage; and that
// make i18n-check sees the panel's C++ calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, readFonts, cString, entries } from "../i18n/panel-header.mjs";
import { check, scanUsage } from "../i18n/lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PANEL = { id: "panel", title: "Panel", dir: "i18n-panel", sources: ["local-panel.yaml", "panel_ui.h"], usage: "code", reads: ["card"], strict: true };
const CARD = { id: "card", title: "Card", dir: "card", sources: [], usage: "code", reads: [], strict: false };
const FONTS = `font:
  - file: "gfonts://Montserrat"
    id: f_s
    size: 16
    glyphsets: [GF_Latin_Core]
    glyphs: "³"
  - file:
      type: gfonts
      family: Montserrat
      weight: 600
    id: f_l
    glyphsets: [GF_Latin_Core]   # a comment
    glyphs: "³"

lvgl:
  glyphs: "not a font"
`;

/** A throwaway repo: the panel's and the card's dictionaries, the panel's sources, the glyph sets. */
function repo({ panel, card, yaml = FONTS, header = "", glyphs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ éèàâêí·{}°'.," }) {
  const root = mkdtempSync(path.join(tmpdir(), "panel-"));
  for (const [dir, dicts] of [["i18n-panel", panel], ["card", card]]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    for (const [lang, d] of Object.entries(dicts)) writeFileSync(path.join(root, dir, `${lang}.json`), JSON.stringify(d));
  }
  writeFileSync(path.join(root, "local-panel.yaml"), yaml);
  writeFileSync(path.join(root, "panel_ui.h"), header);
  mkdirSync(path.join(root, "tools/i18n"), { recursive: true });
  writeFileSync(path.join(root, "tools/i18n/panel-glyphsets.json"), JSON.stringify({ GF_Latin_Core: glyphs }));
  return root;
}
const OPTS = { surfaces: [PANEL, CARD] };
const PANEL_EN = { panel: { change: "Change", left: "{left} left" } };
const PANEL_FR = { panel: { change: "Changer", left: "encore {left}" } };
const PANEL_ES = { panel: { change: "Cambiar", left: "quedan {left}" } };
const CARD_D = (o, l, h, x) => ({ common: { speed: { Off: o, Low: l }, hint: h }, card: { other: x } });
const CARDS = { en: CARD_D("Off", "Low", "Hint", "x"), fr: CARD_D("Arrêt", "Basse", "Astuce", "y"), es: CARD_D("Apagada", "Baja", "Pista", "z") };

test("panel-header: the panel's keys, plus the card's it uses by key or by tr_prefix, sorted by byte", () => {
  const root = repo({
    panel: { en: PANEL_EN, fr: PANEL_FR, es: PANEL_ES }, card: CARDS,
    header: 'T("panel.change"); tr_prefix("common.speed.", code); T("common.hint", lang);',
  });
  const { list, problems } = entries(root, OPTS);
  assert.deepEqual(problems, []);
  assert.deepEqual(list.map((e) => e.key), ["common.hint", "common.speed.Low", "common.speed.Off", "panel.change", "panel.left"]);
  assert.deepEqual(list.find((e) => e.key === "common.speed.Off").texts, ["Off", "Arrêt", "Apagada"]);
  const { text, problems: p } = build(root, OPTS);
  assert.deepEqual(p, []);
  assert.match(text, /inline constexpr int KEY_COUNT = 5;/);
  assert.match(text, /\{"Off", "Arrêt", "Apagada"\},  \/\/ common.speed.Off/);
  assert.ok(!text.includes("card.other"), "a card key the panel doesn't use stays off the board");
});

test("panel-header: a plural, a missing language and a key in two surfaces are refused", () => {
  const root = repo({
    panel: {
      en: { ...PANEL_EN, panel: { ...PANEL_EN.panel, n: { one: "{count} day", other: "{count} days" } }, common: { hint: "Again" } },
      fr: { panel: { change: "Changer", n: { one: "{count} jour", other: "{count} jours" } }, common: { hint: "Encore" } },
      es: { ...PANEL_ES, panel: { ...PANEL_ES.panel, n: { one: "{count} día", other: "{count} días" } }, common: { hint: "Otra" } },
    },
    card: CARDS, header: 'T("common.hint")',
  });
  const { problems } = build(root, OPTS);
  assert.ok(problems.some((p) => p.startsWith("panel.n: a plural")), problems.join("\n"));
  assert.ok(problems.some((p) => p === "panel.left: missing in fr"), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("common.hint is in i18n-panel and in card")), problems.join("\n"));
});

test("panel-header: a character no font covers fails, naming it, its text and the font", () => {
  const root = repo({ panel: { en: PANEL_EN, fr: { panel: { ...PANEL_FR.panel, change: "Changer ŷ" } }, es: PANEL_ES }, card: CARDS });
  const { problems } = build(root, OPTS);
  assert.deepEqual(problems.filter((p) => p.includes("ŷ")).length, 2, problems.join("\n")); // both fonts
  assert.match(problems[0], /^panel.change \(fr\): « ŷ » \(U\+0177\) not in font f_s$/);
  // a font's own glyphs cover it; placeholders' names are never drawn
  const ok = repo({
    panel: { en: PANEL_EN, fr: { panel: { ...PANEL_FR.panel, change: "Changer ŷ" } }, es: PANEL_ES }, card: CARDS,
    yaml: FONTS.replace(/"³"/g, '"³ŷ"'),
  });
  assert.deepEqual(build(ok, OPTS).problems, []);
  // an unknown glyph set, and no font at all
  assert.ok(build(repo({ panel: { en: PANEL_EN, fr: PANEL_FR, es: PANEL_ES }, card: CARDS, yaml: FONTS.replace("[GF_Latin_Core]", "[GF_Greek]") }), OPTS)
    .problems.some((p) => p.includes("glyph set GF_Greek")));
  assert.ok(build(repo({ panel: { en: PANEL_EN, fr: PANEL_FR, es: PANEL_ES }, card: CARDS, yaml: "lvgl:\n" }), OPTS)
    .problems.includes("local-panel.yaml has no font"));
});

test("readFonts reads local-panel.yaml's font: block only", () => {
  assert.deepEqual(readFonts(FONTS), [
    { id: "f_s", glyphsets: ["GF_Latin_Core"], glyphs: "³" },
    { id: "f_l", glyphsets: ["GF_Latin_Core"], glyphs: "³" },
  ]);
});

test("cString: quotes, backslashes, line breaks escaped; UTF-8 kept", () => {
  assert.equal(cString('a "b" \\ c\nd é'), '"a \\"b\\" \\\\ c\\nd é"');
  assert.equal(cString("a\u0001b"), '"a\\x01""b"');
});

test("make i18n-check sees the panel's C++: T(\"key\"), T(\"key\", lang), tr_prefix(\"prefix.\", code)", () => {
  const u = scanUsage('lv_label_set_text(x, panel_ui::T("panel.a"));\nT("panel.b", lang); tr_prefix("common.speed.", c);\nstd::string(T(k));', "code");
  assert.deepEqual([...u.keys].sort(), ["panel.a", "panel.b"]);
  assert.deepEqual([...u.prefixes], ["common.speed."]);
  const root = repo({
    panel: { en: PANEL_EN, fr: PANEL_FR, es: PANEL_ES }, card: CARDS,
    yaml: `${FONTS}\nscript:\n  - lambda: 'T("panel.change"); T("panel.gone");'\n`, header: 'T("panel.left"); tr_prefix("common.speed.", c);',
  });
  const r = check(root, { surfaces: [PANEL, CARD], sameAsEnglish: [] });
  assert.deepEqual(r.errors, ["panel: local-panel.yaml uses panel.gone, which isn't in i18n-panel/en.json"]);
});

test("panel_i18n.h is what the repo's dictionaries give (make panel-i18n)", () => {
  const { text, problems } = build(ROOT);
  assert.deepEqual(problems, []);
  assert.equal(readFileSync(path.join(ROOT, "panel_i18n.h"), "utf8"), text, "panel_i18n.h is stale: run make panel-i18n");
});
