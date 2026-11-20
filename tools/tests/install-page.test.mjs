// node --test (make webui-test): the install page's decisions (docs/install/install-model.js) and its languages
// (docs/install/install-i18n.js, docs/install/i18n/*.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REPO, isPhone, browserSupport, releaseNotesUrl, firmwareFromManifest, loadFirmware, statusMessage,
} from "../../docs/install/install-model.js";
import {
  LANGS, DICTS, LANG_KEY, pickLang, readLang, saveLang, translator, rich, snippets,
} from "../../docs/install/install-i18n.js";
import { flatten, placeholders, tags, scanUsage } from "../i18n/lib.mjs";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iPadAsMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

const MANIFEST = {
  name: "Pool Controller",
  version: "v1.5.0",
  home_assistant_domain: "esphome",
  builds: [{
    chipFamily: "ESP32",
    ota: { path: "firmware.ota.bin", md5: "0", release_url: `${REPO}/releases/tag/v1.5.0` },
    parts: [{ path: "firmware.factory.bin", offset: 0 }],
  }],
};

test("phones and tablets: Client Hints first, then the user agent (iPadOS reads as a Mac with touch)", () => {
  assert.equal(isPhone({ uaMobile: true, userAgent: UA.chromeMac }), true);
  assert.equal(isPhone({ uaMobile: false, userAgent: UA.chromeAndroid }), true);
  assert.equal(isPhone({ userAgent: UA.androidTablet }), true);
  assert.equal(isPhone({ userAgent: UA.iPhone }), true);
  assert.equal(isPhone({ userAgent: UA.iPadAsMac, maxTouchPoints: 5 }), true);
  assert.equal(isPhone({ uaMobile: false, userAgent: UA.chromeMac, maxTouchPoints: 0 }), false);
  assert.equal(isPhone({ uaMobile: false, userAgent: UA.edgeWin, maxTouchPoints: 10 }), false); // a touch-screen PC
  assert.equal(isPhone(), false);
});

test("browser: a phone first, then HTTPS, then Web Serial", () => {
  assert.equal(browserSupport({ phone: true, secure: true, serial: true }), "phone");
  assert.equal(browserSupport({ phone: false, secure: false, serial: false }), "not-allowed");
  assert.equal(browserSupport({ phone: false, secure: true, serial: false }), "unsupported");
  assert.equal(browserSupport({ phone: false, secure: true, serial: true }), "supported");
});

test("release notes: the manifest's https link, else the release of its tag", () => {
  assert.equal(releaseNotesUrl(MANIFEST), `${REPO}/releases/tag/v1.5.0`);
  const noLink = { ...MANIFEST, builds: [{ ...MANIFEST.builds[0], ota: { path: "firmware.ota.bin" } }] };
  assert.equal(releaseNotesUrl(noLink), `${REPO}/releases/tag/v1.5.0`);
  const bad = { ...MANIFEST, builds: [{ ...MANIFEST.builds[0], ota: { release_url: "javascript:alert(1)" } }] };
  assert.equal(releaseNotesUrl(bad), `${REPO}/releases/tag/v1.5.0`);
  const other = { ...MANIFEST, builds: [{ ...MANIFEST.builds[0], ota: { release_url: "https://example.invalid/notes" } }] };
  assert.equal(releaseNotesUrl(other), "https://example.invalid/notes");
});

test("a manifest to install from: a short version and a build with parts", () => {
  assert.deepEqual(firmwareFromManifest(MANIFEST), { state: "ok", version: "v1.5.0", notes: `${REPO}/releases/tag/v1.5.0` });
  assert.deepEqual(firmwareFromManifest({ ...MANIFEST, version: "dev-1a2b3c4" }).state, "ok");
  for (const m of [
    null,
    {},
    { ...MANIFEST, version: "" },
    { ...MANIFEST, version: 150 },
    { ...MANIFEST, version: "<b>v1</b>" },
    { ...MANIFEST, builds: [] },
    { ...MANIFEST, builds: [{ chipFamily: "ESP32", parts: [] }] },
  ]) assert.deepEqual(firmwareFromManifest(m), { state: "error" }, JSON.stringify(m));
});

const answer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("loading the manifest: published, none yet (404), or unreachable", async () => {
  assert.equal((await loadFirmware(answer(200, MANIFEST), "firmware/manifest.json")).state, "ok");
  assert.deepEqual(await loadFirmware(answer(404, null), "firmware/manifest.json"), { state: "none" });
  assert.deepEqual(await loadFirmware(answer(500, null), "firmware/manifest.json"), { state: "error" });
  assert.deepEqual(await loadFirmware(async () => { throw new TypeError("Failed to fetch"); }, "x"), { state: "error" });
  const notJson = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } });
  assert.deepEqual(await loadFirmware(notJson, "x"), { state: "error" });
});

test("loading the manifest: asks past the browser's cache, for the URL given", async () => {
  let seen;
  await loadFirmware(async (url, init) => { seen = { url, init }; return { status: 404, ok: false }; }, "firmware/manifest.json");
  assert.deepEqual(seen, { url: "firmware/manifest.json", init: { cache: "no-cache" } });
});

const OK = { state: "ok", version: "v1.5.0" };
/** Every situation the live status region can be in, with the code it gives. */
const SITUATIONS = [
  [["supported", { state: "loading" }, "loading"], "searching"],
  [["supported", { state: "none" }, "ready"], "none"],
  [["supported", { state: "error" }, "ready"], "error"],
  [["supported", OK, "ready"], "ready"],
  [["supported", OK, "loading"], "tool_loading"],
  [["supported", OK, "error"], "tool_error"],
  [["phone", OK, "loading"], "phone"],
  [["unsupported", OK, "loading"], "unsupported"],
  [["not-allowed", OK, "loading"], "not_allowed"],
];

test("the live status: a code per state, with the version once there is one", () => {
  for (const [args, code] of SITUATIONS) {
    const msg = statusMessage(...args);
    assert.equal(msg.code, code, JSON.stringify(args));
    assert.deepEqual(msg.vars, args[1].state === "ok" ? { version: "v1.5.0" } : {});
  }
});

test("the live status reads as a sentence in every language", () => {
  const seen = new Map();
  for (const lang of LANGS) {
    const t = translator(lang);
    for (const [args] of SITUATIONS) {
      const { code, vars } = statusMessage(...args);
      const text = t(`status.${code}`, vars);
      assert.notEqual(text, `status.${code}`, `${lang}: status.${code} has no text`);
      assert.doesNotMatch(text, /[{}]/, `${lang}: ${text}`);
      if (vars.version) assert.ok(text.includes("v1.5.0"), `${lang}: ${text}`);
      seen.set(`${lang}:${code}`, text);
    }
  }
  assert.equal(seen.get("en:ready"), "Firmware v1.5.0, ready to install.");
  assert.equal(seen.get("fr:ready"), "Firmware v1.5.0, prêt à installer.");
  assert.equal(seen.get("es:ready"), "Firmware v1.5.0, listo para instalar.");
  assert.equal(seen.get("fr:searching"), "Recherche du firmware…");
});

// ------------------------------------------------------------------ the dictionaries

const FLAT = Object.fromEntries(LANGS.map((l) => [l, flatten(DICTS[l]).map]));
const SNIPPETS = snippets(translator("en"), { site: "pool-controller.example", ext: "<svg></svg>" });
/** What the model's messages fill in, beside the page's own snippets. */
const MODEL_VARS = ["version"];

test("the dictionaries: the same keys, placeholders and (no) markup in every language", () => {
  const keys = [...FLAT.en.keys()];
  assert.ok(keys.length > 50, `${keys.length} keys`);
  for (const lang of LANGS) {
    assert.deepEqual([...FLAT[lang].keys()].sort(), [...keys].sort(), `${lang}'s keys`);
    for (const key of keys) {
      const text = FLAT[lang].get(key);
      assert.equal(typeof text, "string", `${lang}: ${key}`);
      assert.ok(text.trim(), `${lang}: ${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(FLAT.en.get(key)), `${lang}: ${key}'s placeholders`);
      // Markup is the page's (snippets), never a dictionary's: a translation tool can't break it.
      assert.deepEqual(tags(text), [], `${lang}: ${key} holds markup`);
    }
  }
});

test("the dictionaries: every placeholder is one the page fills", () => {
  for (const [key, text] of FLAT.en) {
    for (const p of placeholders(text)) assert.ok(p in SNIPPETS || MODEL_VARS.includes(p), `${key}: {${p}}`);
  }
});

test("index.html: every key it names exists; its title and description are en.json's", () => {
  const html = readFileSync(new URL("../../docs/install/index.html", import.meta.url), "utf8");
  const { keys } = scanUsage(html, "code");
  assert.ok(keys.size > 50, `${keys.size} keys`);
  for (const k of keys) assert.ok(FLAT.en.has(k), `index.html: ${k}`);
  const decode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.equal(decode(html.match(/<title>([^<]*)<\/title>/)[1]), DICTS.en.meta.title);
  assert.equal(decode(html.match(/<meta name="description" content="([^"]*)">/)[1]), DICTS.en.meta.description);
  assert.match(html, /<html lang="en">/);
});

// ------------------------------------------------------------------ the language

test("the language: the remembered choice, else the browser's first supported, else English", () => {
  assert.equal(pickLang("es", ["fr-FR", "en"]), "es");
  assert.equal(pickLang(null, ["de-DE", "fr-CA", "en"]), "fr");
  assert.equal(pickLang("de", ["es-419"]), "es"); // a choice the page doesn't have is ignored
  assert.equal(pickLang(null, ["de", "it"]), "en");
  assert.equal(pickLang(null), "en");
});

/** A Storage stand-in; `fail` makes every call throw, as a blocked one does. */
function store({ fail = false } = {}) {
  const m = new Map();
  const guard = () => { if (fail) throw new DOMException("blocked", "SecurityError"); };
  return {
    getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); },
    map: m,
  };
}

test("the choice is remembered in storage, and a missing or blocked storage is no error", () => {
  const s = store();
  assert.equal(readLang(s), null);
  assert.equal(saveLang(s, "fr"), true);
  assert.equal(s.map.get(LANG_KEY), "fr");
  assert.equal(readLang(s), "fr");
  assert.equal(readLang(store({ fail: true })), null);
  assert.equal(saveLang(store({ fail: true }), "fr"), false);
  assert.equal(readLang(null), null);
  assert.equal(saveLang(null, "fr"), false);
});

// ------------------------------------------------------------------ texts as HTML

test("rich: the text escaped, the page's snippets as markup, an unknown placeholder left as it is", () => {
  assert.equal(rich("Open {address} <now> & {other}", { address: "<b>x</b>" }), "Open <b>x</b> &lt;now&gt; &amp; {other}");
  assert.equal(rich("L'outil", {}), "L&#39;outil");
  assert.equal(rich("{toString}", {}), "{toString}"); // only the snippets' own names
});

test("snippets: ESP Web Tools' buttons stay English, the section links follow the language", () => {
  const fr = snippets(translator("fr"), { site: "x.example" });
  const es = snippets(translator("es"), { site: "x.example" });
  assert.equal(fr.connect, '<span class="k">Connect</span>');
  assert.equal(es.connect, fr.connect);
  assert.equal(fr.updates_link, '<a href="#maj">Mises à jour</a>');
  assert.equal(es.updates_link, '<a href="#maj">Actualizaciones</a>');
  assert.equal(fr.https_site, '<span class="mono">https://x.example</span>');
  const t = translator("es");
  assert.equal(
    rich(t("install.erase.never"), es),
    'Nunca en un controlador que ya está en servicio: se actualiza solo y conserva su configuración (consulta <a href="#maj">Actualizaciones</a>).',
  );
});
