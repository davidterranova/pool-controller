// node --test (make webui-test): home-assistant/i18n.js, the card's and the page's texts and formats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, resolveLang, makeT, mergeDicts, localeFromHass, makeFmt, lookup, isPlural } from "../../home-assistant/i18n.js";
import { readFileSync } from "node:fs";

const DICTS = {
  en: { a: { hello: "Hello {name}", days: { one: "{count} day", other: "{count} days" } }, only_en: "English only" },
  fr: { a: { hello: "Bonjour {name}", days: { one: "{count} jour", other: "{count} jours" } } },
  es: { a: { hello: "Hola {name}", days: { one: "{count} día", other: "{count} días" } } },
};

test("the languages are English, French and Spanish", () => {
  assert.deepEqual(LANGS, ["en", "fr", "es"]);
});

test("resolveLang takes the first supported language, whatever the tag's form, else English", () => {
  assert.equal(resolveLang(["de-DE", "fr-CA", "es"]), "fr");
  assert.equal(resolveLang(["ES_419"]), "es");
  assert.equal(resolveLang([null, undefined, "", "en-GB"]), "en");
  assert.equal(resolveLang(["de", "it"]), "en");
  assert.equal(resolveLang([]), "en");
  assert.equal(resolveLang(undefined), "en");
});

test("t fills placeholders and leaves an unknown one as it is", () => {
  const t = makeT(DICTS, "fr");
  assert.equal(t("a.hello", { name: "Ana" }), "Bonjour Ana");
  assert.equal(t("a.hello"), "Bonjour {name}");
  assert.equal(t("a.hello", { name: 0 }), "Bonjour 0");
});

test("t falls back to English, then to the key itself", () => {
  const t = makeT(DICTS, "es");
  assert.equal(t("only_en"), "English only");
  assert.equal(t("no.such.key"), "no.such.key");
  assert.equal(t("a"), "a", "a group is not a text");
  assert.equal(makeT(DICTS, "de")("a.hello", { name: "x" }), "Hello x", "an unknown language reads as English");
});

test("plurals follow each language's rules", () => {
  assert.equal(makeT(DICTS, "en")("a.days", { count: 1 }), "1 day");
  assert.equal(makeT(DICTS, "en")("a.days", { count: 0 }), "0 days");
  assert.equal(makeT(DICTS, "fr")("a.days", { count: 0 }), "0 jour", "French: 0 is singular");
  assert.equal(makeT(DICTS, "fr")("a.days", { count: 1.5 }), "1.5 jour", "French: under 2 is singular");
  assert.equal(makeT(DICTS, "fr")("a.days", { count: 2 }), "2 jours");
  assert.equal(makeT(DICTS, "es")("a.days", { count: 1 }), "1 día");
  assert.equal(makeT(DICTS, "es")("a.days", { count: 1000000 }), "1000000 días", "a missing form (« many ») falls back to other");
  assert.equal(makeT(DICTS, "fr")("a.days"), "{count} jours", "no count: other");
});

test("lookup and isPlural tell texts, plurals and groups apart", () => {
  assert.equal(lookup(DICTS.en, "a.hello"), "Hello {name}");
  assert.ok(isPlural(lookup(DICTS.en, "a.days")));
  assert.ok(!isPlural(lookup(DICTS.en, "a")));
  assert.equal(lookup(DICTS.en, "a.days.one"), undefined, "a plural's form isn't a key");
  assert.ok(!isPlural({ one: "x" }), "a plural needs other");
  assert.ok(!isPlural({ other: "x", label: "y" }), "only CLDR categories");
});

test("mergeDicts merges per language, deeply, the later winning", () => {
  const m = mergeDicts({ en: { a: { x: "1" } }, fr: { a: { x: "un" } } }, { en: { a: { y: "2" }, b: "3" } });
  assert.deepEqual(m, { en: { a: { x: "1", y: "2" }, b: "3" }, fr: { a: { x: "un" } } });
});

test("localeFromHass: the HA language with its own tag, the card's language: first, HA's formats", () => {
  assert.deepEqual(localeFromHass({ locale: { language: "en-GB", number_format: "language", time_format: "language" } }),
    { lang: "en", locale: "en-GB", numberLocale: "en-GB", hour12: undefined });
  assert.deepEqual(localeFromHass({ language: "fr" }), { lang: "fr", locale: "fr", numberLocale: "fr", hour12: undefined });
  assert.deepEqual(localeFromHass({ locale: { language: "fr", number_format: "comma_decimal", time_format: "12" } }, "es"),
    { lang: "es", locale: "es", numberLocale: "en-US", hour12: true });
  assert.equal(localeFromHass({ locale: { language: "de" } }).lang, "en");
  assert.equal(localeFromHass({ locale: { language: "es", time_format: "24" } }).hour12, false);
  assert.equal(localeFromHass(undefined).lang, "en");
});

test("makeFmt writes numbers, litres and times in the locale", () => {
  const fr = makeFmt("fr-FR"), en = makeFmt("en-US"), gb = makeFmt("en-GB");
  assert.equal(fr.litres(9538.4), "9 538 L");
  assert.equal(en.litres(9538.4), "9,538 L");
  assert.equal(fr.number(1.5), "1,5");
  const at = new Date(2026, 6, 14, 14, 5);
  assert.equal(fr.time(at), "14:05");
  assert.equal(gb.time(at), "14:05");
  assert.match(en.time(at), /^02:05\s?PM$/);
  assert.equal(makeFmt("en-US", { hour12: false }).time(at), "14:05");
  assert.equal(makeFmt("fr-FR", { numberLocale: "en-US" }).number(1.5), "1.5");
});

test("the card's dictionaries are valid JSON with every language", () => {
  for (const lang of LANGS) {
    const d = JSON.parse(readFileSync(new URL(`../../home-assistant/i18n/${lang}.json`, import.meta.url), "utf8"));
    assert.equal(typeof d, "object");
  }
});
