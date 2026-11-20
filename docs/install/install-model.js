/*
 * The install page's decisions, without the DOM (tests: tools/tests/install-page.test.mjs).
 *
 *   - which browser this is: one that can install (Web Serial, HTTPS), a phone or tablet (installing is
 *     done from a computer), a page opened without HTTPS, or a browser without Web Serial;
 *   - what firmware/manifest.json says: a version to install, none published yet (404), or unreachable.
 */

export const REPO = "https://github.com/davidterranova/pool-controller";

/** A phone or tablet: Client Hints first, then the user agent. iPadOS reports itself as a Mac with touch. */
export function isPhone({ uaMobile, userAgent = "", maxTouchPoints = 0 } = {}) {
  if (uaMobile === true) return true;
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * "phone", "not-allowed" (no HTTPS: browsers only expose Web Serial in a secure context), "unsupported"
 * (no Web Serial) or "supported". The last three are ESP Web Tools' own rule (isAllowed, isSupported).
 */
export function browserSupport({ phone, secure, serial }) {
  if (phone) return "phone";
  if (!secure) return "not-allowed";
  if (!serial) return "unsupported";
  return "supported";
}

const VERSION_RE = /^[\w.+-]{1,40}$/;

/** The release notes: the manifest's own link when it is an https one, else the release of that tag. */
export function releaseNotesUrl(manifest) {
  const url = manifest?.builds?.[0]?.ota?.release_url;
  if (typeof url === "string" && /^https:\/\//.test(url)) return url;
  return `${REPO}/releases/tag/${encodeURIComponent(manifest.version)}`;
}

/** A parsed manifest.json → {state: "ok", version, notes}, or {state: "error"} when it can't be installed from. */
export function firmwareFromManifest(manifest) {
  const builds = manifest?.builds;
  if (!manifest || typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) return { state: "error" };
  if (!Array.isArray(builds) || !builds.length || !Array.isArray(builds[0].parts) || !builds[0].parts.length) {
    return { state: "error" };
  }
  return { state: "ok", version: manifest.version, notes: releaseNotesUrl(manifest) };
}

/**
 * Reads the manifest with `fetchFn` (fetch's signature). 404: none published yet (Pages serves the site
 * before the first release that carries the firmware). Any other failure, the network's included: error.
 */
export async function loadFirmware(fetchFn, url) {
  try {
    const r = await fetchFn(url, { cache: "no-cache" });
    if (r.status === 404) return { state: "none" };
    if (!r.ok) return { state: "error" };
    return firmwareFromManifest(await r.json());
  } catch {
    return { state: "error" };
  }
}

/**
 * What the live status region says now, as a code and its values: { code, vars }. The page shows it in its
 * language as the text `status.<code>` (i18n/*.json). `tool` is ESP Web Tools: loading, ready, error.
 */
export function statusMessage(browser, fw, tool) {
  if (fw.state === "loading") return { code: "searching", vars: {} };
  if (fw.state === "none") return { code: "none", vars: {} };
  if (fw.state === "error") return { code: "error", vars: {} };
  const vars = { version: fw.version };
  if (browser === "phone") return { code: "phone", vars };
  if (browser === "not-allowed") return { code: "not_allowed", vars };
  if (browser === "unsupported") return { code: "unsupported", vars };
  if (tool === "error") return { code: "tool_error", vars };
  if (tool === "loading") return { code: "tool_loading", vars };
  return { code: "ready", vars };
}
