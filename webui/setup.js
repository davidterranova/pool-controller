/*
 * Setting the controller up from its own page (docs/plans/secret-free-firmware.md, WP3): what used to
 * be compiled in from secrets.yaml lives on the controller now (device-settings.yaml).
 *
 *   - The setup wizard takes the page's place while Setup State isn't `configured`: page password →
 *     Wi-Fi → position and time zone → probes → Home Assistant, one step per missing item, opened at
 *     the first one. A step is done when Setup State no longer lists its item, so a page reopened
 *     after joining the home network, or after a factory reset, resumes where it should.
 *   - The Réglages contrôleur tab gains Position and Sondes (the same forms), Compteur d'eau, and Accès,
 *     Home Assistant and Réinitialiser.
 *   - The fill meter (fill-meter.yaml) is optional, so not a Setup State item: the wizard's step 4 asks about it
 *     (« J'ai un compteur » runs its pulse test, « Pas de compteur » turns it off) without ever blocking a step, and
 *     Réglages contrôleur › Compteur d'eau has the switch, the test, the last pulse and « Alarme après ».
 *
 * Secrets are write-only (CVE-2026-71260 leaks password-mode text values): a password or a key is
 * sent once, its form cleared, and the page never reads one back; whether each is set comes from
 * Setup State. app.js mounts this with its own helpers and calls the returned update on every change.
 */
import {
  SETUP_ITEMS, parseSetupState, nextStep, andList, parseDetectedProbes, shortAddress, probeTrend,
  passwordProblem, validApiKey, parseDegrees, degreesInput, WAITING_FOR, sunTimes,
  FILL_DETECT, FILL_ALARM, fillStatus, parseAlarmMinutes, lastPulseText,
} from "./setup-model.js";
import { TIMEZONES, posixOf, validPosix, validZoneName, browserZone, clockIn } from "./timezones.js";

const STEPS = ["Mot de passe", "Wi-Fi", "Position", "Sondes", "Home Assistant"];
const TITLES = ["Mot de passe de cette page", "Wi-Fi", "Position et fuseau horaire", "Sondes de température", "Home Assistant"];
/** What the controller still needs, per Setup State item (« il lui faut … »). */
const NEED = {
  page_password: "un mot de passe pour cette page",
  wifi: "le réseau Wi-Fi",
  position: "sa position et son fuseau",
  probes: "le rôle de ses sondes",
  api_key: "la liaison avec Home Assistant",
};
/** The probe roles: their select (E key) and name. Bassin is the one the plan and freeze protection need. */
const ROLES = [
  { key: "poolProbe", label: "Bassin" },
  { key: "padProbe", label: "Local technique" },
  { key: "outdoorProbe", label: "Extérieur" },
];
const NO_PROBE = "none";
const AP_SSID = "pool-controller";
const HOME_URL = "http://pool-controller.local";
/** How long a write may take to show in Setup State: the firmware republishes it right after each one. */
const CONFIRM_MS = 3000;
/** Detected Probes readings kept per probe, for its trend (every minute on the device). */
const READINGS_KEPT = 12;
const TREND = { up: "↗ se réchauffe", down: "↘ refroidit", "": "" };

export function mountSetup({ hass, E, ui }) {
  const { icon, esc, toast, fmt1, bars } = ui;
  const $ = (id) => document.getElementById(id);
  const st = (id) => hass.states[id];
  const s = (id) => st(id)?.state;
  const n = (id) => parseFloat(s(id));
  /** A text entity's value, "" while unknown. */
  const text = (id) => (["unknown", "unavailable", undefined].includes(s(id)) ? "" : s(id));
  const refused = (e) => toast(`Refusé par le contrôleur (${e.message})`, true);

  const wz = { open: false, step: 1, seen: false, afterReset: false, resetPending: false, joinedFromHotspot: false };
  const view = { acc: null, reset: false, forget: false, paste: null, busy: false, scanUntil: 0 };
  let keyOrigin = null; // "paste" | "generated": how this page set the API key, for the wording only
  const readings = new Map(); // probe address -> its last readings
  let probesSeen = "", lastMode = null;
  const browserTz = browserZone();
  const joinHome = $("joinForm").parentNode; // step 2 borrows the Réglages contrôleur tab's network list and form

  /* ------------------------------------------------------------ device state */

  /** The missing items, in the wizard's order; null while the device hasn't said. */
  const missing = () => parseSetupState(s(E.setupState));
  const isMissing = (item) => !!missing()?.includes(item);
  const roleAddress = (key) => (text(E[key]) && s(E[key]) !== NO_PROBE ? s(E[key]) : null);
  const probes = () => parseDetectedProbes(s(E.detectedProbes));
  const linked = () => s(E.haLink) === "on";
  const scanning = () => Date.now() < view.scanUntil;
  const deg = (v) => (Number.isFinite(v) ? `${v.toFixed(2).replace(".", ",")}°` : "—");
  /** Resolves true once `pred` holds, false after `ms`. */
  const until = (pred, ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const poll = () => (pred() ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(poll, 200));
    poll();
  });
  /** Whether Setup State dropped `item` after a write: the device's own word that it took it. */
  const confirmed = (item) => until(() => !isMissing(item), CONFIRM_MS);

  /* ------------------------------------------------------------ HTML pieces */

  /** Sets a host's HTML only when it changed, so forms keep what's typed and selects stay open. */
  function paint(host, html) {
    if (host._html === html) return false;
    host.innerHTML = html;
    host._html = html;
    host.querySelectorAll('form[data-form="pos"]').forEach(posHints);
    return true;
  }
  const row = (ic, label, value, sub = "", cls = "") => `<div class="erow"><span class="ic">${icon(ic)}</span>
    <span class="name"><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</span><span class="val${cls ? ` ${cls}` : ""}">${value}</span></div>`;
  const tag = (label, cls = "") => `<span class="stag${cls ? ` ${cls}` : ""}">${label}</span>`;
  const hero = (cls, ic, title, sub) => `<div class="wz-hero ${cls}"><span class="ic">${icon(ic)}</span><span><b>${title}</b><small>${sub}</small></span></div>`;
  const lineBtn = (act, ic, label, extra = "") => `<button type="button" class="btn line" data-act="${act}"${extra}>${icon(ic)}<span>${label}</span></button>`;

  /* ------------------------------------------------------------ passwords (page, OTA) */

  const pwForm = (kind, inWizard) => `<form class="form" data-form="pw" data-kind="${kind}" autocomplete="off">
    ${kind === "page" ? '<input type="text" name="username" value="admin" autocomplete="username" hidden>' : ""}
    <label>${inWizard ? "Mot de passe" : "Nouveau mot de passe"}<span class="pw"><input name="pw" type="password" maxlength="64" autocomplete="new-password">
      <button type="button" class="btn" data-act="eye" title="Afficher" aria-label="Afficher le mot de passe">${icon("eye")}</button></span></label>
    <label>Confirmer<input name="pw2" type="password" maxlength="64" autocomplete="new-password"></label>
    ${inWizard ? "" : `<p class="hint">8 caractères au moins.${kind === "page" ? " Le navigateur le redemandera aussitôt." : ""}</p>
      <div class="rowbtns"><button class="btn fill">Enregistrer</button><button type="button" class="btn" data-act="acc-cancel">Annuler</button></div>`}
  </form>`;

  /** Sends the password once and clears the form; true when the controller took it. */
  async function savePassword(form) {
    const pw = form.elements.pw.value, problem = passwordProblem(pw, form.elements.pw2.value);
    if (problem) {
      toast(problem, true);
      form.elements[pw.length < 8 || pw.length > 64 ? "pw" : "pw2"].focus();
      return false;
    }
    const kind = form.dataset.kind;
    form.reset(); // sent once, never kept nor shown again
    try {
      await hass.setText(kind === "page" ? E.pagePassword : E.otaPassword, pw);
    } catch (e) {
      refused(e);
      return false;
    }
    if (kind === "page" && !(await confirmed("page_password"))) {
      toast("Le contrôleur n'a pas confirmé le mot de passe.", true);
      return false;
    }
    view.acc = null;
    return true;
  }

  /* ------------------------------------------------------------ position and time zone */

  /** The zone the form starts on: the controller's, else this browser's (from the table, or by hand). */
  function tzPick() {
    const posix = text(E.timezone), name = text(E.timezoneName);
    if (posix) return posixOf(name) === posix ? { sel: name, posix: "", name: "" } : { sel: "__posix", posix, name };
    return posixOf(browserTz) ? { sel: browserTz, posix: "", name: "" } : { sel: "__posix", posix: "", name: browserTz };
  }
  /** The dropdown: the preset list, plus the zone picked when posixOf() knows it and the list doesn't. */
  const zoneChoices = (sel) => {
    const names = TIMEZONES.map(([iana]) => iana);
    return sel !== "__posix" && !names.includes(sel) ? [sel, ...names] : names;
  };
  function posForm(withSave) {
    const p = tzPick();
    return `<form class="form" data-form="pos" autocomplete="off">
      <div class="two"><label>Latitude (°)<input name="lat" inputmode="decimal" value="${degreesInput(n(E.latitude))}" placeholder="48,85" autocomplete="off"></label>
        <label>Longitude (°)<input name="lon" inputmode="decimal" value="${degreesInput(n(E.longitude))}" placeholder="2,35" autocomplete="off"></label></div>
      <p class="hint">Arrondies à 0,01° (environ 1 km) : assez pour le soleil, sans situer la maison. Nord et est positifs. Sur une carte, un appui long sur la piscine donne ses coordonnées.</p>
      <label>Fuseau horaire<select name="tz">${zoneChoices(p.sel).map((iana) => `<option${iana === p.sel ? " selected" : ""}>${esc(iana)}</option>`).join("")}
        <option value="__posix"${p.sel === "__posix" ? " selected" : ""}>Autre : chaîne POSIX…</option></select></label>
      <div class="two" data-posix${p.sel === "__posix" ? "" : " hidden"}>
        <label>Chaîne POSIX<input name="posix" class="mono" maxlength="64" value="${esc(p.posix)}" placeholder="IST-5:30" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
        <label>Nom (IANA, affiché)<input name="iana" class="mono" maxlength="64" value="${esc(p.name)}" placeholder="Asia/Kolkata" spellcheck="false" autocapitalize="off" autocomplete="off"></label></div>
      <p class="hint" data-tzhint></p>
      <p class="hint" data-sun></p>
      ${withSave ? '<div class="rowbtns"><button class="btn fill">Enregistrer</button></div>' : ""}
    </form>`;
  }
  function posRead(f) {
    const lat = parseDegrees(f.elements.lat.value), lon = parseDegrees(f.elements.lon.value);
    const sel = f.elements.tz.value, own = sel === "__posix";
    const posix = own ? f.elements.posix.value.trim() : posixOf(sel);
    const name = own ? f.elements.iana.value.trim() : sel;
    return { lat, lon, sel, own, posix, name,
      okLat: lat !== null && Math.abs(lat) <= 90, okLon: lon !== null && Math.abs(lon) <= 180,
      okTz: validPosix(posix), okName: validZoneName(name) };
  }
  /** The form's live hints: the zone kept, a zone typed by hand, and today's sunrise and sunset with these values. */
  function posHints(f) {
    const v = posRead(f), bad = (t) => `<span class="bad">${t}</span>`;
    f.querySelector("[data-posix]").hidden = !v.own;
    f.querySelector("[data-tzhint]").innerHTML = v.own
      ? (browserTz && !posixOf(browserTz) ? `Ce navigateur est sur <b>${esc(browserTz)}</b>, absent de la liste : choisissez un fuseau à la même heure, ou saisissez sa chaîne POSIX (la colonne « TZ » de la base des fuseaux). ` : "")
        + "Le nom ne sert qu'à l'affichage ; le contrôleur applique la chaîne POSIX. "
        + (v.posix && !v.okTz ? `${bad("Chaîne POSIX invalide.")} ` : "")
        + (v.name && !v.okName ? bad("Nom IANA invalide (Zone/Ville).") : "")
      : `${!text(E.timezone) && v.sel === browserTz ? "Préréglé d'après ce navigateur. " : ""}Le contrôleur garde les deux : <b>${esc(v.sel)}</b>, qu'il affiche, et la chaîne POSIX qu'il applique, <span class="mono">${esc(v.posix)}</span>.`;
    let sun = "Avec la latitude et la longitude, le contrôleur calcule le lever et le coucher du soleil, d'où il place la filtration.";
    if (v.okLat && v.okLon && v.okTz) {
      const t = sunTimes(v.lat, v.lon);
      sun = t.polar ? `Avec ces valeurs, aujourd'hui : ${t.polar} polaire. Vérifiez le signe de la latitude.`
        : `Avec ces valeurs, aujourd'hui : lever <b>${clockIn(t.rise, v.name, v.posix)}</b>, coucher <b>${clockIn(t.set, v.name, v.posix)}</b>. S'ils sont loin des vôtres, vérifiez les signes et le fuseau.`;
    }
    f.querySelector("[data-sun]").innerHTML = sun;
  }
  /**
   * Writes what changed: Latitude, Longitude, then Timezone and Timezone Name together. The firmware's
   * own parser has the last word on the POSIX string, so its echo is awaited. "same", "saved" or null.
   */
  async function savePosition(f) {
    const v = posRead(f);
    const fail = (msg) => (toast(msg, true), null);
    if (!v.okLat || !v.okLon) return fail("Latitude entre -90 et 90, longitude entre -180 et 180, en degrés décimaux.");
    if (!v.okTz) return fail("Fuseau horaire : chaîne POSIX invalide.");
    if (!v.okName) return fail("Nom du fuseau : Zone/Ville, comme Asia/Kolkata.");
    const changed = { lat: v.lat !== n(E.latitude), lon: v.lon !== n(E.longitude), tz: v.posix !== text(E.timezone), name: v.name !== text(E.timezoneName) };
    if (!Object.values(changed).some(Boolean)) return "same";
    try {
      if (changed.lat) await hass.setNumber(E.latitude, v.lat);
      if (changed.lon) await hass.setNumber(E.longitude, v.lon);
      if (changed.tz) await hass.setText(E.timezone, v.posix);
      if (changed.name) await hass.setText(E.timezoneName, v.name);
    } catch (e) {
      refused(e);
      return null;
    }
    if (changed.tz && !(await until(() => text(E.timezone) === v.posix, 3000))) {
      return fail("Le contrôleur a refusé ce fuseau : sa chaîne POSIX ne passe pas son analyse.");
    }
    if (!(await confirmed("position"))) return fail("Le contrôleur n'a pas confirmé la position.");
    return "saved";
  }

  /* ------------------------------------------------------------ probes */

  function probesHTML() {
    if (scanning()) return `<div class="scan"><span class="ic">${icon("magnify-scan")}</span>Recherche des sondes sur le bus 1-Wire…</div>`;
    const list = probes(), roleOf = (address) => ROLES.find((r) => roleAddress(r.key) === address);
    const rows = list.map(({ address }) => {
      const r = roleOf(address), a = esc(address);
      return `<div class="probe${r ? " has" : ""}"><span class="ic">${icon("thermometer")}</span>
        <span><span class="t num" data-ptemp="${a}"></span><span class="trend" data-ptrend="${a}"></span><small class="mono">${a}</small></span>
        <select data-probe="${a}" aria-label="Rôle de la sonde ${a}"><option value="">Non utilisée</option>
          ${ROLES.map((x) => `<option value="${x.key}"${r === x ? " selected" : ""}>${x.label}</option>`).join("")}</select></div>`;
    }).join("");
    return (list.length ? `<div class="probes">${rows}</div>`
      : '<p class="hint">Aucune sonde n\'a répondu sur le bus 1-Wire. Vérifiez le câblage, puis relancez la détection.</p>')
      + `<p class="hint">Pour les reconnaître, tenez-en une dans la main : en une minute elle prend plusieurs degrés. <b>Bassin</b> (sur le retour du filtre) est indispensable, le plan et le hors gel en dépendent ; les deux autres sont facultatives.</p>
      <div class="rowbtns">${lineBtn("rescan", "magnify", "Relancer la détection")}</div>`;
  }
  function recordReadings() {
    const textNow = s(E.detectedProbes) || "";
    if (textNow === probesSeen) return;
    probesSeen = textNow;
    for (const { address, celsius } of parseDetectedProbes(textNow)) {
      const r = readings.get(address) || [];
      r.push(celsius);
      if (r.length > READINGS_KEPT) r.shift();
      readings.set(address, r);
    }
  }
  /** Live readings, patched in place: an open role select is never rebuilt under the finger. */
  function patchProbes() {
    for (const { address, celsius } of probes()) {
      const reading = Number.isFinite(celsius) ? `${fmt1(celsius)} °C` : "pas de réponse";
      const trend = TREND[probeTrend(readings.get(address) || [])];
      document.querySelectorAll(`[data-ptemp="${CSS.escape(address)}"]`).forEach((el) => { if (el.textContent !== reading) el.textContent = reading; });
      document.querySelectorAll(`[data-ptrend="${CSS.escape(address)}"]`).forEach((el) => { if (el.textContent !== trend) el.textContent = trend; });
    }
  }
  /** One role per probe: the role that had this probe goes back to none, then the new one takes it. */
  async function setRole(address, roleKey) {
    const current = ROLES.find((r) => roleAddress(r.key) === address);
    const role = ROLES.find((r) => r.key === roleKey);
    const previous = role && roleAddress(role.key);
    try {
      if (current && current !== role) await hass.select(E[current.key], NO_PROBE);
      if (role) await hass.select(E[role.key], address);
    } catch (e) {
      refused(e);
      return;
    }
    if (role && previous && previous !== address) toast(`${role.label} : sonde ${shortAddress(address)} ; ${shortAddress(previous)} n'a plus de rôle`);
  }
  async function rescan() {
    view.scanUntil = Date.now() + 2500;
    render();
    try {
      await hass.press(E.rescanProbes);
    } catch (e) {
      view.scanUntil = 0;
      refused(e);
      return;
    }
    setTimeout(() => {
      const k = probes().length;
      toast(k ? `${k} sonde${k > 1 ? "s" : ""} trouvée${k > 1 ? "s" : ""}` : "Aucune sonde trouvée", !k);
      render();
    }, 2600);
  }

  /* ------------------------------------------------------------ the fill meter (fill-meter.yaml) */

  const hasFill = () => !!st(E.fillEnabled);
  const fillOn = () => s(E.fillEnabled) === "on";
  async function setFill(on) {
    try {
      await hass.callService("switch", on ? "turn_on" : "turn_off", { entity_id: E.fillEnabled });
    } catch (e) {
      refused(e);
      return false;
    }
    toast(on ? "Compteur d'eau activé" : "Compteur d'eau désactivé : rien n'est compté");
    return true;
  }
  async function fillTest() {
    try {
      await hass.press(E.fillDetect);
    } catch (e) {
      refused(e);
      return;
    }
    toast(`À l'écoute : ouvrez le robinet de remplissage (${FILL_DETECT.litres} L en ${FILL_DETECT.minutes} min)`);
  }
  /** The pulse test: Fill Meter Status as a tag, what to do, « Tester ». */
  function fillTestRow() {
    const f = fillStatus(s(E.fillStatus)) || { cls: "idle", tag: "?", sub: "" }, listening = s(E.fillStatus) === "listening";
    return `<div class="erow"><span class="ic">${icon("water-sync")}</span><span class="name"><span>Détecter le compteur${tag(f.tag, f.cls)}</span>
      <small>${esc(f.sub)}</small></span><button type="button" class="btn line" data-act="fill-test"${listening || !hass.connected ? " disabled" : ""}>${listening ? "À l'écoute…" : "Tester"}</button></div>`;
  }
  /** Réglages contrôleur › Compteur d'eau: on or off, then (on) the test and the last pulse. */
  function fillBody() {
    const on = fillOn();
    const seg = `<span class="ctl"><span class="seg" role="radiogroup" aria-label="Compteur d'eau sur le remplissage">
      <button type="button" role="radio" aria-checked="${!on}" data-act="fill-off">Non</button><button type="button" role="radio" aria-checked="${on}" data-act="fill-on">Oui</button></span></span>`;
    return `<div class="erow"><span class="ic">${icon(on ? "water-check" : "water-off")}</span><span class="name"><span>Compteur sur le remplissage</span>
      <small>${on ? "Il compte l'eau ajoutée (Contrôle › Remplissage) et alarme si un remplissage dure trop."
        : "Rien n'est compté : ni Remplissage, ni alarme. Pour une piscine sans compteur sur sa conduite de remplissage."}</small></span>${seg}</div>`
      + (on ? fillTestRow() + row("clock-outline", "Dernière impulsion", esc(lastPulseText(s(E.fillLastPulse))), "Le dernier litre compté") : "");
  }
  /** « Alarme après », apart: a status or a pulse repaints fillBody, never what is being typed here. */
  function fillAlarm() {
    if (!fillOn() || !st(E.fillAlarmAfter)) return "";
    const v = Math.round(n(E.fillAlarmAfter));
    return `<form data-form="fill-alarm" autocomplete="off"><div class="erow"><span class="ic">${icon("timer-alert-outline")}</span>
      <span class="name"><span>Alarme après</span><small>Un remplissage plus long déclenche l'alarme : ici, et Home Assistant prévient toutes les 15 min jusqu'à « Acquitter ». 0 = jamais.</small></span>
      <span class="ctl num-in"><input name="min" inputmode="numeric" value="${Number.isFinite(v) ? v : ""}" aria-label="Alarme après, en minutes"><span>min</span>
      <button class="btn">OK</button></span></div></form>`;
  }
  async function saveFillAlarm(form) {
    const v = parseAlarmMinutes(form.elements.min.value);
    if (v === null) {
      toast(`Alarme après : un nombre de minutes, de ${FILL_ALARM.min} à ${FILL_ALARM.max}`, true);
      return;
    }
    try {
      await hass.setNumber(E.fillAlarmAfter, v);
    } catch (e) {
      refused(e);
      return;
    }
    toast(v ? `Alarme après ${v} min de remplissage` : "Plus d'alarme de remplissage");
  }
  /** The wizard's step 4, after the probes: optional, it never blocks « Continuer ». */
  function fillWizard() {
    const on = fillOn(), status = s(E.fillStatus), f = fillStatus(status);
    const state = !on ? hero("idle", "water-off", "Pas de compteur d'eau", "Rien n'est compté. Pour en ajouter un : Réglages contrôleur › Compteur d'eau.")
      : status === "detected" ? hero("ok", "check", "Compteur détecté", "Il compte : Remplissage et son alarme sont en place.")
      : status === "listening" ? hero("idle", "water-sync", "À l'écoute…", esc(f.sub))
      : status === "not_detected" ? hero("idle", "water-alert", "Compteur pas détecté", esc(f.sub))
      : "";
    return `<h3 class="wz-sub">Compteur d'eau <small>facultatif</small></h3>
      <p class="hint">Un compteur à impulsions sur la conduite de remplissage (1 L par impulsion) : le contrôleur compte l'eau ajoutée, et alarme si un remplissage dure trop.</p>
      ${state}
      <div class="rowbtns">${lineBtn("fill-yes", "water-check", on && status === "detected" ? "Retester" : "J'ai un compteur", status === "listening" ? " disabled" : "")}
        ${on ? lineBtn("fill-no", "water-off", "Pas de compteur") : ""}</div>`;
  }

  /* ------------------------------------------------------------ the API key: Home Assistant sets it */

  const haSteps = () => `<ol class="do"><li>Dans Home Assistant : <b>Paramètres › Appareils et services</b>. Le contrôleur y apparaît tout seul, « Découvert » : ESPHome, Pool Controller (sinon : « Ajouter une intégration » › ESPHome › pool-controller.local).</li>
    <li><b>Ajouter</b>, puis valider. Home Assistant génère la clé et l'envoie au contrôleur : rien à copier, rien à garder.</li></ol>`;
  const haWait = () => `<div class="wz-wait">${hero("idle", "home-assistant", "En attente de Home Assistant", "Cette page se met à jour dès que la clé est définie.")}<div class="prog ind"><i></i></div></div>`;
  const openNote = '<p class="hint warnl">Tant qu\'aucune clé n\'est définie, n\'importe quel appareil du réseau peut parler au contrôleur : ajoutez-le maintenant.</p>';
  const noHaLink = () => `<button type="button" class="linkbtn" data-act="key-skip"${view.busy ? " disabled" : ""}>Je n'utilise pas Home Assistant</button>`;
  function keyUI(ctx) {
    if (view.paste !== ctx) return `<div class="rowbtns">${lineBtn("key-paste", "key-variant", "Coller une clé existante", ` data-ctx="${ctx}"`)}</div>`;
    return `<form class="form" data-form="key" autocomplete="off"><label>Clé de chiffrement (base64, 44 caractères)<input name="key" class="mono" maxlength="44" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="…="></label>
      <p class="hint">Pour un contrôleur que Home Assistant connaît déjà (migration : la valeur api_encryption_key de l'ancien secrets.yaml) : il se reconnecte avec elle, sans rien changer. D'ici là, ne confirmez pas « chiffrement retiré » dans Home Assistant.</p>
      <div class="rowbtns"><button class="btn fill"${view.busy ? " disabled" : ""}>Enregistrer sur le contrôleur</button><button type="button" class="btn" data-act="key-cancel">Annuler</button></div></form>`;
  }
  /** The firmware validates a key, saves it, then refreshes Setup State: its `api_key` going says it took it. */
  async function keyChange(write, wanted, failure) {
    view.busy = true;
    render();
    try {
      await write();
      const ok = await until(() => isMissing("api_key") === !wanted, CONFIRM_MS);
      if (!ok) toast(failure, true);
      return ok;
    } catch (e) {
      refused(e);
      return false;
    } finally {
      view.busy = false;
      render();
    }
  }
  async function saveKey(form) {
    const key = form.elements.key.value.trim();
    if (!validApiKey(key)) return toast("Clé invalide : 32 octets en base64, soit 44 caractères finissant par « = ».", true);
    form.reset(); // sent once, never shown again
    if (!(await keyChange(() => hass.setText(E.apiKey, key), true, "Le contrôleur a refusé cette clé."))) return;
    keyOrigin = "paste";
    view.paste = null;
    if (!wz.open) toast("Clé enregistrée : Home Assistant se reconnecte avec elle.");
  }
  /** « Je n'utilise pas Home Assistant »: the controller draws a random key nobody sees, so its API is closed. */
  async function withoutHomeAssistant() {
    if (!(await keyChange(() => hass.press(E.generateKey), true, "Le contrôleur n'a pas pu se donner de clé."))) return false;
    keyOrigin = "generated";
    view.paste = null;
    if (!wz.open) toast("Sans Home Assistant : clé aléatoire définie");
    return true;
  }
  /** « Ajouter à Home Assistant »: the controller forgets its key, and Home Assistant sets one when it adds it. */
  async function forgetKey() {
    view.forget = false;
    if (!(await keyChange(() => hass.press(E.forgetKey), false, "Le contrôleur n'a pas oublié sa clé."))) return;
    keyOrigin = null;
    toast("Clé oubliée : ajoutez le contrôleur dans Home Assistant");
  }

  /* ------------------------------------------------------------ Réglages contrôleur tab sections */

  function accBody() {
    const pageSet = !isMissing("page_password");
    const line = (kind, ic, label, value, cls, sub) => `<div class="erow"><span class="ic">${icon(ic)}</span>
        <span class="name"><span>${label} ${tag(value, cls)}</span><small>${sub}</small></span>
        <button type="button" class="btn line" data-act="acc-${kind}"${view.acc === kind ? " disabled" : ""}>Changer</button></div>`
      + (view.acc === kind ? `<div class="inl">${pwForm(kind, false)}</div>` : "");
    return line("page", "lock", "Mot de passe de la page", pageSet ? "défini" : "non défini", pageSet ? "" : "bad",
      "Identifiant <b>admin</b>, fixe. Le navigateur le demande pour ouvrir cette page ; il protège aussi le point d'accès, qui reste ouvert.")
      + line("ota", "upload-lock", "Mot de passe OTA", "défini", "",
        "Pour envoyer un firmware depuis un ordinateur (make ota). Tiré au hasard au premier démarrage tant que vous n'en choisissez pas ; les mises à jour de cette page et de Home Assistant n'en ont pas besoin.")
      + '<p class="hint">Écrits seulement : le contrôleur ne les montre jamais, il dit seulement s\'ils sont définis.</p>';
  }
  function haBody() {
    if (isMissing("api_key")) {
      return row("key-variant", "Clé de chiffrement (API)", "non définie", "Home Assistant la définit quand il ajoute le contrôleur.", "bad")
        + row("home-assistant", "Home Assistant", "en attente", "Ajoutez le contrôleur dans Home Assistant : il définit la clé lui-même.", "warn")
        + haSteps() + haWait() + openNote
        + `<div class="${view.paste === "ctl" ? "inl" : "keyslot"}">${keyUI("ctl")}</div>${noHaLink()}`;
    }
    const by = keyOrigin === "paste" ? "Collée sur cette page (migration). Jamais réaffichée."
      : keyOrigin === "generated" ? "Aléatoire, tirée par le contrôleur : personne ne la connaît, personne n'en a besoin."
      : linked() ? "Par Home Assistant, quand il a ajouté le contrôleur. Affichée nulle part, ni ici ni dans Home Assistant."
      : "Le contrôleur ne la montre jamais, ni ici ni ailleurs.";
    const [state, cls, sub] = linked() ? ["connecté", "", "Il échange avec le contrôleur, chiffré par cette clé."]
      : keyOrigin === "generated" ? ["non utilisé", "", "Le contrôleur fonctionne seul : plan, hors gel et mises à jour."]
      : ["non connecté", "warn", "Sans Home Assistant, c'est normal : le contrôleur fonctionne seul. Pour l'y ajouter, il doit d'abord oublier sa clé."];
    let html = row("key-variant", "Clé de chiffrement (API)", "définie", by) + row("home-assistant", "Home Assistant", state, sub, cls);
    if (!linked()) {
      html += view.forget
        ? `<div class="inl"><p class="hint">Le contrôleur oublie sa clé et attend Home Assistant, qui en définira une en l'ajoutant (Paramètres › Appareils et services). D'ici là, n'importe quel appareil du réseau peut lui parler : faites-le dans la foulée.</p>
          <div class="rowbtns"><button type="button" class="btn" data-act="ha-forget-no">Annuler</button><button type="button" class="btn fill" data-act="ha-forget-yes"${view.busy ? " disabled" : ""}>Oublier la clé</button></div></div>`
        : `<div class="rowbtns">${lineBtn("ha-forget", "home-assistant", "Ajouter à Home Assistant")}</div>`;
    }
    return html;
  }
  function resetBody() {
    const fw = text(E.fwVersion);
    return `<div class="erow"><span class="ic">${icon("restore")}</span><span class="name"><span>Réinitialiser le contrôleur</span>
      <small>Efface les accès, le Wi-Fi et la clé ; garde les sondes, la position et le fuseau, donc le plan et le hors gel.</small></span>
      ${view.reset ? "" : '<button type="button" class="btn line danger" data-act="reset-ask">Réinitialiser…</button>'}</div>`
      + (view.reset ? `<div class="dangerbox" role="alertdialog" aria-label="Confirmer la réinitialisation"><b>Effacer les accès et redémarrer ?</b>
        <p>Seront effacés :</p><ul><li>les mots de passe de la page et OTA ;</li><li>le réseau Wi-Fi enregistré ;</li><li>la clé de chiffrement : Home Assistant perd la liaison.</li></ul>
        <p>Restent :</p><ul><li>le rôle des sondes, la position et le fuseau : le plan de filtration et le hors gel continuent ;</li><li>les réglages (filtration, hors gel, compteur d'eau, mises à jour) et l'historique gardé ici (7 derniers jours, remplissage) ;</li><li>le firmware${fw ? ` (${esc(fw)})` : ""}.</li></ul>
        <p>Le contrôleur redémarre sur son point d'accès « ${AP_SSID} », ouvert : connectez-y un téléphone et ouvrez http://192.168.4.1. L'installation ne redemande que ce qui est effacé : un mot de passe, le Wi-Fi, puis Home Assistant.</p>
        <div class="rowbtns"><button type="button" class="btn" data-act="reset-no">Annuler</button><button type="button" class="btn fill danger" data-act="reset-yes">Effacer et redémarrer</button></div></div>` : "");
  }
  async function factoryReset() {
    view.reset = false;
    try {
      await hass.press(E.factoryReset);
    } catch (e) {
      refused(e);
      return;
    }
    wz.resetPending = true; // the wizard opens once Setup State says what was wiped (if this page still reaches it)
    keyOrigin = null;
    toast("Réinitialisation : le contrôleur efface ses accès et redémarre…");
  }
  function renderSections() {
    const sections = [["posStack", E.latitude], ["probeStack", E.detectedProbes], ["fillStack", E.fillEnabled], ["accStack", E.pagePassword], ["haStack", E.apiKey], ["resetStack", E.factoryReset]];
    for (const [id, entity] of sections) $(id).hidden = !st(entity);
    if (st(E.latitude)) paint($("posBody"), `${posForm(true)}<p class="posnote">Ou depuis Home Assistant : carte Piscine › Réglages contrôleur › Position.</p>`);
    if (st(E.detectedProbes)) paint($("probeBody"), probesHTML());
    if (hasFill()) { paint($("fillBody"), fillBody()); paint($("fillAlarm"), fillAlarm()); }
    if (st(E.pagePassword)) paint($("accBody"), accBody());
    if (st(E.apiKey)) paint($("haBody"), haBody());
    if (st(E.factoryReset)) paint($("resetBody"), resetBody());
  }

  /* ------------------------------------------------------------ the wizard */

  function openWizard(m) {
    Object.assign(wz, { open: true, step: nextStep(m), joinedFromHotspot: false,
      afterReset: m.includes("page_password") && !m.includes("position") && !m.includes("probes") });
    view.paste = null;
    scrollTo({ top: 0 });
  }
  function go(step) {
    if (wz.step === 5 && step !== 5) view.paste = null; // a pasted key never outlives its step
    wz.step = step;
    render();
    scrollTo({ top: 0 });
  }
  /** Joined the home network from the hotspot: the hotspot stops, so this page can't follow the controller. */
  const reconnecting = () => wz.joinedFromHotspot && (s(E.wifiMode) === "Connected" || !hass.connected);
  function placeJoin() {
    const here = wz.open && wz.step === 2 && !reconnecting() && s(E.wifiMode) !== "Connected";
    const target = here ? $("wzWifi") : joinHome;
    if ($("joinForm").parentNode !== target) target.append($("nets"), $("joinForm"));
    $("wzWifi").hidden = !here;
  }
  function stepBody(step, m) {
    if (step === 1) {
      return (wz.afterReset
        ? `<p class="wz-intro">Ce contrôleur a été réinitialisé. Il a gardé le rôle de ses sondes, sa position et son fuseau : le plan de filtration et le hors gel continuent. Il lui faut de nouveau ${andList(m.map((k) => NEED[k]))}.</p>`
        : "<p class=\"wz-intro\">Ce contrôleur sort d'usine : rien n'y est encore réglé. Cinq étapes, quelques minutes, et tout reste sur le contrôleur.</p>")
        + `<p class="hint">Son point d'accès « ${AP_SSID} » est ouvert, sans mot de passe Wi-Fi : c'est le mot de passe de cette page qui protège le contrôleur. Choisissez-le d'abord ; tant qu'il n'y en a pas, quiconque se connecte au point d'accès peut ouvrir cette page.</p>
        ${pwForm("page", true)}
        <p class="hint">8 caractères au moins. Identifiant : <b>admin</b>, toujours le même ; seul le mot de passe se choisit. Le navigateur le demandera, le contrôleur ne le réaffichera jamais : gardez-le dans votre gestionnaire de mots de passe.</p>
        ${m.includes("page_password") ? "" : '<p class="hint okl">Mot de passe défini. Laissez vide pour le garder.</p>'}`;
    }
    if (step === 2) {
      const mode = s(E.wifiMode), ssid = esc(text(E.wifiSsid));
      if (reconnecting()) {
        const next = nextStep(m.filter((k) => k !== "wifi"));
        return (mode === "Connected"
          ? hero("ok", "check", `Connecté à « ${ssid} »`, "Le contrôleur a coupé son point d'accès : cette page ne le joint plus ici.")
          : hero("idle", "wifi-sync", `Connexion à « ${esc(text(E.joinSsid))} »…`, "Une fois connecté, le contrôleur coupe son point d'accès : cette page ne le joint plus ici."))
          + `<ol class="do"><li>Reconnectez ce téléphone au Wi-Fi « ${ssid || esc(text(E.joinSsid))} ».</li><li>Ouvrez <b>${HOME_URL}</b>${text(E.ip) ? ` (ou http://${esc(text(E.ip))})` : ""}.</li>
            <li>Le navigateur demande le mot de passe de l'étape 1 (identifiant admin). La page lit Setup State et reprend à la première étape qui manque : ${next <= 5 ? `<b>${next} · ${STEPS[next - 1]}</b>` : "aucune"}.</li></ol>`;
      }
      if (mode === "Connected") {
        return hero("ok", bars(n(E.wifiSignal)), `Connecté à « ${ssid} »`, `Signal ${n(E.wifiSignal)} dBm · ${esc(text(E.ip))}`)
          + '<p class="hint">Pour changer de réseau plus tard : Réglages contrôleur › Wi-Fi.</p>';
      }
      return (mode === "Connecting"
        ? hero("idle", "wifi-sync", `Connexion à « ${esc(text(E.joinSsid))} »…`, "Jusqu'à 30 s ; s'il échoue, le point d'accès reste.")
        : hero("idle", "access-point", `Point d'accès « ${AP_SSID} »`, "Ce téléphone est connecté au contrôleur lui-même. Point d'accès ouvert : cette page, elle, a son mot de passe."))
        + "<p class=\"wz-intro\">Choisissez le réseau de la maison : le contrôleur s'y connecte, puis coupe son point d'accès. Il lui en faut un : l'heure lui vient d'Internet, et Home Assistant passe par là.</p>"
        + '<p class="hint">Cette page perd alors la liaison ; rouverte sur le réseau de la maison, elle reprend où elle en était (Setup State garde <span class="mono">wifi</span> jusque-là).</p>';
    }
    if (step === 3) {
      return "<p class=\"wz-intro\">Le contrôleur place la filtration d'après le lever du soleil et la chaleur de l'après-midi : il lui faut la position de la piscine et l'heure locale.</p>" + posForm(false);
    }
    if (step === 4) {
      const k = probes().length;
      return (k ? `<p class="wz-intro">${k} sonde${k > 1 ? "s" : ""} trouvée${k > 1 ? "s" : ""} sur le bus. Donnez un rôle à chacune :</p>` : "") + probesHTML()
        + (hasFill() ? fillWizard() : "");
    }
    if (step === 5) {
      const intro = "<p class=\"wz-intro\">Home Assistant parle au contrôleur en chiffré. La clé, c'est lui qui la crée : ajoutez-y le contrôleur, il la génère et la lui envoie.</p>";
      if (m.includes("api_key")) {
        return intro + haSteps()
          + (s(E.wifiMode) && s(E.wifiMode) !== "Connected" ? '<p class="hint warnl">Le contrôleur n\'est pas encore sur le réseau de la maison (étape 2) : Home Assistant ne peut pas le joindre.</p>' : "")
          + (wz.afterReset ? "<p class=\"hint\">Home Assistant connaissait ce contrôleur avec l'ancienne clé : il signale « chiffrement retiré » sur l'appareil. Confirmez : il en définit une nouvelle de lui-même.</p>" : "")
          + haWait() + openNote
          + `<p class="hint">Sinon :</p><div class="keyslot">${keyUI("wz")}</div>${noHaLink()}`;
      }
      return intro + (keyOrigin === "paste" ? hero("ok", "check", "Clé définie", "Collée depuis l'ancien secrets.yaml : Home Assistant se reconnecte avec elle.")
        : keyOrigin === "generated" ? hero("ok", "check", "Sans Home Assistant", "Le contrôleur s'est donné une clé aléatoire, que personne ne voit. Pour l'ajouter plus tard : Réglages contrôleur › Home Assistant.")
        : linked() ? hero("ok", "check", "Clé définie par Home Assistant", "Il est connecté, chiffré. La clé n'est affichée nulle part.")
        : hero("ok", "check", "Clé définie", "Le contrôleur a sa clé. Home Assistant n'est pas connecté pour l'instant : Réglages contrôleur › Home Assistant."));
    }
    return doneBody();
  }
  function doneBody() {
    const w = text(E.waitingFor), real = (a, b) => text(a) && text(a) !== "--:--" && text(a) !== text(b);
    const plan = w && w !== "--" ? `Le plan du jour attend ${WAITING_FOR[w] || esc(w)}.`
      : real(E.b1s, E.b1e) ? `Le plan du jour est calculé : ${fmt1(n(E.hoursPlanned))} h, ${text(E.b1s)}–${text(E.b1e)}${real(E.b2s, E.b2e) ? ` et ${text(E.b2s)}–${text(E.b2e)}` : ""}.`
      : "Le plan du jour est calculé.";
    const role = (r) => (roleAddress(r.key) ? `${r.label} ${shortAddress(roleAddress(r.key))}` : `${r.label} aucune`);
    const zone = text(E.timezoneName) || "chaîne POSIX saisie";
    return hero("ok", "check", "Setup State : configured", plan) + "<div>"
      + row("lock", "Mot de passe de la page", "défini", "Identifiant admin")
      + row(bars(n(E.wifiSignal)), "Wi-Fi", esc(text(E.wifiSsid) || "—"), `${HOME_URL}${text(E.ip) ? ` · ${esc(text(E.ip))}` : ""}`)
      + row("map-marker-outline", "Position", `${deg(n(E.latitude))} · ${deg(n(E.longitude))}`, `${esc(zone)} · <span class="mono">${esc(text(E.timezone))}</span>`)
      + row("thermometer", "Sondes", role(ROLES[0]), ROLES.slice(1).map(role).join(" · "))
      + row("home-assistant", "Home Assistant", linked() ? "connecté" : keyOrigin === "generated" ? "non utilisé" : "clé définie",
        linked() ? "Connecté, chiffré." : keyOrigin === "generated" ? "Clé aléatoire ; Réglages contrôleur › Home Assistant pour l'ajouter." : "Réglages contrôleur › Home Assistant.")
      + "</div>";
  }
  function stepNav(step, m) {
    if (step === 6) return '<span class="sp"></span><button type="button" class="btn fill" data-act="wz-finish">Ouvrir la page</button>';
    const blocked = view.busy || !hass.connected
      || (step === 2 && m.includes("wifi")) || (step === 4 && (!roleAddress("poolProbe") || scanning())) || (step === 5 && m.includes("api_key"));
    const last = !m.some((item) => item !== SETUP_ITEMS[step - 1]);
    return `${step > 1 ? '<button type="button" class="btn line" data-act="wz-back">Retour</button>' : ""}<span class="sp"></span>
      <button type="button" class="btn fill" data-act="wz-next"${blocked ? " disabled" : ""}>${last ? "Terminer" : "Continuer"}</button>
      <button type="button" class="linkbtn later" data-act="wz-later">Finir plus tard</button>`;
  }
  function renderWizard() {
    document.body.classList.toggle("setup", wz.open);
    $("wizard").hidden = !wz.open;
    placeJoin();
    if (!wz.open) return;
    const m = missing() || [], step = wz.step, left = m.length;
    paint($("wzSteps"), STEPS.map((label, i) => {
      const k = i + 1, cls = k === step ? "cur" : !m.includes(SETUP_ITEMS[i]) ? "done" : "";
      return `<li class="${cls}"><button type="button" class="n" ${cls === "done" ? `data-act="wz-goto" data-step="${k}"` : 'tabindex="-1"'}
        aria-label="Étape ${k} : ${label}${cls === "done" ? ", faite" : ""}"${k === step ? ' aria-current="step"' : ""}>${cls === "done" ? icon("check") : k}</button><span>${label}</span></li>`;
    }).join(""));
    paint($("wzState"), `Setup State : <span class="mono">${esc(s(E.setupState) || "…")}</span>`);
    $("wzTitle").textContent = step <= 5 ? `${step} · ${TITLES[step - 1]}` : "Contrôleur configuré";
    const what = wz.afterReset ? "Après réinitialisation" : "Première installation";
    $("wzSub").textContent = step <= 5
      ? `${what} · étape ${step} sur 5${left ? ` · ${left > 1 ? `${left} à faire` : m[0] === SETUP_ITEMS[step - 1] ? "plus que celle-ci" : "1 à faire"}` : ""}`
      : `${wz.afterReset ? "Réinstallation" : "Première installation"} terminée`;
    const chip = $("wzChip");
    chip.className = `chip ${!hass.connected ? "bad" : step <= 5 ? "" : "ok"}`;
    chip.textContent = !hass.connected ? "Connexion perdue…" : step <= 5 ? "Non configuré" : "Configuré";
    paint($("wzBody"), stepBody(step, m));
    paint($("wzNav"), stepNav(step, m));
  }
  async function wzNext() {
    if (view.busy) return;
    const step = wz.step, form = $("wzBody").querySelector("form");
    view.busy = true;
    render();
    try {
      if (step === 1) {
        if (form.elements.pw.value || form.elements.pw2.value) {
          if (!(await savePassword(form))) return;
        } else if (isMissing("page_password")) {
          toast("Choisissez un mot de passe pour cette page.", true);
          form.elements.pw.focus();
          return;
        }
      }
      if (step === 2 && isMissing("wifi")) return;
      if (step === 3 && !(await savePosition(form))) return;
      if (step === 4 && !roleAddress("poolProbe")) return toast("Indiquez au moins la sonde du bassin.", true);
      if (step === 4 && !(await confirmed("probes"))) return toast("Le contrôleur n'a pas confirmé la sonde du bassin.", true);
      if (step === 5 && isMissing("api_key")) return;
      wz.step = nextStep(missing() || [], step);
      scrollTo({ top: 0 });
    } finally {
      view.busy = false;
      render();
    }
  }
  /** Not configured, and the wizard closed (put off, or a key forgotten since): say so above the page. */
  function renderBanner() {
    const m = missing();
    paint($("setupAlerts"), !wz.open && m?.length
      ? `<div class="banner info">${icon("clipboard-check-outline")}<span>Le contrôleur n'est pas encore configuré : il lui faut ${andList(m.map((k) => NEED[k]))}.</span>
        <button type="button" class="btn" data-act="wz-resume">Reprendre</button></div>`
      : "");
  }

  /* ------------------------------------------------------------ events */

  async function onClick(ev) {
    const b = ev.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const inWizard = !!b.closest("#wizard"); // now: an await below may repaint the button away
    switch (b.dataset.act) {
      case "wz-next": return wzNext();
      case "wz-back": return go(wz.step - 1);
      case "wz-goto": return go(Number(b.dataset.step));
      case "wz-later":
        wz.open = false;
        break;
      case "wz-resume":
        openWizard(missing() || []);
        break;
      case "wz-finish":
        wz.open = false;
        location.hash = "#controle";
        toast("Contrôleur configuré");
        break;
      case "eye": {
        const input = b.parentNode.querySelector("input"), show = input.type === "password";
        input.type = show ? "text" : "password";
        b.innerHTML = icon(show ? "eye-off" : "eye");
        b.title = show ? "Masquer" : "Afficher";
        return;
      }
      case "acc-page": case "acc-ota": view.acc = b.dataset.act.slice(4); break;
      case "acc-cancel": view.acc = null; break;
      case "key-paste": view.paste = b.dataset.ctx; break;
      case "key-cancel": view.paste = null; break;
      case "key-skip":
        if (await withoutHomeAssistant() && inWizard) {
          wz.step = nextStep(missing() || [], 5);
          scrollTo({ top: 0 });
        }
        break;
      case "ha-forget": view.forget = true; break;
      case "ha-forget-no": view.forget = false; break;
      case "ha-forget-yes": await forgetKey(); break;
      case "rescan": return rescan();
      case "fill-on": if (!fillOn()) await setFill(true); break;
      case "fill-off": if (s(E.fillEnabled) !== "off") await setFill(false); break;
      case "fill-test": await fillTest(); break;
      case "fill-yes": // the wizard: « J'ai un compteur » turns it on if needed, then tests it
        if (fillOn() || await setFill(true)) await fillTest();
        break;
      case "fill-no": await setFill(false); break;
      case "reset-ask": view.reset = true; break;
      case "reset-no": view.reset = false; break;
      case "reset-yes": await factoryReset(); break;
      default: return;
    }
    render();
  }
  async function onSubmit(ev) {
    const form = ev.target.closest("form[data-form]");
    if (!form) return;
    ev.preventDefault();
    const kind = form.dataset.form;
    if (form.closest("#wizard") && kind !== "key") return wzNext();
    if (kind === "fill-alarm") {
      await saveFillAlarm(form);
      return render();
    }
    if (kind === "pw") {
      const page = form.dataset.kind === "page";
      if (await savePassword(form)) toast(page ? "Mot de passe de la page changé : le navigateur va le redemander." : "Mot de passe OTA changé.");
    } else if (kind === "pos") {
      const result = await savePosition(form);
      if (result) toast(result === "same" ? "Rien n'a changé" : "Position enregistrée : plan du jour recalculé");
    } else if (kind === "key") {
      await saveKey(form);
    }
    render();
  }
  async function onChange(ev) {
    const sel = ev.target.closest?.("select[data-probe]");
    if (!sel) return;
    await setRole(sel.dataset.probe, sel.value);
    render();
  }
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("change", onChange);
  document.addEventListener("input", (ev) => {
    const form = ev.target.closest?.('form[data-form="pos"]');
    if (form) posHints(form);
  });

  /* ------------------------------------------------------------ every change */

  function render() {
    renderWizard();
    renderSections();
    renderBanner();
    patchProbes();
  }
  return function update() {
    if (!st(E.setupState)) return; // a firmware from before the settings: nothing to set up here
    const m = missing();
    const mode = s(E.wifiMode);
    if (lastMode === "Hotspot" && mode === "Connecting") wz.joinedFromHotspot = true;
    if (lastMode === "Connecting" && mode === "Hotspot") wz.joinedFromHotspot = false; // the join failed
    lastMode = mode;
    if (m && !wz.seen) {
      wz.seen = true;
      if (m.length) openWizard(m);
    }
    if (m && wz.resetPending && m.includes("page_password")) {
      wz.resetPending = false;
      openWizard(m);
    }
    recordReadings();
    render();
  };
}
