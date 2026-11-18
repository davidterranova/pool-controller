/*
 * The install page (docs/plans/secret-free-firmware.md, WP7): the firmware published beside it
 * (firmware/manifest.json), installed over USB by ESP Web Tools, pinned and loaded from unpkg only
 * where it can install (Chrome or Edge on a computer). Its decisions are in install-model.js.
 */
import { REPO, isPhone, browserSupport, loadFirmware, statusMessage } from "./install-model.js";

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** This page's own address (the custom domain, or a fork's github.io path), for the notes that name it. */
const SITE = new URL(".", location.href);
const SITE_TEXT = (SITE.host + SITE.pathname).replace(/\/$/, "");

const page = { browser: "supported", fw: { state: "loading" }, tool: "loading" };

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
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

/** Where installing isn't possible from here: our own note in place of ESP Web Tools' button. */
function renderBrowser() {
  const unsup = $("unsup");
  const supported = page.browser === "supported";
  $("ewt").hidden = !supported;
  $("goHint").hidden = !supported;
  unsup.hidden = supported;
  if (supported) return;
  if (page.browser === "phone") {
    unsup.innerHTML = `<span class="ic">${ico("phone")}</span><div><b>Sur téléphone, on prépare&nbsp;; on installe depuis un ordinateur</b>
      <p>L'installation se fait par USB, avec Chrome ou Edge sur un ordinateur. Ouvrez-y cette page&nbsp;: <span class="mono">${esc(SITE_TEXT)}</span>. Le téléphone resservira juste après, pour régler le contrôleur.</p>
      <button type="button" class="btn" id="copyLink">${ico("copy")}<span>Copier le lien</span></button></div>`;
    $("copyLink").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(SITE.href);
        toast("Lien copié");
      } catch {
        toast(SITE_TEXT);
      }
    });
  } else if (page.browser === "not-allowed") {
    unsup.innerHTML = `<span class="ic">${ico("lock")}</span><div><b>Page ouverte sans HTTPS</b>
      <p>Le navigateur ne permet l'accès USB qu'en HTTPS&nbsp;: ouvrez <span class="mono">https://${esc(SITE_TEXT)}</span>.</p></div>`;
  } else {
    unsup.innerHTML = `<span class="ic">${ico("laptop")}</span><div><b>Ce navigateur ne peut pas installer</b>
      <p>Il n'a pas accès aux ports USB (Web Serial). Ouvrez cette page dans Chrome ou Edge, sur un ordinateur.</p></div>`;
  }
}

/** The chip, the button, the version line and the notices, from the manifest and ESP Web Tools' state. */
function renderFirmware() {
  const { fw, tool, browser } = page;
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
    chip.textContent = "Recherche du firmware…";
    btn.disabled = true;
    label.textContent = "Installer";
  } else if (fw.state === "ok") {
    chip.classList.add("ok");
    chip.textContent = `Firmware ${fw.version}`;
    label.textContent = `Installer ${fw.version}`;
    btn.disabled = tool !== "ready";
    ver.innerHTML = `<span>Firmware <b>${esc(fw.version)}</b> · ESP32</span><a href="${esc(fw.notes)}">Notes de version${ico("ext")}</a>`;
    $("footVer").textContent = `Firmware ${fw.version}`;
    $("footVer").hidden = false;
  } else {
    btn.disabled = true;
    label.textContent = "Installer";
    nofw.hidden = false;
    if (fw.state === "none") {
      chip.classList.add("warn");
      chip.textContent = "Aucun firmware publié";
      nofw.innerHTML = `<div class="box info"><b class="h">${ico("info")}Pas encore de firmware publié</b>
        <p>Le premier arrive avec la prochaine version du projet&nbsp;; cette page le proposera alors d'elle-même.</p>
        <p>En attendant, on peut le compiler soi-même depuis le dépôt&nbsp;: <span class="mono">make build</span> puis <span class="mono">make flash</span> (voir le README).</p>
        <p><a class="ext" href="${REPO}/releases">Suivre les versions${ico("ext")}</a></p></div>`;
    } else {
      chip.classList.add("bad");
      chip.textContent = "Firmware injoignable";
      nofw.innerHTML = `<div class="box bad"><b class="h">${ico("alert")}Impossible de lire le firmware</b>
        <p><span class="mono">${MANIFEST}</span> ne répond pas. Vérifiez la connexion, puis réessayez.</p>
        <p><button type="button" class="btn line" id="retry">Réessayer</button></p></div>`;
      $("retry").addEventListener("click", () => refreshFirmware({ focus: true }));
    }
  }

  // ESP Web Tools itself, only where it is used: it comes from unpkg, so it can fail on its own.
  if (browser === "supported" && tool === "error" && fw.state === "ok") {
    nofw.hidden = false;
    nofw.innerHTML = `<div class="box bad"><b class="h">${ico("alert")}L'outil d'installation n'a pas pu être chargé</b>
      <p>ESP Web Tools vient de <span class="mono">unpkg.com</span>&nbsp;: vérifiez la connexion (ou un bloqueur de contenu), puis réessayez.</p>
      <p><button type="button" class="btn line" id="reload">Réessayer</button></p></div>`;
    $("reload").addEventListener("click", () => location.reload());
  }
  $("live").textContent = statusMessage(browser, fw, tool);
}

async function refreshFirmware({ focus = false } = {}) {
  page.fw = { state: "loading" };
  renderFirmware();
  page.fw = await loadFirmware((url, init) => fetch(url, init), MANIFEST);
  renderFirmware();
  if (!focus) return;
  // Keep the keyboard where the answer is: the button that replaced « Réessayer », or « Réessayer » again.
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

function start() {
  page.browser = detectBrowser();
  $("site").textContent = SITE_TEXT;
  renderBrowser();
  renderFirmware();
  if (page.browser === "supported") loadInstallTool();
  refreshFirmware();
}

start();
