/*
 * The situations the preview draws the card in. `base(now)` is a normal day; a scenario lists only what differs, by
 * the card's own keys (DEFAULT_ENTITIES). A value is the state; {s, a, ago, seen} adds attributes and how long ago it
 * changed / was last sent, in minutes; null removes the entity (a firmware without it).
 *
 * A scenario: {id, name, note, states, offline (minutes the link has been down), quiet (minutes without a message),
 * recorder ("full", "empty": no statistics yet, "error"), press ({button key: states it sets when pressed}),
 * tab (the panel's tab in screenshots: pump, settings, controller), config (merged into every card's config)}.
 * Add one when the card learns a new state: `make card-preview-check` loads them all.
 */
import { hm, dayKey, stamp, today, seasonal } from "./fake-hass.js";

const BLOCKS = [[9, 30, 13, 0], [15, 0, 19, 30]]; // the plan: 8 h in two blocks
const NUMBERS = { // the firmware's ranges (pool-controller.yaml)
  min: [2, 0, 24, 0.5, "h"], max: [16, 0, 24, 0.5, "h"], warm: [2.5, 0, 6, 0.25, "h"], offset: [-1, -6, 6, 0.5, "h"],
  boostDuration: [5, 0, 15, 1, "min"], boostInterval: [30, 5, 60, 5, "min"], highEvery: [3, 1, 10, 1, ""],
  freezeAt: [3, 0, 10, 0.5, "°C"], timeout: [60, 0, 480, 5, "min"],
  latitude: [45.76, -90, 90, 0.01, "°"], longitude: [4.84, -180, 180, 0.01, "°"],
};

/** A normal day at `now`: Auto, the plan running, the controller talking, the firmware up to date. */
export function base(now = new Date()) {
  const blocks = BLOCKS.map(([a, b, c, d]) => [today(a, b, now), today(c, d, now)]);
  const inBlock = blocks.some(([s, e]) => now >= s && now < e);
  // the commanded speed last changed at the latest block edge (a minute is a day's start, before the first)
  const edge = Math.max(0, ...blocks.flat().filter((t) => t <= now).map((t) => +t)), since = edge ? (now - edge) / 60000 : 600;
  const edges = blocks.flatMap(([s, e]) => [[s, "Low"], [e, "Off"]]).filter(([t]) => t > now);
  const done = blocks.reduce((h, [s, e]) => h + Math.max(0, Math.min(now, e) - s) / 3600000, 0);
  const water = +(seasonal(now) + 0.3).toFixed(1);
  const days = (n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - i - 1); return f(dayKey(d), i); }).join(", ");
  const nums = Object.fromEntries(Object.entries(NUMBERS).map(([k, [v, min, max, step, unit]]) =>
    [k, { s: v, a: { min, max, step, mode: "box", ...(unit ? { unit_of_measurement: unit } : {}) } }]));
  const nextBoost = new Date(Math.ceil(now / 1800000) * 1800000);
  return {
    ...nums,
    override: { s: "Auto", ago: 600 },
    commanded: { s: inBlock ? "Low" : "Off", ago: since },
    planned: { s: inBlock ? "Low" : "Off", ago: since },
    nextAt: edges.length ? hm(edges[0][0]) : "--",
    nextTo: edges.length ? edges[0][1] : "Off",
    b1s: hm(blocks[0][0]), b1e: hm(blocks[0][1]), b2s: hm(blocks[1][0]), b2e: hm(blocks[1][1]),
    hoursToday: done.toFixed(2),
    hoursPlanned: "8.00",
    water: { s: water, a: { unit_of_measurement: "°C", device_class: "temperature" }, ago: 3 },
    waterMin: (water - 0.6).toFixed(1), waterMax: (water + 0.3).toFixed(1),
    outdoor: (water + 2.4).toFixed(1), pad: (water + 4.1).toFixed(1),
    outdoorMin: (water - 4.6).toFixed(1), outdoorMax: (water + 3.1).toFixed(1),
    // the last 7 closed days' outdoors, the oldest before the firmware kept them (from HA's statistics instead)
    outdoorHistory: days(5, (d, i) => `${d}: ${(water - 5 - i * 0.6).toFixed(1)}/${(water + 3 - i * 0.4).toFixed(1)} °C`),
    // the equipment pad: today's min – max and its last closed days, the oldest from HA's statistics too
    padMin: (water + 2.9).toFixed(1), padMax: (water + 4.6).toFixed(1),
    padHistory: days(5, (d, i) => `${d}: ${(water + 2.6 - i * 0.3).toFixed(1)}/${(water + 5.2 - i * 0.2).toFixed(1)} °C`),
    // the last 7 closed days, one of them short of its plan
    history: days(7, (d, i) => `${d}: ${i === 3 ? "6.20" : (7.9 + (i % 3) * 0.05).toFixed(2)} h ${(water - 0.8 - i * 0.1).toFixed(1)}/${(water + 0.2 - i * 0.1).toFixed(1)} °C`),
    planHistory: days(7, (d) => `${d}: 8.00 h`),
    online: { s: "on", ago: 2 * 1440 },
    stuck: "off", notComputed: "off", pending: "off",
    recomputed: stamp(today(6, 2, now)),
    endsAt: "--",
    flow: { s: "0", a: { unit_of_measurement: "L/min" } },
    volume: { s: "18342", a: { unit_of_measurement: "L", state_class: "total_increasing" } },
    nextBoostStart: hm(nextBoost), nextBoostEnd: hm(new Date(+nextBoost + 5 * 60000)),
    apply: "unknown", recompute: "unknown", updateTemps: "unknown", checkUpdate: "unknown", cancelUpdate: "unknown",
    restart: "unknown",
    sun: { s: "above_horizon", a: { next_rising: today(7, 41, now).toISOString(), next_setting: today(17, 9, now).toISOString() } },
    clock: { s: stamp(now), seen: 0.1, ago: 0.1 },
    fwVersion: "v1.8.0",
    esphomeVersion: "2026.11.0b6 (config hash 0x528082c4, built 2026-11-18 17:05:00 +0000)",
    firmware: { s: "off", a: { installed_version: "1.8.0", latest_version: "1.8.0", in_progress: false, title: "Pool Controller",
      release_url: "https://github.com/davidterranova/pool-controller/releases/tag/v1.8.0" } },
    autoUpdate: "on",
    // codes, as the firmware publishes them from 1.11.0 (updates.h); « update-legacy » keeps the French before it
    updateInterval: { s: "24h", a: { options: ["on_request", "6h", "24h", "7d"] } },
    updateStatus: "up_to_date",
    // the controller's health (1.15.0): up 3 d 4 h, its chip warm
    uptime: { s: "274020", a: { unit_of_measurement: "s", device_class: "duration" }, seen: 0.5, ago: 0.5 },
    chipTemp: { s: "48.6", a: { unit_of_measurement: "°C", device_class: "temperature" }, seen: 0.5, ago: 0.5 },
    timezone: "CET-1CEST,M3.5.0,M10.5.0/3", timezoneName: "Europe/Paris",
    sForce: "off", sAuto: "off",
    // the fill meter (fill-meter.yaml): on, nothing running
    fillEnabled: "on", fillAlarmAfter: { s: 60, a: { min: 0, max: 1440, step: 5, unit_of_measurement: "min" } },
    fillRunning: { s: "off", ago: 300 }, fillTooLong: "off", fillAck: "unknown", fillAcked: "off",
  };
}

const at = (min) => stamp(new Date(Date.now() + min * 60000));

export const SCENARIOS = [
  { id: "normal", name: "Journée normale", note: "Auto, le plan tourne, le contrôleur parle" },
  { id: "normal-settings", name: "Réglages", note: "L'onglet « Réglages » d'une journée normale", tab: "settings" },
  { id: "normal-controller", name: "Réglages contrôleur", note: "Position et firmware", tab: "controller" },
  { id: "manual", name: "Manuel High, retour à l'heure", note: "Override High depuis 20 min, retour en Auto dans 40 min",
    states: { override: { s: "High", ago: 20 }, commanded: "High", endsAt: () => at(40) } },
  { id: "stuck", name: "Override sans limite", note: "Arrêt forcé depuis 45 min, sans retour automatique : l'alerte",
    states: { override: { s: "Off", ago: 45 }, commanded: "Off", stuck: { s: "on", ago: 15 }, timeout: { s: 0, a: { min: 0, max: 480, step: 5, unit_of_measurement: "min" } } } },
  { id: "freeze", name: "Hors gel", note: "Bassin à 2,1 °C : Low imposé",
    states: { water: { s: 2.1, a: { unit_of_measurement: "°C" } }, waterMin: "1.8", waterMax: "2.6", outdoor: "-4.0", outdoorMin: "-6.2", outdoorMax: "1.4",
      outdoorHistory: "--", commanded: "Low" } },
  { id: "not-computed", name: "Plan non calculé", note: "Pas de température ni de lever du soleil au matin",
    states: { notComputed: "on", b1s: "--", b1e: "--", b2s: "--", b2e: "--", nextAt: "--", hoursPlanned: "unknown", commanded: "Off", planned: "Off" } },
  { id: "quiet", name: "Contrôleur muet", note: "Plus aucun message depuis 6 min : lumière ambre", quiet: 6 },
  { id: "offline-short", name: "Hors ligne 5 min", note: "Un redémarrage, une OTA : ambre", offline: 5,
    states: { online: { s: "off", ago: 5 } } },
  { id: "offline", name: "Hors ligne 20 min", note: "Au-delà de 15 min : rouge", offline: 20,
    states: { online: { s: "off", ago: 20 } } },
  { id: "filling", name: "Remplissage", note: "Le compteur tourne à 14,8 L/min",
    states: { flow: { s: "14.8", a: { unit_of_measurement: "L/min" }, ago: 12 }, fillRunning: { s: "on", ago: 12 } } },
  { id: "fill-off", name: "Compteur d'eau désactivé", note: "Fill Meter off : pas de remplissage dans « Contrôle »",
    states: { fillEnabled: "off", flow: "unknown", volume: "unknown" } },
  { id: "fill-alarm", name: "Remplissage trop long", note: "1 h 12 de remplissage, alarme non acquittée : bannière, lumière ambre qui pulse",
    states: { flow: { s: "14.8", a: { unit_of_measurement: "L/min" }, ago: 72 }, fillRunning: { s: "on", ago: 72 }, fillTooLong: { s: "on", ago: 12 } },
    press: { fillAck: { fillAcked: "on" } } },
  { id: "fill-acked", name: "Remplissage trop long, acquitté", note: "La bannière dit « acquittée », la lumière reprend sa couleur",
    states: { flow: { s: "14.8", a: { unit_of_measurement: "L/min" }, ago: 80 }, fillRunning: { s: "on", ago: 80 }, fillTooLong: { s: "on", ago: 20 }, fillAcked: { s: "on", ago: 5 } } },
  { id: "update", name: "Firmware disponible", note: "1.9.0 publiée", tab: "controller",
    states: { firmware: { s: "on", a: { installed_version: "1.8.0", latest_version: "1.9.0", in_progress: false, title: "Pool Controller",
      release_url: "https://github.com/davidterranova/pool-controller/releases/tag/v1.9.0" } }, updateStatus: "available" } },
  { id: "update-held", name: "Installation en attente", note: "Demandée pendant un override : le firmware attend", tab: "controller",
    states: { override: { s: "Medium", ago: 10 }, commanded: "Medium", endsAt: () => at(50), updateStatus: "pending:override",
      firmware: { s: "on", a: { installed_version: "1.8.0", latest_version: "1.9.0", in_progress: false, title: "Pool Controller" } } } },
  // The skew: a card from 1.11.0 on a firmware before it, whose Update Status and interval options were French words.
  { id: "update-legacy", name: "Installation en attente, firmware avant 1.11", note: "États en français (avant 1.11.0) : la carte les lit comme les codes",
    tab: "controller",
    states: { flow: { s: "14.8", a: { unit_of_measurement: "L/min" }, ago: 12 }, fillRunning: { s: "on", ago: 12 },
      updateStatus: "en attente (remplissage)", updateInterval: { s: "À la demande", a: { options: ["À la demande", "6 h", "24 h", "7 j"] } },
      firmware: { s: "on", a: { installed_version: "1.10.0", latest_version: "1.11.0", in_progress: false, title: "Pool Controller" } } } },
  // Some ESP32s never give their chip's temperature (ESPHome drops the reading): the row says so. Restarted 7 min ago.
  { id: "chip-no-reading", name: "Redémarré, sans température de puce", note: "Uptime 7 min ; cet ESP32 ne mesure pas sa température",
    tab: "controller", states: { uptime: { s: "420", a: { unit_of_measurement: "s" }, seen: 0.5, ago: 0.5 }, chipTemp: "unknown" } },
  { id: "installing", name: "Installation en cours", note: "Téléchargement à 42 %", tab: "controller",
    states: { updateStatus: "installing", firmware:{ s: "on", a: { installed_version: "1.8.0", latest_version: "1.9.0", in_progress: true, update_percentage: 42, title: "Pool Controller" } } } },
  { id: "old-firmware", name: "Firmware ancien", note: "Sans mises à jour, position ni horloge (avant v1.4) : ni « Réglages contrôleur », ni battement",
    states: { firmware: null, checkUpdate: null, cancelUpdate: null, autoUpdate: null, updateInterval: null, updateStatus: null,
      latitude: null, longitude: null, timezone: null, timezoneName: null, clock: null, planHistory: null, uptime: null, chipTemp: null,
      fillEnabled: null, fillAlarmAfter: null, fillRunning: null, fillTooLong: null, fillAck: null, fillAcked: null } },
  { id: "no-stats", name: "Pas encore de statistiques", note: "Le recorder n'a rien compilé : graphiques vides", recorder: "empty" },
  { id: "no-meter", name: "Sans compteur d'eau", note: "Pas d'entité de volume : pas de section remplissage",
    states: { flow: null, volume: null, fillEnabled: null, fillAlarmAfter: null, fillRunning: null, fillTooLong: null, fillAck: null, fillAcked: null } },
];

/** A scenario's states at `now`: base, then its own (a function is called, for times relative to now). */
export function statesOf(scenario, now = new Date()) {
  const out = { ...base(now) };
  for (const [k, v] of Object.entries(scenario.states || {})) out[k] = typeof v === "function" ? v(now) : v;
  return out;
}
