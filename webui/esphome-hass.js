/*
 * A Home Assistant-shaped `hass` object fed by the device's own web_server (v3 protocol), so the
 * piscine-card written for HA runs unchanged on the ESP32's page.
 *
 *   /events (SSE)   ping (config, then uptime), state (one entity), log (one line, ANSI-coloured)
 *   POST /{domain}/{name}/{action}?…   number set, select set, button press, fan/switch turn_on|off
 *
 * Entity ids are ESPHome's `name_id` ("select/Manual Override"); the card is configured with those
 * instead of HA's entity ids. What HA has and the device doesn't:
 *   - scripts: piscine_forcer_vitesse / piscine_retour_auto only set the Manual Override select (and
 *     its timeout), so callService maps them onto the same REST calls;
 *   - the recorder: the device keeps no history of its states, so a small one lives here, in memory,
 *     from the moment the page opened (gone on reload): the Manual Override's changes, for the card's
 *     timeline of today's overrides;
 *   - last_changed: the device doesn't send it, so it is when this page saw the value change (the
 *     override's start is estimated from its deadline, see _estimateOverrideSince).
 */

const HISTORY_MS = 24 * 3600 * 1000; // a page left open (wall tablet) keeps the last day
const LOG_MAX = 500;

/** Entities the page and the card rely on, by role. */
export const E = {
  pump: "fan/Pump",
  override: "select/Manual Override",
  timeout: "number/Manual Override Timeout",
  endsAt: "text_sensor/Manual Override Ends At",
  overrideActive: "binary_sensor/Manual Override Active",
  commanded: "text_sensor/Pump Commanded Speed",
  planned: "text_sensor/Pump Planned Speed",
  hoursPlanned: "sensor/Planned Filtration Hours",
  hoursToday: "sensor/Filtration Hours Today",
  history: "text_sensor/Daily History",
  b1s: "text_sensor/Schedule Block 1 Start",
  b1e: "text_sensor/Schedule Block 1 End",
  b2s: "text_sensor/Schedule Block 2 Start",
  b2e: "text_sensor/Schedule Block 2 End",
  nextAt: "text_sensor/Next Speed Change",
  nextTo: "text_sensor/Next Planned Speed",
  nextBoostStart: "text_sensor/Next Boost Start",
  nextBoostEnd: "text_sensor/Next Boost End",
  recomputed: "text_sensor/Last Recomputed At",
  notComputed: "binary_sensor/Schedule Not Computed",
  recompute: "button/Recompute Schedule Now",
  min: "number/Min Filtration Hours",
  max: "number/Max Filtration Hours",
  warm: "number/Warmest Part of Day Offset",
  offset: "number/Filtration Hour Offset",
  pending: "binary_sensor/Filtration Config Pending",
  apply: "button/Apply Filtration Config",
  boostDuration: "number/Boost Pulse Duration",
  boostInterval: "number/Boost Pulse Interval",
  highEvery: "number/High Boost Frequency",
  water: "sensor/Pool Return Temperature",
  waterMin: "sensor/Pool Water Min Today",
  waterMax: "sensor/Pool Water Max Today",
  pad: "sensor/Equipment Pad Temperature",
  outdoor: "sensor/Outdoor Temperature",
  updateTemps: "button/Update Temperature Sensors Now",
  haLink: "binary_sensor/Status", // the device's link to Home Assistant's API, not to this page
  online: "page/connected", // synthetic: this page's own link to the device (see _setLink)
  flow: "sensor/Piscine - Débit remplissage",
  volume: "sensor/Piscine - Volume total remplissage",
  // Proposed, from wifi-setup.yaml (not in the firmware yet): the page hides what's missing.
  wifiMode: "text_sensor/WiFi Mode",
  wifiSignal: "sensor/WiFi Signal",
  wifiSsid: "text_sensor/WiFi SSID",
  wifiBssid: "text_sensor/WiFi BSSID",
  ip: "text_sensor/IP Address",
  mac: "text_sensor/MAC Address",
  disconnects: "sensor/WiFi Disconnects",
  hotspotClients: "sensor/Hotspot Clients",
  nearby: "text_sensor/WiFi Networks Nearby",
  joinSsid: "text/New WiFi Network",
  joinPassword: "text/New WiFi Password",
  join: "button/Join WiFi Network",
  clock: "datetime/Device Clock",
  clockSource: "text_sensor/Clock Source",
};

/** What the recorder keeps (every change): the card draws today's overrides from it. */
const RECORDED = new Set([E.override]);

const ANSI = /\x1b\[[0-9;]*m/g;
const LEVELS = { E: "error", W: "warn", I: "info", C: "config", D: "debug", V: "verbose" };

const splitId = (id) => {
  const i = id.indexOf("/");
  return [id.slice(0, i), id.slice(i + 1)];
};

export class EspHass extends EventTarget {
  constructor() {
    super();
    this.states = {};
    this.entities = {}; // name_id -> the full config sent on connect (detail=all)
    this.groups = []; // [{name, sorting_weight}]
    this.config = {}; // first ping: title, comment, log, ota, lang
    this.uptime = null; // seconds, from pings
    this.uptimeAt = 0; // when it was received
    this.lastEventAt = 0;
    this.connected = false;
    this.logs = [];
    this.themes = { darkMode: matchMedia("(prefers-color-scheme: dark)").matches };
    this.history = {}; // name_id -> [[t ms, value]]
    this._estimated = new Set(); // ids whose last_changed is a guess
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      this.themes = { darkMode: e.matches };
      this._changed();
    });
  }

  /* ---------------------------------------------------------------- stream */

  connect() {
    const es = new EventSource("/events");
    es.addEventListener("open", () => this._setLink(true));
    // EventSource retries on its own; until then the controller is unreachable from here.
    es.addEventListener("error", () => this.connected && this._setLink(false));
    es.addEventListener("ping", (ev) => {
      this.lastEventAt = Date.now();
      const data = JSON.parse(ev.data || "{}");
      if ("title" in data) this.config = data;
      if ("uptime" in data) {
        this.uptime = data.uptime;
        this.uptimeAt = Date.now();
      }
      this._changed();
    });
    es.addEventListener("sorting_group", (ev) => this.groups.push(JSON.parse(ev.data)));
    es.addEventListener("state", (ev) => {
      this.lastEventAt = Date.now();
      this._onState(JSON.parse(ev.data));
    });
    es.addEventListener("log", (ev) => this._onLog(ev.data));
    this._es = es;
  }

  _onState(msg) {
    const id = msg.name_id;
    if (!id) return;
    const [domain, name] = splitId(id);
    if (msg.domain) this.entities[id] = { ...msg };
    const conf = this.entities[id] || { domain, name };
    const state = toHaState(domain, msg);
    const prev = this.states[id];
    const now = new Date();
    const lastChanged = !prev || prev.state !== state ? now.toISOString() : prev.last_changed;
    if (!prev) this._estimated.add(id);
    else if (prev.state !== state) this._estimated.delete(id);
    this.states[id] = {
      entity_id: id,
      state,
      last_changed: lastChanged,
      last_updated: now.toISOString(),
      attributes: {
        friendly_name: conf.name || name,
        display: msg.state, // the device's own formatting: accuracy_decimals and unit
        domain,
        icon: conf.icon || undefined,
        unit_of_measurement: conf.uom || undefined,
        min: conf.min_value !== undefined ? parseFloat(conf.min_value) : undefined,
        max: conf.max_value !== undefined ? parseFloat(conf.max_value) : undefined,
        step: conf.step !== undefined ? parseFloat(conf.step) : undefined,
        mode: conf.mode,
        options: conf.option,
      },
    };
    this._estimateOverrideSince();
    this._record(id, state);
    this._changed();
  }

  /**
   * On a fresh page the override's start is unknown; the card shows its age from last_changed. Prefer
   * the local recorder, else the controller's deadline minus the timeout (the firmware restamps its
   * clock when the timeout is edited, so this is "since the last restamp" at worst).
   */
  _estimateOverrideSince() {
    const o = this.states[E.override];
    if (!o || !this._estimated.has(E.override) || o.state === "Auto") return;
    const rec = this.history[E.override] || [];
    let i = rec.length - 1;
    while (i > 0 && rec[i - 1][1] === o.state) i--; // back to the start of the current run
    const recorded = i >= 0 && rec[i][1] === o.state;
    if (recorded && i > 0) {
      o.last_changed = new Date(rec[i][0]).toISOString(); // seen it switch: exact
      return;
    }
    const ends = this.states[E.endsAt], timeout = this.states[E.timeout];
    const deadline = ends && Date.parse(String(ends.state).replace(" ", "T"));
    const minutes = timeout && parseFloat(timeout.state);
    if (Number.isFinite(deadline) && minutes > 0) {
      o.last_changed = new Date(deadline - minutes * 60000).toISOString();
    } else if (recorded) {
      o.last_changed = new Date(rec[i][0]).toISOString(); // at least this old
    }
  }

  /**
   * The card's "controller online" flag. In HA it's the device's Status (its API link to HA); here it's
   * whether this page reaches the device, which is what matters on its own page -- and stays true on
   * the hotspot, where there's no HA at all.
   */
  _setLink(up) {
    this.connected = up;
    const t = new Date().toISOString();
    this.states[E.online] = { entity_id: E.online, state: up ? "on" : "off", last_changed: t, last_updated: t,
      attributes: { friendly_name: "Liaison avec cette page" } };
    this._changed();
  }

  _onLog(raw) {
    const text = String(raw).replace(ANSI, "");
    const m = /^\[([EWICDV])\]\[([^\]]*)\](?:\[[^\]]*\])?:\s?([\s\S]*)$/.exec(text);
    this.logs.push({
      t: Date.now(),
      level: m ? LEVELS[m[1]] : "info",
      tag: m ? m[2] : "",
      msg: m ? m[3] : text,
    });
    if (this.logs.length > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX);
    this.dispatchEvent(new CustomEvent("log", { detail: this.logs[this.logs.length - 1] }));
  }

  /* ---------------------------------------------------------------- recorder */

  _record(id, state) {
    if (!RECORDED.has(id)) return;
    const s = (this.history[id] ||= []);
    const last = s[s.length - 1];
    const now = Date.now();
    if (last && last[1] === state) return;
    s.push([now, state]);
    // Drop what fell out of the window, keeping the last point before it: a step series still knows its
    // state at the window's start.
    let i = 0;
    while (i < s.length - 1 && s[i + 1][0] < now - HISTORY_MS) i++;
    if (i) s.splice(0, i);
  }

  /** [[t ms, value]] for one entity from `from` (ms), with the value in force at `from` first when known. */
  series(id, from) {
    const s = this.history[id] || [];
    let i = s.findIndex((p) => p[0] >= from);
    if (i === -1) i = s.length;
    return s.slice(Math.max(0, i - 1));
  }

  /* ---------------------------------------------------------------- HA API the card uses */

  async callService(domain, service, data = {}) {
    if (domain === "script") {
      const script = service === "turn_on" ? String(data.entity_id || "").replace(/^script\./, "") : service;
      const vars = service === "turn_on" ? data.variables || {} : data;
      if (script === "piscine_retour_auto") return this.select(E.override, "Auto");
      if (script === "piscine_forcer_vitesse") {
        if (vars.duree !== undefined) await this.setNumber(E.timeout, vars.duree);
        return this.select(E.override, vars.vitesse);
      }
      throw new Error(`script.${script} has no equivalent on the controller`);
    }
    const id = data.entity_id;
    if (domain === "number" && service === "set_value") return this.setNumber(id, data.value);
    if (domain === "select" && service === "select_option") return this.select(id, data.option);
    if (domain === "button" && service === "press") return this.press(id);
    if (["fan", "switch"].includes(domain) && ["turn_on", "turn_off", "toggle"].includes(service)) {
      return this._post(id, service);
    }
    throw new Error(`${domain}.${service} isn't supported by the controller's web server`);
  }

  async callWS(msg) {
    if (msg.type === "history/history_during_period") {
      const from = Date.parse(msg.start_time) || 0;
      const out = {};
      for (const id of msg.entity_ids || []) {
        out[id] = this.series(id, from).map(([t, s]) => ({ s, lc: t / 1000 }));
      }
      return out;
    }
    throw new Error(`${msg.type} isn't available on the controller`);
  }

  setNumber(id, value) {
    return this._post(id, "set", { value });
  }
  select(id, option) {
    return this._post(id, "set", { option });
  }
  press(id) {
    return this._post(id, "press");
  }
  setText(id, value) {
    return this._post(id, "set", { value });
  }
  /** `value` as the device takes it: "YYYY-MM-DD HH:MM:SS", local time. */
  setDateTime(id, value) {
    return this._post(id, "set", { value });
  }

  async _post(id, action, params = {}) {
    const [domain, name] = splitId(id);
    const qs = new URLSearchParams(params).toString();
    const url = `/${domain}/${encodeURIComponent(name)}/${action}${qs ? "?" + qs : ""}`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`${action} ${id}: HTTP ${res.status}`);
  }

  /* ---------------------------------------------------------------- change notification */

  _changed() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.dispatchEvent(new Event("change"));
    });
  }
}

/** ESPHome's JSON -> the state string HA would show for the same entity. */
function toHaState(domain, msg) {
  switch (domain) {
    case "binary_sensor":
    case "fan":
    case "switch":
      return msg.value ? "on" : "off";
    case "sensor":
      return msg.value === null || msg.value === undefined || Number.isNaN(msg.value) ? "unavailable" : String(msg.value);
    case "button":
      return "unknown";
    default:
      return msg.value === null || msg.value === undefined ? "unknown" : String(msg.value);
  }
}
