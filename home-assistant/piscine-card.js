/*
 * piscine-card — tile + panel for the pool pump (ESP32 Pool Controller).
 *
 * A Lovelace card, installed through HACS from the pool-controller repo (see its README, « Home
 * Assistant card »). Every change bumps VERSION: merging it to main publishes that version.
 *
 *   type: custom:piscine-card
 *   variant: tile        # tile on a dashboard; tap opens the Bubble pop-up `popup_hash`
 *   layout: horizontal   # or vertical (tile only)
 *   popup_hash: "#piscine"
 *
 *   type: custom:piscine-card
 *   variant: panel       # full controls, placed inside the Bubble pop-up
 *   settings_tab: false  # optional: no « Avancé » nor « Réglages » tab; « Planning et réglages » then opens more_path
 *   temperatures: false  # optional: no outdoor / equipment-pad block at the foot of « Pompe »
 *   controller_light: false                            # optional: no light for the controller (tile, header)
 *   controller_health: { warn: 3, alert: 15, beat: 4 }  # optional: its minutes before amber, before red; seconds between beats
 *
 * The card never writes the controller's Manual Override select itself:
 *   force a speed   script.piscine_forcer_vitesse (vitesse: Off|Low|Medium|High)
 *   back to Auto    script.piscine_retour_auto
 *   duration        number.…_manual_override_timeout (minutes, 0 = never), written directly: the ESP32 holds
 *                   the deadline and ends the override itself (pool-controller PR 19); …_manual_override_ends_at
 *                   is its own "back to Auto at" for the tile and the timeline. No HA timer any more.
 * The fan entity is deliberately not used: its "off" is Manual Override Off, the 16 h trap.
 *
 * Day timeline: the plan in blue; every Manual Override that ran today in red, with its speed's intensity —
 * the ended ones from the recorder (history/history_during_period on the select since local midnight,
 * loaded when the panel is shown and every 15 min, extended live from state changes), the running one up
 * to the controller's deadline (24 h without one).
 *
 * Pool temperature (« Température du bassin », right under the day plan, above Pilotage; mock-up approved
 * 2026-11-17). The probe is on the return pipe: it reads the pool only while water flows, and with the pump
 * stopped it drifts toward the equipment pad's air (warmer than the water in winter). So the card draws what
 * the firmware trusts — readings after 10 min of pumping — apart from the rest:
 *   24 h   the water sensor and the commanded speed from the recorder (same call and reload as the
 *          overrides): solid line for the pool, dashed for the pipe, filtration periods shaded;
 *   7 j    each day's min–max from the device's Daily History, today from Pool Water Min/Max Today;
 *   30 j, 90 j   the same two sensors' long-term statistics (state_class since firmware 2026-11-17), each day
 *          read from its 23:00 hourly row: Min Today only falls and Max Today only rises within a day, so that row
 *          holds the day's final values, while HA's 00:00 hour still carries yesterday's until the reset;
 *   1 an   a bar a week: the days above, and beyond 90 days HA's own daily statistics of the two sensors (a day
 *          there may still hold the evening before: at most a day of lag on a 7-day bar).
 * Days the pool's min–max isn't known (before those statistics start) get the probe's own daily mean instead,
 * dashed like the pipe on 24 h since it includes it: HA keeps it as long as the sensor has existed. A day whose
 * probe spans more than PROBE_GLITCH_C had a bad reading (0 °C, 110 °C) that skews its mean: it is left out.
 * Every view draws the freeze-protection threshold (number Freeze Protection Temperature, 3 °C by default), in
 * red: a dotted line over the zone where Low is forced once the water comes within FREEZE_NEAR_C of it, else a
 * tag at the foot of the axis, so a 13 °C curve isn't squashed to show 3 °C.
 * `recorder: false` (the device's own page) leaves only 7 j, which the device keeps itself, and no range to pick.
 *
 * The controller's light (a dot on the tile; in the panel's header a button that opens « Avancé » › Contrôleur):
 * when the controller was last heard, from the newest update of any of its entities. Green while it talks; amber
 * when it has been quiet for `warn` min, or offline for less than `alert` (a restart, an OTA, a Wi-Fi drop usually
 * end on their own); red beyond. Each new message pops the dot and sends a ring out of it (every `beat` s at most).
 * Its heartbeat is the Device Clock (wifi-setup.yaml, entity `clock`), which changes every minute; without it a
 * still night leaves every value as it was, so only the link counts. Offline, the light replaces the pump's state.
 *
 * Fill water (tab « Remplissage », next to « Pompe »; recorder only, so not on the device's page; mock-up
 * 2026-11-17). The water meter on the fill line (Piscine - Volume total remplissage, total_increasing) as HA's
 * statistics `change`: 30 j one bar a day, 90 j one a week (13 weeks from a Monday, HA's weeks), 12 mois one a
 * month, the period's total above. The running day/week/month adds what the meter counted since the last
 * compiled hour (the live state against that hour's `state`; after a reboot the meter restarts from 0). Above it,
 * today, this month so far and the flow. A tab rather than one more block: the pop-up stays a pump control, and the
 * water history is one tap away.
 *
 * « Avancé » and « Réglages » (mock-up 2026-11-17): between them, every control the controller has, as on its
 * own page's Avancé tab, so the pop-up needs no dashboard behind it. « Avancé »: today's plan with « Recalculer »,
 * the last 7 days of filtration against the plan (Daily History), the controller (its link, Wi-Fi, and its
 * firmware: ESPHome's version and build time, from Home Assistant's device registry) and the probes with
 * « Relire ». « Réglages »: the settings, the same rows as `variant: settings`. « Planning et réglages » at the
 * foot of « Pompe » opens « Avancé ». `settings_tab: false` drops both (the device's page has its own Avancé);
 * the link then goes to `more_path`.
 *
 * At the foot of « Pompe », « Températures »: the outdoor and equipment-pad probes, a tap opening Home
 * Assistant's more-info and its history. `temperatures: false` drops it (the device's page has its own tiles).
 *
 *   type: custom:piscine-card
 *   variant: settings    # the controller's settings: the rows of its own page (Avancé › Réglages)
 * Home Assistant's entities card cuts a long name short on a phone and has no line for a description; these
 * rows wrap both. The device's page runs this same variant, with `icons` (name -> SVG path) where HA has
 * <ha-icon>.
 *
 * Layout: one column on a phone (Bubble bottom sheet). From 680 px of container width (the Bubble
 * adaptive-dialog on a screen, width_desktop 760px) the panel is two columns with the day plan and the
 * temperature across the full width under the header — layout « B » approved on the mock-up (« Screen »
 * view) on 2026-11-11.
 */
const VERSION = "1.3.0";

const DEFAULT_ENTITIES = {
  override: "select.pool_controller_manual_override",
  commanded: "sensor.pool_controller_pump_commanded_speed",
  planned: "sensor.piscine_pool_controller_pump_planned_speed",
  nextAt: "sensor.piscine_pool_controller_next_speed_change",
  nextTo: "sensor.piscine_pool_controller_next_planned_speed",
  b1s: "sensor.piscine_pool_controller_schedule_block_1_start",
  b1e: "sensor.piscine_pool_controller_schedule_block_1_end",
  b2s: "sensor.piscine_pool_controller_schedule_block_2_start",
  b2e: "sensor.piscine_pool_controller_schedule_block_2_end",
  hoursToday: "sensor.piscine_pool_controller_filtration_hours_today",
  hoursPlanned: "sensor.piscine_pool_controller_planned_filtration_hours",
  water: "sensor.pool_controller_pool_return_temperature",
  waterMin: "sensor.piscine_pool_controller_pool_water_min_today",
  waterMax: "sensor.piscine_pool_controller_pool_water_max_today",
  history: "sensor.piscine_pool_controller_daily_history",
  outdoor: "sensor.piscine_pool_controller_outdoor_temperature",
  online: "binary_sensor.piscine_pool_controller_status",
  stuck: "binary_sensor.piscine_pool_controller_manual_override_active",
  notComputed: "binary_sensor.piscine_pool_controller_schedule_not_computed",
  recomputed: "sensor.piscine_pool_controller_last_recomputed_at",
  boostInterval: "number.piscine_pool_controller_boost_pulse_interval",
  boostDuration: "number.piscine_pool_controller_boost_pulse_duration",
  highEvery: "number.piscine_pool_controller_high_boost_frequency",
  sun: "sun.sun",
  timeout: "number.piscine_pool_controller_manual_override_timeout",
  freezeAt: "number.piscine_pool_controller_freeze_protection_temperature",
  endsAt: "sensor.piscine_pool_controller_manual_override_ends_at",
  flow: "sensor.piscine_pool_controller_piscine_debit_remplissage",
  volume: "sensor.piscine_pool_controller_piscine_volume_total_remplissage",
  min: "number.piscine_pool_controller_min_filtration_hours",
  max: "number.piscine_pool_controller_max_filtration_hours",
  offset: "number.piscine_pool_controller_filtration_hour_offset",
  warm: "number.piscine_pool_controller_warmest_part_of_day_offset",
  pending: "binary_sensor.piscine_pool_controller_filtration_config_pending",
  apply: "button.piscine_pool_controller_apply_filtration_config",
  pad: "sensor.pool_controller_equipment_pad_temperature",
  nextBoostStart: "sensor.piscine_pool_controller_next_boost_start",
  nextBoostEnd: "sensor.piscine_pool_controller_next_boost_end",
  recompute: "button.piscine_pool_controller_recompute_schedule_now",
  updateTemps: "button.piscine_pool_controller_update_temperature_sensors_now",
  wifiSignal: "sensor.piscine_pool_controller_wifi_signal",
  wifiSsid: "sensor.piscine_pool_controller_wifi_ssid",
  wifiDisc: "sensor.piscine_pool_controller_wifi_disconnects",
  clock: "datetime.piscine_pool_controller_device_clock",
  sForce: "script.piscine_forcer_vitesse",
  sAuto: "script.piscine_retour_auto",
};
const SPEEDS = { Off: "Arrêt", Low: "Low", Medium: "Medium", High: "High" };
const DURATIONS = [["30 min", 30], ["1 h", 60], ["2 h", 120], ["Jamais", 0]];
const FREEZE_DEFAULT_C = 3; // firmware: Freeze Protection Temperature's initial value, until the number is known
const FREEZE_NEAR_C = 4;    // temperature graph: the threshold joins the scale when the water comes this close
const STUCK_MIN = 30;     // firmware: Manual Override Active after this long off Auto
const CMD_TIMEOUT = 15000;
const MORE_PATH = "/dashboard-piscine/0";
const H_MS = 3600000, M_MS = 60000;
const POOL_AFTER_MIN = 10; // firmware: a reading counts as the pool after this long pumping (Pool Water Min/Max Today)
const T_STEP_MIN = 5;      // 24 h curve: one point per 5 min, the sensor's own pace
const T_RANGES = { "24h": "24 h", "7d": "7 j", "30d": "30 j", "90d": "90 j", "1y": "1 an" };
const T_N = { "7d": 7, "30d": 30, "90d": 90, "1y": 53 }; // bars: a day each, 1 an a week each (53 Mondays)
const T_SPAN = { "30d": "30 jours", "90d": "90 jours", "1y": "12 mois" };
const PROBE_GLITCH_C = 12; // a day the probe spans more than this had a bad reading (0 °C, 110 °C): its mean is dropped
/** The controller's light (`controller_health`): minutes before amber, before red; seconds between two heartbeats. */
const HEALTH = { warn: 3, alert: 15, beat: 4 };
/** Never keys: the sun and the two scripts are Home Assistant's, not the controller's. */
const NOT_CONTROLLER = new Set(["sun", "sForce", "sAuto"]);
const WD = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MO = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const W_RANGES = { "30d": "30 j", "90d": "90 j", "12m": "12 mois" };
const W_PERIOD = { "30d": "day", "90d": "week", "12m": "month" };
/** variant: settings — the device page's « Réglages », in its order and words. `icon` when the entity has none. */
const SETTINGS = [
  { sect: "Durée de filtration · s'applique avec «\u00a0Appliquer\u00a0»" },
  { key: "min", label: "Filtration minimale", sub: "Plancher, même par eau froide", icon: "timer-sand" },
  { key: "max", label: "Filtration maximale", sub: "Plafond, même en pleine chaleur", icon: "timer-sand" },
  { key: "offset", label: "Ajustement de durée", sub: "Ajouté à la durée calculée", icon: "timer-plus" },
  { key: "warm", label: "Décalage du pic de chaleur", sub: "Centre du 2ᵉ bloc par rapport au midi solaire", icon: "sun-clock" },
  { key: "apply", label: "Appliquer les réglages", sub: "Recalcule le plan du jour", icon: "check-bold", button: "Appliquer" },
  { sect: "Impulsions · immédiat" },
  { key: "boostDuration", label: "Durée d'une impulsion", icon: "flash" },
  { key: "boostInterval", label: "Intervalle entre impulsions", sub: "0 = pas d'impulsion", icon: "flash-outline" },
  { key: "highEvery", label: "Une impulsion High toutes les", sub: "Les autres sont en Medium", icon: "flash-triangle" },
  { sect: "Hors gel · immédiat" },
  { key: "freezeAt", label: "Low forcé sous", sub: "Quand l'eau descend sous ce seuil, quoi qu'on demande", icon: "snowflake-thermometer" },
  { sect: "Override manuel · immédiat" },
  { key: "timeout", label: "Retour automatique en Auto après", sub: "0 = jamais (alerte après 30 min)", icon: "timer-outline" },
];
const APPLIED = "Réglages appliqués : plan du jour recalculé";

/**
 * Panel, tab « Réglages »: Plan du jour and Contrôleur, the device page's rows (webui/app.js) in its words. A row
 * whose entity is missing is hidden (Wi-Fi rows need wifi-setup.yaml). `val`/`sub` take the card.
 */
const span = (c, a, b) => (hhmm(c._s(a)) !== null && c._s(a) !== c._s(b) ? `${c._s(a)} → ${c._s(b)}` : "—"); // start == end: none
const degC = (k) => (c) => `${fmt1(c._n(k))} °C`;
const PLAN_ROWS = [
  { key: "hoursPlanned", label: "Durée planifiée", icon: "timer-outline", val: (c) => `${fmt1(c._n("hoursPlanned"))} h` },
  { key: "hoursToday", label: "Filtrée aujourd'hui", icon: "timer-check-outline", val: (c) => `${fmt1(c._n("hoursToday"))} h`,
    sub: (c) => (c._n("hoursPlanned") > 0 ? `${Math.round((c._n("hoursToday") / c._n("hoursPlanned")) * 100)} % du plan` : "") },
  { key: "b1s", label: "Bloc 1", icon: "clock-start", val: (c) => span(c, "b1s", "b1e") },
  { key: "b2s", label: "Bloc 2", icon: "clock-end", val: (c) => span(c, "b2s", "b2e") },
  { key: "planned", label: "Vitesse du plan maintenant", icon: "pump", val: (c) => SPEEDS[c._planned()] || c._planned() },
  { key: "commanded", label: "Vitesse commandée", icon: "pump", val: (c) => SPEEDS[c._commanded()] || c._commanded(),
    sub: (c) => (c._inOvr() ? `Override manuel : ${SPEEDS[c._override()]}` : "Suit le plan") },
  { key: "nextAt", label: "Prochain changement", icon: "clock-fast",
    val: (c) => (hhmm(c._s("nextAt")) !== null ? `${c._s("nextAt")} → ${SPEEDS[c._s("nextTo")] || c._s("nextTo")}` : "Plus rien aujourd'hui") },
  { key: "nextBoostStart", label: "Prochaine impulsion", icon: "flash", val: (c) => span(c, "nextBoostStart", "nextBoostEnd") },
  { key: "recomputed", label: "Plan calculé à", icon: "calendar-clock", val: (c) => stamp(c._s("recomputed")) },
  { key: "recompute", label: "Recalculer le plan maintenant", icon: "refresh", button: "Recalculer", ok: "Plan du jour recalculé" },
];
const CTL_ROWS = [
  { key: "online", label: "Liaison avec Home Assistant", icon: "lan-connect", tone: (c) => ({ late: "warn", lost: "bad" })[c._light().h] || "",
    val: (c) => c._lightText(c._light(), "En ligne", "Muet"), sub: (c) => (c._light().seen ? `Dernier message reçu à ${stampMs(c._light().seen)}` : "") },
  { key: "wifiSignal", label: "Signal Wi-Fi", icon: "wifi",
    val: (c) => `${Math.round(c._n("wifiSignal"))} dBm · ${Math.max(0, Math.min(100, 2 * (c._n("wifiSignal") + 100)))} %`, // HA's dBm -> % rule of thumb
    sub: (c) => (c._s("wifiSsid") && c._s("wifiSsid") !== "unknown" ? `Réseau « ${c._s("wifiSsid")} »` : "") },
  { key: "wifiDisc", label: "Déconnexions Wi-Fi", sub: () => "Depuis le démarrage", icon: "wifi-alert", val: (c) => String(Math.round(c._n("wifiDisc"))) },
  { key: "fw", label: "Firmware", icon: "chip", has: (c) => !!c._firmware(), val: (c) => c._firmware().version, sub: (c) => c._firmware().built },
];
/** Panel, tab « Avancé »: the probes, as the device page's Capteurs. */
const PROBE_ROWS = [
  { key: "water", label: "Eau (retour filtre)", icon: "thermometer-water", val: degC("water"),
    sub: (c) => (c._commanded() === "Off" ? "Pompe arrêtée : la sonde lit le tuyau" : "Pompe en marche : l'eau du bassin") },
  { key: "pad", label: "Local technique", icon: "home-thermometer-outline", val: degC("pad") },
  { key: "outdoor", label: "Extérieur", icon: "weather-partly-cloudy", val: degC("outdoor") },
  { key: "updateTemps", label: "Relire les sondes de température", icon: "thermometer", button: "Relire", ok: "Sondes relues" },
];

const ICONS = {
  outdoor: "M12.74,5.47C15.1,6.5 16.35,9.03 15.92,11.46C17.19,12.56 18,14.19 18,16V16.17C18.31,16.06 18.65,16 19,16A3,3 0 0,1 22,19A3,3 0 0,1 19,22H6A4,4 0 0,1 2,18A4,4 0 0,1 6,14H6.27C5,12.45 4.6,10.24 5.5,8.26C6.72,5.5 9.97,4.24 12.74,5.47M11.93,7.3C10.16,6.5 8.09,7.31 7.31,9.07C6.85,10.09 6.93,11.22 7.41,12.13C8.5,10.83 10.16,10 12,10C12.7,10 13.38,10.12 14,10.34C13.94,9.06 13.18,7.86 11.93,7.3M13.55,3.64C13,3.4 12.45,3.23 11.88,3.12L14.37,1.82L15.27,4.71C14.76,4.29 14.19,3.93 13.55,3.64M6.09,4.44C5.6,4.79 5.17,5.19 4.8,5.63L4.91,2.82L7.87,3.5C7.25,3.71 6.65,4.03 6.09,4.44M18,9.71C17.91,9.12 17.78,8.55 17.59,8L19.97,9.5L17.92,11.73C18.03,11.08 18.05,10.4 18,9.71M3.04,11.3C3.11,11.9 3.24,12.47 3.43,13L1.06,11.5L3.1,9.28C3,9.93 2.97,10.61 3.04,11.3M19,18H16V16A4,4 0 0,0 12,12A4,4 0 0,0 8,16H6A2,2 0 0,0 4,18A2,2 0 0,0 6,20H19A1,1 0 0,0 20,19A1,1 0 0,0 19,18Z",
  pad: "M19 8C20.11 8 21 8.9 21 10V16.76C21.61 17.31 22 18.11 22 19C22 20.66 20.66 22 19 22C17.34 22 16 20.66 16 19C16 18.11 16.39 17.31 17 16.76V10C17 8.9 17.9 8 19 8M19 9C18.45 9 18 9.45 18 10V11H20V10C20 9.45 19.55 9 19 9M12 5.69L7 10.19V18H14.1L14 19L14.1 20H5V12H2L12 3L16.4 6.96C15.89 7.4 15.5 7.97 15.25 8.61L12 5.69Z",
  pump: "M12 2L9.5 6H14.5L12 2M12 22L14.5 18H9.5L12 22M2 12L6 14.5V9.5L2 12M22 12L18 9.5V14.5L22 12M12 8A4 4 0 0 0 8 12A4 4 0 0 0 12 16A4 4 0 0 0 16 12A4 4 0 0 0 12 8M12 10A2 2 0 0 1 14 12A2 2 0 0 1 12 14A2 2 0 0 1 10 12A2 2 0 0 1 12 10Z",
  auto: "M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13.57 17.4,15 16.4,16.1L17.84,17.54C19.18,16.09 20,14.15 20,12A8,8 0 0,0 12,4M12,18A6,6 0 0,1 6,12C6,10.43 6.6,9 7.6,7.9L6.16,6.46C4.82,7.91 4,9.85 4,12A8,8 0 0,0 12,20V23L16,19L12,15V18Z",
  close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  alert: "M13,14H11V9H13M13,18H11V16H13M1,21H23L12,2L1,21Z",
  snow: "M20.79,13.95L18.46,14.57L16.46,13.44V10.56L18.46,9.43L20.79,10.05L21.31,8.12L19.54,7.65L20,5.88L18.07,5.36L17.45,7.69L15.45,8.82L13,7.38V5.12L14.71,3.41L13.29,2L12,3.29L10.71,2L9.29,3.41L11,5.12V7.38L8.55,8.82L6.55,7.69L5.93,5.36L4,5.88L4.47,7.65L2.7,8.12L3.22,10.05L5.55,9.43L7.55,10.56V13.45L5.55,14.58L3.22,13.96L2.7,15.89L4.47,16.36L4,18.12L5.93,18.64L6.55,16.31L8.55,15.18L11,16.62V18.88L9.29,20.59L10.71,22L12,20.71L13.29,22L14.7,20.59L13,18.88V16.62L15.45,15.17L17.45,16.3L18.07,18.63L20,18.12L19.53,16.35L21.3,15.88L20.79,13.95M9.5,10.56L12,9.11L14.5,10.56V13.44L12,14.89L9.5,13.44V10.56Z",
  chevron: "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(1).replace(".", ",") : "–");
const pad = (n) => String(n).padStart(2, "0");
const fmtT = (d) => (d instanceof Date && !isNaN(d) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "–");
const fmtD = (min) => {
  const m = Math.max(0, Math.round(min)), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${pad(r)}` : `${h} h`) : `${r} min`;
};
/** Minutes ago -> « à l'instant », « il y a 3 min », « il y a 2 h », « il y a 4 j ». */
const agoTxt = (m) => (!(m >= 1) ? "à l'instant" : m < 90 ? `il y a ${Math.round(m)} min` : m < 36 * 60 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`);
/** A time in ms -> "HH:MM" today, else "DD/MM HH:MM". */
const stampMs = (t) => { const d = new Date(t); return dayKey(d) === dayKey(new Date()) ? fmtT(d) : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${fmtT(d)}`; };
/** "HH:MM" text sensor -> minutes of day, or null for "--:--" / unavailable. */
const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
};
const minOfDay = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
const midnight = (ms = Date.now()) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The date `ago` days before today, at local midnight (DST-safe). */
const dayAgo = (ago) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ago); return d; };
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : NaN; };
/** Litres: « 940 L », « 9 538 L », then m³ from 10 000 L. */
const fmtL = (v) => (!Number.isFinite(v) ? "–" : v >= 10000 ? `${(v / 1000).toFixed(1).replace(".", ",")} m³`
  : `${Math.round(v).toLocaleString("fr-FR").replace(/\s/g, "\u00a0")} L`);
/** Axis label: « 500 L », « 1,5 m³ ». */
const axL = (v) => (v >= 1000 ? `${String(+(v / 1000).toFixed(2)).replace(".", ",")} m³` : `${Math.round(v)} L`);
/** The device's "YYYY-MM-DD HH:MM:SS" -> "HH:MM" today, else "DD/MM HH:MM". */
const stamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m) return s || "—";
  return dayKey(new Date()) === `${m[1]}-${m[2]}-${m[3]}` ? `${m[4]}:${m[5]}` : `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Daily History "2026-11-13: 6.42 h 25.9/26.6 °C, 2026-11-12: 6.70 h" -> { "2026-11-13": {hours, lo, hi}, … }. */
const parseDays = (text) => Object.fromEntries([...String(text || "").matchAll(
  /(\d{4}-\d{2}-\d{2}): ([\d.]+) h(?: (-?[\d.]+)\/(-?[\d.]+) °C)?/g)]
  .map((m) => [m[1], { hours: +m[2], lo: m[3] === undefined ? NaN : +m[3], hi: m[4] === undefined ? NaN : +m[4] }]));

const STYLE = `
:host {
  --acc:#0e86c4; --acc-soft:rgba(14,134,196,.14); --on-acc:#fff;
  --amber:#c98500; --amber-soft:rgba(227,154,6,.17);
  --cool:#2a72cf; --cool-soft:rgba(42,114,207,.13);
  --danger:#cc3a2f; --danger-soft:rgba(204,58,47,.12);
  --good:#2e9a4a;
  --idle:#858c94; --idle-soft:rgba(133,140,148,.17);
  --raised:rgba(127,135,145,.12); --line:rgba(127,135,145,.28);
  --fg:var(--primary-text-color,#1b1e22); --muted:var(--secondary-text-color,#626a73);
  --card:var(--ha-card-background,var(--card-background-color,#fff));
  --shadow:0 1px 2px rgba(20,24,30,.08);
  --toast-bg:#1f2328; --toast-fg:#f3f4f6;
  display:block;
}
:host([variant=tile]) { height:100%; }
:host([variant=panel]) { container-type:inline-size; }
:host([dark]) {
  --acc:#3fb0ec; --acc-soft:rgba(63,176,236,.18); --on-acc:#06202e;
  --amber:#f0b03a; --amber-soft:rgba(240,176,58,.17);
  --cool:#5f9dee; --cool-soft:rgba(95,157,238,.17);
  --danger:#ff6b60; --danger-soft:rgba(255,107,96,.15);
  --good:#4cc26a;
  --idle:#8f969e; --idle-soft:rgba(143,150,158,.17);
  --raised:rgba(255,255,255,.07); --line:rgba(255,255,255,.12);
  --shadow:0 1px 2px rgba(0,0,0,.35);
  --toast-bg:#e7e9ec; --toast-fg:#141619;
}
* { box-sizing:border-box; }
[hidden] { display:none !important; }
button { font:inherit; color:inherit; }
button:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
svg { display:block; fill:currentColor; }
.num { font-variant-numeric:tabular-nums; }

/* icon bubble */
.ico { width:40px; height:40px; border-radius:50%; display:grid; place-items:center; flex:none; position:relative;
  background:var(--idle-soft); color:var(--idle); transition:background .3s,color .3s; }
.ico svg { width:22px; height:22px; }
.ico.big { width:54px; height:54px; } .ico.big svg { width:30px; height:30px; }
.ico.acc { background:var(--acc-soft); color:var(--acc); }
.ico.amber { background:var(--amber-soft); color:var(--amber); }
.ico.cool { background:var(--cool-soft); color:var(--cool); }
.ico.danger { background:var(--danger-soft); color:var(--danger); }
.ico.idle { background:var(--idle-soft); color:var(--idle); }
.ico.spin svg { animation:spin var(--spd,2.4s) linear infinite; }
.ico.pending::after { content:""; position:absolute; inset:-4px; border-radius:50%; border:2px solid transparent;
  border-top-color:var(--acc); border-right-color:var(--acc); animation:spin .9s linear infinite; }
.ico .dot { position:absolute; top:-1px; right:-1px; width:12px; height:12px; border-radius:50%; background:var(--danger); border:2px solid var(--card); }
@keyframes spin { to { transform:rotate(360deg); } }

/* tile */
ha-card.tile { display:flex; align-items:center; gap:12px; padding:12px; cursor:pointer; height:100%; position:relative;
  transition:transform .12s ease; -webkit-tap-highlight-color:transparent; }
ha-card.tile:active { transform:scale(.985); }
.tile .txt { min-width:0; flex:1; display:flex; flex-direction:column; gap:1px; }
.tile .p { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile .s { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tile .s.warn { color:var(--amber); font-weight:500; }
.tile .s.bad { color:var(--danger); font-weight:500; }
.tile .val { font-size:16px; font-weight:500; flex:none; }
.tile .chev { width:18px; height:18px; fill:var(--muted); flex:none; margin-left:-4px; }
ha-card.tile.vertical { flex-direction:column; justify-content:center; text-align:center; gap:8px; padding:14px 8px; }
.tile.vertical .txt { width:100%; align-items:center; }
.tile.vertical .s { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.tile.vertical .val, .tile.vertical .chev { display:none; }
.tile .led { align-self:flex-start; margin:5px -2px 0 0; }
.tile.vertical .led { position:absolute; top:10px; right:10px; margin:0; }

/* The controller's light: a dot in a thin ring of its own colour. Green = a message
   within HEALTH.warn min; amber = quiet for longer, or offline for less than HEALTH.alert min (a restart, an OTA, a
   Wi-Fi drop); red = beyond. On each new message the dot pops and a ring leaves it and fades (every HEALTH.beat s at most). */
.led { --c:var(--good); position:relative; width:9px; height:9px; border-radius:50%; flex:none;
  background:color-mix(in srgb,var(--c) 75%,transparent); box-shadow:0 0 0 2.5px color-mix(in srgb,var(--c) 16%,transparent); }
.led.late, .clink.late { --c:var(--amber); }
.led.lost, .clink.lost { --c:var(--danger); }
.led::after { content:""; position:absolute; inset:-1px; border-radius:50%; border:2px solid var(--c); opacity:0; pointer-events:none; }
.led.ping { animation:beat .45s ease-out; }
.led.ping::after { animation:ping 1.3s cubic-bezier(.15,.6,.3,1); }
@keyframes beat { 30% { transform:scale(1.4); } }
@keyframes ping { 0% { opacity:.6; transform:scale(1); } 100% { opacity:0; transform:scale(3.6); } }

/* panel */
.panel { display:flex; flex-direction:column; gap:18px; padding:4px 2px 8px; color:var(--fg); }
/* The day plan sits right after the header in the DOM (it spans the wide layout); on a phone, CSS order
   puts readings and alerts back in front of it, and the two .col wrappers are transparent. */
.col { display:contents; }
.sh-head { order:-2; }
.readings, .alert { order:-1; }
.sh-head { display:flex; align-items:center; gap:14px; }
.sh-head .t { flex:1; min-width:0; }
.sh-head h3 { margin:0; font-size:19px; font-weight:500; }
.status { display:inline-flex; align-items:center; gap:6px; margin-top:4px; font-size:12px; font-weight:500;
  padding:3px 9px 3px 7px; border-radius:12px; background:var(--idle-soft); color:var(--idle); }
.status::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.status.acc { background:var(--acc-soft); color:var(--acc); }
.status.amber { background:var(--amber-soft); color:var(--amber); }
.status.cool { background:var(--cool-soft); color:var(--cool); }
.status.danger { background:var(--danger-soft); color:var(--danger); }
.st-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:4px; }
.st-row .status { margin-top:0; }
.clink { --c:var(--good); display:inline-flex; align-items:center; gap:7px; height:22px; padding:0 10px 0 8px; border:0; border-radius:12px;
  font-size:12px; font-weight:500; cursor:pointer; background:color-mix(in srgb,var(--c) 13%,transparent); color:var(--c); }
.x { width:38px; height:38px; border-radius:50%; border:0; background:var(--raised); display:grid; place-items:center; cursor:pointer; flex:none; }
.x svg { width:20px; height:20px; fill:var(--muted); }

.readings { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.reading { background:var(--raised); border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:2px; min-width:0; }
.reading .l { font-size:12px; color:var(--muted); }
.reading .v { font-size:22px; font-weight:500; white-space:nowrap; }
.reading .v small { font-size:13px; font-weight:400; color:var(--muted); margin-left:2px; }
.reading .bar { height:4px; border-radius:2px; background:var(--line); overflow:hidden; margin-top:6px; }
.reading .bar i { display:block; height:100%; background:var(--acc); border-radius:2px; transition:width .4s; }

.alert { display:flex; gap:10px; align-items:flex-start; background:var(--danger-soft); color:var(--danger); border-radius:12px; padding:10px 12px; font-size:13px; font-weight:500; flex-wrap:wrap; }
.alert svg { width:18px; height:18px; flex:none; margin-top:1px; }
.alert span { flex:1; min-width:0; }
.alert.amber { background:var(--amber-soft); color:var(--amber); }
.alert.cool { background:var(--cool-soft); color:var(--cool); }
.alert .act { flex-basis:100%; margin-left:28px; margin-top:-2px; }
.alert .act button { height:34px; border-radius:17px; border:0; padding:0 14px; cursor:pointer; font-weight:500; background:var(--danger); color:#fff; }
.alert .act button:disabled { opacity:.5; cursor:not-allowed; }

/* day plan timeline */
.plan { display:flex; flex-direction:column; gap:6px; }
.plan-h { display:flex; justify-content:space-between; align-items:baseline; }
.plan-h .lbl { margin:0; }
.plan-h span { font-size:12px; color:var(--muted); }
.tl { position:relative; height:28px; border-radius:8px; background:var(--raised); overflow:hidden; }
.tl .blk { position:absolute; top:6px; bottom:6px; border-radius:4px; background:var(--acc-soft); }
.tl .blk i { position:absolute; top:0; bottom:0; background:var(--acc); opacity:.35; }
.tl .blk i.hi { opacity:.75; }
/* manual override: red-ish, same intensity ladder as the blue plan (Low pale, Medium mid, High strong; Arrêt hatched) */
.tl .ovr { position:absolute; top:6px; bottom:6px; border-radius:4px; border-left:2px dashed var(--danger); }
.tl .ovr.Low, .tl-leg i.Low { background:var(--danger-soft); }
.tl .ovr.Medium, .tl-leg i.Medium { background:var(--danger); opacity:.35; }
.tl .ovr.High, .tl-leg i.High { background:var(--danger); opacity:.75; }
.tl .ovr.Off, .tl-leg i.Off { background:repeating-linear-gradient(135deg,var(--danger) 0 3px,transparent 3px 7px); opacity:.45; }
.tl-leg i.Off, .tl-leg i.Low, .tl-leg i.Medium, .tl-leg i.High { border:1px dashed var(--danger); }
.tl .now { position:absolute; top:0; bottom:0; width:2px; background:var(--fg); transform:translateX(-1px); }
.tl .now::after { content:""; position:absolute; top:-1px; left:-3px; width:8px; height:8px; border-radius:50%; background:var(--fg); }
.tl .sun { position:absolute; top:0; bottom:0; width:0; border-left:1px dotted var(--muted); opacity:.6; }
.tl-scale { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); padding:0 1px; }
.tl-leg .leg-ovr { display:contents; }
.tl-leg { display:flex; gap:4px 12px; flex-wrap:wrap; font-size:11px; color:var(--muted); }
.tl-leg i { display:inline-block; width:10px; height:10px; border-radius:3px; vertical-align:-1px; margin-right:4px; }

.power { display:flex; flex-direction:column; gap:10px; }
.pbtn { width:100%; min-height:56px; padding:9px 20px; border-radius:28px; border:0; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px;
  font-size:16px; font-weight:500; background:var(--acc); color:var(--on-acc); transition:filter .15s,transform .1s; }
/* The label carries the deadline (« sinon à 19:04 »); in the 2-column dialog the button is ~340 px wide,
   so it wraps on two lines rather than being cut, as on the mock-up. */
.pbtn span { white-space:normal; text-align:center; line-height:1.25; }
.pbtn svg { width:22px; height:22px; flex:none; }
.pbtn:active:not(:disabled) { transform:scale(.99); }
.pbtn:disabled { opacity:.45; cursor:not-allowed; }
.confirm { display:flex; align-items:center; gap:8px; background:var(--danger-soft); border-radius:28px; padding:8px 8px 8px 18px; min-height:56px; }
.confirm span { flex:1; min-width:0; font-weight:500; font-size:14px; }
.confirm button { height:40px; border-radius:20px; border:0; padding:0 16px; cursor:pointer; font-weight:500; }
.confirm .no { background:transparent; color:var(--muted); }
.confirm .yes { background:var(--danger); color:#fff; }

.pend { background:var(--raised); border-radius:14px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
.pend .row { display:flex; justify-content:space-between; gap:10px; font-size:13px; }
.pend .row b { font-weight:500; }
.pend .row span { color:var(--muted); }
.steps { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
.step { display:flex; flex-direction:column; gap:5px; font-size:11px; color:var(--muted); }
.step i { display:block; height:4px; border-radius:2px; background:var(--line); overflow:hidden; position:relative; }
.step.done { color:var(--fg); } .step.done i { background:var(--acc); }
.step.active { color:var(--fg); font-weight:500; }
.step.active i::after { content:""; position:absolute; inset:0; width:40%; background:var(--acc); border-radius:2px; animation:slide 1.1s ease-in-out infinite; }
.step.fail i { background:var(--danger); }
@keyframes slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(250%)} }

.lbl { font-size:12px; font-weight:500; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
.seg { display:grid; grid-template-columns:repeat(var(--n,3),minmax(0,1fr)); gap:4px; background:var(--raised); border-radius:13px; padding:4px; }
.seg button { height:42px; border:0; border-radius:10px; background:transparent; color:var(--muted); font-weight:500; cursor:pointer; position:relative;
  transition:background .15s,color .15s; padding:0 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.seg button[aria-checked="true"] { background:var(--card); color:var(--fg); box-shadow:var(--shadow); }
.seg button.going { color:var(--fg); outline:1.5px dashed var(--acc); outline-offset:-3px; }
.seg button.stop[aria-checked="true"] { color:var(--danger); }
.seg button:disabled { cursor:not-allowed; }
.seg button:disabled:not([aria-checked="true"]):not(.going) { opacity:.5; }
.seg button small { display:block; font-size:10px; font-weight:400; color:var(--muted); line-height:1.1; margin-top:1px; }
.hint { font-size:12px; color:var(--muted); margin:8px 2px 0; }
.hint b { font-weight:500; color:var(--fg); }
.manual { display:flex; flex-direction:column; gap:14px; background:var(--amber-soft); border-radius:16px; padding:12px; }
.manual .lbl { margin-bottom:6px; }

.link { display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--raised); border-radius:12px; padding:11px 14px;
  font-size:13px; font-weight:500; border:0; width:100%; cursor:pointer; text-align:left; color:var(--fg); }
.link svg { width:18px; height:18px; fill:var(--muted); flex:none; }

.foot { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--muted); border-top:1px solid var(--line); padding-top:12px; }
.foot .stale { color:var(--danger); font-weight:500; }

.toast { position:fixed; left:50%; bottom:22px; transform:translate(-50%,20px); opacity:0; pointer-events:none;
  background:var(--toast-bg); color:var(--toast-fg); border-radius:12px; padding:11px 15px; font-size:13px; font-weight:500;
  width:max-content; max-width:calc(100vw - 32px); transition:opacity .2s,transform .2s; z-index:1000; box-shadow:0 6px 20px rgba(0,0,0,.25); }
.toast.show { opacity:1; transform:translate(-50%,0); }
.toast.err { background:var(--danger); color:#fff; }

/* pool temperature: right after the day plan in the DOM, so it follows it on a phone and in the wide layout */
.temp { display:flex; flex-direction:column; gap:6px; }
.temp-h { display:flex; align-items:center; justify-content:space-between; gap:6px 8px; flex-wrap:wrap; }
.temp-h .lbl { margin:0; }
.seg.mini { display:inline-grid; grid-auto-flow:column; border-radius:10px; padding:3px; gap:2px; }
.seg.mini button { height:26px; padding:0 11px; font-size:12px; border-radius:7px; }
.temp-sum { font-size:12px; color:var(--muted); margin:0; }
.temp-sum b { color:var(--fg); font-weight:500; }
.temp-sum span { display:block; }
.chart { position:relative; height:136px; background:var(--raised); border-radius:12px; touch-action:pan-y; cursor:crosshair; outline-offset:2px; }
.chart:focus-visible { outline:2px solid var(--acc); }
.chart svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; fill:none; }
.chart .gl { stroke:var(--line); stroke-width:1; }
.chart text { font-size:10px; font-family:inherit; fill:var(--muted); }
.chart text.vl { font-weight:500; fill:var(--fg); }
.chart .band { fill:var(--acc); opacity:.09; }
.chart .pool { stroke:var(--acc); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
.chart .pipe { stroke:var(--muted); stroke-width:1.5; stroke-dasharray:3 3; stroke-linecap:round; opacity:.85; }
.chart .xh { stroke:var(--fg); stroke-width:1; opacity:.45; }
.chart .pt { stroke:var(--raised); stroke-width:2; }
.chart .pt.ok { fill:var(--acc); } .chart .pt.no { fill:var(--muted); }
.chart .rng { fill:var(--acc); opacity:.5; }
.chart .mdot { fill:var(--muted); opacity:.85; }
.chart .rng.today { opacity:1; } .chart .rng.hov { opacity:.8; }
/* freeze-protection threshold, in red: dotted line and the zone where Low is forced, or a tag at the foot of the axis */
.chart .fz { stroke:var(--danger); stroke-width:1.5; stroke-dasharray:1 3; stroke-linecap:round; }
.chart .fz-zone { fill:var(--danger); opacity:.07; }
.chart text.fz-t { fill:var(--danger); font-weight:500; }
.tl-leg i.k-fz { width:14px; height:0; border-radius:0; border-top:2px dotted var(--danger); vertical-align:3px; }
.chart .empty { position:absolute; inset:0; display:grid; place-items:center; text-align:center; padding:0 20px; font-size:12px; color:var(--muted); cursor:default; }
.ttip { position:absolute; top:6px; pointer-events:none; background:var(--card); color:var(--muted); box-shadow:0 2px 10px rgba(0,0,0,.18);
  border-radius:8px; padding:5px 9px; font-size:11px; line-height:1.35; white-space:nowrap; z-index:2; }
.ttip b { display:block; font-size:14px; font-weight:500; color:var(--fg); }
.ttip i { display:inline-block; width:12px; height:0; border-top:2px solid var(--acc); vertical-align:3px; margin-right:5px; }
.ttip i.no { border-top-style:dashed; border-top-color:var(--muted); }
.tl-leg i.k-pool, .tl-leg i.k-pipe { width:14px; height:0; border-radius:0; border-top:2px solid var(--acc); vertical-align:3px; }
.tl-leg i.k-pipe { border-top:2px dashed var(--muted); }
.tl-leg i.k-band { background:var(--acc); opacity:.2; }
.tl-leg i.k-rng { width:6px; height:11px; background:var(--acc); border-radius:2px; }

/* tabs « Pompe » / « Remplissage » / « Avancé » / « Réglages »: the pump tab is everything the panel had; the others hide it */
.tabs { order:-2; display:flex; gap:4px; border-bottom:1px solid var(--line); margin:-8px 0 -6px; }
.tabs button { position:relative; border:0; background:none; padding:10px 12px; font-size:14px; font-weight:500; color:var(--muted); cursor:pointer; }
.tabs button[aria-selected="true"] { color:var(--acc); }
.tabs button[aria-selected="true"]::after { content:""; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; border-radius:2px 2px 0 0; background:var(--acc); }
.panel[data-tab="water"] > :not(.sh-head):not(.tabs):not(.water):not(.toast) { display:none !important; }
.panel[data-tab="adv"] > :not(.sh-head):not(.tabs):not(.advpane):not(.toast) { display:none !important; }
.panel[data-tab="settings"] > :not(.sh-head):not(.tabs):not(.setpane):not(.toast) { display:none !important; }
.panel:not([data-tab="water"]) > .water, .panel:not([data-tab="adv"]) > .advpane, .panel:not([data-tab="settings"]) > .setpane { display:none; }
.tabs button { padding:10px 10px; }
.water { display:flex; flex-direction:column; gap:6px; }
.water .readings { margin-bottom:12px; grid-template-columns:repeat(3,minmax(0,1fr)); }
.reading.live .v { color:var(--acc); }
.chart .bar { fill:var(--acc); }
.chart .bar.cur { opacity:.55; } .chart .bar.hov { opacity:.8; } .chart .bar.cur.hov { opacity:.45; }
.chart .base { stroke:var(--muted); stroke-width:1; opacity:.5; }
.tl-leg i.k-bar { width:8px; height:11px; background:var(--acc); border-radius:2px 2px 0 0; }
.tl-leg i.k-cur { width:8px; height:11px; background:var(--acc); opacity:.55; border-radius:2px 2px 0 0; }

/* « Températures », at the foot of « Pompe »: outdoor and equipment pad, a tap opens HA's more-info (its history).
   One per row on a phone, side by side once 200 px each fit. */
.probes { display:flex; flex-direction:column; gap:8px; }
.probes .lbl { margin:0; }
.probes .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:8px; }
.ptile { display:flex; align-items:center; gap:10px; min-width:0; padding:10px; border:0; border-radius:12px; background:var(--raised);
  text-align:left; cursor:pointer; color:var(--fg); }
.ptile .ico { width:36px; height:36px; background:var(--acc-soft); color:var(--acc); }
.ptile .ico svg { width:20px; height:20px; }
.ptile .txt { display:flex; flex-direction:column; min-width:0; }
.ptile .p { font-size:14px; font-weight:500; overflow-wrap:anywhere; }
.ptile .s { font-size:13px; color:var(--muted); }

/* tab « Avancé »: today's plan, the last 7 days, the controller and its probes; tab « Réglages »: the settings
   (together, the device page's Avancé). Each column is a container, so its rows wrap at its own width. */
.advpane, .setpane { display:flex; flex-direction:column; gap:22px; }
.setpane { container-type:inline-size; }
.sp-col { display:flex; flex-direction:column; gap:22px; min-width:0; container-type:inline-size; }
.sp-h { display:flex; align-items:center; gap:10px; margin:0 0 2px; font-size:15px; font-weight:500; }
.erow .val { margin-left:auto; text-align:right; white-space:nowrap; }
.erow .val.bad { color:var(--danger); font-weight:500; }
.days { display:flex; flex-direction:column; gap:4px; }
.day { display:grid; grid-template-columns:70px minmax(0,1fr) 44px 74px; align-items:center; gap:8px; min-height:28px; font-size:13px; }
.day.head { min-height:0; font-size:11px; color:var(--muted); }
.day .w, .day .v { text-align:right; white-space:nowrap; }
.day .dl { color:var(--muted); white-space:nowrap; }
.day.today .dl { color:var(--fg); font-weight:500; }
.day .bar { position:relative; height:10px; border-radius:5px; background:var(--raised); }
.day .bar i { position:absolute; left:0; top:0; bottom:0; border-radius:5px; background:var(--acc); }
.day.today .bar i { opacity:.55; }
.day .bar b { position:absolute; top:-4px; bottom:-4px; width:2px; margin-left:-1px; border-radius:1px; background:var(--fg); }
.day.missing .v, .day.missing .dl { color:var(--muted); font-style:italic; }
.days .dfoot { margin:8px 0 0; font-size:12px; color:var(--muted); }

/* variant: settings — the controller's settings, rows as on its own page; names and descriptions wrap */
:host([variant=settings]) { container-type:inline-size; }
ha-card.set-card { display:block; color:var(--fg); }
ha-card.set-card.plain { background:var(--card); border:1px solid var(--ha-card-border-color,var(--line)); border-radius:var(--ha-card-border-radius,12px); }
.set-h { display:flex; align-items:center; gap:10px; margin:0; padding:16px 16px 4px; font-size:20px; font-weight:400; }
.set-h .hic { color:var(--muted); display:grid; }
.set-h .hic svg, .set-h ha-icon { width:24px; height:24px; --mdc-icon-size:24px; }
.chip { margin-left:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:500; padding:4px 10px 4px 8px;
  border-radius:14px; background:var(--amber-soft); color:var(--amber); white-space:nowrap; }
.chip::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.set { padding:8px 16px 16px; }
.banner { display:flex; gap:10px; align-items:center; flex-wrap:wrap; border-radius:12px; padding:10px 12px; font-size:13px; font-weight:500;
  background:var(--amber-soft); color:var(--amber); margin:4px 0 8px; }
.banner svg { width:20px; height:20px; flex:none; }
.banner span { flex:1; min-width:180px; }
.esect { margin:12px 0 2px; font-size:12px; font-weight:500; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.esect:first-child { margin-top:4px; }
.erow { display:flex; align-items:center; gap:14px; min-height:48px; padding:4px 0; }
.erow .ic { width:40px; height:40px; flex:none; display:grid; place-items:center; color:var(--state-icon-color,var(--muted)); }
.erow .ic svg, .erow .ic ha-icon { width:24px; height:24px; --mdc-icon-size:24px; }
.erow .name { flex:1; min-width:0; overflow-wrap:anywhere; }
.erow .name span { display:block; }
.erow .name small { display:block; font-size:12px; line-height:1.35; color:var(--muted); margin-top:1px; }
.erow .ctl { display:flex; align-items:center; gap:10px; flex:0 1 260px; min-width:150px; }
.erow .ctl input { flex:1; min-width:0; accent-color:var(--acc); margin:0; }
.erow .ctl .v { min-width:64px; text-align:right; white-space:nowrap; }
.erow.dirty .ctl .v { color:var(--amber); font-weight:500; }
.btn { height:36px; padding:0 16px; border-radius:18px; border:0; cursor:pointer; font-weight:500; font-size:14px; white-space:nowrap;
  background:var(--acc); color:var(--on-acc); flex:none; }
.btn:disabled { background:var(--raised); color:var(--muted); cursor:not-allowed; }
.btn.busy { opacity:.6; pointer-events:none; }
@container (max-width: 520px) {
  .erow { flex-wrap:wrap; }
  .erow .ctl { flex:1 1 100%; margin-left:54px; min-width:0; }
}

/* Wide panel (Bubble popup_mode: adaptive-dialog on a screen, width_desktop 760px): day plan and pool
   temperature across the full width under the header (24 h on ~700 px), then readings/alerts/Auto on the left,
   Pilotage and the manual controls on the right. Phones never reach 680 px. */
@container (min-width: 680px) {
  .panel { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 28px; align-items:start; padding:6px 6px 4px; }
  .sh-head, .tabs, .water, .advpane, .setpane, .probes, .foot, .plan, .temp { grid-column:1 / -1; }
  .advpane { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 28px; align-items:start; }
  .water .chart { height:170px; }
  .temp { padding-bottom:20px; border-bottom:1px solid var(--line); }
  .temp .chart { height:150px; }
  .plan .tl { height:34px; }
  .col { display:flex; flex-direction:column; gap:16px; min-width:0; }
  .col-state { align-self:stretch; border-right:1px solid var(--line); padding-right:14px; margin-right:-14px; }
  .power:not(:has(:not([hidden]))) { display:none; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; } }
`;

const PANEL_HTML = `
<div class="panel">
  <div class="sh-head">
    <span class="ico big" id="ico">${svg("pump")}</span>
    <div class="t"><h3>Pompe piscine</h3>
      <div class="st-row"><span class="status" id="status"></span><button class="clink" id="ctlLink" hidden><span class="led" id="ctlLed"></span><span id="ctlTxt"></span></button></div></div>
    <button class="x" id="close" aria-label="Fermer">${svg("close")}</button>
  </div>
  <div class="tabs" role="tablist" id="tabs" hidden>
    <button role="tab" data-tab="pump" aria-selected="true">Pompe</button>
    <button role="tab" data-tab="water" aria-selected="false">Remplissage</button>
    <button role="tab" data-tab="adv" aria-selected="false">Avancé</button>
    <button role="tab" data-tab="settings" aria-selected="false">Réglages</button>
  </div>
  <div class="water" role="tabpanel">
    <div class="readings">
      <div class="reading"><span class="l">Rempli aujourd'hui</span><span class="v num" id="wToday"></span></div>
      <div class="reading"><span class="l">Ce mois-ci</span><span class="v num" id="wMonth"></span></div>
      <div class="reading" id="wFlowBox"><span class="l">Débit</span><span class="v num" id="wFlow"></span></div>
    </div>
    <div class="temp-h">
      <p class="lbl">Eau de remplissage</p>
      <div class="seg mini" role="radiogroup" aria-label="Période du graphique" id="wRange">
        ${Object.entries(W_RANGES).map(([r, l]) => `<button role="radio" data-r="${r}">${l}</button>`).join("")}
      </div>
    </div>
    <p class="temp-sum num" id="wSum"></p>
    <div class="chart" id="wChart" tabindex="0" role="img" aria-label="Eau de remplissage"><svg id="wSvg" aria-hidden="true"></svg><div class="ttip" id="wTip" hidden></div><div class="empty" id="wEmpty" hidden></div></div>
    <div class="tl-leg" id="wLeg"></div>
  </div>
  <div class="advpane" role="tabpanel">
    <div class="sp-col">
      <section><h4 class="sp-h">Plan du jour</h4><div id="planRows"></div></section>
      <section><h4 class="sp-h">7 derniers jours</h4><div class="days" id="days"></div></section>
    </div>
    <div class="sp-col">
      <section><h4 class="sp-h">Contrôleur</h4><div id="ctlRows"></div></section>
      <section><h4 class="sp-h">Sondes</h4><div id="probeRows"></div></section>
    </div>
  </div>
  <div class="setpane" role="tabpanel">
    <section><h4 class="sp-h">Réglages<span class="chip" id="pendChip" hidden>En attente</span></h4>
      <div class="banner" id="pendBanner" hidden>${svg("alert")}<span>Durée de filtration modifiée : elle ne compte qu'une fois appliquée, ce qui recalcule le plan du jour.</span><button class="btn" id="applyNow">Appliquer</button></div>
      <div id="rows"></div></section>
  </div>
  <div class="plan">
    <div class="plan-h"><p class="lbl">Plan du jour</p><span class="num" id="planSum"></span></div>
    <div class="tl" id="tl"></div>
    <div class="tl-scale num"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
    <div class="tl-leg"><span><i style="background:var(--acc-soft)"></i>Low</span><span><i style="background:var(--acc);opacity:.45"></i>Impulsion Medium</span><span><i style="background:var(--acc);opacity:.8"></i>High</span><span id="legOvr" class="leg-ovr"></span></div>
  </div>
  <div class="temp">
    <div class="temp-h">
      <p class="lbl">Température du bassin</p>
      <div class="seg mini" role="radiogroup" aria-label="Période du graphique" id="tRange">
        ${Object.entries(T_RANGES).map(([r, l]) => `<button role="radio" data-r="${r}">${l}</button>`).join("")}
      </div>
    </div>
    <p class="temp-sum num" id="tSum"></p>
    <div class="chart" id="tChart" tabindex="0" role="img" aria-label="Température du bassin"><svg id="tSvg" aria-hidden="true"></svg><div class="ttip" id="tTip" hidden></div><div class="empty" id="tEmpty" hidden></div></div>
    <div class="tl-leg" id="tLeg"></div>
  </div>
  <div class="col col-state">
  <div class="readings">
    <div class="reading"><span class="l">Bassin</span><span class="v num" id="water"></span></div>
    <div class="reading"><span class="l">Extérieur</span><span class="v num" id="outdoor"></span></div>
    <div class="reading"><span class="l">Filtration aujourd'hui</span><span class="v num" id="hours"></span><span class="bar"><i id="hoursBar"></i></span></div>
    <div class="reading"><span class="l">Prochain changement</span><span class="v num" id="next"></span></div>
  </div>
  <div class="alert" id="offAlert" hidden>${svg("alert")}<span id="offTxt"></span></div>
  <div class="alert cool" id="freezeAlert" hidden>${svg("snow")}<span id="freezeTxt"></span></div>
  <div class="alert amber" id="planAlert" hidden>${svg("alert")}<span>Plan du jour non calculé : le contrôleur n'a pas pu lire la température ou le lever du soleil. La pompe peut rester arrêtée.</span></div>
  <div class="alert" id="stuckAlert" hidden>${svg("alert")}<span id="stuckTxt"></span><div class="act"><button id="stuckBtn">Revenir en Auto</button></div></div>
  <div class="power">
    <button class="pbtn" id="autoBtn" hidden>${svg("auto")}<span id="autoBtnTxt">Revenir en Auto</span></button>
    <div class="confirm" id="confirm" hidden>
      <span id="confirmTxt"></span>
      <button class="no" id="cfNo">Annuler</button>
      <button class="yes" id="cfYes">Arrêter</button>
    </div>
    <div class="pend" id="pend" hidden aria-live="polite">
      <div class="row"><b id="pendLabel"></b><span class="num" id="pendTime"></span></div>
      <div class="steps">
        <div class="step" id="st0"><i></i>Envoyé</div>
        <div class="step" id="st1"><i></i>Appliqué par le contrôleur</div>
      </div>
    </div>
  </div>
  </div>
  <div class="col col-set">
  <div class="ctl">
    <p class="lbl">Pilotage</p>
    <div class="seg" role="radiogroup" aria-label="Pilotage de la pompe" id="modeSeg" style="--n:2">
      <button role="radio" data-mode="auto">Auto</button>
      <button role="radio" data-mode="manual">Manuel</button>
    </div>
    <p class="hint" id="modeHint"></p>
  </div>
  <div class="manual" id="manualBlock" hidden>
    <div>
      <p class="lbl">Vitesse forcée</p>
      <div class="seg" role="radiogroup" aria-label="Vitesse forcée" id="speedSeg" style="--n:4">
        <button role="radio" class="stop" data-speed="Off">Arrêt</button>
        <button role="radio" data-speed="Low">Low</button>
        <button role="radio" data-speed="Medium">Medium</button>
        <button role="radio" data-speed="High">High</button>
      </div>
    </div>
    <div>
      <p class="lbl">Retour en Auto</p>
      <div class="seg" role="radiogroup" aria-label="Durée de l'override" id="durSeg" style="--n:4">
        ${DURATIONS.map(([opt, m]) => `<button role="radio" data-dur="${opt}">${opt}${m ? "" : "<small>alerte 30 min</small>"}</button>`).join("")}
      </div>
      <p class="hint" id="durHint"></p>
    </div>
  </div>
  <button class="link" id="more"><span>Planning et réglages</span>${svg("chevron")}</button>
  </div>
  <div class="probes" id="probes">
    <p class="lbl">Températures</p>
    <div class="grid">
      <button class="ptile" data-key="outdoor"><span class="ico">${svg("outdoor")}</span><span class="txt"><span class="p">Extérieur</span><span class="s num" id="prOut"></span></span></button>
      <button class="ptile" data-key="pad"><span class="ico">${svg("pad")}</span><span class="txt"><span class="p">Local technique</span><span class="s num" id="prPad"></span></span></button>
    </div>
  </div>
  <div class="foot"><span class="num" id="sync"></span><span class="num" id="plannedTxt"></span></div>
  <div class="toast" id="toast" role="status"></div>
</div>`;

const SETTINGS_HTML = `
<ha-card class="set-card" id="setCard">
  <h2 class="set-h"><span class="hic" id="setIcon"></span><span id="setTitle"></span><span class="chip" id="pendChip" hidden>En attente</span></h2>
  <div class="set">
    <div class="banner" id="pendBanner" hidden>${svg("alert")}<span>Durée de filtration modifiée : elle ne compte qu'une fois appliquée, ce qui recalcule le plan du jour.</span><button class="btn" id="applyNow">Appliquer</button></div>
    <div id="rows"></div>
  </div>
  <div class="toast" id="toast" role="status"></div>
</ha-card>`;

const TILE_HTML = `
<ha-card class="tile" id="tile" role="button" tabindex="0" aria-haspopup="dialog">
  <span class="ico" id="ico">${svg("pump")}</span>
  <span class="txt"><span class="p">Pompe piscine</span><span class="s" id="sec"></span></span>
  <span class="val num" id="val"></span>
  <span class="led" id="led" role="img" hidden></span>
  <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS.chevron}"/></svg>
</ha-card>`;

class PiscineCard extends HTMLElement {
  setConfig(config) {
    const variant = config.variant || "tile";
    if (!["tile", "panel", "settings"].includes(variant)) throw new Error("variant must be tile, panel or settings");
    this._config = { variant, layout: config.layout || "horizontal", popup_hash: config.popup_hash || "#piscine", more_path: config.more_path || MORE_PATH,
      recorder: config.recorder !== false, title: config.title ?? "Réglages", icons: config.icons || null,
      settings_tab: config.settings_tab !== false, temperatures: config.temperatures !== false,
      controller_light: config.controller_light !== false, health: { ...HEALTH, ...(config.controller_health || {}) } };
    this._e = { ...DEFAULT_ENTITIES, ...(config.entities || {}) };
    this.setAttribute("variant", variant);
    this._built = false;
    this._confirm = false;
    this._manual = false;      // « Manuel » tapped while still on Auto: show the speed block
    this._local = null;        // command started from this card: {value, label, t0, echoed}
    this._hist = null;         // Manual Override states of the last 24 h [{s, t (ms)}], recorder + live changes
    this._wHist = null;        // the same for the water sensor and the commanded speed (24 h curve)
    this._cHist = null;
    this._histDay = null; this._histAt = 0; this._histLoading = false;
    this._range = this._config.recorder ? "24h" : "7d";
    this._tHover = null;       // 24 h: minutes before now; 7 j / 30 j: day index
    this._stats = null;        // 30 / 90 j: { "YYYY-MM-DD": {lo, hi} }, the 23:00 rows of the hourly statistics
    this._daily = null;        // 30 j – 1 an: { "YYYY-MM-DD": {mean (the probe), lo, hi (HA's day of Min/Max Today)} }
    this._beatSeen = null; this._beatAt = -1e9; // the light's last heartbeat: the message it was for, when (performance.now)
    this._statsAt = 0; this._statsLoading = false; this._statsErr = false;
    this._tVer = 0; this._tDrawn = "";
    this._tab = "pump";        // panel: « Pompe », « Remplissage » (water), « Avancé » (adv), « Réglages » (settings)
    this._wRange = "30d"; this._wHover = null;
    this._wStats = {};         // range -> {start (ms), rows [{t, change, state}]}, from the statistics
    this._wAt = {}; this._wDay = {}; this._wLoading = {}; this._wErr = {};
    this._wVer = 0; this._wDrawn = "";
    this._setRows = [];        // settings: [{def, row, input, out, editing (ms)}]
    this._paneRows = [];       // panel, « Avancé »: Plan du jour, Contrôleur, Sondes [{def, row, val, sub, btn, icon}]
    this._daysDrawn = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this.toggleAttribute("dark", !!(hass.themes && hass.themes.darkMode));
    this._update();
  }
  connectedCallback() {
    this._timer = setInterval(() => this._hass && this._update(), 1000);
    if (this._ro && this._built) { this._ro.observe(this._$("tChart")); this._ro.observe(this._$("wChart")); }
  }
  disconnectedCallback() { clearInterval(this._timer); clearTimeout(this._toastTimer); this._ro?.disconnect(); }

  getCardSize() { return { panel: 15, settings: 9 }[this._config.variant] || 1; }
  getGridOptions() {
    if (this._config.variant !== "tile") return { columns: "full", rows: "auto" };
    return this._config.layout === "vertical" ? { columns: 4, rows: "auto", min_columns: 3 } : { columns: 12, rows: "auto", min_columns: 6 };
  }

  /* ---------- recorder: today's overrides, the last 24 h of water and pump speed ---------- */
  /**
   * One call for the last 24 h (panel only), reloaded on a new day or after 15 min and extended live in between:
   * the select's states for the overrides on the timeline (it clamps them to today), and, with a recorder, the
   * water sensor and the commanded speed for the temperature curve.
   */
  _loadHistory() {
    if (this._config.variant !== "panel" || !this._hass || this._histLoading) return;
    const day = new Date().toDateString();
    if (this._histDay === day && Date.now() - this._histAt < 15 * M_MS) return;
    this._histLoading = true;
    const { override, water, commanded } = this._e;
    const ids = this._config.recorder ? [override, water, commanded] : [override];
    const rows = (r, id) => ((r && r[id]) || []).map((x) => ({ s: x.s, t: (x.lc ?? x.lu) * 1000 })).filter((x) => Number.isFinite(x.t));
    this._hass.callWS({ type: "history/history_during_period", start_time: new Date(Date.now() - 24 * H_MS).toISOString(), entity_ids: ids,
      minimal_response: true, no_attributes: true, significant_changes_only: false })
      .then((r) => {
        this._hist = rows(r, override);
        if (this._config.recorder) { this._wHist = rows(r, water); this._cHist = rows(r, commanded); }
      })
      .catch((err) => { console.warn("piscine-card: history unavailable", err); if (this._config.recorder) { this._wHist = []; this._cHist = []; } })
      .finally(() => { this._histDay = day; this._histAt = Date.now(); this._histLoading = false; this._tVer++; this._update(); });
  }
  /** Appends live changes the loaded history does not have yet. */
  _trackLive() {
    const track = (list, key) => {
      const o = this._st(key);
      if (!o || !list) return;
      const t = Date.parse(o.last_changed), last = list[list.length - 1];
      if (!last || (last.s !== o.state && t >= last.t)) { list.push({ s: o.state, t }); this._tVer++; }
    };
    track(this._hist, "override");
    track(this._wHist, "water");
    track(this._cHist, "commanded");
  }
  /** 1 an's first day: the Monday 52 weeks before this week's (HA's weeks start on Monday). */
  _weekStart() { const d = dayAgo(0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 52 * 7); return d; }
  /**
   * 30 j – 1 an: two statistics calls, at most once an hour, only while such a range is shown.
   *   hourly, 90 days   Pool Water Min/Max Today, each day's 23:00 row: Min Today only falls and Max Today only rises
   *                     within a day, so that row holds the day's final values (HA's 00:00 hour still has yesterday's);
   *   daily, 53 weeks   the probe's mean, for the days before those two sensors had statistics (dropped when the probe
   *                     spans more than PROBE_GLITCH_C that day: a bad reading skews it); and the two sensors' own day,
   *                     for 1 an's weeks beyond 90 days: HA's day carries the evening before until the reset, so a
   *                     week may hold the Sunday before it, at most a day of lag on a 7-day bar.
   */
  _loadStats() {
    if (!this._config.recorder || this._statsLoading || Date.now() - this._statsAt < H_MS) return;
    this._statsLoading = true;
    const { waterMin, waterMax, water } = this._e;
    const ws = (o) => this._hass.callWS({ type: "recorder/statistics_during_period", ...o });
    const at = (row) => new Date(typeof row.start === "number" ? row.start : Date.parse(row.start));
    Promise.all([
      ws({ start_time: dayAgo(90).toISOString(), statistic_ids: [waterMin, waterMax], period: "hour", types: ["min", "max"] }),
      ws({ start_time: this._weekStart().toISOString(), statistic_ids: [waterMin, waterMax, water], period: "day", types: ["min", "max", "mean"] }),
    ])
      .then(([hr, dy]) => {
        const stats = {}, daily = {};
        const take = (r, id, type, field, out, at23) => {
          for (const row of (r && r[id]) || []) {
            const d = at(row);
            if ((at23 && d.getHours() !== 23) || !Number.isFinite(row[type])) continue;
            (out[dayKey(d)] ||= {})[field] = row[type];
          }
        };
        take(hr, waterMin, "min", "lo", stats, true);
        take(hr, waterMax, "max", "hi", stats, true);
        take(dy, waterMin, "min", "lo", daily);
        take(dy, waterMax, "max", "hi", daily);
        for (const row of (dy && dy[water]) || [])
          if (Number.isFinite(row.mean) && !(row.max - row.min > PROBE_GLITCH_C)) (daily[dayKey(at(row))] ||= {}).mean = row.mean;
        this._stats = stats; this._daily = daily; this._statsErr = false;
      })
      .catch((err) => { console.warn("piscine-card: temperature statistics unavailable", err); this._stats = {}; this._daily = {}; this._statsErr = true; })
      .finally(() => { this._statsAt = Date.now(); this._statsLoading = false; this._tVer++; this._update(); });
  }
  /** Ended overrides of today as [{speed, from, to}] in minutes of the day; the running one is drawn apart. */
  _pastOverrides(midMs, nowMs) {
    const h = this._hist || [], out = [];
    for (let i = 0; i < h.length - 1; i++) {
      if (!SPEEDS[h[i].s]) continue;                      // Auto, unavailable, unknown
      const from = Math.max(h[i].t, midMs), to = Math.min(h[i + 1].t, nowMs);
      if (to > from) out.push({ speed: h[i].s, from: (from - midMs) / 60000, to: (to - midMs) / 60000 });
    }
    return out;
  }

  /* ---------- helpers ---------- */
  _st(k) { return this._hass.states[this._e[k]]; }
  _s(k) { const o = this._st(k); return o ? o.state : undefined; }
  _n(k, dflt = NaN) { const v = parseFloat(this._s(k)); return Number.isFinite(v) ? v : dflt; }
  _attr(k, a) { const o = this._st(k); return o ? o.attributes[a] : undefined; }
  _$(id) { return this.shadowRoot.getElementById(id); }
  _call(domain, service, data) {
    return this._hass.callService(domain, service, data).catch((err) => {
      console.error("piscine-card:", err);
      this._local = null;
      this._toast("Commande refusée par Home Assistant", true);
      this._update();
    });
  }
  _toast(msg, err = false) {
    const t = this._$("toast"); if (!t) return;
    t.textContent = msg; t.classList.toggle("err", err); t.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), err ? 4500 : 2800);
  }

  /* ---------- derived state ---------- */
  _override() { const s = this._s("override"); return ["Auto", "Off", "Low", "Medium", "High"].includes(s) ? s : "Auto"; }
  _online() { return this._s("online") === "on"; }
  /**
   * When the controller was last heard, in ms (0 = never): the newest update of any of its entities. The Device Clock
   * (wifi-setup.yaml) changes every minute, so a healthy controller is never quiet for long. HA's own `unavailable` (the
   * link is down) is not a message.
   */
  _lastSeen() {
    let t = 0;
    for (const k in this._e) {
      const o = !NOT_CONTROLLER.has(k) && this._hass.states[this._e[k]];
      if (o && o.state !== "unavailable") t = Math.max(t, Date.parse(o.last_updated) || 0);
    }
    return t;
  }
  /**
   * The light: {h, seen (ms), quiet (min since seen), off (min offline, null online)}. h: live = a message within
   * `warn` min; late = quiet for longer, or offline for less than `alert` min (a restart, an OTA, a Wi-Fi drop end on
   * their own); lost = beyond. Without the Device Clock nothing changes every minute (a still night can leave every
   * value as it was), so quiet means nothing there and only the link counts.
   */
  _light() {
    const H = this._config.health, now = Date.now(), seen = this._lastSeen(), quiet = seen ? (now - seen) / M_MS : Infinity;
    const o = this._st("online"), off = this._online() ? null : o ? (now - Date.parse(o.last_changed)) / M_MS : Infinity;
    const beats = !!this._st("clock");
    const h = off !== null ? (off >= H.alert ? "lost" : "late") : beats && quiet >= H.alert ? "lost" : beats && quiet >= H.warn ? "late" : "live";
    return { h, seen, quiet, off };
  }
  /**
   * The controller's firmware, from Home Assistant's device registry (its Status entity's device): ESPHome's
   * version and when it was compiled, « 2026.7.2 (2026-11-14 11:25:41 +0000) ». null on the device's page.
   */
  _firmware() {
    const reg = this._hass.entities && this._hass.entities[this._e.online];
    const dev = reg && this._hass.devices && this._hass.devices[reg.device_id];
    const m = dev && /^(\S+)(?: \((.+)\))?$/.exec(String(dev.sw_version || ""));
    if (!m) return null;
    const t = m[2] ? new Date(Date.parse(m[2].replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"))) : null;
    const built = t && !isNaN(t) ? `Compilé le ${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()} à ${fmtT(t)}` : m[2] ? `Compilé ${m[2]}` : "";
    return { version: `ESPHome ${m[1]}`, built };
  }
  /** « Hors ligne depuis 6 min », « Contrôleur muet depuis 5 min », else `live`. */
  _lightText(L, live = `Contrôleur · ${agoTxt(L.quiet)}`, mute = "Contrôleur muet") {
    if (L.off !== null) return Number.isFinite(L.off) ? `Hors ligne depuis ${fmtD(L.off)}` : "Hors ligne";
    return L.h === "live" ? live : `${mute} depuis ${fmtD(L.quiet)}`;
  }
  /** The light on the tile and in the panel's header. A message newer than the last one drawn: one heartbeat. */
  _renderLight() {
    const on = this._config.controller_light, btn = this._$("ctlLink"), leds = [this._$("led"), this._$("ctlLed")].filter(Boolean);
    if (btn) btn.hidden = !on;
    if (this._$("led")) this._$("led").hidden = !on;
    if (!on) return;
    const L = this._light();
    const tip = L.off !== null ? `Contrôleur hors ligne${L.seen ? ` : dernier message à ${stampMs(L.seen)}` : ""}`
      : `Dernier message du contrôleur à ${stampMs(L.seen)}, ${agoTxt(L.quiet)}`;
    for (const el of leds) {
      const cls = `led ${L.h}${el.classList.contains("ping") ? " ping" : ""}`; // a redraw must not cut a heartbeat short
      if (el.className !== cls) el.className = cls;
      if (el.title !== tip) { el.title = tip; el.setAttribute("aria-label", tip); }
    }
    if (btn) {
      const txt = this._lightText(L);
      if (btn.className !== `clink ${L.h}`) btn.className = `clink ${L.h}`;
      if (this._$("ctlTxt").textContent !== txt) this._$("ctlTxt").textContent = txt;
      if (btn.title !== tip) btn.title = tip;
    }
    if (this._beatSeen === null || L.seen <= this._beatSeen) { if (this._beatSeen === null || L.seen < this._beatSeen) this._beatSeen = L.seen; return; }
    this._beatSeen = L.seen;
    const now = performance.now();
    if (L.h !== "live" || now - this._beatAt < this._config.health.beat * 1000) return;
    this._beatAt = now;
    for (const el of leds) { el.classList.remove("ping"); void el.offsetWidth; el.classList.add("ping"); }
  }
  /** Below this the firmware forces Low, whatever the override (Freeze Protection Temperature). */
  _freezeC() { return this._n("freezeAt", FREEZE_DEFAULT_C); }
  _freeze() { const w = this._n("water"); return Number.isFinite(w) && w < this._freezeC(); }
  _inOvr() { return this._override() !== "Auto"; }
  _ovrSince() { const o = this._st("override"); return o && this._inOvr() ? new Date(o.last_changed) : null; }
  _ovrAgeMin() { const s = this._ovrSince(); return s ? (Date.now() - s.getTime()) / 60000 : 0; }
  /** The controller's own deadline ("YYYY-MM-DD HH:MM:SS" local, "--" when none). */
  _ovrUntil() {
    if (!this._inOvr()) return null;
    const v = this._s("endsAt"); if (!v || v === "--") return null;
    const d = new Date(v.replace(" ", "T")); return isNaN(d) ? null : d;
  }
  _stuck() { return this._inOvr() && this._s("stuck") === "on"; }
  _timeoutMin() { const m = this._n("timeout"); return Number.isFinite(m) ? Math.round(m) : 60; }
  _durChoice() { const m = this._timeoutMin(); const d = DURATIONS.find(([, v]) => v === m); return d ? d : [fmtD(m), m]; }
  _commanded() { const s = this._s("commanded"); return SPEEDS[s] ? s : "Off"; }
  _planned() { const s = this._s("planned"); return SPEEDS[s] ? s : "Off"; }

  /** In-flight command: null when nothing is pending. */
  _pending() {
    const L = this._local;
    const scriptBusy = this._s("sForce") === "on" || this._s("sAuto") === "on";
    if (L) {
      const ovr = this._override();
      if (ovr === L.value) L.echoed = true;
      const applied = L.echoed && (L.value === "Auto" || this._freeze() || this._commanded() === L.value) && !scriptBusy;
      const age = Date.now() - L.t0;
      if (applied) {
        this._local = null;
        this._toast(L.done);
        return null;
      }
      if (age > CMD_TIMEOUT) {
        this._local = null;
        this._toast("Le contrôleur n'a pas répondu. La pompe n'a pas changé.", true);
        return null;
      }
      return { label: L.label, stage: L.echoed ? 1 : 0, t0: L.t0, fail: !this._online() && age > 2000 };
    }
    if (scriptBusy) return { label: this._s("sAuto") === "on" ? "Retour en Auto" : "Vitesse forcée", stage: 1, t0: Date.now(), fail: false };
    return null;
  }

  _phase() {
    if (!this._online()) return { label: "Hors ligne", cls: this._light().h === "lost" ? "danger" : "amber" };
    if (this._freeze()) return { label: "Hors gel · Low", cls: "cool" };
    if (this._stuck()) return { label: `Override depuis ${fmtD(this._ovrAgeMin())}`, cls: "danger" };
    if (this._inOvr()) return { label: `Manuel · ${SPEEDS[this._override()]}`, cls: "amber" };
    const c = this._commanded();
    return c === "Off" ? { label: "Auto · Arrêtée", cls: "idle" } : { label: `Auto · ${SPEEDS[c]}`, cls: "acc" };
  }
  _icoClass(base) {
    const ph = this._phase(), running = this._commanded() !== "Off" && this._online();
    return `${base} ${ph.cls}` + (running ? " spin" : "") + (this._pending() ? " pending" : "");
  }
  _spinSpeed() { return { Low: "3s", Medium: "1.6s", High: "0.9s" }[this._commanded()] || "0s"; }

  /* ---------- pool temperature ---------- */
  /**
   * The last 24 h of the water sensor, one point per 5 min: {t, v (NaN while unavailable), on (pump running),
   * ok (a pool reading: pumping for POOL_AFTER_MIN, the firmware's rule)}. Both histories are step functions.
   * Points sit on the clock's 5-min marks, not on « now − 24 h »: from one redraw to the next the curve only
   * slides, instead of being resampled at other instants and changing shape.
   */
  _tempSeries(now) {
    const W = this._wHist || [], C = this._cHist || [], out = [];
    let wi = -1, ci = -1, v = NaN, on = false, seen = false, onSince = -Infinity;
    const at = (t) => {
      while (wi + 1 < W.length && W[wi + 1].t <= t) v = num(W[++wi].s);
      while (ci + 1 < C.length && C[ci + 1].t <= t) {
        const s = C[++ci].s;
        if (!SPEEDS[s]) continue; // unavailable while HA restarted: the ESP32 kept pumping, keep its last speed
        const isOn = s !== "Off";
        if (isOn && !on) onSince = seen ? C[ci].t : -Infinity; // the window's first state may have started long before
        on = isOn; seen = true;
      }
      out.push({ t, v, on, ok: on && Number.isFinite(v) && t - onSince >= POOL_AFTER_MIN * M_MS });
    };
    const step = T_STEP_MIN * M_MS;
    for (let t = Math.ceil((now - 24 * H_MS) / step) * step; t < now; t += step) at(t);
    at(now);
    return out;
  }
  /**
   * n days, oldest first, today last: {ago, date, lo, hi (the pool), hours, mean (the probe), known}. A day's pool is the
   * device's Daily History, else the statistics' 23:00 row, else (`loose`: 1 an) HA's own day; today, Min/Max Today.
   * `mean` is the probe's daily mean, drawn where the pool is unknown.
   */
  _tempDays(n, loose = false) {
    const hist = parseDays(this._s("history")), stats = this._stats || {}, daily = this._daily || {}, out = [];
    const ok = (x) => x && Number.isFinite(x.lo) && Number.isFinite(x.hi);
    for (let ago = n - 1; ago >= 1; ago--) {
      const date = dayAgo(ago), k = dayKey(date), h = hist[k], src = [h, stats[k], loose && daily[k]].find(ok);
      out.push({ ago, date, lo: src ? src.lo : NaN, hi: src ? src.hi : NaN, hours: h ? h.hours : NaN, mean: daily[k]?.mean ?? NaN });
    }
    out.push({ ago: 0, date: dayAgo(0), lo: this._n("waterMin"), hi: this._n("waterMax"), hours: this._n("hoursToday"), mean: NaN });
    return out.map((d) => ({ ...d, known: Number.isFinite(d.lo) && Number.isFinite(d.hi) }));
  }
  /** 1 an: 53 weeks from _weekStart(), the running one last: the pool's min–max over the week's days, else the probe's mean. */
  _tempWeeks() {
    const days = this._tempDays(Math.round((dayAgo(0) - this._weekStart()) / 864e5) + 1, true), out = [];
    for (let i = 0; i < days.length; i += 7) {
      const ds = days.slice(i, i + 7), pool = ds.filter((d) => d.known), m = ds.filter((d) => Number.isFinite(d.mean));
      out.push({ date: ds[0].date, cur: i + 7 >= days.length, known: pool.length > 0,
        lo: pool.length ? Math.min(...pool.map((d) => d.lo)) : NaN, hi: pool.length ? Math.max(...pool.map((d) => d.hi)) : NaN,
        mean: !pool.length && m.length ? m.reduce((a, d) => a + d.mean, 0) / m.length : NaN });
    }
    return out;
  }

  _renderTemp() {
    const box = this._$("tChart");
    if (!box) return;
    const rec = this._config.recorder, range = rec ? this._range : "7d"; // without the recorder: Daily History's 7 days
    this.shadowRoot.querySelectorAll("#tRange button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === range)));
    if (T_SPAN[range]) this._loadStats();
    const W = box.clientWidth, H = box.clientHeight;
    if (!W) return; // not laid out: the pop-up is closed
    const now = Date.now();
    const key = [range, this._tHover, W, H, this._tVer, Math.floor(now / M_MS),
      ...["water", "waterMin", "waterMax", "history", "hoursToday", "freezeAt"].map((k) => this._s(k))].join("|");
    if (key === this._tDrawn) return;
    this._tDrawn = key;

    const svg = this._$("tSvg"), tip = this._$("tTip"), empty = this._$("tEmpty"), sum = this._$("tSum"), leg = this._$("tLeg");
    const showEmpty = (msg, summary = "") => {
      empty.hidden = false; empty.textContent = msg; svg.innerHTML = ""; tip.hidden = true;
      sum.innerHTML = summary; leg.innerHTML = ""; box.setAttribute("aria-label", msg);
    };
    const nowTxt = `<b>${fmt1(this._n("water"))} °C</b> maintenant`;
    if (range === "24h" && !this._wHist) return showEmpty("Chargement de l'historique…", nowTxt);
    if (T_SPAN[range] && !this._stats) return showEmpty("Chargement des statistiques…", nowTxt);
    empty.hidden = true;

    const L = 8, R = W - 34, TOP = 10, BOT = H - 20;
    const fz = this._freezeC();
    /**
     * y scale over `vals`, padded to the half degree. The freeze-protection threshold joins it when the water comes
     * within FREEZE_NEAR_C of it (a dotted line over the zone where Low is forced); further away a tag at the foot
     * of the axis gives it, rather than squashing a 13 °C curve to show 3 °C.
     */
    const yScale = (vals, top, bot) => {
      const near = Number.isFinite(fz) && Math.min(...vals) - fz <= FREEZE_NEAR_C, all = near ? [...vals, fz] : vals;
      let lo = Math.floor((Math.min(...all) - 0.1) * 2) / 2, hi = Math.ceil((Math.max(...all) + 0.1) * 2) / 2;
      if (hi - lo < 1) { const m = (hi + lo) / 2; lo = Math.floor((m - 0.5) * 2) / 2; hi = lo + 1; } // a flat day isn't a storm
      let step = hi - lo > 2.5 ? 1 : 0.5;
      for (const s of [2, 5, 10]) if ((hi - lo) / step > 7) { step = s; lo = Math.floor(lo / s) * s; hi = Math.ceil(hi / s) * s; } // seasons: round degrees
      const y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
      let g = "";
      for (let v = lo; v <= hi + 1e-9; v += step)
        g += `<line class="gl" x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}"/><text x="${R + 5}" y="${y(v) + 3.5}">${fmt1(v)}°</text>`;
      if (near) {
        // label inside the zone, under the line: the curve only goes there when freeze protection is on
        const yf = y(fz), ly = bot - yf >= 14 ? yf + 11 : yf - 4;
        g += `<rect class="fz-zone" x="${L}" y="${yf}" width="${R - L}" height="${Math.max(0, bot - yf)}"/>`
          + `<line class="fz" x1="${L}" x2="${R}" y1="${yf}" y2="${yf}"/><text class="fz-t" x="${L + 4}" y="${ly}">Hors gel ${fmt1(fz)} °C</text>`;
      } else if (Number.isFinite(fz)) g += `<text class="fz-t" x="${R + 5}" y="${H - 6}">↓${fmt1(fz)}°</text>`;
      const legend = Number.isFinite(fz)
        ? `<span><i class="k-fz"></i>Hors gel : Low forcé sous ${fmt1(fz)} °C${near ? "" : " (sous l'échelle)"}</span>` : "";
      return { y, grid: g, legend };
    };
    const belowFz = (v) => (Number.isFinite(fz) && v < fz ? " · sous le seuil hors gel" : "");
    let g = "", hovX = null;

    if (range === "24h") {
      const pts = this._tempSeries(now), vals = pts.filter((p) => Number.isFinite(p.v)).map((p) => p.v);
      if (!vals.length) return showEmpty("Pas de mesure de la température ces dernières 24 h.", nowTxt);
      const from = now - 24 * H_MS, x = (t) => L + ((t - from) / (24 * H_MS)) * (R - L), mid = midnight(now);
      const sc = yScale(vals, TOP, BOT);
      g += sc.grid;
      let s0 = null; // filtration periods behind the curve
      pts.forEach((p, i) => {
        if (p.on && s0 === null) s0 = p.t;
        if ((!p.on || i === pts.length - 1) && s0 !== null) {
          g += `<rect class="band" x="${x(s0)}" y="${TOP - 4}" width="${Math.max(1, x(p.t) - x(s0))}" height="${BOT - TOP + 4}"/>`;
          s0 = null;
        }
      });
      const tick = new Date(from); tick.setMinutes(0, 0, 0);
      do tick.setHours(tick.getHours() + 1); while (tick.getHours() % 6);
      for (; tick.getTime() <= now; tick.setHours(tick.getHours() + 6))
        g += `<text x="${x(tick.getTime())}" y="${H - 6}" text-anchor="middle">${tick.getHours()} h</text>`;
      // runs of pool / pipe readings, each joined to the point before so the line only breaks where HA has no value
      const runs = [];
      let prev = null;
      for (const p of pts) {
        if (!Number.isFinite(p.v)) { prev = null; continue; }
        const cur = runs[runs.length - 1];
        if (prev && cur && cur.ok === p.ok) cur.pts.push(p);
        else runs.push({ ok: p.ok, pts: prev ? [prev, p] : [p] });
        prev = p;
      }
      for (const r of runs)
        g += `<path class="${r.ok ? "pool" : "pipe"}" d="${r.pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${sc.y(p.v).toFixed(1)}`).join("")}"/>`;
      const known = pts.filter((p) => Number.isFinite(p.v)), last = known[known.length - 1];
      let hov = null;
      if (this._tHover !== null) {
        const target = now - this._tHover * M_MS;
        hov = known.reduce((a, p) => (Math.abs(p.t - target) < Math.abs(a.t - target) ? p : a), known[0]);
        g += `<line class="xh" x1="${x(hov.t)}" x2="${x(hov.t)}" y1="${TOP - 4}" y2="${BOT}"/>`;
        tip.innerHTML = "<b></b><span><i></i><span></span></span>";
        tip.querySelector("b").textContent = `${fmt1(hov.v)} °C`;
        tip.querySelector("i").className = hov.ok ? "" : "no";
        tip.querySelector("span span").textContent = `${hov.t < mid ? "hier " : ""}${fmtT(new Date(hov.t))} · ${
          hov.ok ? "bassin, pompe en marche" : hov.on ? `pompe en marche depuis moins de ${POOL_AFTER_MIN} min` : "tuyau, pompe arrêtée"}${belowFz(hov.v)}`;
        hovX = x(hov.t);
      }
      const dot = hov || last;
      g += `<circle class="pt ${dot.ok ? "ok" : "no"}" cx="${x(dot.t)}" cy="${sc.y(dot.v)}" r="4"/>`;
      // today's pool min/max as the firmware keeps them; pump stopped, the last real pool reading too
      const lo = this._n("waterMin"), hi = this._n("waterMax");
      let s = Number.isFinite(lo) && Number.isFinite(hi) ? `<b>${fmt1(lo)} – ${fmt1(hi)} °C</b> aujourd'hui, pompe en marche`
        : "Pas encore de mesure du bassin aujourd'hui";
      if (!last.ok) {
        const lastOk = [...known].reverse().find((p) => p.ok);
        s += `<span>Pompe ${last.on ? `en marche depuis moins de ${POOL_AFTER_MIN} min` : "arrêtée"} : ${fmt1(last.v)} °C est la température du tuyau.${
          lastOk ? ` Bassin : ${fmt1(lastOk.v)} °C à ${fmtT(new Date(lastOk.t))}${lastOk.t < mid ? " hier" : ""}.` : ""}</span>`;
      }
      sum.innerHTML = s;
      leg.innerHTML = `<span><i class="k-pool"></i>Bassin (pompe en marche depuis ${POOL_AFTER_MIN} min)</span><span><i class="k-pipe"></i>Tuyau, pompe arrêtée</span><span><i class="k-band"></i>Filtration</span>${sc.legend}`;
      box.setAttribute("aria-label", `Température du bassin sur 24 h, de ${fmt1(Math.min(...vals))} à ${fmt1(Math.max(...vals))} °C`);
    } else {
      // 7 / 30 / 90 j: a bar a day; 1 an: a bar a week. The pool's min–max where it is known; elsewhere (before Min/Max
      // Today had statistics) the probe's mean, dashed: the pipe is in it, as on the 24 h curve.
      const wk = range === "1y", days = wk ? this._tempWeeks() : this._tempDays(T_N[range]), n = days.length;
      const cw = (R - L) / n, cx = (i) => L + cw * (i + 0.5);
      const bw = Math.max(1.5, Math.min(12, cw - (cw > 6 ? 3 : 1))), rx = Math.min(4, bw / 2); // 30 bars on a phone: ~7 px, 3 apart; 90: ~2 px, 1 apart
      const isNow = (d) => (wk ? d.cur : d.ago === 0), unit = wk ? "de la semaine" : "du jour";
      const pool = days.filter((d) => d.known), mean = days.filter((d) => !d.known && Number.isFinite(d.mean));
      const vals = [...pool.flatMap((d) => [d.lo, d.hi]), ...mean.map((d) => d.mean)];
      const sc = yScale(vals.length ? vals : [Number.isFinite(this._n("water")) ? this._n("water") : 20], TOP + 6, BOT - 6);
      g += sc.grid;
      const label = (d, i) => {
        if (wk) { const m = d.date.getMonth(); return i < 2 || m % 2 || days[i - 1].date.getMonth() === m ? "" : MO[m]; } // every other month's first Monday
        if (d.ago === 0) return n > 30 ? "" : "auj."; // 90 j: the freeze tag sits there
        return n <= 7 ? WD[d.date.getDay()] : d.ago % (n > 30 ? 14 : 7) ? "" : `${d.date.getDate()} ${MO[d.date.getMonth()]}`;
      };
      const long = (d) => (wk ? `semaine du ${d.date.getDate()} ${MO[d.date.getMonth()]}${d.cur ? ", en cours" : ""}`
        : `${d.ago === 0 ? "aujourd'hui" : WD[d.date.getDay()]} ${d.date.getDate()} ${MO[d.date.getMonth()]}`);
      let run = []; // the probe's mean: joined only between neighbours, a lone day a dot
      const flush = () => {
        if (run.length > 1) g += `<path class="pipe" d="${run.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("")}"/>`;
        else if (run.length) g += `<circle class="mdot" cx="${run[0][0].toFixed(1)}" cy="${run[0][1].toFixed(1)}" r="1.8"/>`;
        run = [];
      };
      days.forEach((d, i) => {
        g += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle">${label(d, i)}</text>`;
        if (!d.known) {
          if (Number.isFinite(d.mean)) { run.push([cx(i), sc.y(d.mean)]); return; }
          flush();
          if (n <= 7) g += `<text x="${cx(i)}" y="${(TOP + BOT) / 2}" text-anchor="middle">–</text>`; // on 30 and more, a row of them would be noise
          return;
        }
        flush();
        const y1 = sc.y(d.hi), y2 = Math.max(sc.y(d.lo), y1 + 4);
        g += `<rect class="rng${isNow(d) ? " today" : ""}${this._tHover === i ? " hov" : ""}" x="${cx(i) - bw / 2}" y="${y1}" width="${bw}" height="${y2 - y1}" rx="${rx}"/>`;
        if (isNow(d) && n <= 30) g += `<text class="vl" x="${cx(i)}" y="${y1 - 4}" text-anchor="middle">${fmt1(d.hi)}</text><text class="vl" x="${cx(i)}" y="${y2 + 11}" text-anchor="middle">${fmt1(d.lo)}</text>`;
      });
      flush();
      const hd = this._tHover !== null ? days[this._tHover] : null;
      if (hd) {
        if (!hd.known && Number.isFinite(hd.mean)) g += `<circle class="pt no" cx="${cx(this._tHover)}" cy="${sc.y(hd.mean)}" r="3.5"/>`;
        tip.innerHTML = "<b></b><span></span>";
        tip.querySelector("b").textContent = hd.known ? `${fmt1(hd.lo)} – ${fmt1(hd.hi)} °C` : Number.isFinite(hd.mean) ? `≈ ${fmt1(hd.mean)} °C` : "Pas de mesure";
        tip.querySelector("span").textContent = long(hd) + (hd.known ? (Number.isFinite(hd.hours) ? ` · ${fmt1(hd.hours)} h de filtration` : "") + belowFz(hd.lo)
          : Number.isFinite(hd.mean) ? ` · sonde, moyenne ${unit}, tuyau compris` : "");
        hovX = cx(this._tHover);
      }
      const k = pool.length + mean.length, span = wk ? "12 mois" : `${n} jours`;
      let s = !k ? "Pas encore de mesure"
        : `<b>${fmt1(Math.min(...vals))} – ${fmt1(Math.max(...vals))} °C</b> sur ${span}${mean.length ? (pool.length ? "" : `, moyenne ${unit} de la sonde`) : ", pompe en marche"}`;
      if (mean.length) s += `<span>${pool.length ? `Pointillés : ${wk ? "les semaines" : "les jours"} sans min – max du bassin, la sonde en moyenne` : "La sonde en moyenne"}, tuyau compris (pompe arrêtée, elle lit le local technique).</span>`;
      if (T_SPAN[range] && this._statsErr) s += "<span>Statistiques de Home Assistant indisponibles : seuls les 7 derniers jours sont connus.</span>";
      else if (n > 7 && k < n) s += `<span>${k} ${wk ? "semaine" : "jour"}${k > 1 ? "s" : ""} mesuré${wk ? "e" : ""}${k > 1 ? "s" : ""} sur ${n}.</span>`;
      sum.innerHTML = s;
      leg.innerHTML = (pool.length || !mean.length ? `<span><i class="k-rng"></i>Min – max ${unit}, pompe en marche depuis ${POOL_AFTER_MIN} min</span>` : "")
        + (mean.length ? `<span><i class="k-pipe"></i>Sonde, moyenne ${unit}, tuyau compris</span>` : "") + sc.legend;
      box.setAttribute("aria-label", `Température du bassin, ${span} : ${days.map((d) => `${long(d)} ${d.known ? `${fmt1(d.lo)} à ${fmt1(d.hi)} °C`
        : Number.isFinite(d.mean) ? `environ ${fmt1(d.mean)} °C (sonde)` : "pas de mesure"}`).join(", ")}`);
    }
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = g;
    tip.hidden = hovX === null;
    // Beside the crosshair, on the side with room, so it never hides the point being read nor the y labels.
    if (hovX !== null) { const tw = tip.offsetWidth; tip.style.left = `${Math.min(Math.max(4, hovX > W / 2 ? hovX - tw - 10 : hovX + 10), W - tw - 4)}px`; }
  }

  /* ---------- fill water (« Remplissage ») ---------- */
  /** A range's first bucket: today − 29 days; the Monday 12 weeks before this week's; the 1st, 11 months back. */
  _wStart(range, now = new Date()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    if (range === "30d") d.setDate(d.getDate() - 29);
    else if (range === "90d") d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 12 * 7);
    else { d.setDate(1); d.setMonth(d.getMonth() - 11); }
    return d;
  }
  /** The meter's statistics over a range (change per day, week or month), reloaded on a new day or after 15 min. */
  _loadWater(range) {
    const day = new Date().toDateString();
    if (!this._config.recorder || this._wLoading[range]
      || (this._wDay[range] === day && Date.now() - (this._wAt[range] || 0) < 15 * M_MS)) return;
    this._wLoading[range] = true;
    const id = this._e.volume, start = this._wStart(range);
    this._hass.callWS({ type: "recorder/statistics_during_period", start_time: start.toISOString(), statistic_ids: [id],
      period: W_PERIOD[range], types: ["change", "state"], units: { volume: "L" } })
      .then((r) => {
        const rows = ((r && r[id]) || []).map((x) => ({ t: typeof x.start === "number" ? x.start : Date.parse(x.start), change: x.change, state: x.state }))
          .filter((x) => Number.isFinite(x.t));
        this._wStats[range] = { rows }; this._wErr[range] = false;
      })
      .catch((err) => { console.warn("piscine-card: water statistics unavailable", err); this._wStats[range] = { rows: [] }; this._wErr[range] = true; })
      .finally(() => { this._wAt[range] = Date.now(); this._wDay[range] = day; this._wLoading[range] = false; this._wVer++; this._update(); });
  }
  /**
   * A range's buckets, oldest first: {t, value (litres; NaN without a statistics row: HA down, or before the meter's
   * first statistics), cur (holds now)}. The running one gets what the meter counted since the last compiled hour:
   * its live state against that hour's, or the whole live state when it is lower (the ESP32 rebooted, it restarted at 0).
   */
  _waterBuckets(range) {
    const st = this._wStats[range];
    if (!st) return null;
    const now = new Date();
    const key = (t) => { const x = new Date(t); return range === "12m" ? `${x.getFullYear()}-${x.getMonth()}` : dayKey(x); };
    const next = (x) => {
      const y = new Date(x);
      if (range === "30d") y.setDate(y.getDate() + 1); else if (range === "90d") y.setDate(y.getDate() + 7); else y.setMonth(y.getMonth() + 1);
      return y;
    };
    const byKey = new Map(st.rows.map((r) => [key(r.t), r])), out = [];
    for (let x = this._wStart(range, now); x <= now; x = next(x)) {
      const row = byKey.get(key(x.getTime()));
      out.push({ t: x.getTime(), value: row && Number.isFinite(row.change) ? row.change : NaN, cur: now < next(x) });
    }
    const last = st.rows[st.rows.length - 1], live = this._n("volume"), cur = out[out.length - 1];
    if (last && Number.isFinite(last.state) && Number.isFinite(live) && cur && cur.cur)
      cur.value = (Number.isFinite(cur.value) ? cur.value : 0) + (live >= last.state ? live - last.state : live);
    return out;
  }

  _renderWater() {
    const box = this._$("wChart");
    if (!box || this._tab !== "water") return;
    const range = this._wRange;
    this._loadWater("30d"); // today's reading
    this._loadWater("12m"); // this month's
    if (range === "90d") this._loadWater(range);

    this.shadowRoot.querySelectorAll("#wRange button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === range)));
    const unit = (txt) => txt.replace(/ (\S+)$/, "<small>$1</small>");
    const days = this._waterBuckets("30d"), flow = this._n("flow");
    const months = this._waterBuckets("12m");
    this._$("wToday").innerHTML = days ? unit(fmtL(days[days.length - 1].value)) : "…";
    this._$("wMonth").innerHTML = months ? unit(fmtL(months[months.length - 1].value)) : "…";

    this._$("wFlow").innerHTML = `${fmt1(flow)}<small>L/min</small>`;
    this._$("wFlowBox").classList.toggle("live", flow > 0);

    const W = box.clientWidth, H = box.clientHeight;
    if (!W) return;
    const key = [range, this._wHover, W, H, this._wVer, Math.floor(Date.now() / M_MS), this._s("volume")].join("|");
    if (key === this._wDrawn) return;
    this._wDrawn = key;
    const svg = this._$("wSvg"), tip = this._$("wTip"), empty = this._$("wEmpty"), sum = this._$("wSum"), leg = this._$("wLeg");
    const showEmpty = (msg) => { empty.hidden = false; empty.textContent = msg; svg.innerHTML = ""; tip.hidden = true; sum.innerHTML = ""; leg.innerHTML = ""; box.setAttribute("aria-label", msg); };
    const b = this._waterBuckets(range);
    if (!b) return showEmpty("Chargement des statistiques…");
    const known = b.filter((x) => Number.isFinite(x.value));
    if (!known.length) return showEmpty(this._wErr[range] ? "Statistiques de Home Assistant indisponibles."
      : "Pas encore de statistiques pour ce compteur : Home Assistant les calcule chaque heure.");
    empty.hidden = true;

    const L = 8, R = W - 40, TOP = 14, BOT = H - 20, n = b.length;
    const max = Math.max(...known.map((x) => x.value), 0);
    // about three gridlines on 1, 2, 5 × 10^k
    const raw = Math.max(max, 3) / 3, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw);
    const hi = Math.max(step, Math.ceil(max / step) * step), y = (v) => BOT - (v / hi) * (BOT - TOP);
    let g = "";
    for (let v = step; v <= hi + 1e-9; v += step) g += `<line class="gl" x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}"/><text x="${R + 5}" y="${y(v) + 3.5}">${axL(v)}</text>`;
    g += `<line class="base" x1="${L}" x2="${R}" y1="${BOT}" y2="${BOT}"/><text x="${R + 5}" y="${BOT + 3.5}">0</text>`;
    const cw = (R - L) / n, cx = (i) => L + cw * (i + 0.5), bw = Math.max(2, Math.min(18, cw - (n > 20 ? 3 : 6))), rr = Math.min(3, bw / 2);
    // rounded at the data end only, anchored on the baseline
    const bar = (x, top) => { const r = Math.min(rr, BOT - top); return `M${x},${BOT}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${BOT}Z`; };
    const date = (x) => new Date(x.t);
    const label = (x, i) => {
      const k = n - 1 - i, t = date(x);
      if (range === "30d") return k === 0 ? "auj." : k % 7 ? "" : `${t.getDate()} ${MO[t.getMonth()]}`;
      if (range === "90d") return k % 3 ? "" : `${t.getDate()} ${MO[t.getMonth()]}`;
      return cw >= 30 || k % 2 === 0 ? MO[t.getMonth()] : "";
    };
    const long = (x) => {
      const t = date(x);
      if (range === "30d") return x.cur ? "aujourd'hui" : `${WD[t.getDay()]} ${t.getDate()} ${MO[t.getMonth()]}`;
      if (range === "90d") return `semaine du ${t.getDate()} ${MO[t.getMonth()]}${x.cur ? ", en cours" : ""}`;
      return `${MONTHS[t.getMonth()]} ${t.getFullYear()}${x.cur ? ", en cours" : ""}`;
    };
    const peak = known.reduce((a, x) => (x.value > a.value ? x : a));
    b.forEach((x, i) => {
      const lb = label(x, i);
      if (lb) g += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle">${lb}</text>`;
      if (!(x.value > 0)) return;
      const top = Math.min(y(x.value), BOT - 2); // a few litres still show
      g += `<path class="bar${x.cur ? " cur" : ""}${this._wHover === i ? " hov" : ""}" d="${bar(cx(i) - bw / 2, top)}"/>`;
      if (x === peak) g += `<text class="vl" x="${Math.min(Math.max(cx(i), L + 16), R - 16)}" y="${top - 4}" text-anchor="middle">${fmtL(x.value)}</text>`;
    });
    let hovX = null;
    const hb = this._wHover !== null ? b[this._wHover] : null;
    if (hb) {
      tip.innerHTML = "<b></b><span></span>";
      tip.querySelector("b").textContent = Number.isFinite(hb.value) ? fmtL(hb.value) : "Pas de relevé";
      tip.querySelector("span").textContent = long(hb);
      hovX = cx(this._wHover);
    }
    const per = { "30d": ["30 jours", "jour", "Aujourd'hui"], "90d": ["13 semaines", "semaine", "Semaine en cours"], "12m": ["12 mois", "mois", "Mois en cours"] }[range];
    const total = known.reduce((a, x) => a + x.value, 0), closed = known.filter((x) => !x.cur), base = closed.length ? closed : known;
    let s = `<b>${fmtL(total)}</b> sur ${per[0]} · ${fmtL(base.reduce((a, x) => a + x.value, 0) / base.length)} par ${per[1]} en moyenne`;
    const end = (t) => (t.endsWith(".") ? t : `${t}.`); // « 15 nov. » already ends the sentence
    if (peak.value > 0) s += `<span>Le plus : ${fmtL(peak.value)}, ${end(long(peak))}</span>`;
    const first = b.findIndex((x) => Number.isFinite(x.value));
    if (first > 0) s += `<span>Premier relevé : ${end(long(b[first]))}</span>`;
    sum.innerHTML = s;
    leg.innerHTML = `<span><i class="k-bar"></i>Litres par ${per[1]}, compteur du remplissage</span><span><i class="k-cur"></i>${per[2]}</span>`;
    box.setAttribute("aria-label", `Eau de remplissage sur ${per[0]} : ${b.map((x) => `${long(x)} ${Number.isFinite(x.value) ? fmtL(x.value) : "pas de relevé"}`).join(", ")}`);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = g;
    tip.hidden = hovX === null;
    if (hovX !== null) { const tw = tip.offsetWidth; tip.style.left = `${Math.min(Math.max(4, hovX > W / 2 ? hovX - tw - 10 : hovX + 10), W - tw - 4)}px`; }
  }

  /* ---------- variant: settings ---------- */
  /** An mdi icon: <ha-icon> in Home Assistant, an SVG path from `icons` on the device's page. */
  _icon(name) {
    name = String(name || "").replace(/^mdi:/, "");
    if (this._config.icons) { const p = this._config.icons[name]; return p ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p}"/></svg>` : ""; }
    return name ? `<ha-icon icon="mdi:${esc(name)}"></ha-icon>` : "";
  }
  _numTxt(key, v) {
    const step = String(this._attr(key, "step") ?? 1), dec = step.includes(".") ? step.split(".")[1].length : 0;
    return `${(+v).toFixed(dec).replace(".", ",")} ${this._attr(key, "unit_of_measurement") || ""}`.trim();
  }
  _wireSettings() {
    if (!customElements.get("ha-card")) this._$("setCard").classList.add("plain"); // the device's page: no HA around
    const head = this.shadowRoot.querySelector(".set-h");
    head.hidden = !this._config.title;
    this._$("setTitle").textContent = this._config.title;
    this._$("setIcon").innerHTML = this._icon("tune-vertical");
    this._wireSettingRows();
  }
  _refused(err) { console.error("piscine-card:", err); this._toast(`Refusé : ${(err && err.message) || err}`, true); }
  /** Presses a button entity, the button busy meanwhile, then says `ok`. */
  _press(btn, key, ok) {
    btn.classList.add("busy");
    this._hass.callService("button", "press", { entity_id: this._e[key] }).then(() => this._toast(ok), (err) => this._refused(err))
      .finally(() => btn.classList.remove("busy"));
  }
  /** The settings rows (SETTINGS) into #rows, with the pending banner's « Appliquer »: the variant and the panel's tab. */
  _wireSettingRows() {
    const refused = (err) => this._refused(err);
    const apply = (btn) => this._press(btn, "apply", APPLIED);
    this._$("applyNow").addEventListener("click", (ev) => apply(ev.currentTarget));
    const host = this._$("rows");
    let sect = null;
    this._sects = [];
    for (const def of SETTINGS) {
      if (def.sect) {
        const el = document.createElement("div"); el.className = "esect"; el.textContent = def.sect; host.appendChild(el);
        this._sects.push(sect = { el, rows: [] });
        continue;
      }
      const row = document.createElement("div"); row.className = "erow";
      row.innerHTML = `<span class="ic"></span><span class="name"><span></span>${def.sub ? "<small></small>" : ""}</span>`
        + (def.button ? `<button class="btn"></button>` : `<span class="ctl"><input type="range"><span class="v num"></span></span>`);
      row.querySelector(".name span").textContent = def.label;
      if (def.sub) row.querySelector("small").textContent = def.sub;
      const r = { def, row, input: row.querySelector("input"), out: row.querySelector(".v"), btn: row.querySelector("button"), editing: 0, icon: null };
      if (r.btn) { r.btn.textContent = def.button; r.btn.addEventListener("click", () => apply(r.btn)); }
      else {
        r.input.setAttribute("aria-label", def.label);
        // the slider wins over pushed states while it is moved, then until the controller's echo
        r.input.addEventListener("input", () => { r.editing = Date.now() + 60000; r.out.textContent = this._numTxt(def.key, r.input.value); row.classList.add("dirty"); });
        r.input.addEventListener("change", () => {
          r.editing = Date.now() + 4000;
          this._hass.callService("number", "set_value", { entity_id: this._e[def.key], value: +r.input.value })
            .catch((err) => { r.editing = 0; refused(err); })
            .finally(() => { row.classList.remove("dirty"); this._update(); });
        });
      }
      host.appendChild(row);
      this._setRows.push(r);
      if (sect) sect.rows.push(r);
    }
  }
  _updateSettings() {
    const pending = this._s("pending") === "on", now = Date.now();
    this._$("pendChip").hidden = !pending;
    this._$("pendBanner").hidden = !pending;
    for (const r of this._setRows) {
      const e = this._st(r.def.key);
      r.row.hidden = !e; // a firmware without it (Freeze Protection Temperature before 2026-11-17)
      if (!e) continue;
      const ic = e.attributes.icon || r.def.icon;
      if (r.icon !== ic) { r.row.querySelector(".ic").innerHTML = this._icon(ic); r.icon = ic; }
      if (r.btn) { r.btn.disabled = !pending; continue; }
      const a = e.attributes;
      r.input.min = a.min; r.input.max = a.max; r.input.step = a.step;
      if (now > r.editing) { r.input.value = e.state; r.out.textContent = this._numTxt(r.def.key, e.state); r.row.classList.remove("dirty"); }
    }
    for (const sc of this._sects) sc.el.hidden = sc.rows.every((r) => r.row.hidden);
  }

  /* ---------- panel, tab « Avancé »: Plan du jour, 7 derniers jours, Contrôleur, Sondes (and « Réglages »' rows) ---------- */
  _wireSetPane() {
    this._wireSettingRows();
    for (const [host, defs] of [[this._$("planRows"), PLAN_ROWS], [this._$("ctlRows"), CTL_ROWS], [this._$("probeRows"), PROBE_ROWS]]) {
      let sect = null;
      for (const def of defs) {
        if (def.sect) { sect = document.createElement("div"); sect.className = "esect"; sect.textContent = def.sect; host.appendChild(sect); continue; }
        const row = document.createElement("div"); row.className = "erow";
        row.innerHTML = `<span class="ic"></span><span class="name"><span></span><small></small></span>`
          + (def.button ? `<button class="btn"></button>` : `<span class="val num"></span>`);
        row.querySelector(".name span").textContent = def.label;
        const r = { def, row, sect, val: row.querySelector(".val"), sub: row.querySelector("small"), btn: row.querySelector("button"), icon: null };
        if (r.btn) { r.btn.textContent = def.button; r.btn.addEventListener("click", () => this._press(r.btn, def.key, def.ok)); }
        host.appendChild(row);
        this._paneRows.push(r);
      }
    }
  }
  _renderAdvPane() {
    for (const r of this._paneRows) {
      const e = this._st(r.def.key);
      r.row.hidden = r.def.has ? !r.def.has(this) : !e;
      if (r.row.hidden) continue;
      const ic = (e && e.attributes.icon) || r.def.icon;
      if (r.icon !== ic) { r.row.querySelector(".ic").innerHTML = this._icon(ic); r.icon = ic; }
      const sub = r.def.sub ? r.def.sub(this) : "";
      r.sub.textContent = sub; r.sub.hidden = !sub;
      if (r.btn) { r.btn.disabled = !this._online(); continue; }
      r.val.textContent = r.def.val(this);
      const tone = r.def.tone ? r.def.tone(this) : "";
      r.val.classList.toggle("bad", tone === "bad"); r.val.classList.toggle("warn", tone === "warn");
    }
    for (const r of this._paneRows) if (r.sect) r.sect.hidden = this._paneRows.every((x) => x.sect !== r.sect || x.row.hidden);
    this._renderDays();
  }
  /** Closed days from the device's Daily History, plus today so far: hours filtered, the plan's mark, the pool's min–max. */
  _renderDays() {
    const host = this._$("days");
    const key = ["history", "hoursToday", "hoursPlanned", "waterMin", "waterMax"].map((k) => this._s(k)).join("|") + new Date().toDateString();
    if (key === this._daysDrawn) return;
    this._daysDrawn = key;
    const closed = parseDays(this._s("history"));
    const rows = [{ label: "Aujourd'hui", hours: this._n("hoursToday"), planned: this._n("hoursPlanned"), lo: this._n("waterMin"), hi: this._n("waterMax"), today: true }];
    for (let i = 1; i <= 7; i++) {
      const d = dayAgo(i);
      rows.push({ label: i === 1 ? "Hier" : `${WD[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, ...closed[dayKey(d)] });
    }
    const scale = Math.max(1, ...rows.flatMap((r) => [r.hours, r.planned]).filter(Number.isFinite));
    const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
    const water = (r) => (Number.isFinite(r.lo) && Number.isFinite(r.hi) ? `${fmt1(r.lo)}–${fmt1(r.hi)}°` : "—");
    const past = rows.filter((r) => !r.today && Number.isFinite(r.hours));
    host.innerHTML = `<div class="day head"><span></span><span>Filtration</span><span></span><span class="w">Eau</span></div>`
      + rows.map((r) => {
        const known = Number.isFinite(r.hours);
        return `<div class="day${r.today ? " today" : ""}${known ? "" : " missing"}" title="${r.today ? "En cours ; le trait marque la durée planifiée" : known ? "" : "Pas de données : contrôleur éteint ou sans heure ce jour-là"}">`
          + `<span class="dl">${r.label}</span><span class="bar">${known ? `<i style="width:${pct(r.hours)}"></i>` : ""}`
          + `${Number.isFinite(r.planned) && r.planned > 0 ? `<b style="left:${pct(r.planned)}"></b>` : ""}</span>`
          + `<span class="v num">${known ? `${fmt1(r.hours)} h` : "—"}</span><span class="w num">${known ? water(r) : ""}</span></div>`;
      }).join("")
      + `<p class="dfoot">${past.length
        ? `Moyenne ${fmt1(past.reduce((a, r) => a + r.hours, 0) / past.length)} h de filtration par jour sur ${past.length} jour${past.length > 1 ? "s" : ""}.`
        : "Aucune journée complète pour l'instant."} Eau : minimum et maximum du jour, mesurés pompe en marche. Le contrôleur enregistre chaque journée à minuit.</p>`;
  }

  /* ---------- build ---------- */
  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const v = this._config.variant;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>${{ panel: PANEL_HTML, settings: SETTINGS_HTML, tile: TILE_HTML }[v]}`;
    this._built = true;
    if (v === "panel") this._wirePanel(); else if (v === "settings") this._wireSettings(); else this._wireTile();
  }

  _navigate(path, replace = false) {
    history[replace ? "replaceState" : "pushState"](null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace } }));
  }
  _wireTile() {
    const tile = this._$("tile");
    if (this._config.layout === "vertical") tile.classList.add("vertical");
    const open = () => this._navigate(this._config.popup_hash);
    tile.addEventListener("click", open);
    tile.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }

  _wirePanel() {
    this._$("close").addEventListener("click", () => this._navigate(location.pathname + location.search, true));
    // « Planning et réglages » and the light: the « Avancé » tab (the light: at « Contrôleur »), or more_path
    // without it (the device's page: its own Avancé tab)
    const openAdv = (at) => {
      if (!this._config.settings_tab) { this._navigate(this._config.more_path); return; }
      this._tab = "adv"; this._update();
      const t = this.shadowRoot.querySelector('#tabs [data-tab="adv"]');
      (at ? this._$(at).closest("section") : this._$("tabs")).scrollIntoView({ block: "nearest" }); t.focus({ preventScroll: true });
    };
    this._$("more").addEventListener("click", () => openAdv());
    this._$("ctlLink").addEventListener("click", () => openAdv("ctlRows"));
    // without the recorder only Daily History's 7 days exist: no range to choose
    this._$("tRange").hidden = !this._config.recorder;
    this.shadowRoot.querySelectorAll(".ptile").forEach((b) => b.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: this._e[b.dataset.key] } }));
    }));
    this._wireSetPane();

    const backToAuto = () => {
      if (this._pending() || !this._inOvr()) return;
      this._manual = false;
      this._local = { value: "Auto", label: "Retour en Auto", done: "Retour en Auto : la pompe suit son plan", t0: Date.now(), echoed: false };
      this._call("script", "turn_on", { entity_id: this._e.sAuto });
      this._update();
    };
    this._$("autoBtn").addEventListener("click", backToAuto);
    this._$("stuckBtn").addEventListener("click", backToAuto);

    this.shadowRoot.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
      if (this._pending()) return;
      if (b.dataset.mode === "auto") { if (this._inOvr()) backToAuto(); else { this._manual = false; this._update(); } }
      else { this._manual = true; this._update(); }
    }));

    const force = (v) => {
      const [, min] = this._durChoice();
      const until = min ? ` jusqu'à ${fmtT(new Date(Date.now() + min * 60000))}` : "";
      this._local = {
        value: v, t0: Date.now(), echoed: false,
        label: v === "Off" ? `Arrêt${until}` : `Manuel ${SPEEDS[v]}${until}`,
        done: v === "Off" ? `Pompe arrêtée${until ? ", Auto à " + until.slice(10) : ""}` : `Pompe en ${SPEEDS[v]}${until ? ", Auto à " + until.slice(10) : ""}`,
      };
      this._call("script", this._e.sForce.replace(/^script\./, ""), { vitesse: v });
      this._update();
    };
    this.shadowRoot.querySelectorAll("#speedSeg button").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.speed;
      if (this._pending() || this._freeze()) return;
      if (v === this._override()) { this._toast(`Déjà en ${SPEEDS[v]}`); return; }
      if (v === "Off") {
        this._confirm = true; this._update(); this._$("cfYes").focus();
        clearTimeout(this._cfTimer);
        this._cfTimer = setTimeout(() => { this._confirm = false; this._update(); }, 7000);
        return;
      }
      force(v);
    }));
    this._$("cfNo").addEventListener("click", () => { clearTimeout(this._cfTimer); this._confirm = false; this._update(); });
    this._$("cfYes").addEventListener("click", () => { clearTimeout(this._cfTimer); this._confirm = false; force("Off"); });

    this.shadowRoot.querySelectorAll("#durSeg button").forEach((b) => b.addEventListener("click", async () => {
      if (this._pending()) return;
      const m = (DURATIONS.find(([o]) => o === b.dataset.dur) || [])[1];
      if (m === undefined || m === this._timeoutMin()) return;
      // The firmware restamps its clock on this write, so during an override the new duration counts from now.
      await this._call("number", "set_value", { entity_id: this._e.timeout, value: m });
      if (this._inOvr()) this._toast(m ? `Retour en Auto à ${fmtT(new Date(Date.now() + m * 60000))}` : "Plus de retour automatique");
      this._update();
    }));

    // pool temperature: range, crosshair (pointer or arrows; Maj+flèche = 1 h on 24 h)
    this.shadowRoot.querySelectorAll("#tRange button").forEach((b) => b.addEventListener("click", () => {
      this._range = b.dataset.r; this._tHover = null; this._renderTemp();
    }));
    const box = this._$("tChart");
    const days = () => T_N[this._range];
    const hoverAt = (clientX) => {
      const r = box.getBoundingClientRect(), f = Math.min(1, Math.max(0, (clientX - r.left - 8) / (r.width - 42)));
      this._tHover = this._range === "24h" ? Math.round(((1 - f) * 1440) / T_STEP_MIN) * T_STEP_MIN : Math.min(days() - 1, Math.floor(f * days()));
      this._renderTemp();
    };
    const leave = () => { if (this._tHover !== null) { this._tHover = null; this._renderTemp(); } };
    box.addEventListener("pointermove", (e) => hoverAt(e.clientX));
    box.addEventListener("pointerdown", (e) => hoverAt(e.clientX));
    box.addEventListener("pointerleave", leave);
    box.addEventListener("blur", leave);
    box.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const back = e.key === "ArrowLeft";
      if (this._range === "24h") {
        const step = e.shiftKey ? 60 : T_STEP_MIN, h = this._tHover ?? 0;
        this._tHover = e.key === "Home" ? 1440 : e.key === "End" ? 0 : Math.min(1440, Math.max(0, h + (back ? step : -step)));
      } else {
        const last = days() - 1, h = this._tHover ?? last;
        this._tHover = e.key === "Home" ? 0 : e.key === "End" ? last : Math.min(last, Math.max(0, h + (back ? -1 : 1)));
      }
      this._renderTemp();
    });

    // tabs « Pompe » / « Remplissage » / « Réglages » (arrows move between the shown ones, as in a tablist)
    this.shadowRoot.querySelectorAll("#tabs button").forEach((b) => {
      b.addEventListener("click", () => { this._tab = b.dataset.tab; this._wHover = null; this._update(); });
      b.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const tabs = [...this.shadowRoot.querySelectorAll("#tabs button:not([hidden])")], i = tabs.indexOf(b);
        const t = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        t.focus(); t.click();
      });
    });
    // fill water: range and bar under the pointer or the arrows
    this.shadowRoot.querySelectorAll("#wRange button").forEach((b) => b.addEventListener("click", () => {
      this._wRange = b.dataset.r; this._wHover = null; this._renderWater();
    }));
    const wbox = this._$("wChart"), bars = () => (this._waterBuckets(this._wRange) || []).length;
    const wAt = (clientX) => {
      const n = bars(); if (!n) return;
      const r = wbox.getBoundingClientRect(), f = Math.min(1, Math.max(0, (clientX - r.left - 8) / (r.width - 48)));
      this._wHover = Math.min(n - 1, Math.floor(f * n)); this._renderWater();
    };
    const wLeave = () => { if (this._wHover !== null) { this._wHover = null; this._renderWater(); } };
    wbox.addEventListener("pointermove", (e) => wAt(e.clientX));
    wbox.addEventListener("pointerdown", (e) => wAt(e.clientX));
    wbox.addEventListener("pointerleave", wLeave);
    wbox.addEventListener("blur", wLeave);
    wbox.addEventListener("keydown", (e) => {
      const n = bars();
      if (!n || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const h = this._wHover ?? n - 1;
      this._wHover = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.min(n - 1, Math.max(0, h + (e.key === "ArrowLeft" ? -1 : 1)));
      this._renderWater();
    });

    this._ro?.disconnect(); // a new setConfig rebuilds the panel
    this._ro = new ResizeObserver(() => { this._renderTemp(); this._renderWater(); });
    this._ro.observe(box);
    this._ro.observe(wbox);
  }

  /* ---------- update ---------- */
  _update() {
    if (!this._built || !this._hass) return;
    const v = this._config.variant;
    if (v === "panel") { this._loadHistory(); this._trackLive(); this._updatePanel(); }
    else if (v === "settings") this._updateSettings();
    else this._updateTile();
  }

  _tileSecondary() {
    const P = this._pending();
    const hrs = `${fmt1(this._n("hoursToday"))} h / ${fmt1(this._n("hoursPlanned"))} h`;
    if (P) return ["Envoi au contrôleur…", "s"];
    if (!this._online()) { const L = this._light(); return [this._lightText(L), L.h === "lost" ? "s bad" : "s warn"]; }
    if (this._freeze()) return [`Hors gel · Low · ${hrs}`, "s"];
    if (this._stuck()) return [`Override ${SPEEDS[this._override()]} depuis ${fmtD(this._ovrAgeMin())}`, "s bad"];
    if (this._inOvr()) { const u = this._ovrUntil(); return [`Manuel ${SPEEDS[this._override()]} · ${u ? "Auto à " + fmtT(u) : "sans limite"}`, "s warn"]; }
    const c = this._commanded();
    return [`Auto · ${c === "Off" ? "Arrêtée" : SPEEDS[c]} · ${hrs}`, "s"];
  }
  _updateTile() {
    const ico = this._$("ico");
    ico.className = this._icoClass("ico");
    ico.style.setProperty("--spd", this._spinSpeed());
    ico.querySelector(".dot")?.remove();
    if (this._stuck()) { const d = document.createElement("span"); d.className = "dot"; ico.appendChild(d); }
    const [sec, cls] = this._tileSecondary();
    this._$("sec").textContent = sec; this._$("sec").className = cls;
    this._$("val").textContent = `${fmt1(this._n("water"))} °C`;
    this._renderLight();
  }

  _drawTimeline() {
    const tl = this._$("tl"); tl.innerHTML = "";
    const pct = (m) => `${(m / 1440) * 100}%`;
    const now = new Date(), nowM = minOfDay(now);
    for (const k of ["next_rising", "next_setting"]) {
      const d = new Date(this._attr("sun", k) || NaN);
      if (!isNaN(d)) { const e = document.createElement("i"); e.className = "sun"; e.style.left = pct(minOfDay(d)); tl.appendChild(e); }
    }
    const blocks = [[hhmm(this._s("b1s")), hhmm(this._s("b1e"))], [hhmm(this._s("b2s")), hhmm(this._s("b2e"))]].filter(([s, e]) => s !== null && e !== null && e > s);
    const interval = this._n("boostInterval", 30), dur = this._n("boostDuration", 5), every = Math.max(1, Math.round(this._n("highEvery", 3)));
    for (const [s, e] of blocks) {
      const b = document.createElement("div"); b.className = "blk"; b.style.left = pct(s); b.style.width = pct(e - s);
      if (interval > 0 && dur > 0) {
        let n = 0;
        for (let t = s; t < e && n < 200; t += interval, n++) {
          const i = document.createElement("i"); i.className = n % every === 0 ? "hi" : "";
          i.style.left = `${((t - s) / (e - s)) * 100}%`; i.style.width = `${(Math.min(dur, e - t) / (e - s)) * 100}%`;
          b.appendChild(i);
        }
      }
      tl.appendChild(b);
    }
    const seen = new Set();
    const mid = new Date(now); mid.setHours(0, 0, 0, 0);
    // Past: every override that ran today and has ended (or was replaced by another speed), what really happened.
    for (const x of this._pastOverrides(mid.getTime(), now.getTime())) {
      const o = document.createElement("div"); o.className = `ovr ${x.speed}`;
      o.style.left = pct(x.from); o.style.width = pct(x.to - x.from); tl.appendChild(o); seen.add(x.speed);
    }
    // Running: from its start (00:00 if it began yesterday) to the controller's deadline.
    const since = this._ovrSince();
    if (since) {
      const o = document.createElement("div"); o.className = `ovr ${this._override()}`;
      const until = this._ovrUntil();
      const startM = since < mid ? 0 : minOfDay(since);
      // No deadline (« Jamais ») or one past midnight: the rest of today's plan is overridden, paint it to 24 h.
      const endM = until && until.toDateString() === now.toDateString() ? Math.max(minOfDay(until), nowM) : 1440;
      o.style.left = pct(startM); o.style.width = pct(Math.max(0, endM - startM)); tl.appendChild(o); seen.add(this._override());
    }
    const n = document.createElement("i"); n.className = "now"; n.style.left = pct(nowM); tl.appendChild(n);
    const sum = blocks.map(([s, e]) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}–${pad(Math.floor(e / 60))}:${pad(e % 60)}`).join(" · ");
    this._$("planSum").textContent = `${fmt1(this._n("hoursPlanned"))} h${sum ? " · " + sum : " · plan non calculé"}`;
    return seen;
  }

  _updatePanel() {
    const P = this._pending();
    const ph = this._phase();
    const inOvr = this._inOvr(), online = this._online(), freeze = this._freeze(), stuck = this._stuck();
    const until = this._ovrUntil();

    // « Remplissage » needs the recorder's statistics and a water meter; « Avancé » and « Réglages » can be turned off
    const shown = { pump: true, water: this._config.recorder && !!this._st("volume"), adv: this._config.settings_tab, settings: this._config.settings_tab };
    if (!shown[this._tab]) this._tab = "pump";
    this._$("tabs").hidden = !shown.water && !shown.settings;
    this.shadowRoot.querySelector(".panel").dataset.tab = this._tab;
    this.shadowRoot.querySelectorAll("#tabs button").forEach((b) => {
      const on = b.dataset.tab === this._tab;
      b.hidden = !shown[b.dataset.tab];
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    });
    if (this._tab === "adv") this._renderAdvPane();
    if (this._tab === "settings") this._updateSettings();

    // « Températures » at the foot of « Pompe »
    const probes = { outdoor: this._st("outdoor"), pad: this._st("pad") };
    this._$("probes").hidden = !this._config.temperatures || (!probes.outdoor && !probes.pad);
    this.shadowRoot.querySelectorAll(".ptile").forEach((b) => { b.hidden = !probes[b.dataset.key]; });
    this._$("prOut").textContent = `${fmt1(this._n("outdoor"))} °C`;
    this._$("prPad").textContent = `${fmt1(this._n("pad"))} °C`;

    this._$("ico").className = this._icoClass("ico big");
    this._$("ico").style.setProperty("--spd", this._spinSpeed());
    const st = this._$("status"); st.className = `status ${ph.cls}`; st.textContent = ph.label;
    st.hidden = this._config.controller_light && !online; // offline, the light says it
    this._renderLight();
    this._$("water").innerHTML = `${fmt1(this._n("water"))}<small>°C</small>`;
    this._$("outdoor").innerHTML = `${fmt1(this._n("outdoor"))}<small>°C</small>`;
    const hT = this._n("hoursToday"), hP = this._n("hoursPlanned");
    this._$("hours").innerHTML = `${fmt1(hT)}<small>h / ${fmt1(hP)} h</small>`;
    this._$("hoursBar").style.width = `${hP > 0 ? Math.min(100, (hT / hP) * 100) : 0}%`;
    const nextAt = this._s("nextAt"), nextTo = this._s("nextTo");
    this._$("next").innerHTML = hhmm(nextAt) !== null ? `${nextAt}<small>→ ${SPEEDS[nextTo] || nextTo || "?"}</small>` : `—<small>plus rien aujourd'hui</small>`;

    // alerts
    this._$("offAlert").hidden = online;
    this._$("offAlert").className = this._light().h === "lost" ? "alert" : "alert amber";
    const onl = this._st("online");
    this._$("offTxt").textContent = `Contrôleur hors ligne depuis ${onl ? fmtD((Date.now() - Date.parse(onl.last_changed)) / 60000) : "?"}. Le plan continue sur l'ESP32, mais aucune commande ne lui parviendra.`;
    this._$("freezeAlert").hidden = !freeze;
    this._$("freezeTxt").textContent = `Hors gel actif (bassin ${fmt1(this._n("water"))} °C) : la pompe tourne en Low quoi qu'on lui demande.`;
    this._$("planAlert").hidden = this._s("notComputed") !== "on";
    this._$("stuckAlert").hidden = !stuck || !online;
    this._$("stuckTxt").textContent = `Override ${SPEEDS[this._override()]} depuis ${fmtD(this._ovrAgeMin())} : la pompe ne suit plus son plan de filtration.`;
    this._$("stuckBtn").disabled = !!P;

    const seen = this._drawTimeline();
    this._$("legOvr").innerHTML = ["Off", "Low", "Medium", "High"].filter((v) => seen.has(v))
      .map((v) => `<span><i class="${v}"></i>Override ${SPEEDS[v]}</span>`).join("");

    // big button / confirmation / tracker
    const ab = this._$("autoBtn");
    ab.hidden = !inOvr || this._confirm;
    ab.disabled = !!P;
    this._$("autoBtnTxt").textContent = until ? `Revenir en Auto maintenant (sinon à ${fmtT(until)})` : "Revenir en Auto";
    this._$("confirm").hidden = !this._confirm;
    if (this._confirm) {
      const [, min] = this._durChoice();
      this._$("confirmTxt").textContent = min ? `Arrêter la pompe pendant ${fmtD(min)} ?` : "Arrêter la pompe sans limite de durée ?";
    }
    this._$("pend").hidden = !P;
    if (P) {
      this._$("pendLabel").textContent = P.label;
      this._$("pendTime").textContent = `${Math.max(0, Math.floor((Date.now() - P.t0) / 1000))} s`;
      this._$("st0").className = "step done";
      this._$("st1").className = "step" + (P.fail ? " fail" : P.stage >= 1 ? " done" : " active");
    }

    // mode
    const L = this._local;
    const effMode = inOvr || this._manual ? "manual" : "auto";
    this.shadowRoot.querySelectorAll("#modeSeg button").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.mode === effMode));
      b.classList.toggle("going", !!L && ((L.value === "Auto") === (b.dataset.mode === "auto")) && L.value !== this._override());
      b.disabled = !!P;
    });
    const planned = this._planned(), cmd = this._commanded();
    const nextTxt = hhmm(nextAt) !== null ? `<b>${SPEEDS[nextTo] || nextTo}</b> à ${nextAt}` : "arrêt en fin de bloc";
    let hint;
    if (freeze) hint = `Hors gel : le contrôleur impose Low tant que le bassin est sous ${fmt1(this._freezeC())} °C. Le pilotage reprendra ensuite.`;
    else if (effMode === "auto") hint = planned === "Off"
      ? `Le contrôleur suit son plan : pompe arrêtée, reprise ${hhmm(nextAt) !== null ? "à " + nextAt : "demain au lever du soleil"}.`
      : `Le contrôleur suit son plan : <b>${SPEEDS[planned]}</b> maintenant, ${nextTxt}.`;
    else if (!inOvr) hint = "Choisissez une vitesse : elle s'applique tout de suite et remplace le plan.";
    else hint = `Le plan est suspendu${until ? ` jusqu'à ${fmtT(until)}` : ""}. Le contrôleur fait <b>${SPEEDS[cmd]}</b>${planned !== cmd ? `, le plan aurait fait ${SPEEDS[planned]}` : ""}.`;
    this._$("modeHint").innerHTML = hint;

    // manual block
    this._$("manualBlock").hidden = effMode !== "manual";
    this.shadowRoot.querySelectorAll("#speedSeg button").forEach((b) => {
      b.setAttribute("aria-checked", String(inOvr && b.dataset.speed === this._override()));
      b.classList.toggle("going", !!L && L.value === b.dataset.speed && L.value !== this._override());
      b.disabled = !!P || freeze;
    });
    const [durOpt, durMin] = this._durChoice();
    this.shadowRoot.querySelectorAll("#durSeg button").forEach((b) => { b.setAttribute("aria-checked", String(b.dataset.dur === durOpt)); b.disabled = !!P; });
    this._$("durHint").textContent = inOvr
      ? (until ? `Retour automatique en Auto à ${fmtT(until)} (dans ${fmtD((until.getTime() - Date.now()) / 60000)}).`
               : `Aucun retour automatique : alerte après ${STUCK_MIN} min, et la pompe reste ainsi jusqu'à ce que quelqu'un repasse en Auto.`)
      : (durMin ? `La pompe reviendra d'elle-même au plan après ${fmtD(durMin)}.`
                : `Sans minuteur : alerte après ${STUCK_MIN} min, et la pompe reste ainsi jusqu'à ce que quelqu'un repasse en Auto.`);

    // footer
    const sy = this._$("sync");
    const rc = /(\d{2}:\d{2})(:\d{2})?$/.exec(this._s("recomputed") || "");
    sy.textContent = rc ? `Plan calculé à ${rc[1]}` : ""; // the link: the light, the alert
    this._$("plannedTxt").textContent = `Plan seul : ${SPEEDS[planned]}`;

    this._renderTemp();
    this._renderWater();
  }
}

if (!customElements.get("piscine-card")) {
  customElements.define("piscine-card", PiscineCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "piscine-card", name: "Pompe piscine", description: "Tile and panel for the pool pump (Pool Controller)" });
  console.info(`%c piscine-card %c ${VERSION} `, "background:#0e86c4;color:#fff", "");
}
