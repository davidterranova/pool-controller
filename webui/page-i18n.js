/*
 * The page's language (docs/plans/i18n.md, I4): English, French or Spanish, from the choice made on the page (its
 * EN | FR | ES switch, remembered by this browser), else the browser's languages, else English. Every text of the page
 * goes through t(): its own keys (webui/i18n-page/) and the card's (webui/i18n/, the card's dictionaries: common.*),
 * bundled into the page, so nothing is fetched and the hotspot works offline. A change re-renders in place: the
 * listeners (onLang) redraw, and the card follows through hass.locale.
 */
import { LANGS, makeT, makeFmt, resolveLang, mergeDicts } from "./i18n.js";
import cardEn from "./i18n/en.json" with { type: "json" };
import cardFr from "./i18n/fr.json" with { type: "json" };
import cardEs from "./i18n/es.json" with { type: "json" };
import en from "./i18n-page/en.json" with { type: "json" };
import fr from "./i18n-page/fr.json" with { type: "json" };
import es from "./i18n-page/es.json" with { type: "json" };

const DICTS = mergeDicts({ en: cardEn, fr: cardFr, es: cardEs }, { en, fr, es });
const STORE = "pool-controller.lang";
/** Each language's name in itself, for the switch's tooltips. */
const NAMES = { en: "English", fr: "Français", es: "Español" }; // i18n-ignore: each language's own name

const stored = () => { try { return localStorage.getItem(STORE); } catch { return null; } };
let lang = resolveLang([stored(), ...(typeof navigator !== "undefined" ? navigator.languages || [navigator.language] : [])]);
let tr = makeT(DICTS, lang), F = makeFmt(lang);
const listeners = new Set();
if (typeof document !== "undefined") document.documentElement.lang = lang;

/** The text of `key` in the page's language, `{placeholders}` filled from `vars`. */
export const t = (key, vars) => tr(key, vars);
/** The page's formats (Intl): number, time, date, litres. */
export const fmt = () => F;
export const pageLang = () => lang;
/** « a », « a and b », « a, b and c », in the page's language. */
export const andList = (items) => new Intl.ListFormat(lang, { type: "conjunction" }).format(items);

/** Switches the page to `next` (en, fr, es), remembered by this browser; each listener redraws. */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  tr = makeT(DICTS, lang);
  F = makeFmt(lang);
  try { localStorage.setItem(STORE, lang); } catch { /* private mode: for this visit only */ }
  document.documentElement.lang = lang;
  for (const f of listeners) f(lang);
}
export const onLang = (f) => listeners.add(f);

/**
 * The static texts of index.html: a data-i18n attribute (a key) sets an element's text, data-i18n-<attribute> an
 * attribute (title, aria-label).
 */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll("*")) {
    for (const a of el.attributes) {
      if (a.name === "data-i18n") el.textContent = t(a.value);
      else if (a.name.startsWith("data-i18n-")) el.setAttribute(a.name.slice(10), t(a.value));
    }
  }
}

/** The EN | FR | ES switch, as HTML: buttons with data-lang, the current one pressed. */
export const langSwitch = () => `<span class="langs" role="group" aria-label="${t("page.lang.label")}">${LANGS.map((l) =>
  `<button type="button" data-lang="${l}" lang="${l}" title="${NAMES[l]}" aria-pressed="${l === lang}">${l.toUpperCase()}</button>`).join("")}</span>`;
