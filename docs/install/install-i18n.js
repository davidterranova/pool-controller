/*
 * The install page's languages (docs/plans/i18n.md, I6), without the DOM (tests: tools/tests/install-page.test.mjs).
 *
 *   - the texts: i18n/{en,fr,es}.json, imported as JSON modules, so nothing but this site is fetched;
 *   - t(): the helper the card and the controller's page use (i18n.js, a symlink to home-assistant/i18n.js:
 *     the Pages job copies the file itself, since Pages serves this folder alone);
 *   - the language: the visitor's remembered choice (the EN | FR | ES switch), else the browser's, else English;
 *   - rich(): a text with {placeholders} that stand for markup the page owns (a code sample, a link, one of
 *     ESP Web Tools' English buttons). The dictionaries hold no markup and no code, so a translation tool can
 *     neither break nor translate them; the text itself is escaped.
 */
import { LANGS, resolveLang, makeT } from "./i18n.js";
import { REPO } from "./install-model.js";
import en from "./i18n/en.json" with { type: "json" };
import fr from "./i18n/fr.json" with { type: "json" };
import es from "./i18n/es.json" with { type: "json" };

export { LANGS };
export const DICTS = { en, fr, es };

/** Where the switch's choice is kept (localStorage). */
export const LANG_KEY = "pool-controller.install.lang";

/** The page's language: the remembered choice, else the first of the browser's that is supported, else English. */
export const pickLang = (stored, browserLangs = []) => resolveLang([stored, ...browserLangs]);

/** The remembered choice, or null: storage can be missing or throw (private mode, blocked site data). */
export function readLang(storage) {
  try {
    return storage?.getItem(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the choice; true when it was kept. */
export function saveLang(storage, lang) {
  try {
    storage.setItem(LANG_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

/** t(key, vars) in `lang`, English for a missing text. */
export const translator = (lang) => makeT(DICTS, lang);

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A text as HTML: escaped, then each {name} of `snippets` replaced by its markup; another {name} stays as it is. */
export const rich = (text, snippets = {}) =>
  esc(text).replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(snippets, name) ? snippets[name] : m));

const k = (label) => `<span class="k">${label}</span>`;
const mono = (code) => `<span class="mono">${esc(code)}</span>`;

/**
 * The markup the texts' {placeholders} stand for, in a language (the links carry translated section titles).
 * `site` is this page's address without its scheme (pool-controller.kitesize.fr, or a fork's), `ext` the
 * external-link icon.
 */
export function snippets(t, { site, ext = "" }) {
  return {
    // ESP Web Tools' window is in English: its buttons are named as it shows them.
    connect: k("Connect"),
    install_pool_controller: k("Install Pool Controller"),
    install: k("Install"),
    configure_wifi: k("Configure Wi-Fi"),
    skip: k("Skip"),
    visit_device: k("Visit Device"),
    add_to_home_assistant: k("Add to Home Assistant"),
    // Addresses, names and commands, never translated.
    address: `<b class="mono">http://pool-controller.local</b>`,
    hotspot_address: `<b class="mono">http://192.168.4.1</b>`,
    hostname: "pool-controller",
    site: mono(site),
    https_site: mono(`https://${site}`),
    manifest: mono("firmware/manifest.json"),
    unpkg: mono("unpkg.com"),
    make_build: mono("make build"),
    make_flash: mono("make flash"),
    make_migrate: mono("make migrate"),
    yaml: mono("pool-controller.yaml"),
    // Links to the page's own sections, by their title in this language, and out.
    updates_link: `<a href="#maj">${esc(t("updates.title"))}</a>`,
    after_link: `<a href="#apres">${esc(t("after.title"))}</a>`,
    hardware_link: `<a class="ext" href="${REPO}/blob/main/POOL-CONTROLLER.md#hardware">POOL-CONTROLLER.md${ext}</a>`,
    ewt_link: `<a href="https://esphome.github.io/esp-web-tools/">ESP Web Tools</a>`,
  };
}
