/*
 * i18n — the interface's languages, for piscine-card, the controller's page and the install page
 * (docs/install/i18n.js is a symlink to this file) (docs/plans/i18n.md).
 *
 * Pure: no DOM, no fetch. The dictionaries are JSON files bundled into what runs (the card's
 * home-assistant/i18n/, the page's webui/i18n/), so nothing needs a network to be translated.
 *
 * Keys are nested by area (`card.override.stuck`) and looked up in the language, then in English, then
 * shown as the key itself, so a missing text is visible rather than blank (`make i18n-check` keeps every
 * key in every language).
 *
 *   {name}     placeholder, replaced by vars.name; an unknown one is left as it is.
 *   plurals    an object of CLDR categories with at least `other`: { "one": "{count} day", "other": "{count} days" },
 *              picked with vars.count through Intl.PluralRules; a category the text lacks falls back to `other`.
 *
 * Formatting follows the full locale (fr-FR, en-GB, es-ES or the browser's own tag) through Intl, never a
 * hard-coded one; in Home Assistant, also the user's number and time format (localeFromHass).
 */

export const LANGS = ["en", "fr", "es"];
export const FALLBACK = "en";
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/** The two-letter language of a tag (« fr-FR », « es_419 », « EN » → fr, es, en), or "". */
export const langOf = (tag) => String(tag ?? "").trim().toLowerCase().split(/[-_]/)[0];

/** The first of `candidates` (language tags, in order of preference) that is supported, else English. */
export function resolveLang(candidates) {
  for (const c of candidates || []) {
    const l = langOf(c);
    if (LANGS.includes(l)) return l;
  }
  return FALLBACK;
}

/** Whether a dictionary value is a plural (an object of CLDR categories, `other` among them). */
export const isPlural = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof v.other === "string"
  && Object.keys(v).every((k) => PLURAL_CATEGORIES.includes(k));

/** The value at a dotted key (« card.override.stuck »), or undefined. */
export function lookup(dict, key) {
  let v = dict;
  for (const part of String(key).split(".")) {
    if (!v || typeof v !== "object" || isPlural(v)) return undefined;
    v = v[part];
  }
  return v;
}

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? String(vars[name]) : m));

/**
 * t(key, vars) for `lang`, from `dicts` ({ en: {...}, fr: {...}, es: {...} }; several dictionaries of a
 * language can be merged by the caller beforehand).
 */
export function makeT(dicts, lang) {
  const primary = (dicts && dicts[lang]) || {};
  const fallback = (dicts && dicts[FALLBACK]) || {};
  const rules = {};
  const plural = (l, n) => (rules[l] ||= new Intl.PluralRules(l)).select(n);
  const t = (key, vars = {}) => {
    let v = lookup(primary, key), l = lang;
    if (v === undefined) { v = lookup(fallback, key); l = FALLBACK; }
    if (isPlural(v)) {
      const n = Number(vars.count);
      v = Number.isFinite(n) ? (v[plural(l, n)] ?? v.other) : v.other;
    }
    return typeof v === "string" ? fill(v, vars) : key;
  };
  t.lang = lang;
  return t;
}

/** Merges dictionaries per language: merge({en, fr}, {en, fr}) → {en: {...a.en, ...b.en}, ...} (deep). */
export function mergeDicts(...sets) {
  const deep = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = v && typeof v === "object" && !isPlural(v) && out[k] && typeof out[k] === "object" && !isPlural(out[k])
        ? deep(out[k], v) : v;
    }
    return out;
  };
  const out = {};
  for (const set of sets) for (const [lang, dict] of Object.entries(set || {})) out[lang] = deep(out[lang] || {}, dict);
  return out;
}

/** HA's number_format → the locale numbers are written in (« language » and « system » follow the language). */
const NUMBER_LOCALES = { comma_decimal: "en-US", decimal_comma: "de-DE", space_comma: "fr-FR" };

/**
 * What the card writes in, from Home Assistant's `hass` and the card's optional `language:`:
 * { lang (en|fr|es), locale (for Intl: the HA language's full tag), numberLocale, hour12 (undefined = the locale's) }.
 */
export function localeFromHass(hass, forced) {
  const loc = (hass && hass.locale) || {};
  const tag = loc.language || (hass && hass.language) || "";
  const lang = resolveLang([forced, tag]);
  // The HA language's own tag when it is this language (« en-GB »), else the bare language (forced: « es »).
  const locale = langOf(tag) === lang && tag ? tag : lang;
  const numberLocale = NUMBER_LOCALES[loc.number_format] || locale;
  const hour12 = loc.time_format === "12" ? true : loc.time_format === "24" ? false : undefined;
  return { lang, locale, numberLocale, hour12 };
}

/**
 * Formatters for a locale: numbers, litres (« 9 538 L », with no-break spaces), times and dates.
 * `hour12` undefined leaves the locale's own clock (24 h in fr and es, 12 h in en-US, 24 h in en-GB).
 */
export function makeFmt(locale, { numberLocale = locale, hour12 } = {}) {
  const nf = {};
  const number = (v, opts = {}) => {
    const k = JSON.stringify(opts);
    return (nf[k] ||= new Intl.NumberFormat(numberLocale, opts)).format(v);
  };
  const clock = hour12 === undefined ? {} : { hour12 };
  return {
    locale,
    number,
    /** Whole litres: « 9 538 L » (fr), « 9,538 L » (en). */
    litres: (v) => `${number(Math.round(v), { maximumFractionDigits: 0 }).replace(/\s/g, " ")} L`,
    /** « 14:05 » (fr, es, en-GB), « 2:05 PM » (en-US); opts as Intl.DateTimeFormat's. */
    time: (date, opts = {}) => new Date(date).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...clock, ...opts }),
    /** A date; opts as Intl.DateTimeFormat's (default: the locale's short date). */
    date: (date, opts = {}) => new Date(date).toLocaleDateString(locale, opts),
  };
}
