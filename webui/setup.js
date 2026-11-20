/*
 * Setting the controller up from its own page (docs/plans/secret-free-firmware.md, WP3): what used to
 * be compiled in from secrets.yaml lives on the controller now (device-settings.yaml).
 *
 *   - The setup wizard takes the page's place while Setup State isn't `configured`: page password →
 *     Wi-Fi → position and time zone → probes → Home Assistant, one step per missing item, opened at
 *     the first one. A step is done when Setup State no longer lists its item, so a page reopened
 *     after joining the home network, or after a factory reset, resumes where it should.
 *   - The Réglages contrôleur tab gains Position and Sondes (the same forms), Compteur d'eau, and Accès (the passwords,
 *     logging out this browser or every one), Home Assistant and Réinitialiser.
 *   - A new Page Password ends every login session (docs/plans/page-login.md), this page's too: the page logs in
 *     again with it at once (login.js), in the wizard as in Accès.
 *   - The fill meter (fill-meter.yaml) is optional, so not a Setup State item: the wizard's step 4 asks about it
 *     (« J'ai un compteur » runs its pulse test, « Pas de compteur » turns it off) without ever blocking a step, and
 *     Réglages contrôleur › Compteur d'eau has the switch, the test, the last pulse and « Alarme après ».
 *
 * Every text is the page's language (page-i18n.js, keys setup.*): the HTML is rebuilt from t() at each render, and
 * paint() redraws what changed, so a change of language redraws in place and the wizard stays on its step.
 *
 * Secrets are write-only (CVE-2026-71260 leaks password-mode text values): a password or a key is
 * sent once, its form cleared, and the page never reads one back; whether each is set comes from
 * Setup State. app.js mounts this with its own helpers and calls the returned update on every change.
 */
import {
  SETUP_ITEMS, parseSetupState, nextStep, parseDetectedProbes, shortAddress, probeTrend,
  passwordProblem, validApiKey, parseDegrees, degreesInput, WAITING_FOR, sunTimes,
  FILL_DETECT, FILL_ALARM, fillStatus, parseAlarmMinutes, lastPulse,
} from "./setup-model.js";
import { TIMEZONES, posixOf, validPosix, validZoneName, browserZone, clockIn } from "./timezones.js";
import { t, fmt, andList, onLang } from "./page-i18n.js";

/** The steps, in Setup State's order (SETUP_ITEMS): their short name (the step list) and title, setup.step.<item>. */
const stepName = (i) => t(`setup.step.${SETUP_ITEMS[i]}.name`);
const stepTitle = (i) => t(`setup.step.${SETUP_ITEMS[i]}.title`);
/** What the controller still needs, per Setup State item (« il lui faut … »): setup.need.<item>. */
const need = (item) => t(`setup.need.${item}`);
/** The probe roles: their select (E key) and name (the card's words). Bassin is the one the plan and freeze protection need. */
const ROLES = [
  { key: "poolProbe", label: "card.read.pool" },
  { key: "padProbe", label: "card.row.pad.label" },
  { key: "outdoorProbe", label: "card.read.outdoor" },
];
const NO_PROBE = "none";
const AP_SSID = "pool-controller";
const HOME_URL = "http://pool-controller.local";
/** How long a write may take to show in Setup State: the firmware republishes it right after each one. */
const CONFIRM_MS = 3000;
/** Detected Probes readings kept per probe, for its trend (every minute on the device). */
const READINGS_KEPT = 12;
const trendText = (trend) => (trend ? t(`setup.probes.trend_${trend}`) : "");

export function mountSetup({ hass, E, login, ui }) {
  const { icon, esc, toast, fmt1, bars } = ui;
  const $ = (id) => document.getElementById(id);
  const st = (id) => hass.states[id];
  const s = (id) => st(id)?.state;
  const n = (id) => parseFloat(s(id));
  /** A text entity's value, "" while unknown. */
  const text = (id) => (["unknown", "unavailable", undefined].includes(s(id)) ? "" : s(id));
  const refused = (e) => toast(t("page.refused", { error: e.message }), true);

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
  /** Whether the page's language writes decimals with a comma (« 43,30 »): how the position's fields show. */
  const comma = () => fmt().number(1.5).includes(",");
  const deg = (v) => (Number.isFinite(v) ? `${fmt().number(v, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}°` : "—");
  /** The controller's « HH:MM » in the page's time format. */
  const hm = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    if (!m) return v;
    const d = new Date();
    d.setHours(+m[1], +m[2], 0, 0);
    return fmt().time(d);
  };
  /** Resolves true once `pred` holds, false after `ms`. */
  const until = (pred, ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    const poll = () => (pred() ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(poll, 200));
    poll();
  });
  /** Whether Setup State dropped `item` after a write: the device's own word that it took it. */
  const confirmed = (item) => until(() => !isMissing(item), CONFIRM_MS);

  /* ------------------------------------------------------------ HTML pieces */

  /** Set while a change of language redraws: what's typed in the forms is put back (paint). */
  let relabel = false;
  /** Sets a host's HTML only when it changed, so forms keep what's typed and selects stay open. */
  function paint(host, html) {
    if (host._html === html) return false;
    const typed = relabel ? [...host.querySelectorAll("form [name]")].map((el) => [el.form?.dataset.form, el.name, el.value]) : [];
    host.innerHTML = html;
    host._html = html;
    for (const [form, name, value] of typed) {
      const el = host.querySelector(`form[data-form="${form}"] [name="${name}"]`);
      if (el && el.value !== value) el.value = value;
    }
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
    <label>${t(inWizard ? "page.pw.label" : "setup.pw.new")}<span class="pw"><input name="pw" type="password" maxlength="64" autocomplete="new-password">
      <button type="button" class="btn" data-act="eye" title="${t("page.pw.show")}" aria-label="${t("page.pw.show_aria")}">${icon("eye")}</button></span></label>
    <label>${t("setup.pw.confirm")}<input name="pw2" type="password" maxlength="64" autocomplete="new-password"></label>
    ${inWizard ? "" : `<p class="hint">${t("setup.pw.min")}${kind === "page" ? ` ${t("setup.pw.others_relog")}` : ""}</p>
      <div class="rowbtns"><button class="btn fill">${t("setup.save")}</button><button type="button" class="btn" data-act="acc-cancel">${t("common.cancel")}</button></div>`}
  </form>`;

  /** Sends the password once and clears the form; true when the controller took it. */
  async function savePassword(form) {
    const pw = form.elements.pw.value, problem = passwordProblem(pw, form.elements.pw2.value);
    if (problem) {
      toast(t(`setup.pw.${problem}`), true);
      form.elements[pw.length < 8 || pw.length > 64 ? "pw" : "pw2"].focus();
      return false;
    }
    const kind = form.dataset.kind;
    form.reset(); // sent once, never kept nor shown again
    try {
      // A new Page Password ends every session, this page's too: it logs in again with it, so nothing asks for it.
      // Should that fail, the login screen says why.
      if (kind === "page" && !(await login.changePassword(() => hass.setText(E.pagePassword, pw), pw))) return false;
      if (kind === "ota") await hass.setText(E.otaPassword, pw);
    } catch (e) {
      refused(e);
      return false;
    }
    if (kind === "page" && !(await confirmed("page_password"))) {
      toast(t("setup.pw.not_confirmed"), true);
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
    const p = tzPick(), c = comma();
    return `<form class="form" data-form="pos" autocomplete="off">
      <div class="two"><label>${t("setup.pos.lat")}<input name="lat" inputmode="decimal" value="${degreesInput(n(E.latitude), c)}" placeholder="${c ? "48,85" : "48.85"}" autocomplete="off"></label>
        <label>${t("setup.pos.lon")}<input name="lon" inputmode="decimal" value="${degreesInput(n(E.longitude), c)}" placeholder="${c ? "2,35" : "2.35"}" autocomplete="off"></label></div>
      <p class="hint">${t("setup.pos.rounded")}</p>
      <label>${t("card.pos.tz")}<select name="tz">${zoneChoices(p.sel).map((iana) => `<option${iana === p.sel ? " selected" : ""}>${esc(iana)}</option>`).join("")}
        <option value="__posix"${p.sel === "__posix" ? " selected" : ""}>${t("setup.pos.other_posix")}</option></select></label>
      <div class="two" data-posix${p.sel === "__posix" ? "" : " hidden"}>
        <label>${t("setup.pos.posix")}<input name="posix" class="mono" maxlength="64" value="${esc(p.posix)}" placeholder="IST-5:30" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
        <label>${t("setup.pos.iana")}<input name="iana" class="mono" maxlength="64" value="${esc(p.name)}" placeholder="Asia/Kolkata" spellcheck="false" autocapitalize="off" autocomplete="off"></label></div>
      <p class="hint" data-tzhint></p>
      <p class="hint" data-sun></p>
      ${withSave ? `<div class="rowbtns"><button class="btn fill">${t("setup.save")}</button></div>` : ""}
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
    const v = posRead(f), bad = (txt) => `<span class="bad">${txt}</span>`;
    f.querySelector("[data-posix]").hidden = !v.own;
    f.querySelector("[data-tzhint]").innerHTML = v.own
      ? (browserTz && !posixOf(browserTz) ? `${t("setup.pos.browser_unlisted", { zone: `<b>${esc(browserTz)}</b>` })} ` : "")
        + `${t("setup.pos.name_display")} `
        + (v.posix && !v.okTz ? `${bad(t("setup.pos.posix_invalid"))} ` : "")
        + (v.name && !v.okName ? bad(t("setup.pos.iana_invalid")) : "")
      : `${!text(E.timezone) && v.sel === browserTz ? `${t("setup.pos.preset")} ` : ""}${t("setup.pos.keeps_both", { zone: `<b>${esc(v.sel)}</b>`, posix: `<span class="mono">${esc(v.posix)}</span>` })}`;
    let sun = t("setup.pos.sun_intro");
    if (v.okLat && v.okLon && v.okTz) {
      const sunT = sunTimes(v.lat, v.lon), loc = fmt().locale;
      sun = sunT.polar ? t(`setup.pos.polar_${sunT.polar}`)
        : t("setup.pos.sun", { rise: `<b>${clockIn(sunT.rise, v.name, v.posix, loc)}</b>`, set: `<b>${clockIn(sunT.set, v.name, v.posix, loc)}</b>` });
    }
    f.querySelector("[data-sun]").innerHTML = sun;
  }
  /**
   * Writes what changed: Latitude, Longitude, then Timezone and Timezone Name together. The firmware's
   * own parser has the last word on the POSIX string, so its echo is awaited. "same", "saved" or null.
   */
  async function savePosition(f) {
    const v = posRead(f);
    const fail = (key) => (toast(t(key), true), null);
    if (!v.okLat || !v.okLon) return fail("setup.pos.bad_degrees");
    if (!v.okTz) return fail("setup.pos.bad_posix");
    if (!v.okName) return fail("setup.pos.bad_name");
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
    if (changed.tz && !(await until(() => text(E.timezone) === v.posix, 3000))) return fail("setup.pos.tz_refused");
    if (!(await confirmed("position"))) return fail("setup.pos.not_confirmed");
    return "saved";
  }

  /* ------------------------------------------------------------ probes */

  function probesHTML() {
    if (scanning()) return `<div class="scan"><span class="ic">${icon("magnify-scan")}</span>${t("setup.probes.scanning")}</div>`;
    const list = probes(), roleOf = (address) => ROLES.find((r) => roleAddress(r.key) === address);
    const rows = list.map(({ address }) => {
      const r = roleOf(address), a = esc(address);
      return `<div class="probe${r ? " has" : ""}"><span class="ic">${icon("thermometer")}</span>
        <span><span class="t num" data-ptemp="${a}"></span><span class="trend" data-ptrend="${a}"></span><small class="mono">${a}</small></span>
        <select data-probe="${a}" aria-label="${t("setup.probes.role_of", { address: a })}"><option value="">${t("setup.probes.unused")}</option>
          ${ROLES.map((x) => `<option value="${x.key}"${r === x ? " selected" : ""}>${t(x.label)}</option>`).join("")}</select></div>`;
    }).join("");
    return (list.length ? `<div class="probes">${rows}</div>` : `<p class="hint">${t("setup.probes.none")}</p>`)
      + `<p class="hint">${t("setup.probes.hint", { pool: `<b>${t("card.read.pool")}</b>` })}</p>
      <div class="rowbtns">${lineBtn("rescan", "magnify", t("setup.probes.rescan"))}</div>`;
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
      const reading = Number.isFinite(celsius) ? `${fmt1(celsius)} °C` : t("setup.probes.no_answer");
      const trend = trendText(probeTrend(readings.get(address) || []));
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
    if (role && previous && previous !== address) {
      toast(t("setup.probes.moved", { role: t(role.label), probe: shortAddress(address), previous: shortAddress(previous) }));
    }
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
      toast(k ? t("setup.probes.found", { count: k }) : t("setup.probes.found_none"), !k);
      render();
    }, 2600);
  }

  /* ------------------------------------------------------------ the fill meter (fill-meter.yaml) */

  const hasFill = () => !!st(E.fillEnabled);
  const fillOn = () => s(E.fillEnabled) === "on";
  const { litres, minutes } = FILL_DETECT;
  /** Fill Meter Status in words: {cls, tag, sub}; a status this page doesn't know shows « ? ». */
  const fillWords = (status) => {
    const f = fillStatus(status);
    return f ? { cls: f.cls, tag: t(`setup.fill.status.${f.code}.tag`), sub: t(`setup.fill.status.${f.code}.sub`, { litres, minutes }) }
      : { cls: "idle", tag: "?", sub: "" };
  };
  /** Fill Meter Last Pulse in words: « aujourd'hui à 14:02 », « le 12/07 à 09:15 », « jamais ». */
  const pulseText = (v) => {
    const p = lastPulse(v);
    if (p.when === "never") return t("setup.fill.pulse.never");
    const date = fmt().date(p.at, { day: "2-digit", month: "2-digit", ...(p.otherYear ? { year: "numeric" } : {}) });
    return t(`setup.fill.pulse.${p.when}`, { time: fmt().time(p.at), date });
  };
  async function setFill(on) {
    try {
      await hass.callService("switch", on ? "turn_on" : "turn_off", { entity_id: E.fillEnabled });
    } catch (e) {
      refused(e);
      return false;
    }
    toast(t(on ? "setup.fill.on_toast" : "setup.fill.off_toast"));
    return true;
  }
  async function fillTest() {
    try {
      await hass.press(E.fillDetect);
    } catch (e) {
      refused(e);
      return;
    }
    toast(t("setup.fill.listening_toast", { litres, minutes }));
  }
  /** The pulse test: Fill Meter Status as a tag, what to do, « Tester ». */
  function fillTestRow() {
    const f = fillWords(s(E.fillStatus)), listening = s(E.fillStatus) === "listening";
    return `<div class="erow"><span class="ic">${icon("water-sync")}</span><span class="name"><span>${t("setup.fill.detect")}${tag(f.tag, f.cls)}</span>
      <small>${esc(f.sub)}</small></span><button type="button" class="btn line" data-act="fill-test"${listening || !hass.connected ? " disabled" : ""}>${t(listening ? "setup.fill.listening" : "setup.fill.test")}</button></div>`;
  }
  /** Réglages contrôleur › Compteur d'eau: on or off, then (on) the test and the last pulse. */
  function fillBody() {
    const on = fillOn();
    const seg = `<span class="ctl"><span class="seg" role="radiogroup" aria-label="${t("setup.fill.switch_aria")}">
      <button type="button" role="radio" aria-checked="${!on}" data-act="fill-off">${t("page.no")}</button><button type="button" role="radio" aria-checked="${on}" data-act="fill-on">${t("page.yes")}</button></span></span>`;
    return `<div class="erow"><span class="ic">${icon(on ? "water-check" : "water-off")}</span><span class="name"><span>${t("setup.fill.switch")}</span>
      <small>${t(on ? "setup.fill.on_sub" : "setup.fill.off_sub")}</small></span>${seg}</div>`
      + (on ? fillTestRow() + row("clock-outline", t("setup.fill.last_pulse"), esc(pulseText(s(E.fillLastPulse))), t("setup.fill.last_pulse_sub")) : "");
  }
  /** « Alarme après », apart: a status or a pulse repaints fillBody, never what is being typed here. */
  function fillAlarm() {
    if (!fillOn() || !st(E.fillAlarmAfter)) return "";
    const v = Math.round(n(E.fillAlarmAfter));
    return `<form data-form="fill-alarm" autocomplete="off"><div class="erow"><span class="ic">${icon("timer-alert-outline")}</span>
      <span class="name"><span>${t("setup.fill.alarm")}</span><small>${t("setup.fill.alarm_sub")}</small></span>
      <span class="ctl num-in"><input name="min" inputmode="numeric" value="${Number.isFinite(v) ? v : ""}" aria-label="${t("setup.fill.alarm_aria")}"><span>min</span>
      <button class="btn">OK</button></span></div></form>`;
  }
  async function saveFillAlarm(form) {
    const v = parseAlarmMinutes(form.elements.min.value);
    if (v === null) {
      toast(t("setup.fill.alarm_bad", { min: FILL_ALARM.min, max: FILL_ALARM.max }), true);
      return;
    }
    try {
      await hass.setNumber(E.fillAlarmAfter, v);
    } catch (e) {
      refused(e);
      return;
    }
    toast(v ? t("setup.fill.alarm_set", { min: v }) : t("setup.fill.alarm_none"));
  }
  /** The wizard's step 4, after the probes: optional, it never blocks « Continuer ». */
  function fillWizard() {
    const on = fillOn(), status = s(E.fillStatus), f = fillWords(status);
    const state = !on ? hero("idle", "water-off", t("setup.fill.wz_none"), t("setup.fill.wz_none_sub"))
      : status === "detected" ? hero("ok", "check", t("setup.fill.wz_detected"), t("setup.fill.wz_detected_sub"))
      : status === "listening" ? hero("idle", "water-sync", t("setup.fill.listening"), esc(f.sub))
      : status === "not_detected" ? hero("idle", "water-alert", t("setup.fill.wz_not_detected"), esc(f.sub))
      : "";
    return `<h3 class="wz-sub">${t("setup.fill.heading")} <small>${t("setup.fill.optional")}</small></h3>
      <p class="hint">${t("setup.fill.wz_intro")}</p>
      ${state}
      <div class="rowbtns">${lineBtn("fill-yes", "water-check", t(on && status === "detected" ? "setup.fill.retest" : "setup.fill.have"), status === "listening" ? " disabled" : "")}
        ${on ? lineBtn("fill-no", "water-off", t("setup.fill.have_not")) : ""}</div>`;
  }

  /* ------------------------------------------------------------ the API key: Home Assistant sets it */

  const haSteps = () => `<ol class="do"><li>${t("setup.ha.step1")}</li><li>${t("setup.ha.step2")}</li></ol>`;
  const haWait = () => `<div class="wz-wait">${hero("idle", "home-assistant", t("setup.ha.waiting"), t("setup.ha.waiting_sub"))}<div class="prog ind"><i></i></div></div>`;
  const openNote = () => `<p class="hint warnl">${t("setup.ha.open_note")}</p>`;
  const noHaLink = () => `<button type="button" class="linkbtn" data-act="key-skip"${view.busy ? " disabled" : ""}>${t("setup.ha.no_ha")}</button>`;
  function keyUI(ctx) {
    if (view.paste !== ctx) return `<div class="rowbtns">${lineBtn("key-paste", "key-variant", t("setup.ha.paste"), ` data-ctx="${ctx}"`)}</div>`;
    return `<form class="form" data-form="key" autocomplete="off"><label>${t("setup.ha.key_label")}<input name="key" class="mono" maxlength="44" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="…="></label>
      <p class="hint">${t("setup.ha.paste_hint")}</p>
      <div class="rowbtns"><button class="btn fill"${view.busy ? " disabled" : ""}>${t("setup.ha.save_key")}</button><button type="button" class="btn" data-act="key-cancel">${t("common.cancel")}</button></div></form>`;
  }
  /** The firmware validates a key, saves it, then refreshes Setup State: its `api_key` going says it took it. */
  async function keyChange(write, wanted, failure) {
    view.busy = true;
    render();
    try {
      await write();
      const ok = await until(() => isMissing("api_key") === !wanted, CONFIRM_MS);
      if (!ok) toast(t(failure), true);
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
    if (!validApiKey(key)) return toast(t("setup.ha.key_invalid"), true);
    form.reset(); // sent once, never shown again
    if (!(await keyChange(() => hass.setText(E.apiKey, key), true, "setup.ha.key_refused"))) return;
    keyOrigin = "paste";
    view.paste = null;
    if (!wz.open) toast(t("setup.ha.key_saved"));
  }
  /** « Je n'utilise pas Home Assistant »: the controller draws a random key nobody sees, so its API is closed. */
  async function withoutHomeAssistant() {
    if (!(await keyChange(() => hass.press(E.generateKey), true, "setup.ha.key_gen_failed"))) return false;
    keyOrigin = "generated";
    view.paste = null;
    if (!wz.open) toast(t("setup.ha.key_generated"));
    return true;
  }
  /** « Ajouter à Home Assistant »: the controller forgets its key, and Home Assistant sets one when it adds it. */
  async function forgetKey() {
    view.forget = false;
    if (!(await keyChange(() => hass.press(E.forgetKey), false, "setup.ha.forget_failed"))) return;
    keyOrigin = null;
    toast(t("setup.ha.forgotten"));
  }

  /* ------------------------------------------------------------ Réglages contrôleur tab sections */

  function accBody() {
    const pageSet = !isMissing("page_password");
    const line = (kind, ic, label, value, cls, sub) => `<div class="erow"><span class="ic">${icon(ic)}</span>
        <span class="name"><span>${label} ${tag(value, cls)}</span><small>${sub}</small></span>
        <button type="button" class="btn line" data-act="acc-${kind}"${view.acc === kind ? " disabled" : ""}>${t("setup.acc.change")}</button></div>`
      + (view.acc === kind ? `<div class="inl">${pwForm(kind, false)}</div>` : "");
    return line("page", "lock", t("setup.acc.page"), t(pageSet ? "setup.set" : "setup.unset"), pageSet ? "" : "bad", t("setup.acc.page_sub"))
      + line("ota", "upload-lock", t("setup.acc.ota"), t("setup.set"), "", t("setup.acc.ota_sub"))
      + `<p class="hint">${t("setup.acc.write_only")}</p>`
      + (pageSet ? sessionsBody() : "");
  }
  /** Logging out: this browser, or every one (the Logout All Devices button, on a firmware that has it). */
  function sessionsBody() {
    const all = !!st(E.logoutAll);
    return `<div class="sect">${t("setup.acc.sessions")}</div><p class="hint">${t("setup.acc.logout_hint")}${all ? ` ${t("setup.acc.logout_all_hint")}` : ""}</p>
      <div class="rowbtns">${lineBtn("logout", "logout", t("setup.acc.logout"))}${all ? lineBtn("logout-all", "devices", t("setup.acc.logout_all")) : ""}</div>`;
  }
  /** « Se déconnecter »: this browser's session ends, the login screen opens. */
  async function logOut() {
    try {
      await login.logOut();
    } catch (e) {
      refused(e);
    }
  }
  /** « Déconnecter tous les appareils »: every session ends, this one too, so the login screen opens at once. */
  async function logOutAll() {
    try {
      await hass.press(E.logoutAll);
    } catch (e) {
      refused(e);
      return;
    }
    hass.checkSession();
  }
  function haBody() {
    if (isMissing("api_key")) {
      return row("key-variant", t("setup.ha.key_row"), t("setup.ha.key_unset"), t("setup.ha.key_unset_sub"), "bad")
        + row("home-assistant", "Home Assistant", t("setup.ha.state_waiting"), t("setup.ha.state_waiting_sub"), "warn")
        + haSteps() + haWait() + openNote()
        + `<div class="${view.paste === "ctl" ? "inl" : "keyslot"}">${keyUI("ctl")}</div>${noHaLink()}`;
    }
    const by = t(keyOrigin === "paste" ? "setup.ha.by_paste" : keyOrigin === "generated" ? "setup.ha.by_generated"
      : linked() ? "setup.ha.by_ha" : "setup.ha.by_unknown");
    const [state, cls, sub] = linked() ? [t("setup.ha.state_linked"), "", t("setup.ha.state_linked_sub")]
      : keyOrigin === "generated" ? [t("setup.ha.state_unused"), "", t("setup.ha.state_unused_sub")]
      : [t("setup.ha.state_unlinked"), "warn", t("setup.ha.state_unlinked_sub")];
    let html = row("key-variant", t("setup.ha.key_row"), t("setup.ha.key_set"), by) + row("home-assistant", "Home Assistant", state, sub, cls);
    if (!linked()) {
      html += view.forget
        ? `<div class="inl"><p class="hint">${t("setup.ha.forget_hint")}</p>
          <div class="rowbtns"><button type="button" class="btn" data-act="ha-forget-no">${t("common.cancel")}</button><button type="button" class="btn fill" data-act="ha-forget-yes"${view.busy ? " disabled" : ""}>${t("setup.ha.forget")}</button></div></div>`
        : `<div class="rowbtns">${lineBtn("ha-forget", "home-assistant", t("setup.ha.add"))}</div>`;
    }
    return html;
  }
  function resetBody() {
    const fw = text(E.fwVersion);
    return `<div class="erow"><span class="ic">${icon("restore")}</span><span class="name"><span>${t("setup.reset.row")}</span>
      <small>${t("setup.reset.row_sub")}</small></span>
      ${view.reset ? "" : `<button type="button" class="btn line danger" data-act="reset-ask">${t("setup.reset.ask")}</button>`}</div>`
      + (view.reset ? `<div class="dangerbox" role="alertdialog" aria-label="${t("setup.reset.aria")}"><b>${t("setup.reset.confirm")}</b>
        <p>${t("setup.reset.wiped")}</p><ul><li>${t("setup.reset.wiped_pw")}</li><li>${t("setup.reset.wiped_wifi")}</li><li>${t("setup.reset.wiped_key")}</li></ul>
        <p>${t("setup.reset.kept")}</p><ul><li>${t("setup.reset.kept_probes")}</li><li>${t("setup.reset.kept_settings")}</li><li>${fw ? t("setup.reset.kept_fw_v", { version: esc(fw) }) : t("setup.reset.kept_fw")}</li></ul>
        <p>${t("setup.reset.after", { ssid: AP_SSID })}</p>
        <div class="rowbtns"><button type="button" class="btn" data-act="reset-no">${t("common.cancel")}</button><button type="button" class="btn fill danger" data-act="reset-yes">${t("setup.reset.yes")}</button></div></div>` : "");
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
    toast(t("setup.reset.toast"));
  }
  function renderSections() {
    const sections = [["posStack", E.latitude], ["probeStack", E.detectedProbes], ["fillStack", E.fillEnabled], ["accStack", E.pagePassword], ["haStack", E.apiKey], ["resetStack", E.factoryReset]];
    for (const [id, entity] of sections) $(id).hidden = !st(entity);
    if (st(E.latitude)) paint($("posBody"), `${posForm(true)}<p class="posnote">${t("setup.pos.from_ha")}</p>`);
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
        ? `<p class="wz-intro">${t("setup.wz1.after_reset", { needs: andList(m.map(need)) })}</p>`
        : `<p class="wz-intro">${t("setup.wz1.new")}</p>`)
        + `<p class="hint">${t("setup.wz1.hotspot", { ssid: AP_SSID })}</p>
        ${pwForm("page", true)}
        <p class="hint">${t("setup.wz1.hint")}</p>
        ${m.includes("page_password") ? "" : `<p class="hint okl">${t("setup.wz1.set")}</p>`}`;
    }
    if (step === 2) {
      const mode = s(E.wifiMode), ssid = esc(text(E.wifiSsid));
      if (reconnecting()) {
        const next = nextStep(m.filter((k) => k !== "wifi"));
        return (mode === "Connected"
          ? hero("ok", "check", t("page.wifi.connected_to", { ssid }), t("setup.wz2.hotspot_off"))
          : hero("idle", "wifi-sync", t("page.wifi.connecting_to", { ssid: esc(text(E.joinSsid)) }), t("setup.wz2.hotspot_will_stop")))
          + `<ol class="do"><li>${t("setup.wz2.reconnect", { ssid: ssid || esc(text(E.joinSsid)) })}</li><li>${t("setup.wz2.open", { url: `<b>${HOME_URL}</b>` })}${text(E.ip) ? ` (${t("setup.wz2.or")} http://${esc(text(E.ip))})` : ""}.</li>
            <li>${t("setup.wz2.resume", { step: next <= 5 ? `<b>${next} · ${stepName(next - 1)}</b>` : t("setup.wz2.none") })}</li></ol>`;
      }
      if (mode === "Connected") {
        return hero("ok", bars(n(E.wifiSignal)), t("page.wifi.connected_to", { ssid }), `${t("setup.wz2.signal", { dbm: n(E.wifiSignal) })} · ${esc(text(E.ip))}`)
          + `<p class="hint">${t("setup.wz2.change_later")}</p>`;
      }
      return (mode === "Connecting"
        ? hero("idle", "wifi-sync", t("page.wifi.connecting_to", { ssid: esc(text(E.joinSsid)) }), t("setup.wz2.connecting_sub"))
        : hero("idle", "access-point", t("page.wifi.hotspot_named", { ssid: AP_SSID }), t("setup.wz2.hotspot_sub")))
        + `<p class="wz-intro">${t("setup.wz2.intro")}</p>`
        + `<p class="hint">${t("setup.wz2.lose_link", { item: '<span class="mono">wifi</span>' })}</p>`;
    }
    if (step === 3) return `<p class="wz-intro">${t("setup.wz3.intro")}</p>${posForm(false)}`;
    if (step === 4) {
      const k = probes().length;
      return (k ? `<p class="wz-intro">${t("setup.wz4.found", { count: k })}</p>` : "") + probesHTML()
        + (hasFill() ? fillWizard() : "");
    }
    if (step === 5) {
      const intro = `<p class="wz-intro">${t("setup.wz5.intro")}</p>`;
      if (m.includes("api_key")) {
        return intro + haSteps()
          + (s(E.wifiMode) && s(E.wifiMode) !== "Connected" ? `<p class="hint warnl">${t("setup.wz5.not_home")}</p>` : "")
          + (wz.afterReset ? `<p class="hint">${t("setup.wz5.after_reset")}</p>` : "")
          + haWait() + openNote()
          + `<p class="hint">${t("setup.wz5.otherwise")}</p><div class="keyslot">${keyUI("wz")}</div>${noHaLink()}`;
      }
      return intro + (keyOrigin === "paste" ? hero("ok", "check", t("setup.wz5.key_set"), t("setup.wz5.pasted"))
        : keyOrigin === "generated" ? hero("ok", "check", t("setup.wz5.without_ha"), t("setup.wz5.generated"))
        : linked() ? hero("ok", "check", t("setup.wz5.by_ha"), t("setup.wz5.by_ha_sub"))
        : hero("ok", "check", t("setup.wz5.key_set"), t("setup.wz5.unlinked")));
    }
    return doneBody();
  }
  function doneBody() {
    const w = text(E.waitingFor), real = (a, b) => text(a) && text(a) !== "--:--" && text(a) !== text(b);
    const blocks = `${hm(text(E.b1s))}–${hm(text(E.b1e))}`, blocks2 = `${hm(text(E.b2s))}–${hm(text(E.b2e))}`;
    const plan = w && w !== "--" ? t("setup.done.waits", { what: WAITING_FOR[w] ? t(WAITING_FOR[w]) : esc(w) })
      : real(E.b1s, E.b1e) ? (real(E.b2s, E.b2e) ? t("setup.done.plan2", { hours: fmt1(n(E.hoursPlanned)), block1: blocks, block2: blocks2 })
        : t("setup.done.plan1", { hours: fmt1(n(E.hoursPlanned)), block1: blocks }))
      : t("setup.done.plan");
    const role = (r) => (roleAddress(r.key) ? `${t(r.label)} ${shortAddress(roleAddress(r.key))}` : t("setup.done.role_none", { role: t(r.label) }));
    const zone = text(E.timezoneName) || t("card.pos.tz_posix");
    return hero("ok", "check", "Setup State : configured", plan) + "<div>"
      + row("lock", t("setup.acc.page"), t("setup.set"), t("setup.done.page_sub"))
      + row(bars(n(E.wifiSignal)), "Wi-Fi", esc(text(E.wifiSsid) || "—"), `${HOME_URL}${text(E.ip) ? ` · ${esc(text(E.ip))}` : ""}`)
      + row("map-marker-outline", t("card.sec.position"), `${deg(n(E.latitude))} · ${deg(n(E.longitude))}`, `${esc(zone)} · <span class="mono">${esc(text(E.timezone))}</span>`)
      + row("thermometer", t("card.sec.probes"), role(ROLES[0]), ROLES.slice(1).map(role).join(" · "))
      + row("home-assistant", "Home Assistant", t(linked() ? "setup.ha.state_linked" : keyOrigin === "generated" ? "setup.ha.state_unused" : "setup.done.key_set"),
        t(linked() ? "setup.done.ha_linked" : keyOrigin === "generated" ? "setup.done.ha_generated" : "setup.done.ha_where"))
      + "</div>";
  }
  function stepNav(step, m) {
    if (step === 6) return `<span class="sp"></span><button type="button" class="btn fill" data-act="wz-finish">${t("setup.nav.open")}</button>`;
    const blocked = view.busy || !hass.connected
      || (step === 2 && m.includes("wifi")) || (step === 4 && (!roleAddress("poolProbe") || scanning())) || (step === 5 && m.includes("api_key"));
    const last = !m.some((item) => item !== SETUP_ITEMS[step - 1]);
    return `${step > 1 ? `<button type="button" class="btn line" data-act="wz-back">${t("setup.nav.back")}</button>` : ""}<span class="sp"></span>
      <button type="button" class="btn fill" data-act="wz-next"${blocked ? " disabled" : ""}>${t(last ? "setup.nav.finish" : "setup.nav.next")}</button>
      <button type="button" class="linkbtn later" data-act="wz-later">${t("setup.nav.later")}</button>`;
  }
  function renderWizard() {
    document.body.classList.toggle("setup", wz.open);
    $("wizard").hidden = !wz.open;
    placeJoin();
    if (!wz.open) return;
    const m = missing() || [], step = wz.step, left = m.length;
    paint($("wzSteps"), SETUP_ITEMS.map((item, i) => {
      const k = i + 1, label = stepName(i), cls = k === step ? "cur" : !m.includes(item) ? "done" : "";
      return `<li class="${cls}"><button type="button" class="n" ${cls === "done" ? `data-act="wz-goto" data-step="${k}"` : 'tabindex="-1"'}
        aria-label="${t(cls === "done" ? "setup.nav.step_done" : "setup.nav.step", { n: k, name: label })}"${k === step ? ' aria-current="step"' : ""}>${cls === "done" ? icon("check") : k}</button><span>${label}</span></li>`;
    }).join(""));
    paint($("wzState"), `Setup State : <span class="mono">${esc(s(E.setupState) || "…")}</span>`);
    $("wzTitle").textContent = step <= 5 ? `${step} · ${stepTitle(step - 1)}` : t("setup.nav.configured_title");
    const what = t(wz.afterReset ? "setup.nav.after_reset" : "setup.nav.first_install");
    const todo = !left ? "" : left > 1 ? t("setup.nav.todo", { count: left }) : m[0] === SETUP_ITEMS[step - 1] ? t("setup.nav.only_this") : t("setup.nav.todo", { count: 1 });
    $("wzSub").textContent = step <= 5
      ? `${what} · ${t("setup.nav.step_of", { n: step })}${todo ? ` · ${todo}` : ""}`
      : t(wz.afterReset ? "setup.nav.reinstall_done" : "setup.nav.install_done");
    const chip = $("wzChip");
    chip.className = `chip ${!hass.connected ? "bad" : step <= 5 ? "" : "ok"}`;
    chip.textContent = t(!hass.connected ? "page.conn.lost" : step <= 5 ? "setup.nav.not_configured" : "setup.nav.configured");
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
          toast(t("setup.wz1.choose"), true);
          form.elements.pw.focus();
          return;
        }
      }
      if (step === 2 && isMissing("wifi")) return;
      if (step === 3 && !(await savePosition(form))) return;
      if (step === 4 && !roleAddress("poolProbe")) return toast(t("setup.wz4.need_pool"), true);
      if (step === 4 && !(await confirmed("probes"))) return toast(t("setup.wz4.not_confirmed"), true);
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
      ? `<div class="banner info">${icon("clipboard-check-outline")}<span>${t("setup.banner", { needs: andList(m.map(need)) })}</span>
        <button type="button" class="btn" data-act="wz-resume">${t("setup.banner_btn")}</button></div>`
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
        toast(t("setup.nav.configured_toast"));
        break;
      case "eye": {
        const input = b.parentNode.querySelector("input"), show = input.type === "password";
        input.type = show ? "text" : "password";
        b.innerHTML = icon(show ? "eye-off" : "eye");
        b.title = t(show ? "page.pw.hide" : "page.pw.show");
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
      case "logout": await logOut(); break;
      case "logout-all": await logOutAll(); break;
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
      if (await savePassword(form)) toast(t(page ? "setup.pw.page_changed" : "setup.pw.ota_changed"));
    } else if (kind === "pos") {
      const result = await savePosition(form);
      if (result) toast(t(result === "same" ? "setup.pos.same" : "setup.pos.saved"));
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

  // A new language redraws everything in place: the wizard stays on its step, what's typed stays.
  onLang(() => {
    relabel = true;
    try { render(); } finally { relabel = false; }
  });
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
