/*
 * A Home Assistant-shaped `hass` object fed by the device's own web_server (v3 protocol), so the
 * piscine-card written for HA runs unchanged on the ESP32's page.
 *
 *   /events (SSE)   ping (config, then uptime), state (one entity), log (one line, ANSI-coloured)
 *   POST /{domain}/{name}/{action}?…   number set, select set, button press, fan/switch turn_on|off,
 *                                       update install
 *   GET /login/session   whether this browser's login session is alive (and keeps it so)
 *
 * Once a Page Password is set, the controller answers 401 without a login session (docs/plans/page-login.md): a 401
 * on the stream or on a POST dispatches "login-required", and the page shows its login screen (login.js).
 *
 * Entity ids are "domain/Name" ("select/Manual Override"): ESPHome 2026.11 sends them as `id`; older
 * versions sent them as `name_id` beside an `id` of "domain-object_id", hence entityId(). The card is configured with those
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
  planHistory: "text_sensor/Daily Plan History",
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
  freezeAt: "number/Freeze Protection Temperature",
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
  fillToday: "sensor/Fill Water Today",
  fillDays: "text_sensor/Fill Water Days",
  fillMonths: "text_sensor/Fill Water Months",
  // Write-only, a one-off tool Home Assistant drives (its history into the record above): known, so the page lists
  // it nowhere (not under Capteurs internes › Autres entités).
  fillImport: "text/Fill Water Import",
  // From fill-meter.yaml: the meter as an option, its pulse test and its long-fill alarm. A firmware without them
  // counts the meter always: the page shows Remplissage and no « Compteur d'eau ».
  fillEnabled: "switch/Fill Meter",
  fillAlarmAfter: "number/Fill Alarm After",
  fillDetect: "button/Detect Fill Meter",
  fillStatus: "text_sensor/Fill Meter Status",
  fillLastPulse: "text_sensor/Fill Meter Last Pulse",
  fillRunning: "binary_sensor/Fill Running",
  fillTooLong: "binary_sensor/Fill Running Too Long",
  fillAck: "button/Acknowledge Fill Alarm",
  fillAcked: "binary_sensor/Fill Alarm Acknowledged",
  fwVersion: "text_sensor/Firmware Version",
  esphomeVersion: "text_sensor/ESPHome Version",
  // From updates.yaml: the page falls back to comparing with GitHub on a firmware without them.
  fwUpdate: "update/Firmware",
  updateStatus: "text_sensor/Update Status",
  updateProgress: "sensor/Update Progress",
  autoUpdate: "switch/Auto Update",
  updateInterval: "select/Update Check Interval",
  checkUpdate: "button/Check for Update",
  cancelUpdate: "button/Cancel Update",
  // From wifi-setup.yaml: the page hides what a firmware without it doesn't have.
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
  // From device-settings.yaml (setup.js): what used to be compiled in. Secrets are write-only.
  setupState: "text_sensor/Setup State",
  pagePassword: "text/Page Password",
  otaPassword: "text/OTA Password",
  apiKey: "text/API Key",
  generateKey: "button/Generate API Key",
  forgetKey: "button/Forget API Key",
  latitude: "number/Latitude",
  longitude: "number/Longitude",
  timezone: "text/Timezone",
  timezoneName: "text/Timezone Name",
  detectedProbes: "text_sensor/Detected Probes",
  poolProbe: "select/Pool Probe",
  padProbe: "select/Pad Probe",
  outdoorProbe: "select/Outdoor Probe",
  rescanProbes: "button/Rescan Probes",
  factoryReset: "button/Factory Reset",
  logoutAll: "button/Logout All Devices", // ends every login session (docs/plans/page-login.md)
  waitingFor: "text_sensor/Schedule Waiting For",
};

/** What the recorder keeps (every change): the card draws today's overrides from it. */
const RECORDED = new Set([E.override]);

const ANSI = /\x1b\[[0-9;]*m/g;
const LEVELS = { E: "error", W: "warn", I: "info", C: "config", D: "debug", V: "verbose" };

const splitId = (id) => {
  const i = id.indexOf("/");
  return [id.slice(0, i), id.slice(i + 1)];
};

/** An entity's "domain/Name" id: `id` from ESPHome 2026.11, `name_id` before (when `id` was
 * "domain-object_id"). Null for a message that carries neither. */
export function entityId(msg) {
  if (msg.name_id) return msg.name_id;
  const id = String(msg.id || "");
  return id.includes("/") ? id : null;
}

/** Whether the controller now runs another firmware than the one first seen: `seen` unset means nothing seen yet. */
export const firmwareChanged = (seen, reported) => !!seen && !!reported && seen !== reported;

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
    this.firmware = null; // the controller's firmware when this page loaded (Firmware's current_version)
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      this.themes = { darkMode: e.matches };
      this._changed();
    });
  }

  /* ---------------------------------------------------------------- stream */

  /** Opens the stream, or a new one in place of the last (after a login: this one carries its cookie). */
  connect() {
    this._close();
    this.groups = []; // sent again with the rest
    const es = new EventSource("/events");
    this._es = es;
    es.addEventListener("open", () => this._setLink(true));
    // The stream drops on a reboot or a Wi-Fi hiccup, and when the controller ends this browser's session (idle,
    // logout, a new Page Password): only the session says which, so it's asked at once, and a 401 brings the login
    // screen. EventSource retries on its own; until then the controller is unreachable from here. It gives up for good
    // on an answer other than 200 (the gate's 401 among them): then a new stream starts every 5 s.
    es.addEventListener("error", () => {
      if (this._es !== es) return;
      if (this.connected) this._setLink(false);
      this.checkSession().then(() => {
        if (this._es !== es || es.readyState !== EventSource.CLOSED) return;
        this._retry = setTimeout(() => this.connect(), 5000);
      });
    });
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
  }

  /** Closes the stream, with no retry: logged out, the login screen up. */
  disconnect() {
    this._close();
    if (this.connected) this._setLink(false);
  }

  _close() {
    this._es?.close();
    this._es = null;
    clearTimeout(this._retry);
  }

  /**
   * GET /login/session, which also keeps the session alive (session.js): true with a session or none needed, false
   * when the controller wants a login ("login-required" is then dispatched), null when it can't be reached. One at
   * a time.
   */
  checkSession() {
    this._checking ||= fetch("/login/session", { cache: "no-store" })
      .then((res) => {
        if (res.status === 401) this._loginRequired();
        return res.status === 401 ? false : res.ok || null;
      })
      .catch(() => null)
      .finally(() => (this._checking = null));
    return this._checking;
  }

  /** The gate's 401: the stream stops until the login screen has done its work, which calls connect(). */
  _loginRequired() {
    this.disconnect();
    this.dispatchEvent(new Event("login-required"));
  }

  _onState(msg) {
    const id = entityId(msg);
    if (!id) return;
    const [domain, name] = splitId(id);
    if (msg.domain) this.entities[id] = { ...msg };
    // The firmware this page came with: a stream that reconnects onto another (an update, then a reboot) reloads the
    // page, so its code is the new firmware's too. Only the full config, on each connect, carries it.
    if (id === E.fwUpdate && msg.current_version) {
      if (firmwareChanged(this.firmware, msg.current_version)) location.reload();
      this.firmware ??= msg.current_version;
    }
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
        ...(domain === "update" ? updateAttributes(msg, conf) : {}),
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
    if (domain === "update" && service === "install") return this.install(id);
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
  /** An update entity's install: the firmware's gate decides when it starts (updates.yaml). */
  install(id) {
    return this._post(id, "install");
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
    if (res.status === 401) {
      this._loginRequired();
      throw new Error("connexion requise");
    }
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
    case "update":
      // HA: on = an update to install (installing included), off = up to date.
      return { "UPDATE AVAILABLE": "on", INSTALLING: "on", "NO UPDATE": "off" }[msg.state] || "unknown";
    default:
      return msg.value === null || msg.value === undefined ? "unknown" : String(msg.value);
  }
}

/**
 * An update entity's attributes as HA names them. The device sends the latest version as `value` with
 * every state, the installed one and the release only with the full config (on connect).
 */
function updateAttributes(msg, conf) {
  return {
    installed_version: conf.current_version || null,
    latest_version: msg.value || null,
    in_progress: msg.state === "INSTALLING",
    release_url: conf.release_url || null,
    title: conf.title || null,
  };
}
