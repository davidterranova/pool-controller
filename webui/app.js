/*
 * The controller's own page: « Contrôle » runs Home Assistant's piscine-card (unchanged, fed by
 * esphome-hass.js) next to HA-style tiles; « Avancé » has the settings, today's plan, the device's
 * sensors and its live log; « Wi-Fi » (wifi-setup.yaml) its connection, statistics and a way to
 * join a network. No charts: the device keeps no history of its sensors, only what it records
 * itself (today's water min/max, and each of the last 7 days). Everything talks to the ESP32 only,
 * so it keeps working while Home Assistant is down.
 */
import { EspHass, E } from "./esphome-hass.js";
import { ICONS } from "./icons.js";

const hass = new EspHass();
const $ = (id) => document.getElementById(id);
const st = (id) => hass.states[id];
const s = (id) => st(id)?.state;
const n = (id) => parseFloat(s(id));
const shown = (id) => st(id)?.attributes.display ?? s(id) ?? "—";
const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1).replace(".", ",") : "–");
const pad2 = (v) => String(v).padStart(2, "0");
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const SPEED_FR = { Off: "Arrêt", Low: "Low", Medium: "Medium", High: "High", Auto: "Auto" };

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
  if (d) return `${d} j ${hr} h ${pad2(m)} min`;
  if (hr) return `${hr} h ${pad2(m)} min`;
  return `${m} min ${pad2(Math.floor(sec % 60))} s`;
}
/** ms -> "HH:MM" today, else "DD/MM HH:MM". */
function clock(t) {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hm}`;
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
const run = (p, ok) => p.then(() => ok && toast(ok)).catch((e) => toast(`Refusé par le contrôleur (${e.message})`, true));

/* ================================================================ tabs */

const TABS = ["controle", "avance", "wifi"];
let tab = "controle";
function route() {
  const want = location.hash.slice(1);
  tab = TABS.includes(want) ? want : "controle";
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== tab;
    document.querySelector(`.tabs a[data-tab="${t}"]`).setAttribute("aria-selected", String(t === tab));
  }
  if (tab === "avance") scrollLogToEnd();
  scrollTo({ top: 0 });
}
addEventListener("hashchange", route);
addEventListener("popstate", route);
addEventListener("location-changed", route); // what piscine-card fires after its own pushState

/* ================================================================ « Contrôle » */

const card = document.createElement("piscine-card");
card.setConfig({
  variant: "panel",
  more_path: "#avance", // its « Planning, réglages et remplissage » link opens the Avancé tab
  entities: {
    override: E.override, commanded: E.commanded, planned: E.planned, nextAt: E.nextAt, nextTo: E.nextTo,
    b1s: E.b1s, b1e: E.b1e, b2s: E.b2s, b2e: E.b2e, hoursToday: E.hoursToday, hoursPlanned: E.hoursPlanned,
    water: E.water, outdoor: E.outdoor, online: E.online, stuck: E.overrideActive, notComputed: E.notComputed,
    recomputed: E.recomputed, boostInterval: E.boostInterval, boostDuration: E.boostDuration,
    highEvery: E.highEvery, timeout: E.timeout, endsAt: E.endsAt,
    sun: "sun.sun", // not on the device: the timeline just has no sunrise/sunset marks
  },
});
$("cardHost").appendChild(card);
let cardReady = false;

/** "25,9 – 26,6 °C" from two sensors, or null while either is unknown. */
function range(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `${fmt1(lo)} – ${fmt1(hi)} °C` : null;
}

const TILES = [
  { id: E.water, name: "Bassin", icon: "thermometer-water", group: "temps", full: true,
    // Today's min/max, kept by the controller (pumping readings only: the probe is on the return pipe).
    sub: () => st(E.waterMin) && (range(n(E.waterMin), n(E.waterMax))
      ? `Aujourd'hui ${range(n(E.waterMin), n(E.waterMax))}` : "Aujourd'hui : pas encore mesurée"),
    subTitle: "Minimum et maximum depuis minuit, mesurés pompe en marche (la sonde est sur le retour)" },
  { id: E.outdoor, name: "Extérieure", icon: "weather-partly-cloudy", group: "temps" },
  { id: E.pad, name: "Local technique", icon: "home-thermometer-outline", group: "temps" },
  { id: E.flow, name: "Débit de remplissage", icon: "water-pump", group: "water" },
  { id: E.volume, name: "Volume total rempli", icon: "water", group: "water" },
];
for (const t of TILES) {
  t.el = h(`<div class="card tile${t.full ? " full" : ""}">
    <div class="row"><span class="ic">${icon(t.icon)}</span>
      <span class="txt"><div class="name">${t.name}</div><div class="state num"></div>
        ${t.sub ? `<div class="sub num" title="${t.subTitle}"></div>` : ""}</span></div></div>`);
  $(t.group === "temps" ? "tilesTemps" : "tilesWater").appendChild(t.el);
}

function updateControl() {
  if (!cardReady && st(E.override)) {
    card.hass = hass;
    // Built for a Bubble pop-up: the close button has nothing to close here.
    card.shadowRoot.getElementById("close").hidden = true;
    cardReady = true;
  } else if (cardReady) card.hass = hass;
  for (const t of TILES) {
    t.el.querySelector(".state").textContent = shown(t.id);
    if (t.sub) {
      const sub = t.el.querySelector(".sub"), text = t.sub();
      sub.hidden = !text;
      sub.textContent = text || "";
    }
  }
  $("subtitle").textContent = `${fmt1(n(E.water))} °C · ${s(E.commanded) ?? "–"} · ${fmt1(n(E.hoursToday))} h`;
  const c = $("conn");
  c.className = `chip ${hass.connected ? "ok" : "bad"}`;
  c.textContent = hass.connected ? "Connecté au contrôleur" : "Connexion perdue…";
}

/* ================================================================ « Avancé »: entity rows */

const updaters = [];

/** Read-only row: icon, label (+ sub-label), value. `value` defaults to the entity's display state. */
function valueRow(host, { id, label, sub, iconName, value, problem, visible }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small></small></span><span class="val num"></span></div>`);
  row.querySelector(".name span").textContent = label;
  host.appendChild(row);
  updaters.push(() => {
    const e = id ? st(id) : null;
    row.hidden = (!!id && !e) || (!!visible && !visible());
    if (row.hidden) return;
    row.querySelector(".ic").innerHTML = icon(typeof iconName === "function" ? iconName() : iconName || e?.attributes.icon);
    const subText = typeof sub === "function" ? sub() : sub || "";
    row.querySelector("small").textContent = subText;
    row.querySelector("small").hidden = !subText;
    const val = row.querySelector(".val");
    if (problem) {
      const on = e.state === "on";
      val.textContent = on ? problem : "OK";
      val.className = `val ${on ? "bad" : "good"}`;
      row.classList.toggle("problem", on);
    } else val.textContent = value ? value() : shown(id);
  });
  return row;
}

/** Number row: slider + value, written when released (the HA entities-card slider row). */
function numberRow(host, { id, label, sub }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small></small></span>
    <span class="ctl"><input type="range"><span class="v num"></span></span></div>`);
  row.querySelector(".name span").textContent = label;
  row.querySelector("small").textContent = sub || "";
  row.querySelector("small").hidden = !sub;
  const input = row.querySelector("input"), out = row.querySelector(".v");
  input.setAttribute("aria-label", label);
  let editing = 0; // until when the slider wins over pushed states
  const unit = () => st(id)?.attributes.unit_of_measurement || "";
  const decimals = () => {
    const step = String(st(id)?.attributes.step ?? 1);
    return step.includes(".") ? step.split(".")[1].length : 0;
  };
  const label_ = (v) => `${(+v).toFixed(decimals()).replace(".", ",")} ${unit()}`.trim();
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

function buttonRow(host, { id, label, sub, iconName, text = "Appuyer", ok, fill, disabled }) {
  const row = h(`<div class="erow"><span class="ic"></span><span class="name"><span></span><small></small></span><button class="btn"></button></div>`);
  row.querySelector(".name span").textContent = label;
  row.querySelector("small").textContent = sub || "";
  row.querySelector("small").hidden = !sub;
  const b = row.querySelector("button");
  b.textContent = text;
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
    row.querySelector(".ic").innerHTML = icon(iconName || e.attributes.icon);
    b.disabled = disabled ? disabled() : false;
  });
  return row;
}
const sect = (host, text) => host.appendChild(h(`<div class="sect">${esc(text)}</div>`));

/* ---- Réglages */
{
  const host = $("settingsRows");
  const pending = () => s(E.pending) === "on";
  updaters.push(() => {
    $("pendingChip").hidden = !pending();
    $("pendingBanner").hidden = !pending();
  });
  $("applyNow").addEventListener("click", (ev) => {
    ev.target.classList.add("busy");
    run(hass.press(E.apply), "Réglages appliqués : plan du jour recalculé").finally(() => ev.target.classList.remove("busy"));
  });
  sect(host, "Durée de filtration · s'applique avec « Appliquer »");
  numberRow(host, { id: E.min, label: "Filtration minimale", sub: "Plancher, même par eau froide" });
  numberRow(host, { id: E.max, label: "Filtration maximale", sub: "Plafond, même en pleine chaleur" });
  numberRow(host, { id: E.offset, label: "Ajustement de durée", sub: "Ajouté à la durée calculée" });
  numberRow(host, { id: E.warm, label: "Décalage du pic de chaleur", sub: "Centre du 2ᵉ bloc par rapport au midi solaire" });
  buttonRow(host, { id: E.apply, label: "Appliquer les réglages", sub: "Recalcule le plan du jour", text: "Appliquer", fill: true,
    ok: "Réglages appliqués : plan du jour recalculé", disabled: () => !pending() });
  sect(host, "Impulsions · immédiat");
  numberRow(host, { id: E.boostDuration, label: "Durée d'une impulsion" });
  numberRow(host, { id: E.boostInterval, label: "Intervalle entre impulsions", sub: "0 = pas d'impulsion" });
  numberRow(host, { id: E.highEvery, label: "Une impulsion High toutes les", sub: "Les autres sont en Medium" });
  sect(host, "Override manuel · immédiat");
  numberRow(host, { id: E.timeout, label: "Retour automatique en Auto après", sub: "0 = jamais (alerte après 30 min)" });
}

/* ---- Plan du jour */
{
  const host = $("planRows");
  // "--:--" when there is none; start == end when the firmware folded block 2 into block 1.
  const range = (a, b) => () => (s(a) && s(a) !== "--:--" && s(a) !== s(b) ? `${s(a)} → ${s(b)}` : "—");
  valueRow(host, { id: E.hoursPlanned, label: "Durée planifiée" });
  valueRow(host, { id: E.hoursToday, label: "Filtrée aujourd'hui",
    sub: () => (n(E.hoursPlanned) > 0 ? `${Math.round((n(E.hoursToday) / n(E.hoursPlanned)) * 100)} % du plan` : "") });
  valueRow(host, { id: E.b1s, label: "Bloc 1", iconName: "clock-start", value: range(E.b1s, E.b1e) });
  valueRow(host, { id: E.b2s, label: "Bloc 2", iconName: "clock-end", value: range(E.b2s, E.b2e) });
  valueRow(host, { id: E.planned, label: "Vitesse du plan maintenant", value: () => SPEED_FR[s(E.planned)] || s(E.planned) });
  valueRow(host, { id: E.commanded, label: "Vitesse commandée", value: () => SPEED_FR[s(E.commanded)] || s(E.commanded),
    sub: () => (s(E.override) && s(E.override) !== "Auto" ? `Override manuel : ${SPEED_FR[s(E.override)]}` : "Suit le plan") });
  valueRow(host, { id: E.nextAt, label: "Prochain changement",
    value: () => (s(E.nextAt) && s(E.nextAt) !== "--:--" ? `${s(E.nextAt)} → ${SPEED_FR[s(E.nextTo)] || s(E.nextTo)}` : "Plus rien aujourd'hui") });
  valueRow(host, { id: E.nextBoostStart, label: "Prochaine impulsion", value: range(E.nextBoostStart, E.nextBoostEnd) });
  valueRow(host, { id: E.recomputed, label: "Plan calculé à", value: () => stamp(s(E.recomputed)) });
  valueRow(host, { id: E.notComputed, label: "Plan du jour", problem: "Non calculé" });
  valueRow(host, { id: E.overrideActive, label: "Override sans limite", problem: "Depuis plus de 30 min" });
  buttonRow(host, { id: E.recompute, label: "Recalculer le plan maintenant", text: "Recalculer", ok: "Plan du jour recalculé" });
}

/* ---- 7 derniers jours: closed days from the device's Daily History, plus today so far */
{
  const host = $("days");
  const WD = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  /** "2026-11-13: 6.42 h 25.9/26.6 °C, 2026-11-12: 6.70 h" -> { "2026-11-13": {hours, lo, hi}, … } */
  const parse = (text) => Object.fromEntries([...String(text || "").matchAll(
    /(\d{4}-\d{2}-\d{2}): ([\d.]+) h(?: (-?[\d.]+)\/(-?[\d.]+) °C)?/g)]
    .map((m) => [m[1], { hours: +m[2], lo: m[3] === undefined ? NaN : +m[3], hi: m[4] === undefined ? NaN : +m[4] }]));
  let drawn = "";
  updaters.push(() => {
    if (!st(E.history) && !st(E.hoursToday)) return;
    const today = new Date();
    const key = [s(E.history), s(E.hoursToday), s(E.hoursPlanned), s(E.waterMin), s(E.waterMax), today.toDateString()].join("|");
    if (key === drawn) return;
    drawn = key;
    const closed = parse(s(E.history));
    const rows = [{ label: "Aujourd'hui", hours: n(E.hoursToday), planned: n(E.hoursPlanned), lo: n(E.waterMin), hi: n(E.waterMax), today: true }];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      rows.push({ label: i === 1 ? "Hier" : `${WD[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`, ...closed[dayKey(d)] });
    }
    const scale = Math.max(1, ...rows.flatMap((r) => [r.hours, r.planned]).filter(Number.isFinite));
    const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
    const water = (r) => Number.isFinite(r.lo) && Number.isFinite(r.hi) ? `${fmt1(r.lo)}–${fmt1(r.hi)}°` : "—";
    host.innerHTML = `<div class="day head"><span></span><span>Filtration</span><span></span><span class="w">Eau</span></div>`
      + rows.map((r) => {
        const known = Number.isFinite(r.hours);
        return `<div class="day${r.today ? " today" : ""}${known ? "" : " missing"}"
          title="${r.today ? "En cours ; le trait marque la durée planifiée" : known ? "" : "Pas de données : contrôleur éteint ou sans heure ce jour-là"}">
          <span class="lbl">${r.label}</span>
          <span class="bar">${known ? `<i style="width:${pct(r.hours)}"></i>` : ""}${Number.isFinite(r.planned) && r.planned > 0 ? `<b style="left:${pct(r.planned)}"></b>` : ""}</span>
          <span class="v num">${known ? `${fmt1(r.hours)} h` : "—"}</span>
          <span class="w num">${known ? water(r) : ""}</span></div>`;
      }).join("");
    const past = rows.filter((r) => !r.today && Number.isFinite(r.hours));
    host.appendChild(h(`<p class="foot">${past.length
      ? `Moyenne ${fmt1(past.reduce((a, r) => a + r.hours, 0) / past.length)} h de filtration par jour sur ${past.length} jour${past.length > 1 ? "s" : ""}.`
      : "Aucune journée complète pour l'instant."}
      Eau : minimum et maximum du jour, mesurés pompe en marche. Le contrôleur enregistre chaque journée à minuit.</p>`));
  });
}

/* ---- Wi-Fi and clock (wifi-setup.yaml) */
const AP_SSID = "pool-controller";
const CLOCK_SOURCE = {
  SNTP: "Synchronisée par internet",
  Browser: "Réglée depuis un navigateur",
  None: "Aucune source : pas de plan du jour",
};
/** The device sends "0-00-00 00:00:00" for a clock that was never set. */
const clockSet = () => s(E.clockSource) !== "None" && /^\d{4}-/.test(s(E.clock) || "");
const quality = (dbm) => Math.max(0, Math.min(100, 2 * (dbm + 100))); // HA's dBm -> % rule of thumb
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
  valueRow(rows, { id: E.wifiBssid, label: "Borne Wi-Fi (BSSID)", iconName: "router-wireless", visible: connected, value: orDash(E.wifiBssid) });
  valueRow(rows, { id: E.ip, label: "Adresse IP", iconName: "ip-network", visible: connected, value: orDash(E.ip) });
  valueRow(rows, { id: E.hotspotClients, label: "Appareils sur le point d'accès", iconName: "access-point",
    visible: () => mode() === "Hotspot", value: () => String(n(E.hotspotClients) || 0) });
  valueRow(rows, { id: E.mac, label: "Adresse MAC", iconName: "identifier", value: orDash(E.mac) });
  valueRow(rows, { id: E.disconnects, label: "Déconnexions", sub: "Depuis le démarrage", iconName: "wifi-alert",
    value: () => String(n(E.disconnects) || 0) });

  let joiningTo = null, lastMode = null, netsKey = "";
  updaters.push(() => {
    // The tab only exists on a firmware with wifi-setup.yaml.
    document.querySelector('.tabs a[data-tab="wifi"]').hidden = !st(E.wifiMode);
    if (!st(E.wifiMode)) return;
    const m = mode(), chip = $("wifiChip");
    chip.className = `chip ${m === "Connected" ? "ok" : m === "Hotspot" ? "warn" : ""}`;
    chip.textContent = m === "Connected" ? "Connecté" : m === "Hotspot" ? "Point d'accès" : "Connexion…";
    hero.className = `wifi-hero ${m === "Hotspot" ? "hotspot" : m === "Connecting" ? "connecting" : ""}`;
    const clients = n(E.hotspotClients) || 0;
    const [ic, title, sub] =
      m === "Connected" ? [bars(n(E.wifiSignal)), `Connecté à « ${s(E.wifiSsid)} »`,
        Number.isFinite(n(E.wifiSignal)) ? `Signal ${n(E.wifiSignal)} dBm · ${quality(n(E.wifiSignal))} %` : ""]
      : m === "Hotspot" ? ["access-point", `Point d'accès « ${AP_SSID} »`,
        `Ouvert, sans mot de passe · ${clients} appareil${clients > 1 ? "s" : ""} connecté${clients > 1 ? "s" : ""} · http://192.168.4.1`]
      : ["wifi-sync", `Connexion à « ${joiningTo || s(E.joinSsid) || "…"} »`, "Jusqu'à 30 s"];
    hero.innerHTML = `<span class="ic">${icon(ic)}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span>`;

    // The outcome of a join this page asked for.
    if (lastMode === "Connecting" && m !== "Connecting" && joiningTo) {
      if (m === "Connected" && s(E.wifiSsid) === joiningTo) toast(`Connecté à « ${joiningTo} » ; réseau enregistré`);
      else toast(`Impossible de rejoindre « ${joiningTo} » (mot de passe ou portée). Le contrôleur garde son réseau.`, true);
      joiningTo = null;
    }
    lastMode = m;
    joinBtn.disabled = m === "Connecting";
    $("joinHint").textContent = m === "Hotspot"
      ? "Le contrôleur essaie ce réseau 30 s et ne l'enregistre que si la connexion réussit. Une fois connecté, son point d'accès s'arrête : rejoignez ce réseau avec ce téléphone, puis ouvrez http://pool-controller.local."
      : "Le contrôleur essaie ce réseau 30 s et ne l'enregistre que si la connexion réussit ; sinon il garde le réseau actuel. S'il change de réseau, cette page perd la liaison : retrouvez-le sur http://pool-controller.local.";

    const list = nearby(), current = connected() ? s(E.wifiSsid) : null;
    const key = JSON.stringify([list, current]);
    if (key === netsKey) return;
    netsKey = key;
    nets.innerHTML = list.length ? "" : `<p class="hint">Aucun réseau détecté pour l'instant.</p>`;
    for (const net of list) {
      const b = h(`<button type="button" class="net"><span class="ic">${icon(bars(net.rssi))}</span>
        <span class="ssid"></span>${net.ssid === current ? '<span class="tag">connecté</span>' : ""}<span class="dbm num">${net.rssi} dBm</span></button>`);
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
    ev.currentTarget.title = show ? "Masquer" : "Afficher";
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const ssid = ssidIn.value.trim(), pw = pwIn.value;
    if (!ssid) return;
    if (pw.length && pw.length < 8) return toast("Mot de passe : 8 caractères minimum, ou vide pour un réseau ouvert.", true);
    if (connected() && ssid !== s(E.wifiSsid) &&
        !confirm(`Le contrôleur va quitter « ${s(E.wifiSsid)} » pour « ${ssid} ». Cette page perdra la liaison : retrouvez-le ensuite sur http://pool-controller.local. Continuer ?`)) return;
    joinBtn.classList.add("busy");
    try {
      await hass.setText(E.joinSsid, ssid);
      await hass.setText(E.joinPassword, pw); // held by the device, never sent back
      await hass.press(E.join);
      joiningTo = ssid;
      pwIn.value = "";
    } catch (e) {
      toast(`Refusé par le contrôleur (${e.message})`, true);
    } finally {
      joinBtn.classList.remove("busy");
    }
  });
}

/* ---- Alerts above both tabs: on the hotspot, and a clock that was never set */
{
  const host = $("alerts");
  let clockTried = false, drawn = "";
  const localStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const setClock = () => {
    const d = new Date();
    return run(hass.setDateTime(E.clock, localStamp(d)), `Horloge du contrôleur réglée sur ce navigateur (${clock(d)})`);
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
    const key = `${hotspot}|${noClock}`;
    if (key === drawn) return;
    drawn = key;
    host.innerHTML = "";
    if (hotspot) {
      const b = h(`<div class="banner info">${icon("access-point")}<span>Le contrôleur n'est relié à aucun réseau Wi-Fi : vous êtes sur son point d'accès « ${AP_SSID} ».</span><button class="btn">Configurer le Wi-Fi</button></div>`);
      b.querySelector("button").addEventListener("click", goWifi);
      host.appendChild(b);
    }
    if (noClock) {
      const b = h(`<div class="banner">${icon("clock-alert-outline")}<span>Le contrôleur n'a pas l'heure : il ne peut pas calculer le plan du jour.</span><button class="btn">Régler sur ce navigateur</button></div>`);
      b.querySelector("button").addEventListener("click", setClock);
      host.appendChild(b);
    }
  });
}

/* ---- Capteurs internes */
const KNOWN = new Set(Object.values(E));
{
  const host = $("deviceRows");
  valueRow(host, { label: "Liaison avec cette page", iconName: "lan-connect",
    value: () => (hass.connected ? "Connectée" : "Perdue, nouvelle tentative…") });
  valueRow(host, { label: "En marche depuis", iconName: "clock-outline",
    value: () => duration(hass.uptime === null ? NaN : hass.uptime + (Date.now() - hass.uptimeAt) / 1000) });
  valueRow(host, { label: "Dernière donnée reçue", iconName: "information-outline",
    value: () => (hass.lastEventAt ? `il y a ${Math.round((Date.now() - hass.lastEventAt) / 1000)} s` : "—") });
  valueRow(host, { label: "Contrôleur", iconName: "chip",
    value: () => hass.config.title || "—", sub: () => hass.config.comment || "" });
  valueRow(host, { id: E.haLink, label: "Home Assistant", iconName: "home-assistant", sub: "Liaison API du contrôleur",
    value: () => (s(E.haLink) === "on" ? "Connecté" : "Non connecté") });
  valueRow(host, { id: E.clock, label: "Horloge", iconName: () => (clockSet() ? "clock-check-outline" : "clock-alert-outline"),
    value: () => (clockSet() ? stamp(s(E.clock)) : "Pas réglée"), sub: () => CLOCK_SOURCE[s(E.clockSource)] || "" });
  sect(host, "Capteurs");
  valueRow(host, { id: E.water, label: "Eau (retour filtre)", iconName: "thermometer-water" });
  valueRow(host, { id: E.pad, label: "Local technique", iconName: "home-thermometer-outline" });
  valueRow(host, { id: E.outdoor, label: "Extérieur", iconName: "weather-partly-cloudy" });
  valueRow(host, { id: E.flow, label: "Débit de remplissage" });
  valueRow(host, { id: E.volume, label: "Volume total rempli" });
  buttonRow(host, { id: E.updateTemps, label: "Relire les sondes de température", iconName: "thermometer", text: "Relire", ok: "Sondes relues" });
  const others = h(`<div></div>`);
  host.appendChild(others);
  let seen = "";
  updaters.push(() => {
    // Anything the YAML gains later (Wi-Fi signal, ESP temperature…) shows up here without a page change.
    const ids = Object.keys(hass.states).filter((id) => !KNOWN.has(id)).sort();
    if (ids.join() === seen) return;
    seen = ids.join();
    others.innerHTML = "";
    if (ids.length) sect(others, "Autres entités");
    for (const id of ids) {
      const domain = st(id).attributes.domain;
      if (domain === "number") numberRow(others, { id, label: st(id).attributes.friendly_name });
      else if (domain === "button") buttonRow(others, { id, label: st(id).attributes.friendly_name });
      else valueRow(others, { id, label: st(id).attributes.friendly_name });
    }
    for (const u of updaters) u();
  });
}

/* ================================================================ logs */

const LOG_FILTERS = { all: () => true, warn: (l) => l.level === "warn" || l.level === "error", error: (l) => l.level === "error" };
let logFilter = "all", logPaused = false;
const logBox = $("log");
function logLine(l) {
  const d = new Date(l.t);
  const row = document.createElement("div");
  row.className = l.level;
  row.innerHTML = `<span class="t">${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}</span>` +
    `${l.tag ? `<span class="tag">[${esc(l.tag)}]</span> ` : ""}${esc(l.msg)}`;
  return row;
}
function renderLog() {
  logBox.innerHTML = "";
  const lines = hass.logs.filter(LOG_FILTERS[logFilter]);
  if (!lines.length) logBox.innerHTML = `<div class="none">Aucune ligne pour l'instant. Le contrôleur n'envoie que les messages émis pendant que la page est ouverte (niveau INFO et au-dessus).</div>`;
  for (const l of lines) logBox.appendChild(logLine(l));
  $("logCount").textContent = `${hass.logs.length} ligne${hass.logs.length > 1 ? "s" : ""}`;
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
  $("logCount").textContent = `${hass.logs.length} ligne${hass.logs.length > 1 ? "s" : ""}`;
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
  ev.currentTarget.title = logPaused ? "Reprendre" : "Pause";
  if (!logPaused) renderLog();
});
$("logClear").addEventListener("click", () => {
  hass.logs.length = 0;
  renderLog();
});

/* ================================================================ wiring */

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
