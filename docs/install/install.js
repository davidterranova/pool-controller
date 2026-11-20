/*
 * The install page (docs/plans/secret-free-firmware.md, WP7): the firmware published beside it
 * (firmware/manifest.json), installed over USB by ESP Web Tools, pinned and loaded from unpkg only
 * where it can install (Chrome or Edge on a computer). Its decisions are in install-model.js.
 *
 * In English, French and Spanish (docs/plans/i18n.md, I6; install-i18n.js): the visitor's remembered choice,
 * else the browser's language, else English. The EN | FR | ES switch re-renders in place: the page's state
 * (the firmware found, ESP Web Tools loaded, an open « Wiring ») stays as it is.
 */
import { REPO, isPhone, browserSupport, loadFirmware, statusMessage } from "./install-model.js";
import { LANGS, pickLang, readLang, saveLang, translator, esc, rich, snippets } from "./install-i18n.js";

const EWT_URL = "https://unpkg.com/esp-web-tools@10.4.0/dist/web/install-button.js?module";
const MANIFEST = "firmware/manifest.json";

const $ = (id) => document.getElementById(id);
const ICON = {
  alert: "M13 14H11V9H13M13 18H11V16H13M1 21H23L12 2L1 21Z",
  phone: "M17,19H7V5H17M17,1H7C5.89,1 5,1.89 5,3V21A2,2 0 0,0 7,23H17A2,2 0 0,0 19,21V3C19,1.89 18.1,1 17,1Z",
  laptop: "M4,6H20V16H4M20,18A2,2 0 0,0 22,16V6C22,4.89 21.1,4 20,4H4C2.89,4 2,4.89 2,6V16A2,2 0 0,0 4,18H0V20H24V18H20Z",
  lock: "M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z",
  copy: "M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z",
  ext: "M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z",
  info: "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z",
};
const ico = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

/** This page's own address (the custom domain, or a fork's github.io path), for the notes that name it. */
const SITE = new URL(".", location.href);
const SITE_TEXT = (SITE.host + SITE.pathname).replace(/\/$/, "");

/** localStorage, or null where reading it throws (blocked site data): the choice is then not remembered. */
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const page = { browser: "supported", fw: { state: "loading" }, tool: "loading", t: null, snips: null };

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function detectBrowser() {
  return browserSupport({
    phone: isPhone({
      uaMobile: navigator.userAgentData?.mobile,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    }),
    secure: window.isSecureContext,
    serial: "serial" in navigator,
  });
}

/** The page in `lang`: t(), then every data-i18n text and data-i18n-<attribute>, the title, <html lang>, the switch. */
function localize(lang) {
  const t = translator(lang);
  page.t = t;
  page.snips = snippets(t, { site: SITE_TEXT, ext: ico("ext") });
  document.documentElement.lang = lang;
  document.title = t("meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
  for (const el of document.body.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      if (name === "data-i18n") el.innerHTML = rich(t(value), page.snips);
      else if (name.startsWith("data-i18n-")) el.setAttribute(name.slice("data-i18n-".length), t(value));
    }
  }
  for (const b of document.querySelectorAll(".lang [data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

/** Where installing isn't possible from here: our own note in place of ESP Web Tools' button. */
function renderBrowser() {
  const { t, snips } = page;
  const unsup = $("unsup");
  const supported = page.browser === "supported";
  $("ewt").hidden = !supported;
  $("goHint").hidden = !supported;
  unsup.hidden = supported;
  if (supported) return;
  if (page.browser === "phone") {
    unsup.innerHTML = `<span class="ic">${ico("phone")}</span><div><b>${esc(t("browser.phone.title"))}</b>
      <p>${rich(t("browser.phone.body"), snips)}</p>
      <button type="button" class="btn" id="copyLink">${ico("copy")}<span>${esc(t("browser.phone.copy"))}</span></button></div>`;
    $("copyLink").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SITE.href);
        toast(page.t("browser.phone.copied"));
      } catch {
        toast(SITE_TEXT);
      }
    });
  } else if (page.browser === "not-allowed") {
    unsup.innerHTML = `<span class="ic">${ico("lock")}</span><div><b>${esc(t("browser.http.title"))}</b>
      <p>${rich(t("browser.http.body"), snips)}</p></div>`;
  } else {
    unsup.innerHTML = `<span class="ic">${ico("laptop")}</span><div><b>${esc(t("browser.unsupported.title"))}</b>
      <p>${esc(t("browser.unsupported.body"))}</p></div>`;
  }
}

/** The chip, the button, the version line and the notices, from the manifest and ESP Web Tools' state. */
function renderFirmware() {
  const { fw, tool, browser, t, snips } = page;
  const chip = $("verChip");
  const btn = $("installBtn");
  const label = btn.querySelector("span");
  const nofw = $("nofw");
  const ver = $("ver");
  chip.className = "chip";
  nofw.hidden = true;
  nofw.innerHTML = "";
  ver.innerHTML = "";
  $("footVer").textContent = "";
  $("footVer").hidden = true;
  $("filesRow").hidden = fw.state === "none";
  $("go").setAttribute("aria-busy", String(fw.state === "loading" || (browser === "supported" && tool === "loading")));

  if (fw.state === "loading") {
    chip.textContent = t("status.searching");
    btn.disabled = true;
    label.textContent = t("install.button");
  } else if (fw.state === "ok") {
    const firmware = t("firmware.chip", { version: fw.version });
    chip.classList.add("ok");
    chip.textContent = firmware;
    label.textContent = t("install.button_version", { version: fw.version });
    btn.disabled = tool !== "ready";
    ver.innerHTML = `<span>${rich(t("firmware.chip"), { version: `<b>${esc(fw.version)}</b>` })} · ESP32</span>`
      + `<a href="${esc(fw.notes)}">${esc(t("firmware.notes"))}${ico("ext")}</a>`;
    $("footVer").textContent = firmware;
    $("footVer").hidden = false;
  } else {
    btn.disabled = true;
    label.textContent = t("install.button");
    nofw.hidden = false;
    if (fw.state === "none") {
      chip.classList.add("warn");
      chip.textContent = t("firmware.none_chip");
      nofw.innerHTML = `<div class="box info"><b class="h">${ico("info")}${esc(t("firmware.none.title"))}</b>
        <p>${esc(t("firmware.none.next"))}</p>
        <p>${rich(t("firmware.none.build"), snips)}</p>
        <p><a class="ext" href="${REPO}/releases">${esc(t("firmware.none.follow"))}${ico("ext")}</a></p></div>`;
    } else {
      chip.classList.add("bad");
      chip.textContent = t("firmware.error_chip");
      nofw.innerHTML = `<div class="box bad"><b class="h">${ico("alert")}${esc(t("firmware.error.title"))}</b>
        <p>${rich(t("firmware.error.body"), snips)}</p>
        <p><button type="button" class="btn line" id="retry">${esc(t("firmware.retry"))}</button></p></div>`;
      $("retry").addEventListener("click", () => refreshFirmware({ focus: true }));
    }
  }

  // ESP Web Tools itself, only where it is used: it comes from unpkg, so it can fail on its own.
  if (browser === "supported" && tool === "error" && fw.state === "ok") {
    nofw.hidden = false;
    nofw.innerHTML = `<div class="box bad"><b class="h">${ico("alert")}${esc(t("tool.error.title"))}</b>
      <p>${rich(t("tool.error.body"), snips)}</p>
      <p><button type="button" class="btn line" id="reload">${esc(t("firmware.retry"))}</button></p></div>`;
    $("reload").addEventListener("click", () => location.reload());
  }
  const status = statusMessage(browser, fw, tool);
  $("live").textContent = t(`status.${status.code}`, status.vars);
}

async function refreshFirmware({ focus = false } = {}) {
  page.fw = { state: "loading" };
  renderFirmware();
  page.fw = await loadFirmware((url, init) => fetch(url, init), MANIFEST);
  renderFirmware();
  if (!focus) return;
  // Keep the keyboard where the answer is: the button that replaced « Try again », or « Try again » again.
  const target = page.fw.state === "error" ? $("retry") : page.browser === "supported" && !$("installBtn").disabled ? $("installBtn") : $("go");
  target?.focus();
}

async function loadInstallTool() {
  try {
    await import(EWT_URL);
    await customElements.whenDefined("esp-web-install-button");
    page.tool = "ready";
  } catch (e) {
    console.error("ESP Web Tools could not be loaded from unpkg", e);
    page.tool = "error";
  }
  renderFirmware();
}

/** The whole page in `lang`, in place: the texts, then the parts drawn from the page's state. */
function render(lang) {
  localize(lang);
  renderBrowser();
  renderFirmware();
}

function start() {
  page.browser = detectBrowser();
  $("site").textContent = SITE_TEXT;
  render(pickLang(readLang(storage), navigator.languages || [navigator.language]));
  for (const b of document.querySelectorAll(".lang [data-lang]")) {
    b.addEventListener("click", () => {
      const lang = b.dataset.lang;
      if (!LANGS.includes(lang) || lang === page.t.lang) return;
      saveLang(storage, lang);
      render(lang);
    });
  }
  if (page.browser === "supported") loadInstallTool();
  refreshFirmware();
}

start();
