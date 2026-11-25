/*
 * The controller's own page, in three tabs, the same as Home Assistant's piscine-card (mock-up v17):
 * « Contrôle » runs that card's panel (unchanged, fed by esphome-hass.js; its long-fill banner too) and its water
 * variant, gone with its heading while Fill Meter is off (fill-meter.yaml), as are the flow and volume rows;
 * « Réglages » today's plan, the device's sensors, the settings (the card's settings variant) and the
 * last 7 days; « Réglages contrôleur » its Wi-Fi (wifi-setup.yaml: connection, statistics, joining a
 * network), its firmware, what setup.js adds (its position, probes, fill meter, passwords, Home Assistant key and
 * factory reset), and its live log, plus the setup wizard shown instead of the page while the
 * controller isn't set up (device-settings.yaml), and the login screen while it asks for its password (login.js).
 * The device keeps no history of its
 * sensors, so the only charts are of what it records itself: the pool's min/max and filtration of the
 * last 7 days, and the fill water of 30 days and 12 months. Everything talks to the ESP32 only, so it
 * keeps working while Home Assistant is down.
 *
 * Every text is in the page's language (page-i18n.js: English, French or Spanish, the EN | FR | ES switch in the
 * headers): rows take keys and translate them at each update, caches of what was drawn include the language, and a
 * change redraws in place; the card follows through hass.locale.
 */
import { EspHass, E } from "./esphome-hass.js";
import { ICONS } from "./icons.js";
import { mountSetup } from "./setup.js";
import { WAITING_FOR } from "./setup-model.js";
import { mountLogin } from "./login.js";
import { keepAlive } from "./session.js";
import { t, fmt, setLang, onLang, pageLang, applyStatic, langSwitch } from "./page-i18n.js";

const hass = new EspHass();
const $ = (id) => document.getElementById(id);
const st = (id) => hass.states[id];
const s = (id) => st(id)?.state;
const n = (id) => parseFloat(s(id));
const shown = (id) => st(id)?.attributes.display ?? s(id) ?? "—";
/** One decimal in the page's language: « 25,9 », « 25.9 ». */
const fmt1 = (v) => (Number.isFinite(v) ? fmt().number(v, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) : "–");
const pad2 = (v) => String(v).padStart(2, "0");
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A speed code (Off, Low…, Auto) in words: the card's glossary keys. */
const speed = (v) => (["Off", "Low", "Medium", "High"].includes(v) ? t(`common.speed.${v}`) : v === "Auto" ? t("common.mode.auto") : v);
/** Fill Meter turned off (fill-meter.yaml): no Remplissage, no flow nor volume rows. A firmware without it counts. */
const fillOff = () => s(E.fillEnabled) === "off";

function icon(name) {
  const p = ICONS[String(name || "").replace(/^mdi:/, "")];
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${p ? `<path d="${p}"/>` : '<circle cx="12" cy="12" r="3"/>'}</svg>`;
}
function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function duration(sec) {
  if (!Number.isFinite(sec)) return "—";
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return t("page.uptime.d", { d, h: hr, m: pad2(m) });
  if (hr) return `${hr} h ${pad2(m)} min`;
  return `${m} min ${pad2(Math.floor(sec % 60))} s`;
}
/** ms -> "HH:MM" today, else "DD/MM HH:MM", in the page's language and formats. */
function clock(ms) {
  const d = new Date(ms), hm = fmt().time(d);
  return d.toDateString() === new Date().toDateString() ? hm : `${fmt().date(d, { day: "2-digit", month: "2-digit" })} ${hm}`;
}
/** The controller's « HH:MM » (a block, the next change) in the page's time format. */
function hhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
  if (!m) return v;
  const d = new Date();
  d.setHours(+m[1], +m[2], 0, 0);
  return fmt().time(d);
}
/** The device's "YYYY-MM-DD HH:MM:SS" -> clock(). */
function stamp(v) {
  const t = Date.parse(String(v || "").replace(" ", "T"));
  return Number.isFinite(t) ? clock(t) : v || "—";
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), err ? 4500 : 2600);
}
const refusedMsg = (e) => t("page.refused", { error: e.message });
/** Runs a write; `ok` (a key, or a function returning the text) is the toast once the controller took it. */
const run = (p, ok) => p.then(() => ok && toast(typeof ok === "function" ? ok() : t(ok))).catch((e) => toast(refusedMsg(e), true));

/* ================================================================ tabs */

const TABS = ["controle", "reglages", "reglages-controleur"];
/** The tabs' old names (links and bookmarks from before v17) -> where they live now. */
const TAB_ALIASES = { avance: "reglages", controleur: "reglages-controleur", wifi: "reglages-controleur", remplissage: "controle" };
let tab = "controle";
/**
 * #remplissage: Contrôle at its Remplissage (below Filtration on a phone). Filtration grows as the controller's
 * states come in, so the page follows it for a few seconds, until the reader scrolls or types.
 */
function scrollToWater() {
  const ro = new ResizeObserver(() => $("waterStack").scrollIntoView({ block: "start" }));
  const STOP = ["wheel", "touchstart", "keydown", "pointerdown"];
  const stop = () => { ro.disconnect(); for (const t of STOP) removeEventListener(t, stop); };
  for (const t of STOP) addEventListener(t, stop, { passive: true });
  setTimeout(stop, 4000);
  ro.observe($("tab-controle"));
}
function route() {
  const want = location.hash.slice(1), alias = TAB_ALIASES[want];
  tab = TABS.includes(alias || want) ? alias || want : "controle";
  if (alias) history.replaceState(null, "", `#${tab}`); // the address bar shows the tab's name of today
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== tab;
    document.querySelector(`.tabs a[data-tab="${t}"]`).setAttribute("aria-selected", String(t === tab));
  }
  if (tab === "reglages-controleur") scrollLogToEnd();
  scrollTo({ top: 0 });
  if (want === "remplissage" && !fillOff()) scrollToWater();
  // #wifi: Réglages contrôleur at its Wi-Fi, which comes after Accès and Home Assistant
  if (want === "wifi") requestAnimationFrame(() => $("wifiStack").scrollIntoView({ block: "start" }));
}
addEventListener("hashchange", route);
addEventListener("popstate", route);
addEventListener("location-changed", route); // what piscine-card fires after its own pushState

/* ================================================================ « Contrôle » */

const card = document.createElement("piscine-card");
card.setConfig({
  variant: "panel",
  recorder: false, // no recorder nor statistics here: the temperature graph keeps its 7 days, from Daily (Outdoor, Equipment Pad) History
  settings_tab: false, // this page has its own « Réglages » and « Réglages contrôleur »
  controller_light: false, // its header's « Connected to the controller » chip is this page's link to the controller
  entities: {
    override: E.override, commanded: E.commanded, planned: E.planned, nextAt: E.nextAt, nextTo: E.nextTo,
    b1s: E.b1s, b1e: E.b1e, b2s: E.b2s, b2e: E.b2e, hoursToday: E.hoursToday, hoursPlanned: E.hoursPlanned,
    water: E.water, waterMin: E.waterMin, waterMax: E.waterMax, history: E.history, outdoor: E.outdoor,
    outdoorMin: E.outdoorMin, outdoorMax: E.outdoorMax, outdoorHistory: E.outdoorHistory, pad: E.pad,
    padMin: E.padMin, padMax: E.padMax, padHistory: E.padHistory, online: E.online, stuck: E.overrideActive, notComputed: E.notComputed,
    recomputed: E.recomputed, boostInterval: E.boostInterval, boostDuration: E.boostDuration,
    highEvery: E.highEvery, timeout: E.timeout, endsAt: E.endsAt, freezeAt: E.freezeAt,
    // the long-fill alarm's banner, with « Acquitter » (fill-meter.yaml): this page's own, fed by the controller
    fillEnabled: E.fillEnabled, fillAlarmAfter: E.fillAlarmAfter, fillRunning: E.fillRunning, fillTooLong: E.fillTooLong,
    fillAck: E.fillAck, fillAcked: E.fillAcked,
    sun: "sun.sun", // not on the device: the timeline just has no sunrise/sunset marks
  },
});
$("cardHost").appendChild(card);
let cardReady = false;

function updateControl() {
  if (!cardReady && st(E.override)) {
    card.hass = hass;
    // Built for a Bubble pop-up: the close button has nothing to close here.
    card.shadowRoot.getElementById("close").hidden = true;
    cardReady = true;
  } else if (cardReady) card.hass = hass;
  $("subtitle").textContent = `${fmt1(n(E.water))} °C · ${speed(s(E.commanded)) ?? "–"} · ${fmt1(n(E.hoursToday))} h`;
  const c = $("conn");
  c.className = `chip ${hass.connected ? "ok" : "bad"}`;
  c.textContent = t(hass.connected ? "page.conn.ok" : "page.conn.lost");
}

/* ================================================================ « Réglages » and « Réglages contrôleur »: entity rows */

const updaters = [];

/** A row's words: a key (translated at each update, so a language change shows at once), or a function. */
const words = (v) => (typeof v === "function" ? v() : v ? t(v) : "");
/**
 * Read-only row: icon, label (+ sub-label), value. `label` and `sub` are keys (or functions); `name` a text as is (an
 * entity's own name). `value` defaults to the entity's display state; `problem` is the key shown when it is on.
 */
function valueRow(host, { id, label, name, sub, iconName, value, problem, visible }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small></small></span><span class="val num"></span></div>`);
  host.appendChild(row);
  updaters.push(() => {
    const e = id ? st(id) : null;
    row.hidden = (!!id && !e) || (!!visible && !visible());
    if (row.hidden) return;
    row.querySelector(".name span").textContent = name ?? words(label);
    row.querySelector(".ic").innerHTML = icon(typeof iconName === "function" ? iconName() : iconName || e?.attributes.icon);
    const subText = words(sub);
    row.querySelector("small").textContent = subText;
    row.querySelector("small").hidden = !subText;
    const val = row.querySelector(".val");
    if (problem) {
      const on = e.state === "on";
      val.textContent = on ? t(problem) : "OK";
      val.className = `val ${on ? "bad" : "good"}`;
      row.classList.toggle("problem", on);
    } else val.textContent = value ? value() : shown(id);
  });
  return row;
}

/** Number row: slider + value, written when released (the HA entities-card slider row). `name`: the entity's own. */
function numberRow(host, { id, name }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small hidden></small></span>
    <span class="ctl"><input type="range"><span class="v num"></span></span></div>`);
  row.querySelector(".name span").textContent = name;
  const input = row.querySelector("input"), out = row.querySelector(".v");
  input.setAttribute("aria-label", name);
  let editing = 0; // until when the slider wins over pushed states
  const unit = () => st(id)?.attributes.unit_of_measurement || "";
  const decimals = () => {
    const step = String(st(id)?.attributes.step ?? 1);
    return step.includes(".") ? step.split(".")[1].length : 0;
  };
  const label_ = (v) => `${fmt().number(+v, { minimumFractionDigits: decimals(), maximumFractionDigits: decimals(), useGrouping: false })} ${unit()}`.trim();
  input.addEventListener("input", () => {
    editing = Date.now() + 60000;
    out.textContent = label_(input.value);
    row.classList.add("dirty");
  });
  input.addEventListener("change", () => {
    editing = Date.now() + 4000; // wait for the device's echo
    run(hass.setNumber(id, input.value)).finally(() => row.classList.remove("dirty"));
  });
  host.appendChild(row);
  updaters.push(() => {
    const e = st(id);
    row.hidden = !e;
    if (!e) return;
    const a = e.attributes;
    row.querySelector(".ic").innerHTML = icon(a.icon);
    input.min = a.min;
    input.max = a.max;
    input.step = a.step;
    if (Date.now() > editing) {
      input.value = e.state;
      out.textContent = label_(e.state);
      row.classList.remove("dirty");
    }
  });
}

/** Button row: `label`, `sub`, `text` and `ok` (its toast) are keys; `name` an entity's own name, as is. */
function buttonRow(host, { id, label, name, sub, iconName, text = "page.press", ok, fill, disabled }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small></small></span><button class="btn"></button></div>`);
  const b = row.querySelector("button");
  if (fill) b.classList.add("fill");
  b.addEventListener("click", () => {
    b.classList.add("busy");
    run(hass.press(id), ok).finally(() => b.classList.remove("busy"));
  });
  host.appendChild(row);
  updaters.push(() => {
    const e = st(id);
    row.hidden = !e;
    if (!e) return;
    row.querySelector(".name span").textContent = name ?? t(label);
    row.querySelector("small").textContent = sub ? t(sub) : "";
    row.querySelector("small").hidden = !sub;
    b.textContent = t(text);
    row.querySelector(".ic").innerHTML = icon(iconName || e.attributes.icon);
    b.disabled = disabled ? disabled() : false;
  });
  return row;
}
/** A section's heading: `key`, translated at each update. */
const sect = (host, key) => {
  const el = host.appendChild(h(`<div class="sect"></div>`));
  updaters.push(() => { el.textContent = t(key); });
  return el;
};

/* ---- Filtration et hors gel: piscine-card's settings variant, the rows Home Assistant's card shows too */
{
  const settings = document.createElement("piscine-card");
  const configure = () => settings.setConfig({
    variant: "settings",
    title: t("card.sec.filtration_freeze"), // the section's name in Home Assistant's card too
    icons: ICONS, // no <ha-icon> here
    entities: {
      min: E.min, max: E.max, offset: E.offset, warm: E.warm, pending: E.pending, apply: E.apply,
      boostDuration: E.boostDuration, boostInterval: E.boostInterval, highEvery: E.highEvery, freezeAt: E.freezeAt,
    },
  });
  configure();
  onLang(() => { configure(); if (st(E.min)) settings.hass = hass; }); // its title is the page's
  settings.classList.add("o3"); // Réglages: after Plan du jour and Capteurs internes (index.html)
  $("settingsHost").replaceWith(settings);
  updaters.push(() => { if (st(E.min)) settings.hass = hass; });
}

/* ---- Contrôle › Remplissage: piscine-card's water variant, from the controller's own record (Fill Water Today, Days,
   Months) rather than Home Assistant's statistics: the same readings and chart, 30 days and 12 months */
{
  const water = document.createElement("piscine-card");
  water.setConfig({
    variant: "water",
    recorder: false,
    entities: { flow: E.flow, volume: E.volume, fillToday: E.fillToday, fillDays: E.fillDays, fillMonths: E.fillMonths,
      fillEnabled: E.fillEnabled, fillAlarmAfter: E.fillAlarmAfter, fillRunning: E.fillRunning, fillTooLong: E.fillTooLong,
      fillAcked: E.fillAcked },
  });
  $("waterHost").replaceWith(water);
  updaters.push(() => {
    // Fill Meter off: no Remplissage at all (the card hides itself; its heading goes with it)
    $("waterStack").hidden = fillOff();
    if (st(E.flow)) water.hass = hass;
  });
}

/* ---- Plan du jour */
{
  const host = $("planRows");
  // "--:--" when there is none; start == end when the firmware folded block 2 into block 1.
  const range = (a, b) => () => (s(a) && s(a) !== "--:--" && s(a) !== s(b) ? `${hhmm(s(a))} → ${hhmm(s(b))}` : "—");
  // Most of the words are the card's (its « Réglages » › Plan du jour shows the same rows).
  valueRow(host, { id: E.hoursPlanned, label: "card.row.hoursPlanned.label" });
  valueRow(host, { id: E.hoursToday, label: "card.row.hoursToday.label",
    sub: () => (n(E.hoursPlanned) > 0 ? t("card.row.hoursToday.pct", { pct: Math.round((n(E.hoursToday) / n(E.hoursPlanned)) * 100) }) : "") });
  valueRow(host, { id: E.b1s, label: "card.row.b1s.label", iconName: "clock-start", value: range(E.b1s, E.b1e) });
  valueRow(host, { id: E.b2s, label: "card.row.b2s.label", iconName: "clock-end", value: range(E.b2s, E.b2e) });
  valueRow(host, { id: E.planned, label: "card.row.planned.label", value: () => speed(s(E.planned)) });
  valueRow(host, { id: E.commanded, label: "card.row.commanded.label", value: () => speed(s(E.commanded)),
    sub: () => (s(E.override) && s(E.override) !== "Auto" ? t("card.row.commanded.forced", { speed: speed(s(E.override)) }) : t("card.row.commanded.follows")) });
  valueRow(host, { id: E.nextAt, label: "card.row.nextAt.label",
    value: () => (s(E.nextAt) && s(E.nextAt) !== "--:--" ? `${hhmm(s(E.nextAt))} → ${speed(s(E.nextTo))}` : t("card.nothing_today")) });
  valueRow(host, { id: E.nextBoostStart, label: "card.row.nextBoostStart.label", value: range(E.nextBoostStart, E.nextBoostEnd) });
  valueRow(host, { id: E.recomputed, label: "card.row.recomputed.label", value: () => stamp(s(E.recomputed)) });
  valueRow(host, { id: E.notComputed, label: "card.sec.plan", problem: "page.plan.not_computed",
    sub: () => (s(E.notComputed) === "on" && WAITING_FOR[s(E.waitingFor)] ? t("page.plan.waits", { what: t(WAITING_FOR[s(E.waitingFor)]) }) : "") });
  valueRow(host, { id: E.overrideActive, label: "page.plan.forced_nolimit", problem: "page.plan.forced_30" });
  buttonRow(host, { id: E.recompute, label: "card.row.recompute.label", text: "card.row.recompute.button", ok: "card.row.recompute.ok" });
}

/* ---- 7 derniers jours: closed days from the device's Daily History, each with its plan from Daily Plan History
   (days closed since the firmware that has it), plus today so far. As piscine-card's « 7 derniers jours ». */
{
  const host = $("days");
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  /** "2026-11-13: 6.42 h 25.9/26.6 °C, 2026-11-12: 6.70 h" -> { "2026-11-13": {hours, lo, hi}, … } */
  const parse = (text) => Object.fromEntries([...String(text || "").matchAll(
    /(\d{4}-\d{2}-\d{2}): ([\d.]+) h(?: (-?[\d.]+)\/(-?[\d.]+) °C)?/g)]
    .map((m) => [m[1], { hours: +m[2], lo: m[3] === undefined ? NaN : +m[3], hi: m[4] === undefined ? NaN : +m[4] }]));
  const SHORT_TOLERANCE_H = 0.25; // under its plan by more than the day boundary and the minute rounding
  const isShort = (r) => Number.isFinite(r.hours) && Number.isFinite(r.planned) && r.hours < r.planned - SHORT_TOLERANCE_H;
  // The card's words (its « 7 derniers jours »)
  const title = (r) => {
    if (r.today) return t("card.days.tip_today");
    if (!Number.isFinite(r.hours)) return t("card.days.tip_nodata");
    if (!Number.isFinite(r.planned)) return t("card.days.tip_noplan");
    const gap = r.hours - r.planned;
    return t("card.days.tip_plan", { planned: fmt1(r.planned), gap: Math.abs(gap) < 0.05 ? t("card.days.plan_kept") : `${gap > 0 ? "+" : "−"}${fmt1(Math.abs(gap))} h` });
  };
  let drawn = "";
  updaters.push(() => {
    if (!st(E.history) && !st(E.hoursToday)) return;
    const today = new Date();
    const key = [s(E.history), s(E.planHistory), s(E.hoursToday), s(E.hoursPlanned), s(E.waterMin), s(E.waterMax), today.toDateString(), pageLang()].join("|");
    if (key === drawn) return;
    drawn = key;
    const closed = parse(s(E.history)), plans = parse(s(E.planHistory));
    const rows = [{ label: t("common.today_cap"), hours: n(E.hoursToday), planned: n(E.hoursPlanned), lo: n(E.waterMin), hi: n(E.waterMax), today: true }];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const label = `${fmt().date(d, { weekday: "short" })} ${fmt().date(d, { day: "2-digit", month: "2-digit" })}`;
      rows.push({ label: i === 1 ? t("common.yesterday_cap") : label, ...closed[dayKey(d)], planned: plans[dayKey(d)]?.hours });
    }
    const scale = Math.max(1, ...rows.flatMap((r) => [r.hours, r.planned]).filter(Number.isFinite));
    const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
    const water = (r) => Number.isFinite(r.lo) && Number.isFinite(r.hi) ? `${fmt1(r.lo)}–${fmt1(r.hi)}°` : "—";
    host.innerHTML = `<div class="day head"><span></span><span>${t("card.sec.filtration")}</span><span></span><span class="w">${t("card.days.water")}</span></div>`
      + rows.map((r) => {
        const known = Number.isFinite(r.hours);
        return `<div class="day${r.today ? " today" : ""}${known ? "" : " missing"}${!r.today && isShort(r) ? " short" : ""}"
          title="${title(r)}">
          <span class="lbl">${r.label}</span>
          <span class="bar">${known ? `<i style="width:${pct(r.hours)}"></i>` : ""}${Number.isFinite(r.planned) && r.planned > 0 ? `<b style="left:${pct(r.planned)}"></b>` : ""}</span>
          <span class="v num">${known ? `${fmt1(r.hours)} h` : "—"}</span>
          <span class="w num">${known ? water(r) : ""}</span></div>`;
      }).join("");
    const past = rows.filter((r) => !r.today && Number.isFinite(r.hours));
    host.appendChild(h(`<p class="foot">${past.length
      ? t("card.days.mean", { hours: fmt1(past.reduce((a, r) => a + r.hours, 0) / past.length), count: past.length })
      : t("card.days.none")} ${t("card.days.legend")}</p>`));
  });
}

/* ---- Wi-Fi and clock (wifi-setup.yaml) */
const AP_SSID = "pool-controller";
/** Clock Source (SNTP, Browser, None) -> its key. */
const CLOCK_SOURCE = { SNTP: "page.clock.sntp", Browser: "page.clock.browser", None: "page.clock.none" };
/** The device sends "0-00-00 00:00:00" for a clock that was never set. */
const clockSet = () => s(E.clockSource) !== "None" && /^\d{4}-/.test(s(E.clock) || "");
const quality = (dbm) => Math.max(0, Math.min(100, 2 * (dbm + 100))); // HA's dBm -> % rule of thumb
/** good / fair / weak (its steps are this page's bars below). */
const signalWord = (dbm) => t(`page.wifi.signal.${dbm >= -67 ? "good" : dbm >= -75 ? "fair" : "weak"}`);
const bars = (dbm) =>
  !Number.isFinite(dbm) ? "wifi-strength-outline"
  : dbm >= -55 ? "wifi-strength-4" : dbm >= -67 ? "wifi-strength-3" : dbm >= -75 ? "wifi-strength-2" : "wifi-strength-1";
/** wifi_info's scan_results: "SSID: -58dB" per line, strongest first. */
const nearby = () => String(s(E.nearby) || "").split("\n")
  .map((l) => /^(.+): (-?\d+)dB$/.exec(l.trim())).filter(Boolean).map((m) => ({ ssid: m[1], rssi: +m[2] }));
const mode = () => s(E.wifiMode);
const orDash = (id) => () => s(id) || "—";

{
  const hero = $("wifiHero"), rows = $("wifiRows"), nets = $("nets");
  const form = $("joinForm"), ssidIn = $("joinSsid"), pwIn = $("joinPw"), joinBtn = $("joinBtn");
  const connected = () => mode() === "Connected";
  // Network and signal are in the hero line above.
  valueRow(rows, { id: E.wifiBssid, label: "page.wifi.bssid", iconName: "router-wireless", visible: connected, value: orDash(E.wifiBssid) });
  valueRow(rows, { id: E.ip, label: "page.wifi.ip", iconName: "ip-network", visible: connected, value: orDash(E.ip) });
  valueRow(rows, { id: E.hotspotClients, label: "page.wifi.hotspot_clients", iconName: "access-point",
    visible: () => mode() === "Hotspot", value: () => String(n(E.hotspotClients) || 0) });
  valueRow(rows, { id: E.mac, label: "page.wifi.mac", iconName: "identifier", value: orDash(E.mac) });
  valueRow(rows, { id: E.disconnects, label: "page.wifi.disconnects", sub: "page.wifi.since_boot", iconName: "wifi-alert",
    value: () => String(n(E.disconnects) || 0) });

  let joiningTo = null, lastMode = null, netsKey = "";
  updaters.push(() => {
    // The section only exists on a firmware with wifi-setup.yaml.
    $("wifiStack").hidden = !st(E.wifiMode);
    if (!st(E.wifiMode)) return;
    const m = mode(), chip = $("wifiChip");
    chip.className = `chip ${m === "Connected" ? "ok" : m === "Hotspot" ? "warn" : ""}`;
    chip.textContent = t(m === "Connected" ? "page.wifi.chip.connected" : m === "Hotspot" ? "page.wifi.chip.hotspot" : "page.wifi.chip.connecting");
    hero.className = `wifi-hero ${m === "Hotspot" ? "hotspot" : m === "Connecting" ? "connecting" : ""}`;
    const clients = n(E.hotspotClients) || 0;
    const [ic, title, sub] =
      m === "Connected" ? [bars(n(E.wifiSignal)), t("page.wifi.connected_to", { ssid: s(E.wifiSsid) }),
        Number.isFinite(n(E.wifiSignal)) ? t("page.wifi.signal_line", { dbm: n(E.wifiSignal), pct: quality(n(E.wifiSignal)), word: signalWord(n(E.wifiSignal)) }) : ""]
      : m === "Hotspot" ? ["access-point", t("page.wifi.hotspot_named", { ssid: AP_SSID }),
        `${t("page.wifi.hotspot_open", { count: clients })} · http://192.168.4.1`]
      : ["wifi-sync", t("page.wifi.connecting_to", { ssid: joiningTo || s(E.joinSsid) || "…" }), t("page.wifi.up_to_30s")];
    hero.innerHTML = `<span class="ic">${icon(ic)}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span>`;

    // The outcome of a join this page asked for.
    if (lastMode === "Connecting" && m !== "Connecting" && joiningTo) {
      if (m === "Connected" && s(E.wifiSsid) === joiningTo) toast(t("page.wifi.joined", { ssid: joiningTo }));
      else toast(t("page.wifi.join_failed", { ssid: joiningTo }), true);
      joiningTo = null;
    }
    lastMode = m;
    joinBtn.disabled = m === "Connecting";
    $("joinHint").textContent = t(m === "Hotspot" ? "page.wifi.join_hint_hotspot" : "page.wifi.join_hint", { url: "http://pool-controller.local" });

    const list = nearby(), current = connected() ? s(E.wifiSsid) : null;
    const key = JSON.stringify([list, current, pageLang()]);
    if (key === netsKey) return;
    netsKey = key;
    nets.innerHTML = list.length ? "" : `<p class="hint">${t("page.wifi.none")}</p>`;
    for (const net of list) {
      const b = h(`<button type="button" class="net"><span class="ic">${icon(bars(net.rssi))}</span>
        <span class="ssid"></span>${net.ssid === current ? `<span class="tag">${t("page.wifi.tag_connected")}</span>` : ""}<span class="dbm num">${net.rssi} dBm</span></button>`);
      b.querySelector(".ssid").textContent = net.ssid;
      b.setAttribute("aria-current", String(net.ssid === current));
      b.addEventListener("click", () => {
        ssidIn.value = net.ssid;
        pwIn.focus();
      });
      nets.appendChild(b);
    }
  });

  $("pwShow").addEventListener("click", (ev) => {
    const show = pwIn.type === "password";
    pwIn.type = show ? "text" : "password";
    ev.currentTarget.innerHTML = icon(show ? "eye-off" : "eye");
    ev.currentTarget.title = t(show ? "page.pw.hide" : "page.pw.show");
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const ssid = ssidIn.value.trim(), pw = pwIn.value;
    if (!ssid) return;
    if (pw.length && pw.length < 8) return toast(t("page.wifi.pw_short"), true);
    if (connected() && ssid !== s(E.wifiSsid) &&
        !confirm(t("page.wifi.confirm_switch", { from: s(E.wifiSsid), to: ssid, url: "http://pool-controller.local" }))) return;
    joinBtn.classList.add("busy");
    try {
      await hass.setText(E.joinSsid, ssid);
      await hass.setText(E.joinPassword, pw); // held by the device, never sent back
      await hass.press(E.join);
      joiningTo = ssid;
      pwIn.value = "";
    } catch (e) {
      toast(refusedMsg(e), true);
    } finally {
      joinBtn.classList.remove("busy");
    }
  });
}

/* ---- Firmware: the version it runs (Firmware Version: the commit `make` compiled, or a release's tag), ESPHome's, its
   updates (updates.yaml), then how long it has run and its chip's temperature. Updates: the Firmware update entity
   behind the controller's own gate, « Vérifier » (Check for Update), « Installer », « Annuler la demande » while an
   install waits (Cancel Update), Auto Update (scheduled checks only) and Update Check Interval. Whether a newer firmware exists is the controller's to say: the page asks GitHub
   nothing (a firmware without updates.yaml just has no « Mise à jour » row). */
{
  const Card = customElements.get("piscine-card"), host = $("fwRows");
  const version = () => Card.parseVersion(s(E.fwVersion)), esphome = () => Card.parseEsphome(s(E.esphomeVersion));
  const hasUpdates = () => !!st(E.fwUpdate);
  valueRow(host, { id: E.fwVersion, label: "page.fw.version", iconName: "tag-outline", value: () => version()?.label || "—", sub: () => version()?.sub || "" });
  valueRow(host, { id: E.esphomeVersion, name: "ESPHome", iconName: "chip", value: () => esphome()?.version || "—", sub: () => esphome()?.built || "" });

  /** A row whose sub-line is drawn only when it changes: a link rebuilt every second would lose its hover. */
  const statusRow = (buttons) => {
    const row = h(`<div class="erow"><span class="ic">${icon("cloud-sync-outline")}</span><span class="name"><span></span><small></small></span>
      ${buttons.map((b) => `<button class="btn${b.fill ? " fill" : ""}"></button>`).join("")}</div>`);
    host.appendChild(row);
    let drawn = "";
    const small = row.querySelector("small"), btns = [...row.querySelectorAll("button")];
    return {
      row, buttons: btns,
      draw(r) {
        const key = [r.text, r.cls, r.href, r.link, pageLang()].join("|");
        if (key === drawn) return;
        drawn = key;
        row.querySelector(".name span").textContent = t("card.fw.update");
        btns.forEach((b, i) => { b.textContent = t(buttons[i].text); });
        small.className = r.cls || ""; small.textContent = r.text;
        if (r.href) small.append(" ", h(`<a href="${esc(r.href)}" target="_blank" rel="noopener">${esc(r.link)}</a>`));
      },
    };
  };

  /* -- updates.yaml: the controller checks the releases and installs through its gate */
  {
    const { row, buttons: [check, install, cancel], draw } = statusRow(
      [{ text: "card.fw.check" }, { text: "card.fw.install", fill: true }, { text: "card.fw.cancel_request" }]);
    const fw = () => st(E.fwUpdate)?.attributes || {};
    // An older firmware (before 1.11.0) says Update Status and the interval's options in French: read as their codes.
    const LEGACY_UPDATE = { "non vérifié": "unchecked", "vérification": "checking", "à jour": "up_to_date", "disponible": "available", // i18n-ignore: an old firmware's words
      "installation": "installing", "en attente (mode manuel)": "pending:override", "en attente (remplissage)": "pending:fill",
      "erreur (vérification)": "error:check", "erreur (installation)": "error:install" }; // i18n-ignore: an old firmware's words
    const LEGACY_INTERVAL = { "À la demande": "on_request", "6 h": "6h", "24 h": "24h", "7 j": "7d" }; // i18n-ignore: an old firmware's options
    /** Update Check Interval's option (a code, or an older firmware's French) in words. */
    const intervalLabel = (o) => {
      const c = LEGACY_INTERVAL[o] || o, m = /^(\d+)([hd])$/.exec(c);
      return c === "on_request" ? t("card.fw.opt.on_request") : !m ? o : m[2] === "h" ? `${m[1]} h` : t("card.fw.opt.days", { count: +m[1] });
    };
    const status = () => { const v = s(E.updateStatus) || ""; return LEGACY_UPDATE[v] || v; };
    let installed = null; // the installed version last seen: a change after a reboot is an update done
    /** Update Status (the firmware's code) -> the sentence under « Mise à jour ». */
    const sentence = () => {
      const a = fw(), latest = a.latest_version || t("page.fw.new_version"), now = a.installed_version || "—";
      const st_ = status(), every = LEGACY_INTERVAL[s(E.updateInterval)] || s(E.updateInterval);
      if (!hass.connected && (st_ === "installing" || a.in_progress)) return { text: t("page.fw.rebooting"), cls: "fw-up" };
      if (st_ === "installing" || a.in_progress) return { text: t("page.fw.installing", { version: latest }), cls: "fw-up" };
      if (st_.startsWith("pending:")) return { text: t(st_ === "pending:fill" ? "page.fw.pending_fill" : "page.fw.pending_override", { version: latest }), cls: "fw-up" };
      if (st_ === "checking") return { text: t("page.fw.checking") };
      // Also every check until a first release is published: the controller only knows it got no answer.
      if (st_ === "error:check") return { text: t("page.fw.error_check"), cls: "fw-err" };
      if (st_ === "error:install") return { text: t("page.fw.error_install", { version: latest, installed: now }), cls: "fw-err" };
      if (st(E.fwUpdate).state === "on") return { text: t("page.fw.available", { version: latest, installed: now }), cls: "fw-up", href: a.release_url, link: t("card.fw.notes") };
      if (st(E.fwUpdate).state === "off") return { text: t("page.fw.up_to_date", { installed: now }), cls: "fw-ok" };
      return { text: every && every !== "on_request" ? t("page.fw.not_checked_every", { every: intervalLabel(every) }) : t("page.fw.not_checked") };
    };
    check.addEventListener("click", () => {
      check.classList.add("busy");
      run(hass.press(E.checkUpdate)).finally(() => check.classList.remove("busy"));
    });
    install.addEventListener("click", () => {
      const a = fw();
      if (!confirm(t("page.fw.confirm_install", { version: a.latest_version }))) return;
      install.classList.add("busy");
      run(hass.install(E.fwUpdate), "page.fw.install_requested").finally(() => install.classList.remove("busy"));
    });
    cancel.addEventListener("click", () => {
      cancel.classList.add("busy");
      run(hass.press(E.cancelUpdate), "card.fw.cancelled").finally(() => cancel.classList.remove("busy"));
    });
    updaters.push(() => {
      row.hidden = !hasUpdates();
      if (row.hidden) return;
      const a = fw(), st_ = status();
      const busy = st_ === "installing" || st_.startsWith("pending:") || a.in_progress;
      check.disabled = !hass.connected || busy || st_ === "checking" || !st(E.checkUpdate);
      install.hidden = st(E.fwUpdate).state !== "on" || busy;
      install.disabled = !hass.connected;
      // Only while the install waits at the gate: the controller ignores it otherwise.
      cancel.hidden = !st_.startsWith("pending:") || !st(E.cancelUpdate);
      cancel.disabled = !hass.connected;
      draw(sentence());
      if (a.installed_version && installed && a.installed_version !== installed) toast(t("page.fw.updated", { version: a.installed_version }));
      if (a.installed_version) installed = a.installed_version;
    });

    /* -- An install, step by step, under « Mise à jour »: requested (and what it waits for), the download (Update
       Progress: written to flash as it arrives), the reboot, then installed. The page reloads onto the new firmware
       (esphome-hass.js), so the version it waits for is kept in sessionStorage to say « Installée » after it. */
    const STEPS = ["requested", "download", "reboot", "installed"]; // their words: page.fw.steps.*
    const inst = h(`<div class="fw-inst" hidden aria-live="polite">
      <ol class="fw-steps">${STEPS.map(() => "<li><i></i><span></span></li>").join("")}</ol>
      <div class="prog"><i></i></div>
      <p class="fw-line"><span></span><b class="num"></b></p></div>`);
    row.after(inst);
    const [bar, [line, pct]] = [inst.querySelector(".prog"), inst.querySelectorAll(".fw-line > *")];
    const KEY = "pool-fw-install";
    const saved = () => { try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; } };
    const save = (v) => { try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } };
    const DONE_MS = 60_000; // « Installée » stays this long after the reboot
    let watched = false, drawnInst = "";
    /** Where the install is: { step, state ("on" | "err" | "done"), pct (number, or null for an unknown amount), text }. */
    const phase = () => {
      const a = fw(), st_ = status(), p = n(E.updateProgress), latest = a.latest_version || t("page.fw.new_version");
      const job = saved();
      if (job?.to && a.installed_version === job.to && !a.in_progress) {
        if (Date.now() - job.at > DONE_MS) return save(null), null;
        return { step: 3, state: "done", pct: 100, text: t("page.fw.inst.done", { version: job.to }) };
      }
      if (st_.startsWith("pending:")) return { step: 0, state: "on", text: t(st_ === "pending:fill" ? "page.fw.inst.wait_fill" : "page.fw.inst.wait_override") };
      if (a.in_progress && !hass.connected) return { step: 2, state: "on", pct: null, text: t("page.fw.inst.rebooting", { version: latest }) };
      if (a.in_progress && p >= 100) return { step: 2, state: "on", pct: null, text: t("page.fw.inst.verifying") };
      if (a.in_progress && Number.isFinite(p)) return { step: 1, state: "on", pct: p, text: t("page.fw.inst.downloading", { version: latest }) };
      if (a.in_progress || st_ === "installing") return { step: 1, state: "on", pct: null, text: t("page.fw.inst.connecting") };
      if (st_ === "error:install" && watched) return { step: 1, state: "err", text: t("page.fw.inst.failed", { version: a.installed_version || t("page.fw.inst.its_version") }) };
      return null;
    };
    updaters.push(() => {
      const ph = hasUpdates() ? phase() : null;
      if (ph && ph.state === "on") {
        watched = true;
        if (saved()?.to !== fw().latest_version) save({ to: fw().latest_version, at: Date.now() });
      }
      if (ph?.state === "on" && ph.step === 2) save({ ...saved(), at: Date.now() }); // « Installée » counts from the reboot
      const key = JSON.stringify(ph && [ph.step, ph.state, ph.pct == null ? null : Math.floor(ph.pct), ph.text, pageLang()]);
      if (key === drawnInst) return;
      drawnInst = key;
      inst.hidden = !ph;
      if (!ph) return;
      inst.querySelectorAll(".fw-steps li").forEach((li, i) => {
        li.className = i < ph.step ? "done" : i === ph.step ? ph.state : "";
        li.querySelector("span").textContent = t(`page.fw.steps.${STEPS[i]}`);
      });
      bar.hidden = ph.step === 0 || ph.state === "err";
      bar.classList.toggle("ind", ph.pct === null);
      bar.classList.toggle("ok", ph.state === "done");
      bar.firstElementChild.style.width = ph.pct == null ? "" : `${Math.max(2, Math.min(100, ph.pct))}%`;
      inst.classList.toggle("err", ph.state === "err");
      line.textContent = ph.text;
      pct.textContent = ph.step === 1 && ph.pct != null ? `${Math.floor(ph.pct)} %` : "";
    });

    /** A segmented control on a switch or a select: [label, value] pairs, the entity's state picks one. Keys. */
    const segRow = ({ id, label, sub, iconName, options, set }) => {
      const r = h(`<div class="erow"><span class="ic">${icon(iconName)}</span><span class="name"><span></span><small></small></span>
        <span class="ctl"><span class="seg" role="radiogroup"></span></span></div>`);
      const seg = r.querySelector(".seg");
      host.appendChild(r);
      let drawn = "";
      updaters.push(() => {
        r.hidden = !st(id);
        if (r.hidden) return;
        const opts = options(), key = JSON.stringify([opts, s(id), pageLang()]);
        if (key === drawn) return;
        drawn = key;
        r.querySelector(".name span").textContent = t(label);
        r.querySelector("small").textContent = t(sub);
        seg.setAttribute("aria-label", t(label));
        seg.innerHTML = "";
        for (const [text, value] of opts) {
          const b = h(`<button role="radio" aria-checked="${s(id) === value}"></button>`);
          b.textContent = text;
          b.addEventListener("click", () => s(id) !== value && run(set(value)));
          seg.appendChild(b);
        }
      });
    };
    segRow({ id: E.autoUpdate, label: "page.fw.auto", iconName: "timer-check", sub: "page.fw.auto_sub",
      options: () => [[t("page.no"), "off"], [t("page.yes"), "on"]],
      set: (v) => hass.callService("switch", v === "on" ? "turn_on" : "turn_off", { entity_id: E.autoUpdate }) });
    segRow({ id: E.updateInterval, label: "page.fw.interval", iconName: "timer-outline", sub: "page.fw.interval_sub",
      options: () => (st(E.updateInterval)?.attributes.options || []).map((o) => [intervalLabel(o), o]),
      set: (v) => hass.select(E.updateInterval, v) });
  }

  /* -- the controller's health: how long it has run (the event stream's pings, every second, with or without the Uptime
     sensor) and since when, and Chip Temperature (the ESP32's own sensor; some chips never give a reading) */
  const upSec = () => (hass.uptime === null ? NaN : hass.uptime + (Date.now() - hass.uptimeAt) / 1000);
  valueRow(host, { label: "card.fw.uptime", iconName: "clock-outline", value: () => duration(upSec()),
    sub: () => (Number.isFinite(upSec()) ? t("card.fw.restarted", { when: clock(hass.uptimeAt - hass.uptime * 1000) }) : "") });
  const chipC = () => n(E.chipTemp);
  valueRow(host, { id: E.chipTemp, label: "card.fw.chip_temp", iconName: "thermometer-lines",
    value: () => (Number.isFinite(chipC()) ? `${fmt1(chipC())} °C` : "—"),
    sub: () => t(Number.isFinite(chipC()) ? "card.fw.chip_temp_sub" : "card.fw.chip_temp_none") });
}

/* ---- Alerts above both tabs: on the hotspot, and a clock that was never set */
{
  const host = $("alerts");
  let clockTried = false, drawn = "";
  const localStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const setClock = () => {
    const d = new Date();
    return run(hass.setDateTime(E.clock, localStamp(d)), () => t("page.clock.set", { time: clock(d) }));
  };
  const goWifi = () => (location.hash = "#wifi");
  updaters.push(() => {
    // No internet, no SNTP: the device can't place today's plan. This page has a clock; hand it over,
    // once per page load, and only when the device has none at all.
    const noClock = hass.connected && s(E.clockSource) === "None";
    if (noClock && !clockTried && st(E.clock)) {
      clockTried = true;
      setClock();
    }
    const hotspot = mode() === "Hotspot";
    const key = `${hotspot}|${noClock}|${pageLang()}`;
    if (key === drawn) return;
    drawn = key;
    host.innerHTML = "";
    if (hotspot) {
      const b = h(`<div class="banner info">${icon("access-point")}<span>${esc(t("page.alert.hotspot", { ssid: AP_SSID }))}</span><button class="btn">${t("page.alert.hotspot_btn")}</button></div>`);
      b.querySelector("button").addEventListener("click", goWifi);
      host.appendChild(b);
    }
    if (noClock) {
      const b = h(`<div class="banner">${icon("clock-alert-outline")}<span>${t("page.alert.no_clock")}</span><button class="btn">${t("page.alert.no_clock_btn")}</button></div>`);
      b.querySelector("button").addEventListener("click", setClock);
      host.appendChild(b);
    }
  });
}

/* ---- The login screen while the controller asks for its Page Password (login.js), and the session kept alive while
   someone uses the page (session.js): the event stream alone doesn't, so a tab left open logs out after 6 h. */
const session = keepAlive({ send: () => hass.checkSession() });
const login = mountLogin({
  ui: { icon },
  onLogin: () => {
    session.refreshed();
    hass.connect();
  },
  onLogout: () => hass.disconnect(),
});
hass.addEventListener("login-required", () => login.show());
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => login.shown || session.input(), { capture: true, passive: true });
document.addEventListener("visibilitychange", () => document.hidden || login.shown || session.input());

/* ---- Setup: the wizard while the controller isn't set up, and the Réglages contrôleur tab's Position, Sondes,
   Accès, Home Assistant and Réinitialiser sections (setup.js) */
updaters.push(mountSetup({ hass, E, login, ui: { icon, esc, toast, fmt1, bars } }));

/* ---- Capteurs internes */
const KNOWN = new Set(Object.values(E));
{
  const host = $("deviceRows");
  valueRow(host, { label: "page.device.link", iconName: "lan-connect",
    value: () => t(hass.connected ? "page.device.link_ok" : "page.device.link_lost") });
  valueRow(host, { label: "page.device.last_event", iconName: "information-outline",
    value: () => (hass.lastEventAt ? t("page.device.ago_s", { s: Math.round((Date.now() - hass.lastEventAt) / 1000) }) : "—") });
  valueRow(host, { label: "page.device.controller", iconName: "chip",
    value: () => hass.config.title || "—", sub: () => hass.config.comment || "" });
  valueRow(host, { id: E.haLink, name: "Home Assistant", iconName: "home-assistant", sub: "page.device.ha_sub",
    value: () => t(s(E.haLink) === "on" ? "page.device.ha_on" : "page.device.ha_off") });
  valueRow(host, { id: E.clock, label: "page.device.clock", iconName: () => (clockSet() ? "clock-check-outline" : "clock-alert-outline"),
    value: () => (clockSet() ? stamp(s(E.clock)) : t("page.device.clock_unset")), sub: () => (CLOCK_SOURCE[s(E.clockSource)] ? t(CLOCK_SOURCE[s(E.clockSource)]) : "") });
  sect(host, "page.device.sensors");
  valueRow(host, { id: E.water, label: "card.row.water.label", iconName: "thermometer-water" });
  valueRow(host, { id: E.pad, label: "card.row.pad.label", iconName: "home-thermometer-outline" });
  valueRow(host, { id: E.outdoor, label: "card.row.outdoor.label", iconName: "weather-partly-cloudy" });
  valueRow(host, { id: E.flow, label: "page.device.flow", visible: () => !fillOff() });
  valueRow(host, { id: E.volume, label: "page.device.volume", visible: () => !fillOff() });
  buttonRow(host, { id: E.updateTemps, label: "card.row.updateTemps.label", iconName: "thermometer", text: "card.row.updateTemps.button", ok: "card.row.updateTemps.ok" });
  const others = h(`<div></div>`);
  host.appendChild(others);
  let seen = "";
  updaters.push(() => {
    // Anything the YAML gains later (Wi-Fi signal, ESP temperature…) shows up here without a page change.
    const ids = Object.keys(hass.states).filter((id) => !KNOWN.has(id)).sort();
    if (ids.join() === seen) return;
    seen = ids.join();
    others.innerHTML = "";
    if (ids.length) sect(others, "page.device.others");
    // the entities' own names, as the firmware gives them (English)
    for (const id of ids) {
      const domain = st(id).attributes.domain;
      if (domain === "number") numberRow(others, { id, name: st(id).attributes.friendly_name });
      else if (domain === "button") buttonRow(others, { id, name: st(id).attributes.friendly_name });
      else valueRow(others, { id, name: st(id).attributes.friendly_name });
    }
    for (const u of updaters) u();
  });
}

/* ================================================================ Réglages contrôleur › Journal */

const LOG_FILTERS = { all: () => true, warn: (l) => l.level === "warn" || l.level === "error", error: (l) => l.level === "error" };
let logFilter = "all", logPaused = false;
const logBox = $("log");
function logLine(l) {
  const d = new Date(l.t);
  const row = document.createElement("div");
  row.className = l.level;
  row.innerHTML = `<span class="t">${fmt().time(d, { second: "2-digit" })}</span>` +
    `${l.tag ? `<span class="tag">[${esc(l.tag)}]</span> ` : ""}${esc(l.msg)}`;
  return row;
}
function renderLog() {
  logBox.innerHTML = "";
  const lines = hass.logs.filter(LOG_FILTERS[logFilter]);
  if (!lines.length) logBox.innerHTML = `<div class="none">${t("page.log.none")}</div>`;
  for (const l of lines) logBox.appendChild(logLine(l));
  $("logCount").textContent = t("page.log.count", { count: hass.logs.length });
  scrollLogToEnd();
}
function scrollLogToEnd() {
  logBox.scrollTop = logBox.scrollHeight;
}
hass.addEventListener("log", (ev) => {
  if (logPaused) return;
  if (!LOG_FILTERS[logFilter](ev.detail)) return;
  const atEnd = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
  logBox.querySelector(".none")?.remove();
  logBox.appendChild(logLine(ev.detail));
  while (logBox.childElementCount > 500) logBox.firstElementChild.remove();
  $("logCount").textContent = t("page.log.count", { count: hass.logs.length });
  if (atEnd) scrollLogToEnd();
});
for (const b of document.querySelectorAll("#logSeg button")) {
  b.addEventListener("click", () => {
    logFilter = b.dataset.f;
    document.querySelectorAll("#logSeg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    renderLog();
  });
}
$("logPause").addEventListener("click", (ev) => {
  logPaused = !logPaused;
  ev.currentTarget.innerHTML = `${icon(logPaused ? "play" : "pause")}`;
  ev.currentTarget.title = t(logPaused ? "page.log.resume" : "page.log.pause");
  ev.currentTarget.setAttribute("aria-label", ev.currentTarget.title);
  if (!logPaused) renderLog();
});
$("logClear").addEventListener("click", () => {
  hass.logs.length = 0;
  renderLog();
});

/* ================================================================ wiring */

/**
 * The page's language: its static texts, the EN | FR | ES switch in each header, and Home Assistant's locale for the
 * card (which follows it). Run at load and on every change of language.
 */
function applyLang() {
  applyStatic();
  document.title = t("page.title"); // on the device, ESPHome's own <title>
  document.querySelectorAll("[data-langs]").forEach((el) => (el.innerHTML = langSwitch()));
  hass.language = pageLang();
  hass.locale = { language: pageLang(), number_format: "language", time_format: "language" };
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-lang]");
  if (b) setLang(b.dataset.lang);
});
onLang(() => {
  applyLang();
  if (logPaused) $("logPause").title = t("page.log.resume");
  renderLog();
  update();
});
applyLang();
document.querySelectorAll("[data-icon]").forEach((e) => (e.innerHTML = icon(e.dataset.icon) + e.innerHTML));

function update() {
  updateControl();
  for (const u of updaters) u();
}
hass.addEventListener("change", update);
setInterval(update, 1000); // uptime, "il y a … s"

route();
renderLog();
hass.connect();
