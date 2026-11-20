// node --test webui/test/ (make webui-test): the page's language (page-i18n.js): what it picks, its texts in each
// language, and that the page fetches nothing to translate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// The module reads navigator and localStorage when it loads: a browser asking for Spanish, nothing stored.
Object.defineProperty(globalThis, "navigator", { value: { languages: ["es-ES", "en"] }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const page = await import("../page-i18n.js");

test("the browser's language, else English; the switch changes it, an unknown language changes nothing", () => {
  assert.equal(page.pageLang(), "es");
  page.setLang("xx");
  assert.equal(page.pageLang(), "es");
});

test("a rendered message in each language: the page's own keys, the card's, plurals and lists", () => {
  globalThis.document = { documentElement: {} };
  const seen = [];
  page.onLang((l) => seen.push(l));
  const expect = {
    en: ["Connected to the controller", "2 probes found", "the position and the time", "Control"],
    fr: ["Connecté au contrôleur", "2 sondes trouvées", "la position et l'heure", "Contrôle"],
    es: ["Conectado al controlador", "2 sondas encontradas", "la posición y la hora", "Control"],
  };
  for (const lang of ["en", "fr", "es"]) {
    page.setLang(lang);
    assert.equal(document.documentElement.lang, lang);
    const t = page.t;
    assert.deepEqual([t("page.conn.ok"), t("setup.probes.found", { count: 2 }),
      page.andList([t("setup.waiting.position"), t("setup.waiting.clock")]), t("card.tab.pump")], expect[lang], lang);
    assert.match(page.langSwitch(), new RegExp(`data-lang="${lang}"[^>]*aria-pressed="true"`));
  }
  assert.deepEqual(seen, ["en", "fr", "es"]);
});

test("offline: the page's sources fetch nothing to translate, and its bundle carries the texts", () => {
  for (const f of ["page-i18n.js", "app.js", "setup.js", "login.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\(\s*["'`][^"'`]*i18n|import\(\s*["'`][^"'`]*\.json/, f);
  }
  const bundle = new URL("../dist/device.js", import.meta.url);
  if (existsSync(bundle)) {
    const js = readFileSync(bundle, "utf8"); // esbuild escapes non-ASCII: phrases without accents
    assert.ok(js.includes("Conectado al controlador") && js.includes("Connected to the controller") && js.includes("Piscine"), "the three languages are in the bundle");
    assert.doesNotMatch(js, /https?:\/\/[^"'`\s]*\/i18n/, "no dictionary fetched from a server");
  }
});
