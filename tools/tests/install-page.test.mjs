// node --test (make webui-test): the install page's decisions (docs/install/install-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPO, isPhone, browserSupport, releaseNotesUrl, firmwareFromManifest, loadFirmware, statusMessage,
} from "../../docs/install/install-model.js";

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

test("the live status: one sentence per state", () => {
  const ok = { state: "ok", version: "v1.5.0" };
  assert.equal(statusMessage("supported", { state: "loading" }, "loading"), "Recherche du firmware…");
  assert.match(statusMessage("supported", { state: "none" }, "ready"), /Pas encore de firmware publié/);
  assert.match(statusMessage("supported", { state: "error" }, "ready"), /Impossible de lire le firmware/);
  assert.equal(statusMessage("supported", ok, "ready"), "Firmware v1.5.0, prêt à installer.");
  assert.match(statusMessage("supported", ok, "loading"), /Chargement de l'outil/);
  assert.match(statusMessage("supported", ok, "error"), /n'a pas pu être chargé/);
  assert.match(statusMessage("phone", ok, "loading"), /depuis un ordinateur/);
  assert.match(statusMessage("unsupported", ok, "loading"), /Chrome ou Edge/);
  assert.match(statusMessage("not-allowed", ok, "loading"), /HTTPS/);
});
