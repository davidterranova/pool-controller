/*
 * A stand-in for Home Assistant's `hass` object, enough for piscine-card: the states of the controller's entities, the
 * recorder's 24 h history and long-term statistics it asks for over the websocket, and the services it calls, applied
 * as the controller would (a forced speed changes Manual Override, a number takes its value…) after a short delay.
 *
 * States are written by the card's own keys (`override`, `water`, `fillTooLong`…), not entity ids: `ids` maps them,
 * from the card itself (see index.html), so a scenario doesn't depend on any install's ids.
 */

const M = 60000, H = 60 * M, D = 24 * H;
/** Not the controller's: they stay when it goes offline (the card's NOT_CONTROLLER). */
const NOT_CONTROLLER = new Set(["sun", "sForce", "sAuto"]);
/** Echo delay of a command, as the ESP32 and Home Assistant take it. */
const ECHO_MS = 700;

const pad = (v) => String(v).padStart(2, "0");
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const stamp = (d) => `${dayKey(d)} ${hm(d)}:${pad(d.getSeconds())}`;
/** Today at h:m, local. */
export const today = (h, m = 0, now = new Date()) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d; };

/** A small seeded random, so a scenario draws the same curves on every load. */
function rand(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The pool's water over the year: about 8 °C in winter, 26 °C in summer. */
export const seasonal = (d) => {
  const start = new Date(d.getFullYear(), 0, 0), doy = (d - start) / D;
  return 17 + 9 * Math.sin((2 * Math.PI * (doy - 110)) / 365);
};

/**
 * A state spec -> {state, attributes, last_changed, last_updated}. A spec is a value (the state), or
 * {s, a (attributes), ago (minutes since it changed, 60 by default), seen (minutes since the controller last sent it)}.
 */
function toState(id, spec, now, quiet) {
  const o = spec !== null && typeof spec === "object" ? spec : { s: spec };
  const seen = o.seen ?? quiet ?? 0.4, ago = Math.max(o.ago ?? 60, seen);
  return { entity_id: id, state: String(o.s), attributes: { friendly_name: id, ...(o.a || {}) },
    last_changed: new Date(now - ago * M).toISOString(), last_updated: new Date(now - seen * M).toISOString() };
}

export class FakeHass {
  /**
   * ids: the card's key -> entity id map. scenario: {states (key -> spec, null = no such entity), offline (minutes),
   * quiet (minutes), recorder ("full" | "empty" | "error"), press (button key -> {key: spec} applied when pressed)}.
   * specs: key -> spec, every state (scenarios.js statesOf: the normal day with the scenario's changes).
   */
  constructor({ ids, specs, scenario, dark = false, lang = "fr", onChange = () => {}, log = () => {} }) {
    this.lang = lang; // the HA user's language, which the card follows
    this.ids = ids;
    this.keyOf = Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, k]));
    this.scenario = scenario;
    this.specs = specs; // the recorder's history follows them, not the live states (unavailable while offline)
    this.dark = dark;
    this.onChange = onChange;
    this.log = log;
    const now = Date.now(), states = {};
    for (const [k, spec] of Object.entries(specs)) {
      const id = ids[k];
      if (!id || spec === null || spec === undefined) continue;
      let st = toState(id, spec, now, NOT_CONTROLLER.has(k) ? undefined : scenario.quiet);
      // Offline: Home Assistant marks every entity of the device unavailable, from when the link dropped.
      if (scenario.offline && !NOT_CONTROLLER.has(k) && k !== "online")
        st = { ...st, state: "unavailable", last_changed: new Date(now - scenario.offline * M).toISOString(), last_updated: new Date(now - scenario.offline * M).toISOString() };
      states[id] = st;
    }
    this.states = states;
    // The controller's device, so the light can open its page (/config/devices/device/<id>).
    this.entities = Object.fromEntries(Object.keys(states).map((id) => [id, { entity_id: id, device_id: "pool-controller-device" }]));
    this.devices = { "pool-controller-device": { id: "pool-controller-device", name: "Pool Controller", sw_version: "2026.11.0b6" } };
    this.callService = this.callService.bind(this);
    this.callWS = this.callWS.bind(this);
  }

  /** What the cards get: a new object (and states object) on every change, like Home Assistant's. */
  snapshot() {
    return { states: this.states, entities: this.entities, devices: this.devices, themes: { darkMode: this.dark },
      config: { latitude: 45.76, longitude: 4.84, time_zone: "Europe/Paris", unit_system: { temperature: "°C" } },
      language: this.lang, locale: { language: this.lang }, callService: this.callService, callWS: this.callWS };
  }

  /** Sets states by key ({key: spec}), now, as a message from the controller. */
  set(changes) {
    const now = Date.now(), states = { ...this.states };
    for (const [k, spec] of Object.entries(changes)) {
      const id = this.ids[k];
      if (!id) continue;
      const old = states[id], st = toState(id, spec !== null && typeof spec === "object" ? { ago: 0, seen: 0, ...spec } : { s: spec, ago: 0, seen: 0 }, now);
      if (old && old.state === st.state) st.last_changed = old.last_changed; // only its update is new
      if (old && !(spec && typeof spec === "object" && spec.a)) st.attributes = old.attributes;
      states[id] = st;
    }
    this.states = states;
    this.onChange();
  }
  get(k) { return this.states[this.ids[k]]?.state; }

  /* ---------------------------------------------------------------- services */
  callService(domain, service, data = {}) {
    this.log("service", `${domain}.${service}`, data);
    const key = this.keyOf[data.entity_id], later = (changes) => setTimeout(() => this.set(changes), ECHO_MS);
    if (domain === "script" && service === "turn_on" && key === "sAuto")
      later({ override: "Auto", endsAt: "--", stuck: "off", commanded: this.get("planned") || "Off" });
    else if (domain === "script" && `script.${service}` === this.ids.sForce) {
      const min = parseFloat(this.get("timeout")) || 0, v = data.vitesse;
      later({ override: v, commanded: v, endsAt: min ? stamp(new Date(Date.now() + min * M)) : "--" });
    } else if (domain === "number" && service === "set_value" && key) {
      const changes = { [key]: String(data.value) };
      if (key === "timeout" && this.get("override") !== "Auto")
        changes.endsAt = +data.value ? stamp(new Date(Date.now() + data.value * M)) : "--";
      later(changes);
    } else if ((domain === "select" && service === "select_option") && key) later({ [key]: data.option });
    else if (domain === "text" && service === "set_value" && key) later({ [key]: data.value });
    else if (domain === "switch" && key) later({ [key]: service === "turn_on" ? "on" : "off" });
    else if (domain === "button" && service === "press" && key) {
      const r = this.scenario.press && this.scenario.press[key];
      later({ [key]: stamp(new Date()), ...(r || {}) });
    } else if (domain === "update" && service === "install")
      later({ firmware: { s: "on", a: { ...this.states[this.ids.firmware].attributes, in_progress: true, update_percentage: 12 } } });
    return new Promise((ok) => setTimeout(ok, 150));
  }

  /* ---------------------------------------------------------------- websocket: recorder, statistics */
  callWS(msg) {
    const rec = this.scenario.recorder || "full";
    this.log("ws", msg.type, { entities: msg.entity_ids || msg.statistic_ids, period: msg.period });
    if (rec === "error") return new Promise((_, no) => setTimeout(() => no(new Error("recorder unavailable")), 200));
    if (rec === "empty") return new Promise((ok) => setTimeout(() => ok({}), 200));
    const out = msg.type === "history/history_during_period" ? this._history(msg)
      : msg.type === "recorder/statistics_during_period" ? this._statistics(msg) : {};
    return new Promise((ok) => setTimeout(() => ok(out), 200));
  }

  /** The last 24 h: the water and outdoor sensors every 5 min, the commanded speed by the plan's blocks, the override's states. */
  _history(msg) {
    const now = Date.now(), from = now - D, out = {};
    for (const id of msg.entity_ids) {
      const k = this.keyOf[id], live = this.states[id];
      if (!live) continue;
      if (k === "water") {
        const spec = this.specs.water, r = rand(7), rows = [];
        const v = parseFloat(spec !== null && typeof spec === "object" ? spec.s : spec);
        const until = this.scenario.offline ? now - this.scenario.offline * M : now; // nothing recorded since the link dropped
        for (let t = from; t <= until; t += 5 * M) {
          const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
          rows.push({ s: (v - 0.4 + 0.6 * Math.sin(((h - 10) / 24) * 2 * Math.PI) + (r() - 0.5) * 0.1).toFixed(2), lu: t / 1000 });
        }
        out[id] = rows;
      } else if (k === "outdoor") {
        // the air: cold at dawn, warmest mid-afternoon, around the live value
        const spec = this.specs.outdoor, r = rand(11), rows = [];
        const v = parseFloat(spec !== null && typeof spec === "object" ? spec.s : spec);
        const until = this.scenario.offline ? now - this.scenario.offline * M : now;
        for (let t = from; t <= until; t += 5 * M) {
          const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
          rows.push({ s: (v - 2 + 4.5 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + (r() - 0.5) * 0.4).toFixed(1), lu: t / 1000 });
        }
        out[id] = rows;
      } else if (k === "commanded") {
        const rows = [], blocks = this._blocks(), speedAt = (t) => (blocks.some(([s, e]) => t >= s && t < e) ? "Low" : "Off");
        let last = null;
        for (let t = from; t <= now; t += 5 * M) { const s = speedAt(t); if (s !== last) { rows.push({ s, lu: t / 1000 }); last = s; } }
        out[id] = rows;
      } else {
        // The override: Auto until its live state took over
        const lc = Date.parse(live.last_changed), rows = [{ s: "Auto", lu: from / 1000 }];
        if (live.state !== "Auto" && lc > from) rows.push({ s: live.state, lu: lc / 1000 });
        out[id] = rows;
      }
    }
    return out;
  }
  /** Yesterday's and today's plan blocks, in ms. */
  _blocks() {
    const out = [];
    for (const back of [1, 0]) {
      const base = new Date(Date.now() - back * D);
      for (const [s, e] of [["b1s", "b1e"], ["b2s", "b2e"]]) {
        const a = /^(\d\d):(\d\d)$/.exec(this.get(s) || ""), b = /^(\d\d):(\d\d)$/.exec(this.get(e) || "");
        if (a && b) out.push([today(+a[1], +a[2], base).getTime(), today(+b[1], +b[2], base).getTime()]);
      }
    }
    return out;
  }

  /** Long-term statistics: the pool's min/max (hourly and daily), the probe's daily mean, the fill meter's change. */
  _statistics(msg) {
    const start = Date.parse(msg.start_time), now = Date.now(), out = {};
    for (const id of msg.statistic_ids) {
      const k = this.keyOf[id];
      if (k === "volume") { out[id] = this._volume(start, msg.period); continue; }
      const rows = [];
      for (let d = new Date(start); d.getTime() <= now; d = new Date(d.getTime() + (msg.period === "hour" ? H : D))) {
        if (msg.period === "hour" && d.getHours() !== 23) continue;
        const day = new Date(d); day.setHours(0, 0, 0, 0);
        if (now - day.getTime() < D) continue; // today has no closed statistics
        const r = rand(day.getTime() / D), t = seasonal(day) + (r() - 0.5) * 0.8;
        if (k === "outdoor") { // the air: a wider day, a few degrees under the water
          const lo = t - 7 + (r() - 0.5) * 3, hi = lo + 7 + r() * 6;
          rows.push({ start: d.getTime(), end: d.getTime() + D, min: +lo.toFixed(2), max: +hi.toFixed(2), mean: +((lo + hi) / 2).toFixed(2) });
          continue;
        }
        rows.push({ start: d.getTime(), end: d.getTime() + (msg.period === "hour" ? H : D), min: +(t - 0.5).toFixed(2), max: +(t + 0.6).toFixed(2), mean: +(t + 0.1).toFixed(2) });
      }
      out[id] = rows;
    }
    return out;
  }
  /** The fill meter, `change` per day, week or month: a few fills a month, a top-up of 300 to 900 L each. */
  _volume(start, period) {
    const now = new Date(), days = [];
    for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
      const r = rand(Math.floor(d.getTime() / D) * 13);
      days.push({ t: new Date(d), l: r() < 0.16 ? Math.round(300 + r() * 600) : 0 });
    }
    const keyOf = (d) => period === "month" ? `${d.getFullYear()}-${d.getMonth()}`
      : period === "week" ? dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))) : dayKey(d);
    const buckets = new Map();
    for (const { t, l } of days) {
      const k = keyOf(t);
      if (!buckets.has(k)) {
        const s = period === "month" ? new Date(t.getFullYear(), t.getMonth(), 1)
          : period === "week" ? new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7)) : new Date(t.getFullYear(), t.getMonth(), t.getDate());
        buckets.set(k, { start: s.getTime(), change: 0 });
      }
      buckets.get(k).change += l;
    }
    // `state` is the meter at the end of each row; the live one (the running hour) is the card's to add
    let total = parseFloat(this.get("volume")) || 0;
    const rows = [...buckets.values()].sort((a, b) => b.start - a.start);
    for (const r of rows) { r.state = total; total -= r.change; }
    return rows.reverse();
  }
}
