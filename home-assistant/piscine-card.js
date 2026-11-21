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
 *   settings_tab: false  # optional: no « Réglages » nor « Réglages contrôleur » tab, so no tab bar
 *   controller_light: false                            # optional: no light for the controller (tile, header)
 *   controller_health: { warn: 3, alert: 15, beat: 4 }  # optional: its minutes before amber, before red; seconds between beats
 *   more_path: /config/…  # optional: where the light leads instead of the controller's device page
 *   language: es          # optional: en, fr or es, instead of the Home Assistant user's language (its texts:
 *                         # home-assistant/i18n/<lang>.json; numbers and times follow the user's profile)
 *   # temperatures: deprecated since 1.8.0, accepted and ignored (the probes are in « Réglages » › Sondes)
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
 * Pool temperature (« Température du bassin », under the day plan and Pilotage; mock-up approved
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
 * The outdoors on the same axis, in orange (1.13.0): on 24 h the outdoor sensor's line from the recorder; on the other
 * ranges each day's (week's) min – max as a band behind the pool's bars, from the device's Daily Outdoor History (its
 * Outdoor Min/Max Today closed at midnight), else the outdoor sensor's own daily statistics (in the air every reading
 * counts, so HA's day is exact and goes back as far as the sensor); today from Outdoor Min/Max Today, or with a firmware
 * before them the sensor's states since midnight. It widens the scale, never the freeze threshold's place.
 * Every view draws the freeze-protection threshold (number Freeze Protection Temperature, 3 °C by default), in
 * red: a dotted line over the zone where Low is forced once the water comes within FREEZE_NEAR_C of it, else a
 * tag at the foot of the axis, so a 13 °C curve isn't squashed to show 3 °C.
 * `recorder: false` (the device's own page) leaves only 7 j, which the device keeps itself, and no range to pick.
 *
 * Three tabs, the controller's own page's (mock-up v17, 2026-11-18): « Contrôle » | « Réglages » | « Réglages
 * contrôleur ». `settings_tab: false` keeps « Contrôle » alone, without a tab bar (the device's page has its own two).
 *
 * The controller's light (a dot on the tile; in the panel's header a button that opens Home Assistant's own device
 * page for the controller, /config/devices/device/<device_id of the `online` entity>: its link, Wi-Fi signal and
 * disconnections; `more_path` when given leads there instead; without a device id, « Réglages contrôleur »):
 * when the controller was last heard, from the newest update of any of its entities. Green while it talks; amber
 * when it has been quiet for `warn` min, or offline for less than `alert` (a restart, an OTA, a Wi-Fi drop usually
 * end on their own); red beyond. Each new message pops the dot and sends a ring out of it (every `beat` s at most).
 * Its heartbeat is the Device Clock (wifi-setup.yaml, entity `clock`), which changes every minute; without it a
 * still night leaves every value as it was, so only the link counts. Offline, the light replaces the pump's state.
 * A fill running too long (Fill Running Too Long, fill-meter.yaml) and not yet acknowledged (Fill Alarm Acknowledged)
 * turns it amber and pulsing, over the controller's health unless that is red: red > pulsing amber > amber > green. The
 * header and the tile then read « Remplissage depuis 1 h 12 », and the header's button leads to the banner below.
 *
 * Fill water (« Contrôle », after the readings, under its chart's « Eau de remplissage »; recorder only, so not in the
 * device page's panel; mock-up 2026-11-17). The water meter on the fill line (Piscine - Volume total remplissage,
 * total_increasing) as HA's statistics `change`: 30 j one bar a day, 90 j one a week (13 weeks from a Monday, HA's
 * weeks), 12 mois one a month, the period's total above. The running day/week/month adds what the meter counted
 * since the last compiled hour (the live state against that hour's `state`; after a reboot the meter restarts from
 * 0). Above it, today, this month so far and the flow, and while a fill runs (Fill Running) since when.
 * The meter is optional (fill-meter.yaml, 1.9.0): with Fill Meter (`fillEnabled`) off, there is no fill water, in the
 * panel or as `variant: water` (hidden). A fill longer than Fill Alarm After puts a banner in « Contrôle », with
 * « Acquitter » (Acknowledge Fill Alarm), then « acquittée » until the fill ends. The meter's settings are not the
 * card's: Home Assistant's device page, the controller's own page. A firmware without these entities counts always.
 *
 *   type: custom:piscine-card
 *   variant: water       # the same, alone. With `recorder: false` (the device's page) from the controller's own
 *                        # record instead: entities fillToday, fillDays, fillMonths (Fill Water Today / Days /
 *                        # Months), 30 j and 12 mois.
 *
 * « Réglages » and « Réglages contrôleur »: between them, every control the controller has, as on its own page, so
 * the pop-up needs no dashboard behind it. « Réglages », read in this order: today's plan with « Recalculer », the
 * probes with « Relire » (a tap on one opens Home Assistant's more-info, its history), « Filtration et hors gel »
 * (the same rows as `variant: settings`), then the last 7 days of filtration against the plan (Daily History, each day's plan from Daily Plan History).
 * « Réglages contrôleur »: « Position », the controller's latitude, longitude and time zone, and « Utiliser la
 * position et le fuseau de Home Assistant », which writes hass.config's, rounded to 0.01°, the zone as its IANA name
 * (Timezone Name) and its POSIX string (Timezone, from TZ_POSIX); then « Firmware » (mock-up 2026-11-18, plan WP4).
 * The section runs on the controller's update entity, « Firmware » (ESPHome's `update` platform on the release
 * manifest): installed version (with ESPHome's version and build time), latest version and its release notes,
 * « Vérifier » (Check for Update) and « Installer » (update.install, with its progress), Auto Update and Update Check
 * Interval. A tap on a version row opens Home Assistant's own dialog for that entity (its release notes, « Ignorer »).
 * The firmware holds every install while a manual override or a fill runs, whoever asked (Update Status says
 * `pending:override` or `pending:fill`; a firmware before 1.11.0 said it in French, which LEGACY_STATUS reads until no
 * supported firmware is that old): the card asks first when « Installer » would wait, and says so while it waits, with « Annuler la demande »
 * (Cancel Update). Auto Update installs only what a scheduled check finds, never after « Vérifier ». Whether a newer
 * firmware exists is the controller's to say, and the card's own version is HACS's: the card asks GitHub nothing. A
 * firmware without the entity (before the update entity, v1.4) has no Firmware section. The tabs are the way in:
 * « Contrôle » has no link to them.
 *
 *   type: custom:piscine-card
 *   variant: settings    # the controller's settings: the rows of its own page (Réglages › Filtration et hors gel)
 * Home Assistant's entities card cuts a long name short on a phone and has no line for a description; these
 * rows wrap both. The device's page runs this same variant, with `icons` (name -> SVG path) where HA has
 * <ha-icon>.
 *
 * Layout: one column on a phone (Bubble bottom sheet). From 680 px of container width (the Bubble
 * adaptive-dialog on a screen, width_desktop 760px) « Contrôle » runs across the full width under the header:
 * the day plan, Pilotage right under it, the temperature, then the readings in one row (layout « B », approved
 * on the mock-up on 2026-11-11; Pilotage moved under the plan on 2026-11-20). « Réglages » is two columns, cut after « Appliquer »: Plan du jour, Sondes and
 * « Filtration » on the left, « Impulsions et hors gel » and 7 derniers jours on the right; « Réglages
 * contrôleur » is Position beside Firmware, Redémarrer under Firmware.
 */
// The texts, in every language, bundled into the card (i18n.js; docs/plans/i18n.md): nothing is fetched. The
// release builds this file with them (make card), and the device's page bundles it the same way.
import { LANGS, makeT, makeFmt, localeFromHass, resolveLang } from "./i18n.js";
import en from "./i18n/en.json" with { type: "json" };
import fr from "./i18n/fr.json" with { type: "json" };
import es from "./i18n/es.json" with { type: "json" };
const DICTS = { en, fr, es };
/**
 * The language and formats of the card being drawn (PiscineCard._use()), for the helpers outside the class: each card
 * sets them before it draws, so two cards in two languages on one dashboard each draw in their own.
 */
let T = makeT(DICTS, "en"), F = makeFmt("en");

const VERSION = "1.13.0";

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
  planHistory: "sensor.piscine_pool_controller_daily_plan_history",
  outdoor: "sensor.piscine_pool_controller_outdoor_temperature",
  outdoorMin: "sensor.piscine_pool_controller_outdoor_min_today",
  outdoorMax: "sensor.piscine_pool_controller_outdoor_max_today",
  outdoorHistory: "sensor.piscine_pool_controller_daily_outdoor_history",
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
  clock: "datetime.piscine_pool_controller_device_clock",
  fwVersion: "sensor.piscine_pool_controller_firmware_version",
  esphomeVersion: "sensor.piscine_pool_controller_esphome_version",
  // From here, a fresh install's ids (« Pool Controller »): entities the firmware got with its settings (WP2) and its
  // updates (WP6). An older firmware has none of them, and their rows hide.
  firmware: "update.pool_controller_firmware",
  checkUpdate: "button.pool_controller_check_for_update",
  cancelUpdate: "button.pool_controller_cancel_update",
  restart: "button.pool_controller_restart", // « Réglages contrôleur » › Redémarrer (device-settings.yaml, 1.12.0)
  autoUpdate: "switch.pool_controller_auto_update",
  updateInterval: "select.pool_controller_update_check_interval",
  updateStatus: "sensor.pool_controller_update_status",
  latitude: "number.pool_controller_latitude",
  longitude: "number.pool_controller_longitude",
  timezone: "text.pool_controller_timezone",
  timezoneName: "text.pool_controller_timezone_name",
  // The fill meter as an option (fill-meter.yaml, 1.9.0): on or off, and its long-fill alarm. Its settings are not the
  // card's (Home Assistant's device page, the controller's own page). A firmware without them counts the meter always
  // and has no alarm.
  fillEnabled: "switch.pool_controller_fill_meter",
  fillAlarmAfter: "number.pool_controller_fill_alarm_after",
  fillRunning: "binary_sensor.pool_controller_fill_running",
  fillTooLong: "binary_sensor.pool_controller_fill_running_too_long",
  fillAck: "button.pool_controller_acknowledge_fill_alarm",
  fillAcked: "binary_sensor.pool_controller_fill_alarm_acknowledged",
  sForce: "script.piscine_forcer_vitesse",
  sAuto: "script.piscine_retour_auto",
};
/** The pump's speeds, as the controller names them (codes); their words are the dictionaries' common.speed.*. */
const SPEEDS = { Off: true, Low: true, Medium: true, High: true };
const speedTxt = (v) => (SPEEDS[v] ? T(`common.speed.${v}`) : v);
/**
 * An older firmware's Update Status (before 1.11.0, in French) -> its code. Remove once no supported firmware sends
 * them (docs/plans/i18n.md, I7).
 */
const LEGACY_STATUS = {
  "non vérifié": "unchecked", "vérification": "checking", "à jour": "up_to_date", "disponible": "available", // i18n-ignore: an old firmware's words
  "installation": "installing", "en attente (mode manuel)": "pending:override", "en attente (remplissage)": "pending:fill",
  "erreur (vérification)": "error:check", "erreur (installation)": "error:install", // i18n-ignore: an old firmware's words
};
/** Update Check Interval's option (a code: on_request, 6h, 24h, 7d) in words; an older firmware's own option as is. */
const intervalTxt = (o) => {
  const m = /^(\d+)([hd])$/.exec(o);
  return o === "on_request" ? T("card.fw.opt.on_request") : !m ? o : m[2] === "h" ? `${m[1]} h` : T("card.fw.opt.days", { count: +m[1] });
};
/** Manual Override Timeout's choices, in minutes (0 = never). */
const DURATIONS = [30, 60, 120, 0];
const FREEZE_DEFAULT_C = 3; // firmware: Freeze Protection Temperature's initial value, until the number is known
const FREEZE_NEAR_C = 4;    // temperature graph: the threshold joins the scale when the water comes this close
const STUCK_MIN = 30;     // firmware: Manual Override Active after this long off Auto
const CMD_TIMEOUT = 15000;
const H_MS = 3600000, M_MS = 60000;
const POOL_AFTER_MIN = 10; // firmware: a reading counts as the pool after this long pumping (Pool Water Min/Max Today)
const T_STEP_MIN = 5;      // 24 h curve: one point per 5 min, the sensor's own pace
const T_RANGES = ["24h", "7d", "30d", "90d", "1y"]; // their labels: card.range.*
const T_N = { "7d": 7, "30d": 30, "90d": 90, "1y": 53 }; // bars: a day each, 1 an a week each (53 Mondays)
const T_STATS = new Set(["30d", "90d", "1y"]); // the ranges drawn from HA's statistics
const PROBE_GLITCH_C = 12; // a day the probe spans more than this had a bad reading (0 °C, 110 °C): its mean is dropped
const OUT_SANE = [-40, 60]; // firmware: an outdoor reading outside this is a bad one (Outdoor Min/Max Today); a day beyond it is dropped
/** The controller's light (`controller_health`): minutes before amber, before red; seconds between two heartbeats. */
const HEALTH = { warn: 3, alert: 15, beat: 4 };
/** Never keys: the sun and the two scripts are Home Assistant's, not the controller's. */
const NOT_CONTROLLER = new Set(["sun", "sForce", "sAuto"]);
/**
 * The controller's two id prefixes: a device first named « Piscine Pool Controller » (piscine_pool_controller_…) and a
 * fresh install (pool_controller_…). A default id Home Assistant lacks is looked up under the other one, so a default
 * written for one install still finds the entity on the other.
 */
const ID_PREFIXES = [["piscine_pool_controller_", "pool_controller_"], ["pool_controller_", "piscine_pool_controller_"]];
const otherId = (id) => {
  const dot = id.indexOf("."), object = id.slice(dot + 1);
  const p = ID_PREFIXES.find(([from]) => object.startsWith(from));
  return p ? `${id.slice(0, dot + 1)}${p[1]}${object.slice(p[0].length)}` : null;
};
const W_RANGES = ["30d", "90d", "12m"]; // their labels: card.range.*
const W_PERIOD = { "30d": "day", "90d": "week", "12m": "month" };
/**
 * variant: settings and the panel's « Réglages » › « Filtration et hors gel » — the device page's, in its order and
 * words. A row's words are card.row.<key>.label and, with `sub`, .sub; a section's, `sect` (a key). `icon` when the
 * entity has none. Not Manual Override Timeout: « Contrôle » › Manuel › « Retour en Auto » sets it, with the override
 * it applies to. In the wide panel the rows split after « Appliquer » (APPLY_CUT).
 */
const SETTINGS = [
  { sect: "card.settings.filtration_section" },
  { key: "min", sub: true, icon: "timer-sand" },
  { key: "max", sub: true, icon: "timer-sand" },
  { key: "offset", sub: true, icon: "timer-plus" },
  { key: "warm", sub: true, icon: "sun-clock" },
  { key: "apply", sub: true, icon: "check-bold", button: "common.apply" },
  { sect: "card.sect.pulses" },
  { key: "boostDuration", icon: "flash" },
  { key: "boostInterval", sub: true, icon: "flash-outline" },
  { key: "highEvery", sub: true, icon: "flash-triangle" },
  { sect: "card.sect.freeze" },
  { key: "freezeAt", sub: true, icon: "snowflake-thermometer" },
];
const APPLY_CUT = SETTINGS.findIndex((d) => d.key === "apply") + 1;

/**
 * Panel, tab « Réglages »: Plan du jour, the device page's rows (webui/app.js) in its words: card.row.<key>.label, and
 * for a button .button and .ok (its toast). A row whose entity is missing is hidden. `val`/`sub` take the card.
 */
const span = (c, a, b) => (hhmm(c._s(a)) !== null && c._s(a) !== c._s(b) ? `${clock(c._s(a))} → ${clock(c._s(b))}` : "—"); // start == end: none
const degC = (k) => (c) => `${fmt1(c._n(k))} °C`;
const PLAN_ROWS = [
  { key: "hoursPlanned", icon: "timer-outline", val: (c) => `${fmt1(c._n("hoursPlanned"))} h` },
  { key: "hoursToday", icon: "timer-check-outline", val: (c) => `${fmt1(c._n("hoursToday"))} h`,
    sub: (c) => (c._n("hoursPlanned") > 0 ? c._t("card.row.hoursToday.pct", { pct: Math.round((c._n("hoursToday") / c._n("hoursPlanned")) * 100) }) : "") },
  { key: "b1s", icon: "clock-start", val: (c) => span(c, "b1s", "b1e") },
  { key: "b2s", icon: "clock-end", val: (c) => span(c, "b2s", "b2e") },
  { key: "planned", icon: "pump", val: (c) => speedTxt(c._planned()) },
  { key: "commanded", icon: "pump", val: (c) => speedTxt(c._commanded()),
    sub: (c) => (c._inOvr() ? c._t("card.row.commanded.forced", { speed: speedTxt(c._override()) }) : c._t("card.row.commanded.follows")) },
  { key: "nextAt", icon: "clock-fast",
    val: (c) => (hhmm(c._s("nextAt")) !== null ? `${clock(c._s("nextAt"))} → ${speedTxt(c._s("nextTo"))}` : c._t("card.nothing_today")) },
  { key: "nextBoostStart", icon: "flash", val: (c) => span(c, "nextBoostStart", "nextBoostEnd") },
  { key: "recomputed", icon: "calendar-clock", val: (c) => stamp(c._s("recomputed")) },
  { key: "recompute", icon: "refresh", button: true },
];
/**
 * Panel, tab « Réglages » › Sondes: the probes, as the device page's Capteurs internes › Capteurs. `more`: a tap opens
 * Home Assistant's more-info for that sensor, with its history.
 */
const PROBE_ROWS = [
  { key: "water", icon: "thermometer-water", val: degC("water"), more: true,
    sub: (c) => c._t(c._commanded() === "Off" ? "card.row.water.off" : "card.row.water.on") },
  { key: "pad", icon: "home-thermometer-outline", val: degC("pad"), more: true },
  { key: "outdoor", icon: "weather-partly-cloudy", val: degC("outdoor"), more: true },
  { key: "updateTemps", icon: "thermometer", button: true },
];

const ICONS = {
  pump: "M12 2L9.5 6H14.5L12 2M12 22L14.5 18H9.5L12 22M2 12L6 14.5V9.5L2 12M22 12L18 9.5V14.5L22 12M12 8A4 4 0 0 0 8 12A4 4 0 0 0 12 16A4 4 0 0 0 16 12A4 4 0 0 0 12 8M12 10A2 2 0 0 1 14 12A2 2 0 0 1 12 14A2 2 0 0 1 10 12A2 2 0 0 1 12 10Z",
  auto: "M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13.57 17.4,15 16.4,16.1L17.84,17.54C19.18,16.09 20,14.15 20,12A8,8 0 0,0 12,4M12,18A6,6 0 0,1 6,12C6,10.43 6.6,9 7.6,7.9L6.16,6.46C4.82,7.91 4,9.85 4,12A8,8 0 0,0 12,20V23L16,19L12,15V18Z",
  close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  alert: "M13,14H11V9H13M13,18H11V16H13M1,21H23L12,2L1,21Z",
  snow: "M20.79,13.95L18.46,14.57L16.46,13.44V10.56L18.46,9.43L20.79,10.05L21.31,8.12L19.54,7.65L20,5.88L18.07,5.36L17.45,7.69L15.45,8.82L13,7.38V5.12L14.71,3.41L13.29,2L12,3.29L10.71,2L9.29,3.41L11,5.12V7.38L8.55,8.82L6.55,7.69L5.93,5.36L4,5.88L4.47,7.65L2.7,8.12L3.22,10.05L5.55,9.43L7.55,10.56V13.45L5.55,14.58L3.22,13.96L2.7,15.89L4.47,16.36L4,18.12L5.93,18.64L6.55,16.31L8.55,15.18L11,16.62V18.88L9.29,20.59L10.71,22L12,20.71L13.29,22L14.7,20.59L13,18.88V16.62L15.45,15.17L17.45,16.3L18.07,18.63L20,18.12L19.53,16.35L21.3,15.88L20.79,13.95M9.5,10.56L12,9.11L14.5,10.56V13.44L12,14.89L9.5,13.44V10.56Z",
  chevron: "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
  timer: "M12,20A7,7 0 0,1 5,13A7,7 0 0,1 12,6A7,7 0 0,1 19,13A7,7 0 0,1 12,20M19.03,7.39L20.45,5.97C20,5.46 19.55,5 19.04,4.56L17.62,6C16.07,4.74 14.12,4 12,4A9,9 0 0,0 3,13A9,9 0 0,0 12,22C17,22 21,17.97 21,13C21,10.88 20.26,8.93 19.03,7.39M11,14H13V8H11M15,1H9V3H15V1Z",
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

/** Numbers in the card's language (HA's number format): one decimal, « 25,9 » in French; no grouping, as before. */
const fmtN = (n, dec) => F.number(n, { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });
const fmt1 = (n) => (Number.isFinite(n) ? fmtN(n, 1) : "–");
const pad = (n) => String(n).padStart(2, "0");
/** A time of day in the card's language and HA's time format: « 19:04 », « 07:04 PM ». */
const fmtT = (d) => (d instanceof Date && !isNaN(d) ? F.time(d) : "–");
/** The controller's « HH:MM » (a block, the next change) the same way. */
const clock = (s) => { const m = hhmm(s); if (m === null) return s; const d = new Date(); d.setHours(Math.floor(m / 60), m % 60, 0, 0); return fmtT(d); };
/** « 17 nov. », « Nov 17 »; with the weekday, « lun. 17 nov. ». */
const dayMonth = (d) => F.date(d, { day: "numeric", month: "short" });
const wdDayMonth = (d) => F.date(d, { weekday: "short", day: "numeric", month: "short" });
/** « 17/11 », « 11/17 ». */
const ddmm = (d) => F.date(d, { day: "2-digit", month: "2-digit" });
const fmtD = (min) => {
  const m = Math.max(0, Math.round(min)), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${pad(r)}` : `${h} h`) : `${r} min`;
};
/** Minutes ago -> « à l'instant », « il y a 3 min », « il y a 2 h », « il y a 4 j ». */
const agoTxt = (m) => (!(m >= 1) ? T("common.ago.now") : m < 90 ? T("common.ago.min", { n: Math.round(m) })
  : m < 36 * 60 ? T("common.ago.h", { n: Math.round(m / 60) }) : T("common.ago.d", { n: Math.round(m / 1440) }));
/** A time in ms -> "HH:MM" today, else "DD/MM HH:MM". */
const stampMs = (t) => { const d = new Date(t); return dayKey(d) === dayKey(new Date()) ? fmtT(d) : `${ddmm(d)} ${fmtT(d)}`; };
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
const fmtL = (v) => (!Number.isFinite(v) ? "–" : v >= 10000 ? `${fmtN(v / 1000, 1)} m³`
  : `${F.number(Math.round(v), { maximumFractionDigits: 0 }).replace(/\s/g, "\u00a0")} L`);
/** Axis label: « 500 L », « 1,5 m³ ». */
const axL = (v) => (v >= 1000 ? `${F.number(v / 1000, { maximumFractionDigits: 2, useGrouping: false })} m³` : `${Math.round(v)} L`);
/** The device's "YYYY-MM-DD HH:MM:SS" -> "HH:MM" today, else "DD/MM HH:MM". */
const stamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m) return s || "—";
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return dayKey(new Date()) === `${m[1]}-${m[2]}-${m[3]}` ? fmtT(d) : `${ddmm(d)} ${fmtT(d)}`;
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const r2 = (v) => Math.round(v * 100) / 100; // the controller keeps its position to 0.01° (about 1 km)
const deg = (v) => (Number.isFinite(v) ? `${fmtN(v, 2)}°` : T("card.pos.unset"));
const isSet = (s) => s !== undefined && s !== "" && s !== "unknown" && s !== "unavailable";
/** Daily History "2026-11-13: 6.42 h 25.9/26.6 °C, 2026-11-12: 6.70 h" -> { "2026-11-13": {hours, lo, hi}, … }. */
const parseDays = (text) => Object.fromEntries([...String(text || "").matchAll(
  /(\d{4}-\d{2}-\d{2}): ([\d.]+) h(?: (-?[\d.]+)\/(-?[\d.]+) °C)?/g)]
  .map((m) => [m[1], { hours: +m[2], lo: m[3] === undefined ? NaN : +m[3], hi: m[4] === undefined ? NaN : +m[4] }]));
/** Daily Outdoor History ("2026-11-13: -1.4/9.8 °C, …") -> {"2026-11-13": {lo, hi}}. */
const parseOutdoor = (text) => Object.fromEntries([...String(text || "").matchAll(/(\d{4}-\d{2}-\d{2}): (-?[\d.]+)\/(-?[\d.]+) °C/g)]
  .map((m) => [m[1], { lo: +m[2], hi: +m[3] }]));

/** A closed day this far under its plan is « sous son plan »: less is the day boundary and the minute rounding. */
const SHORT_TOLERANCE_H = 0.25;
const dayShort = (r) => Number.isFinite(r.hours) && Number.isFinite(r.planned) && r.hours < r.planned - SHORT_TOLERANCE_H;
/** A row of « 7 derniers jours »'s tooltip: today's, a closed day's against its plan, or a day without data. */
const dayTitle = (r) => {
  if (r.today) return T("card.days.tip_today");
  if (!Number.isFinite(r.hours)) return T("card.days.tip_nodata");
  if (!Number.isFinite(r.planned)) return T("card.days.tip_noplan");
  const gap = r.hours - r.planned;
  return T("card.days.tip_plan", { planned: fmt1(r.planned), gap: Math.abs(gap) < 0.05 ? T("card.days.plan_kept") : `${gap > 0 ? "+" : "−"}${fmt1(Math.abs(gap))} h` });
};

const STYLE = `
:host {
  --acc:#0e86c4; --acc-soft:rgba(14,134,196,.14); --on-acc:#fff;
  --amber:#c98500; --amber-soft:rgba(227,154,6,.17);
  --cool:#2a72cf; --cool-soft:rgba(42,114,207,.13);
  --danger:#cc3a2f; --danger-soft:rgba(204,58,47,.12);
  --good:#2e9a4a;
  --out:#c2672a;
  --idle:#858c94; --idle-soft:rgba(133,140,148,.17);
  --raised:rgba(127,135,145,.12); --line:rgba(127,135,145,.28);
  --fg:var(--primary-text-color,#1b1e22); --muted:var(--secondary-text-color,#626a73);
  --card:var(--ha-card-background,var(--card-background-color,#fff));
  --shadow:0 1px 2px rgba(20,24,30,.08);
  --toast-bg:#1f2328; --toast-fg:#f3f4f6;
  display:block;
}
:host([variant=tile]) { height:100%; }
:host([variant=panel]) { container:pcard / inline-size; }
:host([dark]) {
  --acc:#3fb0ec; --acc-soft:rgba(63,176,236,.18); --on-acc:#06202e;
  --amber:#f0b03a; --amber-soft:rgba(240,176,58,.17);
  --cool:#5f9dee; --cool-soft:rgba(95,157,238,.17);
  --danger:#ff6b60; --danger-soft:rgba(255,107,96,.15);
  --good:#4cc26a;
  --out:#f0955a;
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
/* A fill running too long, not yet acknowledged (fill-meter.yaml): amber, and the dot keeps pulsing, its ring going out
   again and again, until someone acknowledges it or the fill ends. Reduced motion (the rule at the end): steady amber. */
.led.alarm, .clink.alarm { --c:var(--amber); }
.led.alarm { animation:fillpulse 1.6s ease-in-out infinite; }
.led.alarm::after { animation:ping 1.6s cubic-bezier(.15,.6,.3,1) infinite; }
@keyframes fillpulse { 30% { transform:scale(1.35); } 60% { transform:scale(1); } }
.led::after { content:""; position:absolute; inset:-1px; border-radius:50%; border:2px solid var(--c); opacity:0; pointer-events:none; }
.led.ping { animation:beat .45s ease-out; }
.led.ping::after { animation:ping 1.3s cubic-bezier(.15,.6,.3,1); }
@keyframes beat { 30% { transform:scale(1.4); } }
@keyframes ping { 0% { opacity:.6; transform:scale(1); } 100% { opacity:0; transform:scale(3.6); } }

/* panel */
.panel { display:flex; flex-direction:column; gap:18px; padding:4px 2px 8px; color:var(--fg); }
/* The day plan, then Pilotage, sit right after the header in the DOM (the wide layout's reading order); on a
   phone, CSS order puts readings and alerts back in front of them, and the .col wrapper is transparent. */
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
.reading .sub { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
.alert.amber .act button { background:var(--amber); }

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

/* Pilotage, right under the day plan: Auto / Manuel, the manual controls, then « Revenir en Auto » and a command's progress */
.pilot { display:flex; flex-direction:column; gap:14px; }
.power { display:flex; flex-direction:column; gap:10px; }
.power:not(:has(:not([hidden]))) { display:none; }
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
/* outdoor: a line on 24 h, its daily (weekly) min – max as a band behind the pool's bars */
.chart .out { stroke:var(--out); stroke-width:1.5; stroke-linejoin:round; stroke-linecap:round; }
.chart .out-band { fill:var(--out); opacity:.16; }
.chart .out-edge { stroke:var(--out); stroke-width:1; opacity:.7; stroke-linejoin:round; }
.chart .pt.out-pt { fill:var(--out); }
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
.ttip i.o { border-top-color:var(--out); }
.ttip .o-l { display:block; }
.tl-leg i.k-pool, .tl-leg i.k-pipe { width:14px; height:0; border-radius:0; border-top:2px solid var(--acc); vertical-align:3px; }
.tl-leg i.k-pipe { border-top:2px dashed var(--muted); }
.tl-leg i.k-band { background:var(--acc); opacity:.2; }
.tl-leg i.k-rng { width:6px; height:11px; background:var(--acc); border-radius:2px; }
.tl-leg i.k-out { width:14px; height:0; border-radius:0; border-top:2px solid var(--out); vertical-align:3px; }
.tl-leg i.k-out-band { width:14px; height:10px; background:color-mix(in srgb, var(--out) 22%, transparent); border-top:1px solid var(--out); border-bottom:1px solid var(--out); border-radius:0; }

/* tabs « Contrôle » (pump) / « Réglages » (settings) / « Réglages contrôleur » (controller), the controller page's own:
   « Contrôle » is everything the panel shows but the two panes; each of those hides the rest */
.tabs { order:-2; display:flex; gap:4px; border-bottom:1px solid var(--line); margin:-8px 0 -6px; }
.tabs button { position:relative; border:0; background:none; padding:10px 10px; font-size:14px; font-weight:500; color:var(--muted); cursor:pointer; white-space:nowrap; }
.tabs button[aria-selected="true"] { color:var(--acc); }
.tabs button[aria-selected="true"]::after { content:""; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; border-radius:2px 2px 0 0; background:var(--acc); }
.panel[data-tab="settings"] > :not(.sh-head):not(.tabs):not(.setpane):not(.toast) { display:none !important; }
.panel[data-tab="controller"] > :not(.sh-head):not(.tabs):not(.ctlpane):not(.toast) { display:none !important; }
.panel:not([data-tab="settings"]) > .setpane, .panel:not([data-tab="controller"]) > .ctlpane { display:none; }
.water { display:flex; flex-direction:column; gap:6px; }
/* « Contrôle »: the fill water after the readings, a rule above it; its chart's « Eau de remplissage » is its label */
.panel > .water { border-top:1px solid var(--line); padding-top:16px; }
.water .readings { margin-bottom:12px; grid-template-columns:repeat(3,minmax(0,1fr)); }
/* three narrow tiles on a phone: a label that wraps (« Rempli aujourd'hui ») must not push its value below the others'.
   The tiles share the row's height; labels stay on top (two lines at most), values sit on the bottom line. */
.water .reading { justify-content:space-between; }
.water .run { font-size:13px; color:var(--muted); margin:-6px 2px 6px; }
.water .run.warn { color:var(--amber); font-weight:500; }
.water .reading .l { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
ha-card.water-card { display:block; color:var(--fg); padding:16px; container-type:inline-size; }
ha-card.water-card.plain { background:var(--card); border:1px solid var(--ha-card-border-color,var(--line)); border-radius:var(--ha-card-border-radius,12px); }
.reading.live .v { color:var(--acc); }
.chart .bar { fill:var(--acc); }
.chart .bar.cur { opacity:.55; } .chart .bar.hov { opacity:.8; } .chart .bar.cur.hov { opacity:.45; }
.chart .base { stroke:var(--muted); stroke-width:1; opacity:.5; }
.tl-leg i.k-bar { width:8px; height:11px; background:var(--acc); border-radius:2px 2px 0 0; }
.tl-leg i.k-cur { width:8px; height:11px; background:var(--acc); opacity:.55; border-radius:2px 2px 0 0; }

/* tab « Réglages », read in this order: Plan du jour › Sondes › Filtration et hors gel › 7 derniers jours; tab
   « Réglages contrôleur »: Position › Firmware › Redémarrer. One column on a phone; two when wide (@container pcard below), the
   settings cut after « Appliquer »: their second part (.cont) continues the first on a phone, without a heading.
   Each column is a container, so its rows wrap at its own width. */
.setpane, .ctlpane { display:flex; flex-direction:column; gap:22px; container-type:inline-size; }
.sp-col { display:flex; flex-direction:column; gap:22px; min-width:0; container-type:inline-size; }
.sp-h { display:flex; align-items:center; gap:10px; margin:0 0 2px; font-size:15px; font-weight:500; }
.setpane .cont { margin-top:-22px; }
.setpane .cont > .sp-h { display:none; }
.setpane .cont .esect:first-child { margin-top:12px; }
.sp-h .wide { display:none; } /* « Filtration » in the wide panel, where « … et hors gel » has its own column */
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
.day.short .bar i { background:var(--amber); }
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
.erow .ic { width:40px; height:40px; flex:none; display:grid; place-items:center; color:var(--muted); } /* not the theme's --state-icon-color: neutral, as on the device page */
.erow .ic svg, .erow .ic ha-icon { width:24px; height:24px; --mdc-icon-size:24px; }
.erow .name { flex:1; min-width:0; overflow-wrap:anywhere; }
.erow .name span { display:block; }
.erow .name small { display:block; font-size:12px; line-height:1.35; color:var(--muted); margin-top:1px; }
.erow .name small.fw-up { color:var(--acc); }
.erow .name small.fw-ok { color:var(--good); }
.erow .name small a { color:var(--acc); font-weight:500; text-decoration:none; }
.erow .ctl { display:flex; align-items:center; gap:10px; flex:0 1 260px; min-width:150px; }
.erow .ctl input { flex:1; min-width:0; accent-color:var(--acc); margin:0; }
.erow .ctl .v { min-width:64px; text-align:right; white-space:nowrap; }
.erow.dirty .ctl .v { color:var(--amber); font-weight:500; }
.btn { height:36px; padding:0 16px; border-radius:18px; border:0; cursor:pointer; font-weight:500; font-size:14px; white-space:nowrap;
  background:var(--acc); color:var(--on-acc); flex:none; }
.btn:disabled { background:var(--raised); color:var(--muted); cursor:not-allowed; }
.btn.busy { opacity:.6; pointer-events:none; }
/* « Réglages contrôleur » › Firmware on the update entity, and › Position */
.btn.tonal { background:transparent; color:var(--acc); border:1px solid var(--line); padding:0 14px; }
.btn.tonal:disabled { background:transparent; color:var(--muted); opacity:.6; }
.erow .btns { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.erow:has(> .btns) .name { min-width:6.5em; } /* two buttons go under the name rather than break « Mise à jour » */
.erow .val.acc { color:var(--acc); font-weight:500; }
.erow.more { cursor:pointer; border-radius:12px; margin:0 -8px; padding:4px 8px; }
.erow.more:hover, .erow.more:focus-visible { background:var(--raised); outline:none; }
.erow .chev { display:grid; flex:none; margin-left:-4px; color:var(--muted); }
.erow .chev svg { width:18px; height:18px; }
.erow .name small.bad { color:var(--danger); }
.mono { font-family:var(--code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace); font-size:11px; }
.tgl { appearance:none; -webkit-appearance:none; width:40px; height:24px; border-radius:12px; background:var(--line); position:relative;
  flex:none; cursor:pointer; transition:background .15s; margin:0 0 0 auto; }
.tgl::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff;
  transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.tgl:checked { background:var(--acc); }
.tgl:checked::after { transform:translateX(16px); }
.tgl:disabled, .esel:disabled { opacity:.5; cursor:not-allowed; }
.esel { height:36px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--acc); font:inherit;
  font-size:14px; font-weight:500; padding:0 8px; margin-left:auto; flex:none; }
.prog { height:6px; border-radius:3px; background:var(--line); overflow:hidden; margin:-2px 0 8px 54px; }
.prog i { display:block; height:100%; background:var(--acc); border-radius:3px; transition:width .2s; }
.prog.ind i { width:35% !important; animation:indet 1.1s ease-in-out infinite; }
@keyframes indet { 0% { transform:translateX(-100%); } 100% { transform:translateX(290%); } }
.banner .acts { flex:1 1 100%; display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
.banner .btn.tonal { color:inherit; }
.posnote { font-size:12px; color:var(--muted); margin:6px 0 0; }
@container (max-width: 520px) {
  .erow { flex-wrap:wrap; }
  .erow .ctl { flex:1 1 100%; margin-left:54px; min-width:0; }
}

/* Wide panel (Bubble popup_mode: adaptive-dialog on a screen, width_desktop 760px): everything across the full
   width, in reading order: day plan, Pilotage (the manual controls side by side), pool temperature (24 h on
   ~700 px), then the readings in one row of four and the alerts. Phones never reach 680 px. */
@container (min-width: 680px) {
  .panel { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 28px; align-items:start; padding:6px 6px 4px; }
  .sh-head, .tabs, .water, .setpane, .ctlpane, .foot, .plan, .pilot, .temp, .col-state { grid-column:1 / -1; }
  .setpane, .ctlpane { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 28px; align-items:start; }
  .sp-col + .sp-col { align-self:stretch; border-left:1px solid var(--line); padding-left:14px; margin-left:-14px; }
  .water .chart { height:170px; }
  .pilot, .temp { padding-bottom:20px; border-bottom:1px solid var(--line); }
  .manual { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 20px; }
  .col-state .readings { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .temp .chart { height:150px; }
  .plan .tl { height:34px; }
  .col { display:flex; flex-direction:column; gap:16px; min-width:0; }
}
/* Wide « Réglages »: the settings' second part opens the right column, under its own heading, and the first is
   « Filtration » alone. Named: these sit in columns that are containers themselves. */
@container pcard (min-width: 680px) {
  .setpane .cont { margin-top:0; }
  .setpane .cont > .sp-h { display:flex; }
  .setpane .cont .esect:first-child { margin-top:4px; }
  .sp-h .narrow { display:none; }
  .sp-h .wide { display:inline; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; } }
`;

/**
 * The card's HTML, in the language `t` speaks (the card rebuilds when it changes). The fill water: in the panel's
 * « Contrôle », after the readings, and alone as `variant: water`.
 */
const waterPane = (t) => `
    <div class="readings">
      <div class="reading"><span class="l">${t("card.water.today")}</span><span class="v num" id="wToday"></span></div>
      <div class="reading"><span class="l">${t("card.water.month")}</span><span class="v num" id="wMonth"></span></div>
      <div class="reading" id="wFlowBox"><span class="l">${t("card.water.flow")}</span><span class="v num" id="wFlow"></span></div>
    </div>
    <p class="run num" id="wRun" hidden></p>
    <div class="temp-h">
      <p class="lbl">${t("card.water.title")}</p>
      <div class="seg mini" role="radiogroup" aria-label="${t("card.chart_range")}" id="wRange">
        ${W_RANGES.map((r) => `<button role="radio" data-r="${r}">${t(`card.range.${r}`)}</button>`).join("")}
      </div>
    </div>
    <p class="temp-sum num" id="wSum"></p>
    <div class="chart" id="wChart" tabindex="0" role="img" aria-label="${t("card.water.title")}"><svg id="wSvg" aria-hidden="true"></svg><div class="ttip" id="wTip" hidden></div><div class="empty" id="wEmpty" hidden></div></div>
    <div class="tl-leg" id="wLeg"></div>`;

const panelHtml = (t) => `
<div class="panel">
  <div class="sh-head">
    <span class="ico big" id="ico">${svg("pump")}</span>
    <div class="t"><h3>${t("card.title")}</h3>
      <div class="st-row"><span class="status" id="status"></span><button class="clink" id="ctlLink" hidden><span class="led" id="ctlLed"></span><span id="ctlTxt"></span></button></div></div>
    <button class="x" id="close" aria-label="${t("card.close")}">${svg("close")}</button>
  </div>
  <div class="tabs" role="tablist" id="tabs" hidden>
    <button role="tab" data-tab="pump" aria-selected="true">${t("card.tab.pump")}</button>
    <button role="tab" data-tab="settings" aria-selected="false">${t("card.tab.settings")}</button>
    <button role="tab" data-tab="controller" aria-selected="false">${t("card.tab.controller")}</button>
  </div>
  <div class="setpane" role="tabpanel">
    <div class="sp-col">
      <section><h4 class="sp-h">${t("card.sec.plan")}</h4><div id="planRows"></div></section>
      <section><h4 class="sp-h">${t("card.sec.probes")}</h4><div id="probeRows"></div></section>
      <section><h4 class="sp-h"><span><span class="narrow">${t("card.sec.filtration_freeze")}</span><span class="wide">${t("card.sec.filtration")}</span></span><span class="chip" id="pendChip" hidden>${t("common.pending")}</span></h4>
        <div class="banner" id="pendBanner" hidden>${svg("alert")}<span>${t("card.pend_banner")}</span><button class="btn" id="applyNow">${t("common.apply")}</button></div>
        <div id="rows"></div></section>
    </div>
    <div class="sp-col">
      <section class="cont"><h4 class="sp-h">${t("card.sec.pulses_freeze")}</h4><div id="rows2"></div></section>
      <section><h4 class="sp-h">${t("card.sec.days")}</h4><div class="days" id="days"></div></section>
    </div>
  </div>
  <div class="ctlpane" role="tabpanel">
    <div class="sp-col">
      <section id="posSec" hidden><h4 class="sp-h">${t("card.sec.position")}</h4><div id="posRows"></div>
        <p class="posnote">${t("card.pos.note")}</p></section>
    </div>
    <div class="sp-col">
      <section id="fwSec" hidden><h4 class="sp-h">${t("card.sec.firmware")}</h4><div id="updRows"></div></section>
      <section id="restartSec" hidden><h4 class="sp-h">${t("card.sec.restart")}</h4>
        <div class="erow"><span class="ic" id="restartIc"></span><span class="name"><span>${t("card.restart.row")}</span><small>${t("card.restart.sub")}</small></span>
          <button class="btn" id="restartBtn">${t("card.restart.button")}</button></div>
        <div class="confirm" id="restartCf" role="alertdialog" aria-label="${t("card.restart.aria")}" hidden>
          <span>${t("card.restart.confirm")}</span>
          <button class="no" id="restartNo">${t("common.cancel")}</button>
          <button class="yes" id="restartYes">${t("card.restart.yes")}</button>
        </div></section>
    </div>
  </div>
  <div class="plan">
    <div class="plan-h"><p class="lbl">${t("card.sec.plan")}</p><span class="num" id="planSum"></span></div>
    <div class="tl" id="tl"></div>
    <div class="tl-scale num"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
    <div class="tl-leg"><span><i style="background:var(--acc-soft)"></i>${t("common.speed.Low")}</span><span><i style="background:var(--acc);opacity:.45"></i>${t("card.leg.pulse", { speed: t("common.speed.Medium") })}</span><span><i style="background:var(--acc);opacity:.8"></i>${t("common.speed.High")}</span><span id="legOvr" class="leg-ovr"></span></div>
  </div>
  <div class="pilot">
  <div class="ctl">
    <p class="lbl">${t("card.ctl.title")}</p>
    <div class="seg" role="radiogroup" aria-label="${t("card.ctl.aria")}" id="modeSeg" style="--n:2">
      <button role="radio" data-mode="auto">${t("common.mode.auto")}</button>
      <button role="radio" data-mode="manual">${t("common.mode.manual")}</button>
    </div>
    <p class="hint" id="modeHint"></p>
  </div>
  <div class="manual" id="manualBlock" hidden>
    <div>
      <p class="lbl">${t("card.speed.title")}</p>
      <div class="seg" role="radiogroup" aria-label="${t("card.speed.title")}" id="speedSeg" style="--n:4">
        ${Object.keys(SPEEDS).map((v) => `<button role="radio"${v === "Off" ? ' class="stop"' : ""} data-speed="${v}">${t(`common.speed.${v}`)}</button>`).join("")}
      </div>
    </div>
    <div>
      <p class="lbl">${t("card.dur.title")}</p>
      <div class="seg" role="radiogroup" aria-label="${t("card.dur.aria")}" id="durSeg" style="--n:4">
        ${DURATIONS.map((m) => `<button role="radio" data-dur="${m}">${m ? fmtD(m) : t("common.never")}${m ? "" : `<small>${t("card.dur.alert", { min: STUCK_MIN })}</small>`}</button>`).join("")}
      </div>
      <p class="hint" id="durHint"></p>
    </div>
  </div>
  <div class="power">
    <button class="pbtn" id="autoBtn" hidden>${svg("auto")}<span id="autoBtnTxt">${t("card.back_auto")}</span></button>
    <div class="confirm" id="confirm" hidden>
      <span id="confirmTxt"></span>
      <button class="no" id="cfNo">${t("common.cancel")}</button>
      <button class="yes" id="cfYes">${t("card.confirm.stop")}</button>
    </div>
    <div class="pend" id="pend" hidden aria-live="polite">
      <div class="row"><b id="pendLabel"></b><span class="num" id="pendTime"></span></div>
      <div class="steps">
        <div class="step" id="st0"><i></i>${t("card.step.sent")}</div>
        <div class="step" id="st1"><i></i>${t("card.step.applied")}</div>
      </div>
    </div>
  </div>
  </div>
  <div class="temp">
    <div class="temp-h">
      <p class="lbl">${t("card.temp.title")}</p>
      <div class="seg mini" role="radiogroup" aria-label="${t("card.chart_range")}" id="tRange">
        ${T_RANGES.map((r) => `<button role="radio" data-r="${r}">${t(`card.range.${r}`)}</button>`).join("")}
      </div>
    </div>
    <p class="temp-sum num" id="tSum"></p>
    <div class="chart" id="tChart" tabindex="0" role="img" aria-label="${t("card.temp.title")}"><svg id="tSvg" aria-hidden="true"></svg><div class="ttip" id="tTip" hidden></div><div class="empty" id="tEmpty" hidden></div></div>
    <div class="tl-leg" id="tLeg"></div>
  </div>
  <div class="col col-state">
  <div class="readings">
    <div class="reading"><span class="l">${t("card.read.pool")}</span><span class="v num" id="water"></span></div>
    <div class="reading"><span class="l">${t("card.read.outdoor")}</span><span class="v num" id="outdoor"></span><span class="sub num" id="padTxt" hidden></span></div>
    <div class="reading"><span class="l">${t("card.read.hours")}</span><span class="v num" id="hours"></span><span class="bar"><i id="hoursBar"></i></span></div>
    <div class="reading"><span class="l">${t("card.read.next")}</span><span class="v num" id="next"></span></div>
  </div>
  <div class="alert" id="offAlert" hidden>${svg("alert")}<span id="offTxt"></span></div>
  <div class="alert cool" id="freezeAlert" hidden>${svg("snow")}<span id="freezeTxt"></span></div>
  <div class="alert amber" id="planAlert" hidden>${svg("alert")}<span>${t("card.alert.plan")}</span></div>
  <div class="alert" id="stuckAlert" hidden>${svg("alert")}<span id="stuckTxt"></span><div class="act"><button id="stuckBtn">${t("card.back_auto")}</button></div></div>
  <div class="alert amber" id="fillAlert" hidden>${svg("alert")}<span id="fillTxt"></span><div class="act" id="fillAct"><button id="fillAckBtn">${t("card.fill.ack")}</button></div></div>
  </div>
  <div class="water" id="waterBlk" hidden>${waterPane(t)}</div>
  <div class="foot"><span class="num" id="sync"></span><span class="num" id="plannedTxt"></span></div>
  <div class="toast" id="toast" role="status"></div>
</div>`;

const settingsHtml = (t) => `
<ha-card class="set-card" id="setCard">
  <h2 class="set-h"><span class="hic" id="setIcon"></span><span id="setTitle"></span><span class="chip" id="pendChip" hidden>${t("common.pending")}</span></h2>
  <div class="set">
    <div class="banner" id="pendBanner" hidden>${svg("alert")}<span>${t("card.pend_banner")}</span><button class="btn" id="applyNow">${t("common.apply")}</button></div>
    <div id="rows"></div>
  </div>
  <div class="toast" id="toast" role="status"></div>
</ha-card>`;

const waterHtml = (t) => `
<ha-card class="water-card" id="waterCard"><div class="water">${waterPane(t)}</div><div class="toast" id="toast" role="status"></div></ha-card>`;

const tileHtml = (t) => `
<ha-card class="tile" id="tile" role="button" tabindex="0" aria-haspopup="dialog">
  <span class="ico" id="ico">${svg("pump")}</span>
  <span class="txt"><span class="p">${t("card.title")}</span><span class="s" id="sec"></span></span>
  <span class="val num" id="val"></span>
  <span class="led" id="led" role="img" hidden></span>
  <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS.chevron}"/></svg>
</ha-card>`;

class PiscineCard extends HTMLElement {
  setConfig(config) {
    const variant = config.variant || "tile";
    if (!["tile", "panel", "settings", "water"].includes(variant)) throw new Error("variant must be tile, panel, settings or water");
    let language = config.language ?? null;
    if (language !== null && !LANGS.includes(language)) {
      console.warn(`piscine-card: language "${language}" ignored (${LANGS.join(", ")}); the Home Assistant user's language applies`);
      language = null;
    }
    this._config = { variant, layout: config.layout || "horizontal", popup_hash: config.popup_hash || "#piscine", more_path: config.more_path || null,
      recorder: config.recorder !== false, title: config.title, icons: config.icons || null, // title: card.tab.settings when not set
      settings_tab: config.settings_tab !== false, // `temperatures` (before 1.8.0): accepted, ignored
      controller_light: config.controller_light !== false, health: { ...HEALTH, ...(config.controller_health || {}) }, language };
    this._localeKey = null;
    this._setLocale(this._hass);
    this._mapped = config.entities || {};
    this._e = { ...DEFAULT_ENTITIES, ...this._mapped };
    this.setAttribute("variant", variant);
    this._built = false;
    this._confirm = false;
    this._manual = false;      // « Manuel » tapped while still on Auto: show the speed block
    this._local = null;        // command started from this card: {value, label, t0, echoed}
    this._hist = null;         // Manual Override states of the last 24 h [{s, t (ms)}], recorder + live changes
    this._wHist = null;        // the same for the water sensor and the commanded speed (24 h curve)
    this._cHist = null;
    this._oHist = null;        // and the outdoor sensor (its line on 24 h; today's min – max before Outdoor Min/Max Today)
    this._histDay = null; this._histAt = 0; this._histLoading = false;
    this._range = this._config.recorder ? "24h" : "7d";
    this._tHover = null;       // 24 h: minutes before now; 7 j / 30 j: day index
    this._stats = null;        // 30 / 90 j: { "YYYY-MM-DD": {lo, hi} }, the 23:00 rows of the hourly statistics
    this._daily = null;        // 30 j – 1 an: { "YYYY-MM-DD": {mean (the probe), lo, hi (HA's day of Min/Max Today)} }
    this._oDaily = null;       // 7 j – 1 an: { "YYYY-MM-DD": {lo, hi} }, the outdoor sensor's own daily statistics
    // « Réglages contrôleur » › Firmware on the update entity: the « Installer » question open, a check under way
    // (until, since: ms), an install seen running (so an unavailable entity next reads as its reboot), what is drawn
    this._upd = { ask: false, checkUntil: 0, checkFrom: 0, wasBusy: false, drawn: "" };
    this._posDrawn = "";
    this._beatSeen = null; this._beatAt = -1e9; // the light's last heartbeat: the message it was for, when (performance.now)
    this._statsAt = 0; this._statsLoading = false; this._statsErr = false;
    this._tVer = 0; this._tDrawn = "";
    this._tab = "pump"; // panel: « Contrôle » (pump), « Réglages » (settings), « Réglages contrôleur » (controller)
    this._wRange = "30d"; this._wHover = null;
    this._wStats = {};         // range -> {start (ms), rows [{t, change, state}]}, from the statistics
    this._wAt = {}; this._wDay = {}; this._wLoading = {}; this._wErr = {};
    this._wVer = 0; this._wDrawn = "";
    this._setRows = [];        // settings: [{def, row, input, out, editing (ms)}]
    this._paneRows = [];       // panel, « Réglages »: Plan du jour, Sondes [{def, row, val, sub, btn, icon}]
    this._daysDrawn = "";
  }

  set hass(hass) {
    this._hass = hass;
    this._resolveIds(hass);
    if (this._setLocale(hass) && this._built) this._rebuild(); // the user changed their language: the card follows
    this._use();
    if (!this._built) this._build();
    this.toggleAttribute("dark", !!(hass.themes && hass.themes.darkMode));
    this._update();
  }
  /** Each default id (not one `entities:` maps) that Home Assistant lacks, under the controller's other prefix if it has that. */
  _resolveIds(hass) {
    for (const [k, id] of Object.entries(DEFAULT_ENTITIES)) {
      if (k in this._mapped || NOT_CONTROLLER.has(k)) continue;
      const alt = !hass.states[id] && otherId(id);
      this._e[k] = alt && hass.states[alt] ? alt : id;
    }
  }
  connectedCallback() {
    this._timer = setInterval(() => this._hass && this._update(), 1000);
    if (this._ro && this._built) for (const el of [this._$("tChart"), this._$("wChart")]) if (el) this._ro.observe(el);
  }
  disconnectedCallback() { clearInterval(this._timer); clearTimeout(this._toastTimer); clearTimeout(this._rsTimer); this._ro?.disconnect(); }

  /**
   * The card's language and formats, from the HA user's profile (or `language:`): this._t(key, vars) and
   * this._fmt. True when they changed.
   */
  _setLocale(hass) {
    const L = localeFromHass(hass, this._config.language);
    const key = `${L.lang}|${L.locale}|${L.numberLocale}|${L.hour12}`;
    if (key === this._localeKey) return false;
    this._localeKey = key;
    this._t = makeT(DICTS, L.lang);
    this._fmt = makeFmt(L.locale, L);
    return true;
  }
  /** This card's language for the helpers outside the class (T, F), before it draws. */
  _use() { T = this._t; F = this._fmt; }
  /** Draws everything again, in a new language: the HTML and every cache of what was drawn. */
  _rebuild() {
    Object.assign(this, { _built: false, _setRows: [], _paneRows: [], _sects: [], _posDrawn: "", _tDrawn: "", _wDrawn: "", _daysDrawn: "" });
    this._upd.drawn = "";
  }

  getCardSize() {
    if (this._config.variant === "water" && this._hass && this._fillOff()) return 0;
    return { panel: 15, settings: 9, water: 6 }[this._config.variant] || 1;
  }
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
    const { override, water, commanded, outdoor } = this._e;
    const ids = this._config.recorder ? [override, water, commanded, outdoor] : [override];
    const rows = (r, id) => ((r && r[id]) || []).map((x) => ({ s: x.s, t: (x.lc ?? x.lu) * 1000 })).filter((x) => Number.isFinite(x.t));
    this._hass.callWS({ type: "history/history_during_period", start_time: new Date(Date.now() - 24 * H_MS).toISOString(), entity_ids: ids,
      minimal_response: true, no_attributes: true, significant_changes_only: false })
      .then((r) => {
        this._hist = rows(r, override);
        if (this._config.recorder) { this._wHist = rows(r, water); this._cHist = rows(r, commanded); this._oHist = rows(r, outdoor); }
      })
      .catch((err) => { console.warn("piscine-card: history unavailable", err); if (this._config.recorder) { this._wHist = []; this._cHist = []; this._oHist = []; } })
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
    track(this._oHist, "outdoor");
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
   *                     week may hold the Sunday before it, at most a day of lag on a 7-day bar;
   *                     and the outdoor sensor's own day min/max: in the air, every reading is the outdoors, so HA's
   *                     day is exact (no 23:00 trick) and goes back as far as the sensor (7 j uses it too).
   */
  _loadStats() {
    if (!this._config.recorder || this._statsLoading || Date.now() - this._statsAt < H_MS) return;
    this._statsLoading = true;
    const { waterMin, waterMax, water, outdoor } = this._e;
    const ws = (o) => this._hass.callWS({ type: "recorder/statistics_during_period", ...o });
    const at = (row) => new Date(typeof row.start === "number" ? row.start : Date.parse(row.start));
    Promise.all([
      ws({ start_time: dayAgo(90).toISOString(), statistic_ids: [waterMin, waterMax], period: "hour", types: ["min", "max"] }),
      ws({ start_time: this._weekStart().toISOString(), statistic_ids: [waterMin, waterMax, water, outdoor], period: "day", types: ["min", "max", "mean"] }),
    ])
      .then(([hr, dy]) => {
        const stats = {}, daily = {}, oDaily = {};
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
        for (const row of (dy && dy[outdoor]) || [])
          if (Number.isFinite(row.min) && Number.isFinite(row.max) && row.min >= OUT_SANE[0] && row.max <= OUT_SANE[1])
            oDaily[dayKey(at(row))] = { lo: row.min, hi: row.max };
        this._stats = stats; this._daily = daily; this._oDaily = oDaily; this._statsErr = false;
      })
      .catch((err) => { console.warn("piscine-card: temperature statistics unavailable", err); this._stats = {}; this._daily = {}; this._oDaily = {}; this._statsErr = true; })
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
      this._toast(this._t("common.ha_refused"), true);
      this._update();
    });
  }
  /** Home Assistant's own more-info dialog for one of the card's entities (its history, an update's release notes). */
  _moreInfo(key) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: this._e[key] } }));
    return true;
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
   * their own); lost = beyond; alarm = a fill running too long, not acknowledged (unless lost). Without the Device Clock nothing changes every minute (a still night can leave every
   * value as it was), so quiet means nothing there and only the link counts.
   */
  _light() {
    const H = this._config.health, now = Date.now(), seen = this._lastSeen(), quiet = seen ? (now - seen) / M_MS : Infinity;
    const o = this._st("online"), off = this._online() ? null : o ? (now - Date.parse(o.last_changed)) / M_MS : Infinity;
    const beats = !!this._st("clock");
    const health = off !== null ? (off >= H.alert ? "lost" : "late") : beats && quiet >= H.alert ? "lost" : beats && quiet >= H.warn ? "late" : "live";
    const fill = this._fillAlarm(), h = health !== "lost" && fill && !fill.acked ? "alarm" : health;
    return { h, seen, quiet, off, fill };
  }
  /** The firmware's version (Firmware Version) and ESPHome's (its entity, else Home Assistant's device registry). */
  _fw() {
    const reg = this._hass.entities && this._hass.entities[this._e.online];
    const dev = reg && this._hass.devices && this._hass.devices[reg.device_id];
    return { version: PiscineCard.parseVersion(this._s("fwVersion")),
      esphome: PiscineCard.parseEsphome(this._s("esphomeVersion")) || PiscineCard.parseEsphome(dev && dev.sw_version) };
  }
  /**
   * Firmware Version, « v1.4.0 » (a release) or « v1.3.0-4-g1a2b3c4-dirty » (git describe, as make compiles it) ->
   * {label, sub, dirty}. Also used by the device's page.
   */
  static parseVersion(text) {
    const t = String(text || "").trim();
    if (!t || t === "unknown" || t === "unavailable") return null;
    const m = /^(?:(v\d[\w.]*?)(?:-(\d+)-g([0-9a-f]{7,40}))?|([0-9a-f]{7,40}))(-dirty)?$/.exec(t);
    if (!m) return { label: t, sub: T("card.fw.not_make"), dirty: false };
    const [, tag, n, hash, bare, dirty] = m, local = dirty ? ` · ${T("card.fw.local_changes")}` : "";
    if (bare) return { label: bare.slice(0, 7), sub: `Commit ${bare.slice(0, 7)}${local}`, dirty: !!dirty };
    return { label: n ? `${tag} +${n}` : tag, sub: (hash ? T("card.fw.commits_after", { hash: hash.slice(0, 7), count: +n, tag }) : T("card.fw.released")) + local, dirty: !!dirty };
  }
  /**
   * ESPHome's version and build time -> {version, built}, from ESPHome Version (« 2026.7.2 (config hash 0x528082c4,
   * built 2026-11-17 18:11:55 +0000) » since 2026.7, « 2026.7.2 2026-11-17 18:05:00 +0000 » before) or from Home
   * Assistant's device registry (« 2026.7.2 (2026-11-14 11:25:41 +0000) »).
   */
  static parseEsphome(text) {
    const m = /^(\S+)(?:\s+\(?(.+?)\)?)?$/.exec(String(text || "").trim());
    if (!m || m[1] === "unknown" || m[1] === "unavailable") return null;
    const when = m[2] && (/\bbuilt\s+(.+)$/.exec(m[2])?.[1] ?? m[2]); // after « config hash …, built »
    const t = when ? new Date(Date.parse(when.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/ ?([+-]\d{2}):?(\d{2})$/, "$1:$2"))) : null;
    const built = t && !isNaN(t) ? T("card.fw.built_at", { date: F.date(t, { day: "2-digit", month: "2-digit", year: "numeric" }), time: fmtT(t) })
      : when ? T("card.fw.built_raw", { when }) : "";
    return { version: m[1], built };
  }
  /**
   * Update Status, the firmware's updates and their gate (WP6), as codes (docs/plans/i18n.md, « Firmware code
   * contract »): unchecked, checking, up_to_date, available, installing, pending:override, pending:fill, error:check,
   * error:install. An older firmware's French states go through LEGACY_STATUS; other forms (« deferred: manual
   * override », « failed: … ») through the patterns below. -> {kind, why}: kind is deferred, failed, installing,
   * checking or "" (nothing to add to the update entity); why, in the card's words. Also for the device's page.
   */
  static parseUpdateStatus(text) {
    let t = String(text || "").trim();
    if (!isSet(t) || t === "--") return { kind: "", why: "" };
    t = LEGACY_STATUS[t] || t;
    const [code, arg = ""] = t.split(":");
    const KINDS = { checking: "checking", installing: "installing", pending: "deferred", error: "failed" };
    if (/^[a-z_]+(:[a-z_]+)?$/.test(t) && (KINDS[code] !== undefined || ["unchecked", "up_to_date", "available"].includes(code))) {
      const kind = KINDS[code] || "", why = { override: "override", fill: "fill", check: "check", install: "install" }[arg];
      return { kind, why: kind && why ? T(`card.fw.why.${why}`) : "" };
    }
    const m = /^([^:(]+?)\s*(?:[:(]\s*(.*?)\)?)?$/.exec(t) || [t, t], head = m[1], rest = m[2] || "";
    const kind = /^(deferred|held|waiting|pending)/i.test(head) ? "deferred"
      : /^(failed|error)/i.test(head) ? "failed"
      : /^(installing|downloading|writing)/i.test(head) ? "installing"
      : /^checking/i.test(head) ? "checking" : "";
    const why = /override|manual/i.test(rest) ? T("card.fw.why.override") : /fill/i.test(rest) ? T("card.fw.why.fill")
      : kind === "failed" && /check/i.test(rest) ? T("card.fw.why.check")
      : kind === "failed" && /install/i.test(rest) ? T("card.fw.why.install") : rest;
    return { kind, why: kind ? why : "" };
  }
  /** IANA zone (« Europe/Paris ») -> its POSIX TZ string (TZ_POSIX), or null for a name tzdata doesn't have. */
  static posixTz(iana) {
    if (!TZ_BY_NAME) {
      TZ_BY_NAME = new Map();
      for (const [posix, names] of Object.entries(TZ_POSIX)) for (const n of names.split(" ")) TZ_BY_NAME.set(n, posix);
    }
    return TZ_BY_NAME.get(String(iana || "")) || null;
  }
  /** Why the firmware would hold an install now (its gate): a manual override, or a fill. Null when nothing would. */
  _hold() {
    if (this._inOvr()) {
      const until = this._ovrUntil();
      const speed = speedTxt(this._override());
      return { long: until ? this._t("card.fw.hold_until", { speed, time: fmtT(until) }) : this._t("card.fw.hold_noend", { speed }), ovr: true };
    }
    const run = this._st("fillRunning"); // as the firmware's gate; before it (1.9.0), a non-zero flow
    return (run ? run.state === "on" : this._n("flow") > 0) ? { long: this._t("card.fw.why.fill"), ovr: false } : null;
  }
  /** The update entity as « Réglages contrôleur » › Firmware shows it; null without one (a firmware before WP6). */
  _updModel() {
    const u = this._st("firmware");
    if (!u) return null;
    const a = u.attributes || {}, off = !isSet(u.state), status = PiscineCard.parseUpdateStatus(this._s("updateStatus"));
    const busy = !off && (!!a.in_progress || status.kind === "installing"), fw = this._fw();
    const pct = !busy ? null : Number.isFinite(a.update_percentage) ? a.update_percentage : typeof a.in_progress === "number" ? a.in_progress : null;
    return { off, busy, pct: pct === null ? null : Math.round(pct), rebooting: off && this._upd.wasBusy,
      installed: (!off && a.installed_version) || fw.version?.label || "—", esphome: fw.esphome,
      latest: off ? null : a.latest_version || null, avail: u.state === "on", notes: a.release_url || null,
      status, checking: Date.now() < this._upd.checkUntil || status.kind === "checking",
      hold: this._hold(), ask: this._upd.ask, online: this._online(), canCheck: !!this._st("checkUpdate"), canCancel: !!this._st("cancelUpdate"),
      auto: this._st("autoUpdate"), interval: this._st("updateInterval"), updated: Date.parse(u.last_updated) || 0,
      statusAt: Date.parse(this._st("updateStatus")?.last_updated) || 0 };
  }
  /** « Réglages contrôleur » › Firmware on the update entity, as HTML (mock-up 2026-11-18): one string per state, drawn when it changes. */
  _updHtml(m) {
    // `more`: the row opens Home Assistant's own dialog for the update entity (release notes, « Ignorer »)
    const t = this._t;
    const row = (icon, label, sub, right, cls = "", more = false) => `<div class="erow${more ? ` more" data-act="more" role="button" tabindex="0" title="${t("common.open_in_ha")}` : ""}">`
      + `<span class="ic">${this._icon(icon)}</span><span class="name"><span>${label}</span>`
      + `${sub ? `<small class="${cls}">${sub}</small>` : ""}</span>${right}${more ? `<span class="chev">${svg("chevron")}</span>` : ""}</div>`;
    const val = (v, cls = "") => `<span class="val num${cls}">${esc(v)}</span>`;
    const st = m.status, deferred = st.kind === "deferred" && !m.busy, latest = esc(m.latest || "");
    const waits = t("card.fw.why.waits");
    const status = m.rebooting ? t("card.fw.rebooting")
      : m.off ? t("card.fw.off")
      : m.busy ? (m.pct !== null ? t("card.fw.installing_pct", { pct: m.pct }) : t("card.fw.installing"))
      : m.checking ? t("card.fw.checking")
      : deferred ? t("card.fw.deferred", { why: esc(st.why || waits) })
      : st.kind === "failed" ? t("card.fw.failed", { why: esc(st.why || t("card.fw.why.install")) })
      : m.avail ? t("card.fw.avail", { version: latest }) : t("card.fw.nothing");
    const idle = !m.off && m.online && !m.busy;
    const btns = (m.canCheck ? `<button class="btn tonal" data-act="check"${idle && !m.checking ? "" : " disabled"}>${t("card.fw.check")}</button>` : "")
      + (m.avail ? `<button class="btn" data-act="install"${idle && !deferred && !m.ask ? "" : " disabled"}>${deferred ? t("common.pending") : t("card.fw.install")}</button>` : "");
    const auto = m.auto, iv = m.interval, opts = (iv && iv.attributes.options) || [];
    const onRequest = iv && (iv.state === "on_request" || /demande/i.test(iv.state)); // the code, or an older firmware's option
    return row("tag-outline", t("card.fw.installed"), m.esphome ? esc(`ESPHome ${m.esphome.version}${m.esphome.built ? ` · ${m.esphome.built.charAt(0).toLowerCase()}${m.esphome.built.slice(1)}` : ""}`) : "", val(m.installed), "", !m.off)
      + (m.latest ? row("cloud-sync-outline", t("card.fw.latest"), (m.avail ? t("card.fw.upd_avail") : t("card.fw.up_to_date"))
        + (/^https?:\/\//.test(m.notes || "") ? ` · <a href="${esc(m.notes)}" target="_blank" rel="noopener">${t("card.fw.notes")}</a>` : ""), val(m.latest, m.avail ? " acc" : ""), m.avail ? "fw-up" : "fw-ok", true) : "")
      + row("download", t("card.fw.update"), status, btns ? `<span class="btns">${btns}</span>` : "", st.kind === "failed" && !m.busy && !m.off ? "bad" : "")
      + (m.busy && m.pct !== null ? `<div class="prog"><i style="width:${m.pct}%"></i></div>` : m.busy || m.rebooting || m.checking ? `<div class="prog ind"><i></i></div>` : "")
      + (m.ask && m.hold && m.avail ? `<div class="banner">${svg("alert")}<span>${t("card.fw.ask", { hold: esc(cap(m.hold.long)), version: latest })}${m.hold.ovr ? ` ${t("card.fw.ask_ovr")}` : ""}</span>`
        + `<div class="acts"><button class="btn tonal" data-act="ask-no">${t("common.cancel")}</button><button class="btn" data-act="ask-yes">${t("card.fw.install_at_end")}</button></div></div>` : "")
      + (deferred ? `<div class="banner">${svg("timer")}<span>${t(latest ? "card.fw.deferred_v" : "card.fw.deferred_nov", { version: latest, why: esc(m.hold ? m.hold.long : st.why || waits) })}</span>`
        + (m.canCancel ? `<div class="acts"><button class="btn tonal" data-act="cancel"${m.online ? "" : " disabled"}>${t("card.fw.cancel_request")}</button></div>` : "") + "</div>" : "")
      + (auto ? row("autorenew", t("card.fw.auto"), t("card.fw.auto_sub"),
        `<input type="checkbox" class="tgl" data-act="auto" aria-label="${t("card.fw.auto")}"${auto.state === "on" ? " checked" : ""}${isSet(auto.state) ? "" : " disabled"}>`) : "")
      + (iv ? row("timer-outline", t("card.fw.interval"), onRequest ? t("card.fw.interval_on_request") : isSet(iv.state) ? t("card.fw.interval_auto") : "",
        `<select class="esel" data-act="interval" aria-label="${t("card.fw.interval")}"${isSet(iv.state) ? "" : " disabled"}>${opts.includes(iv.state) ? "" : "<option selected></option>"}`
        + opts.map((o) => `<option value="${esc(o)}"${o === iv.state ? " selected" : ""}>${esc(intervalTxt(o))}</option>`).join("") + "</select>") : "");
  }
  /** Draws « Réglages contrôleur » › Firmware when the update entity exists; says how a « Vérifier » ended. */
  _renderUpdate() {
    const host = this._$("updRows"), m = this._updModel(), U = this._upd;
    this._$("fwSec").hidden = !m; // no update entity (a firmware before v1.4): nothing to show
    if (!m) return;
    if (m.busy) U.wasBusy = true; else if (!m.off) U.wasBusy = false;
    m.rebooting = m.off && U.wasBusy;
    // a « Vérifier » ends when the entity changes, when Update Status moves on from « vérification », or after 10 s
    // (an answer that changes nothing changes no state)
    const settled = m.statusAt > U.checkFrom && m.status.kind !== "checking";
    if (U.checkUntil && (m.updated > U.checkFrom || settled || Date.now() >= U.checkUntil || m.off)) {
      U.checkUntil = 0; m.checking = false;
      if (m.status.kind === "failed") this._toast(cap(m.status.why), true);
      else if (!m.off) this._toast(m.avail ? this._t("card.fw.toast_avail", { version: m.latest }) : this._t("card.fw.toast_ok", { version: m.installed }));
    }
    if (U.ask && (!m.hold || !m.avail || m.busy)) U.ask = m.ask = false; // nothing holds it any more: « Installer » is enough
    const html = this._updHtml(m);
    if (html !== U.drawn) { U.drawn = html; host.innerHTML = html; } // only on a change: a link rebuilt every second loses its hover
  }
  _wireUpdate() {
    const host = this._$("updRows"), U = this._upd;
    const redraw = () => { U.drawn = ""; this._update(); };
    const send = (domain, service, data, ok) => this._hass.callService(domain, service, data)
      .then(() => ok && this._toast(ok), (err) => { this._refused(err); redraw(); });
    const install = () => {
      const m = this._updModel();
      send("update", "install", { entity_id: this._e.firmware },
        this._t(m.hold ? (m.hold.ovr ? "card.fw.req_ovr" : "card.fw.req_fill") : "card.fw.req", { version: m.latest }));
    };
    const more = (ev) => !ev.target.closest("a") && ev.target.closest('[data-act="more"]') && this._moreInfo("firmware");
    host.addEventListener("keydown", (ev) => { if ((ev.key === "Enter" || ev.key === " ") && more(ev)) ev.preventDefault(); });
    host.addEventListener("click", (ev) => {
      if (more(ev)) return;
      const b = ev.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === "check") {
        U.checkFrom = Date.now(); U.checkUntil = U.checkFrom + 10000;
        this._hass.callService("button", "press", { entity_id: this._e.checkUpdate }).catch((err) => { U.checkUntil = 0; this._refused(err); redraw(); });
        this._update();
      } else if (act === "install") { if (this._hold()) { U.ask = true; this._update(); } else install(); }
      else if (act === "ask-no") { U.ask = false; this._update(); }
      else if (act === "ask-yes") { U.ask = false; install(); this._update(); }
      else if (act === "cancel") send("button", "press", { entity_id: this._e.cancelUpdate }, this._t("card.fw.cancelled"));
    });
    host.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.dataset.act === "auto") send("switch", t.checked ? "turn_on" : "turn_off", { entity_id: this._e.autoUpdate });
      else if (t.dataset.act === "interval" && t.value) send("select", "select_option", { entity_id: this._e.updateInterval, option: t.value });
    });
  }

  /* ---------- panel, tab « Réglages contrôleur » › Position ---------- */
  /** Home Assistant's own position and zone (hass.config), as the controller would take them; null without one. */
  _haPos() {
    const c = this._hass.config;
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
    return { lat: r2(c.latitude), lon: r2(c.longitude), iana: c.time_zone || "", posix: PiscineCard.posixTz(c.time_zone) };
  }
  _renderPos() {
    const sec = this._$("posSec");
    sec.hidden = !this._st("latitude") && !this._st("longitude") && !this._st("timezone");
    if (sec.hidden) return;
    const lat = this._n("latitude"), lon = this._n("longitude"), tz = this._s("timezone"), name = this._s("timezoneName"), h = this._haPos();
    const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.005;
    const same = h && near(lat, h.lat) && near(lon, h.lon) && (!h.posix || (tz === h.posix && name === h.iana));
    const t = this._t;
    const row = (key, icon, label, value, sub = "") => (this._st(key) ? `<div class="erow"><span class="ic">${this._icon(icon)}</span><span class="name"><span>${label}</span>`
      + `${sub ? `<small>${sub}</small>` : ""}</span><span class="val num">${esc(value)}</span></div>` : "");
    const html = row("latitude", "map-marker", t("card.pos.lat"), deg(lat)) + row("longitude", "map-marker", t("card.pos.lon"), deg(lon))
      + row("timezone", "earth", t("card.pos.tz"), isSet(name) ? name : isSet(tz) ? t("card.pos.tz_posix") : t("card.pos.tz_unset"), isSet(tz) ? `POSIX <span class="mono">${esc(tz)}</span>` : "")
      + (h ? `<div class="erow"><span class="ic">${this._icon("home-assistant")}</span><span class="name"><span>${t("card.pos.use_ha")}</span><small>${same
        ? (h.posix ? t("card.pos.same") : esc(t("card.pos.same_pos", { zone: h.iana })))
        : esc(t(h.posix ? "card.pos.ha" : "card.pos.ha_nozone", { lat: deg(h.lat), lon: deg(h.lon), zone: h.iana || t("card.pos.ha_tz_unset") }))}</small></span>`
        + `<button class="btn" data-act="pos-ha"${same || !this._online() ? " disabled" : ""}>${t("card.pos.use")}</button></div>` : "");
    if (html !== this._posDrawn) { this._posDrawn = html; this._$("posRows").innerHTML = html; }
  }
  /** Writes hass.config's position, and its zone when TZ_POSIX has it: Timezone (POSIX, applied) and Timezone Name together. */
  _posFromHa(btn) {
    const h = this._haPos();
    if (!h) return;
    const writes = [["latitude", "number", h.lat], ["longitude", "number", h.lon], ...(h.posix ? [["timezone", "text", h.posix], ["timezoneName", "text", h.iana]] : [])]
      .filter(([key]) => this._st(key));
    btn.classList.add("busy");
    Promise.all(writes.map(([key, domain, value]) => this._hass.callService(domain, "set_value", { entity_id: this._e[key], value })))
      .then(() => this._toast(this._t(h.posix ? "card.pos.sent_both" : "card.pos.sent_pos")), (err) => this._refused(err))
      .finally(() => { btn.classList.remove("busy"); this._posDrawn = ""; this._update(); });
  }

  /** « Hors ligne depuis 6 min », « Contrôleur muet depuis 5 min », else « Contrôleur · il y a 2 min ». */
  _lightText(L) {
    if (L.off !== null) return Number.isFinite(L.off) ? this._t("card.light.off_since", { duration: fmtD(L.off) }) : this._t("card.light.off");
    if (L.h === "alarm") return this._fillText(L.fill);
    return L.h === "live" ? this._t("card.light.live", { ago: agoTxt(L.quiet) }) : this._t("card.light.mute_since", { duration: fmtD(L.quiet) });
  }
  /** The light on the tile and in the panel's header. A message newer than the last one drawn: one heartbeat. */
  _renderLight() {
    const on = this._config.controller_light, btn = this._$("ctlLink"), leds = [this._$("led"), this._$("ctlLed")].filter(Boolean);
    if (btn) btn.hidden = !on;
    if (this._$("led")) this._$("led").hidden = !on;
    if (!on) return;
    const L = this._light();
    const tip = L.off !== null ? (L.seen ? this._t("card.light.tip_off_last", { time: stampMs(L.seen) }) : this._t("card.light.tip_off"))
      : (L.h === "alarm" ? `${this._t("card.light.tip_alarm", { fill: this._fillText(L.fill, "running") })} ` : "")
        + this._t("card.light.tip_last", { time: stampMs(L.seen), ago: agoTxt(L.quiet) });
    for (const el of leds) {
      // a redraw must not cut a heartbeat short; the alarm's own pulse replaces it
      const cls = `led ${L.h}${el.classList.contains("ping") && L.h !== "alarm" ? " ping" : ""}`;
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
  /** Fill Meter turned off (fill-meter.yaml): no fill water, no alarm. A firmware without the switch counts always. */
  _fillOff() { return this._s("fillEnabled") === "off"; }
  /**
   * The long-fill alarm, Fill Running Too Long: null, or {since (the fill's start, a Date, or null), min (how long it
   * has run, at least), acked (Fill Alarm Acknowledged)}. The start is Fill Running's last change, unless that came
   * later than an alarm allows (Home Assistant restarted, the page was opened, during the fill): then only « more than
   * Fill Alarm After » is known.
   */
  _fillAlarm() {
    if (this._fillOff() || this._s("fillTooLong") !== "on") return null;
    const after = this._n("fillAlarmAfter", 0), run = this._st("fillRunning");
    const t = run && run.state === "on" ? Date.parse(run.last_changed) : NaN;
    const since = Number.isFinite(t) && Date.now() - t >= (after - 1) * M_MS ? new Date(t) : null;
    return { since, min: since ? (Date.now() - t) / M_MS : after, acked: this._s("fillAcked") === "on" };
  }
  /** « Remplissage depuis 1 h 12 », « … depuis plus de 1 h »; `kind` fill, running (« Remplissage en cours… ») or on (« En cours… »). */
  _fillText(f, kind = "fill") { return this._t(`card.fill.${kind}${f.since ? "" : "_over"}`, { duration: fmtD(f.min) }); }
  _timeoutMin() { const m = this._n("timeout"); return Number.isFinite(m) ? Math.round(m) : 60; }
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
        this._toast(this._t("card.cmd.timeout"), true);
        return null;
      }
      return { label: L.label, stage: L.echoed ? 1 : 0, t0: L.t0, fail: !this._online() && age > 2000 };
    }
    if (scriptBusy) return { label: this._t(this._s("sAuto") === "on" ? "card.dur.title" : "card.speed.title"), stage: 1, t0: Date.now(), fail: false };
    return null;
  }

  _phase() {
    const t = this._t;
    if (!this._online()) return { label: t("card.light.off"), cls: this._light().h === "lost" ? "danger" : "amber" };
    if (this._freeze()) return { label: t("card.phase.freeze", { speed: speedTxt("Low") }), cls: "cool" };
    if (this._stuck()) return { label: t("card.phase.stuck", { duration: fmtD(this._ovrAgeMin()) }), cls: "danger" };
    if (this._inOvr()) return { label: `${t("common.mode.manual")} · ${speedTxt(this._override())}`, cls: "amber" };
    const c = this._commanded();
    return c === "Off" ? { label: `${t("common.mode.auto")} · ${t("common.stopped")}`, cls: "idle" } : { label: `${t("common.mode.auto")} · ${speedTxt(c)}`, cls: "acc" };
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
   * `mean` is the probe's daily mean, drawn where the pool is unknown. `olo`, `ohi`: the outdoors, from the device's
   * Daily Outdoor History, else the outdoor sensor's daily statistics; today, Outdoor Min/Max Today (_outToday).
   */
  _tempDays(n, loose = false) {
    const hist = parseDays(this._s("history")), stats = this._stats || {}, daily = this._daily || {}, out = [];
    const oHist = parseOutdoor(this._s("outdoorHistory")), oDaily = this._oDaily || {};
    const ok = (x) => x && Number.isFinite(x.lo) && Number.isFinite(x.hi);
    for (let ago = n - 1; ago >= 1; ago--) {
      const date = dayAgo(ago), k = dayKey(date), h = hist[k], src = [h, stats[k], loose && daily[k]].find(ok), o = [oHist[k], oDaily[k]].find(ok);
      out.push({ ago, date, lo: src ? src.lo : NaN, hi: src ? src.hi : NaN, hours: h ? h.hours : NaN, mean: daily[k]?.mean ?? NaN,
        olo: o ? o.lo : NaN, ohi: o ? o.hi : NaN });
    }
    const o = this._outToday();
    out.push({ ago: 0, date: dayAgo(0), lo: this._n("waterMin"), hi: this._n("waterMax"), hours: this._n("hoursToday"), mean: NaN, olo: o.lo, ohi: o.hi });
    return out.map((d) => ({ ...d, known: Number.isFinite(d.lo) && Number.isFinite(d.hi), oknown: Number.isFinite(d.olo) && Number.isFinite(d.ohi) }));
  }
  /**
   * Today's outdoor min – max: Outdoor Min/Max Today; with a firmware before them, the outdoor sensor's states since
   * midnight in the 24 h history.
   */
  _outToday() {
    const lo = this._n("outdoorMin"), hi = this._n("outdoorMax");
    if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo, hi };
    const mid = dayAgo(0).getTime(), v = (this._oHist || []).filter((p) => p.t >= mid).map((p) => parseFloat(p.s))
      .filter((x) => Number.isFinite(x) && x >= OUT_SANE[0] && x <= OUT_SANE[1]);
    return v.length ? { lo: Math.min(...v), hi: Math.max(...v) } : { lo: NaN, hi: NaN };
  }
  /** 24 h: the outdoor sensor's readings, {t, v (NaN: unavailable or a bad reading)}, the last one held until now. */
  _outSeries(now) {
    const from = now - 24 * H_MS, out = (this._oHist || []).map((p) => {
      const v = parseFloat(p.s);
      return { t: Math.max(p.t, from), v: Number.isFinite(v) && v >= OUT_SANE[0] && v <= OUT_SANE[1] ? v : NaN };
    });
    if (out.length && Number.isFinite(out[out.length - 1].v)) out.push({ t: now, v: out[out.length - 1].v });
    return out;
  }
  /** 1 an: 53 weeks from _weekStart(), the running one last: the pool's min–max over the week's days, else the probe's mean; the outdoors' min–max. */
  _tempWeeks() {
    const days = this._tempDays(Math.round((dayAgo(0) - this._weekStart()) / 864e5) + 1, true), out = [];
    for (let i = 0; i < days.length; i += 7) {
      const ds = days.slice(i, i + 7), pool = ds.filter((d) => d.known), m = ds.filter((d) => Number.isFinite(d.mean)), o = ds.filter((d) => d.oknown);
      out.push({ date: ds[0].date, cur: i + 7 >= days.length, known: pool.length > 0,
        lo: pool.length ? Math.min(...pool.map((d) => d.lo)) : NaN, hi: pool.length ? Math.max(...pool.map((d) => d.hi)) : NaN,
        mean: !pool.length && m.length ? m.reduce((a, d) => a + d.mean, 0) / m.length : NaN,
        oknown: o.length > 0, olo: o.length ? Math.min(...o.map((d) => d.olo)) : NaN, ohi: o.length ? Math.max(...o.map((d) => d.ohi)) : NaN });
    }
    return out;
  }

  _renderTemp() {
    const box = this._$("tChart");
    if (!box) return;
    const rec = this._config.recorder, range = rec ? this._range : "7d"; // without the recorder: Daily History's 7 days
    this.shadowRoot.querySelectorAll("#tRange button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === range)));
    if (range !== "24h") this._loadStats(); // 7 j too: the outdoors of the days before Daily Outdoor History
    const W = box.clientWidth, H = box.clientHeight;
    if (!W) return; // not laid out: the pop-up is closed
    const now = Date.now();
    const key = [range, this._tHover, W, H, this._tVer, Math.floor(now / M_MS),
      ...["water", "waterMin", "waterMax", "history", "hoursToday", "freezeAt", "outdoorMin", "outdoorMax", "outdoorHistory"].map((k) => this._s(k))].join("|");
    if (key === this._tDrawn) return;
    this._tDrawn = key;

    const svg = this._$("tSvg"), tip = this._$("tTip"), empty = this._$("tEmpty"), sum = this._$("tSum"), leg = this._$("tLeg");
    const showEmpty = (msg, summary = "") => {
      empty.hidden = false; empty.textContent = msg; svg.innerHTML = ""; tip.hidden = true;
      sum.innerHTML = summary; leg.innerHTML = ""; box.setAttribute("aria-label", msg);
    };
    const t = this._t;
    const nowTxt = t("card.temp.now", { temp: fmt1(this._n("water")) });
    if (range === "24h" && !this._wHist) return showEmpty(t("card.temp.loading_history"), nowTxt);
    if (T_STATS.has(range) && !this._stats) return showEmpty(t("card.temp.loading_stats"), nowTxt);
    empty.hidden = true;

    const L = 8, R = W - 34, TOP = 10, BOT = H - 20;
    const fz = this._freezeC();
    /**
     * y scale over `vals`, padded to the half degree. The freeze-protection threshold joins it when the water comes
     * within FREEZE_NEAR_C of it (a dotted line over the zone where Low is forced); further away a tag at the foot
     * of the axis gives it, rather than squashing a 13 °C curve to show 3 °C. `out`, the outdoors, widens the scale
     * but never brings the threshold in: it is the water's.
     */
    const yScale = (vals, top, bot, out = []) => {
      const near = Number.isFinite(fz) && Math.min(...vals) - fz <= FREEZE_NEAR_C, all = [...vals, ...out, ...(near ? [fz] : [])];
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
          + `<line class="fz" x1="${L}" x2="${R}" y1="${yf}" y2="${yf}"/><text class="fz-t" x="${L + 4}" y="${ly}">${t("card.temp.fz", { temp: fmt1(fz) })}</text>`;
      } else if (Number.isFinite(fz)) g += `<text class="fz-t" x="${R + 5}" y="${H - 6}">↓${fmt1(fz)}°</text>`;
      const legend = Number.isFinite(fz)
        ? `<span><i class="k-fz"></i>${t(near ? "card.temp.fz_leg" : "card.temp.fz_leg_below", { temp: fmt1(fz) })}</span>` : "";
      return { y, grid: g, legend };
    };
    const belowFz = (v) => (Number.isFinite(fz) && v < fz ? ` · ${t("card.temp.below_fz")}` : "");
    let g = "", hovX = null;

    if (range === "24h") {
      const pts = this._tempSeries(now), vals = pts.filter((p) => Number.isFinite(p.v)).map((p) => p.v);
      if (!vals.length) return showEmpty(t("card.temp.none_24h"), nowTxt);
      const from = now - 24 * H_MS, x = (t) => L + ((t - from) / (24 * H_MS)) * (R - L), mid = midnight(now);
      const opts = this._outSeries(now), ovals = opts.filter((p) => Number.isFinite(p.v)).map((p) => p.v);
      const sc = yScale(vals, TOP, BOT, ovals);
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
      // the outdoors under the pool's line, broken where it was unavailable
      let od = "", pen = false;
      for (const p of opts) {
        if (!Number.isFinite(p.v)) { pen = false; continue; }
        od += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${sc.y(p.v).toFixed(1)}`; pen = true;
      }
      if (od) g += `<path class="out" d="${od}"/>`;
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
        tip.querySelector("span span").textContent = `${hov.t < mid ? `${t("common.yesterday")} ` : ""}${fmtT(new Date(hov.t))} · ${
          hov.ok ? t("card.temp.tip_pool") : hov.on ? t("card.temp.tip_short", { min: POOL_AFTER_MIN }) : t("card.temp.tip_pipe")}${belowFz(hov.v)}`;
        const oAt = [...opts].reverse().find((p) => p.t <= hov.t);
        if (oAt && Number.isFinite(oAt.v)) {
          g += `<circle class="pt out-pt" cx="${x(hov.t)}" cy="${sc.y(oAt.v)}" r="3.5"/>`;
          tip.insertAdjacentHTML("beforeend", `<span class="o-l"><i class="o"></i><span class="ov"></span></span>`);
          tip.querySelector(".ov").textContent = t("card.temp.tip_out", { temp: fmt1(oAt.v) });
        }
        hovX = x(hov.t);
      }
      const dot = hov || last;
      g += `<circle class="pt ${dot.ok ? "ok" : "no"}" cx="${x(dot.t)}" cy="${sc.y(dot.v)}" r="4"/>`;
      // today's pool min/max as the firmware keeps them; pump stopped, the last real pool reading too
      const lo = this._n("waterMin"), hi = this._n("waterMax");
      let s = Number.isFinite(lo) && Number.isFinite(hi) ? t("card.temp.today_range", { lo: fmt1(lo), hi: fmt1(hi) }) : t("card.temp.none_today");
      if (!last.ok) {
        const lastOk = [...known].reverse().find((p) => p.ok);
        s += `<span>${last.on ? t("card.temp.pipe_short", { min: POOL_AFTER_MIN, temp: fmt1(last.v) }) : t("card.temp.pipe_off", { temp: fmt1(last.v) })}${
          lastOk ? ` ${t(lastOk.t < mid ? "card.temp.last_pool_yday" : "card.temp.last_pool", { temp: fmt1(lastOk.v), time: fmtT(new Date(lastOk.t)) })}` : ""}</span>`;
      }
      const oRange = ovals.length ? { lo: fmt1(Math.min(...ovals)), hi: fmt1(Math.max(...ovals)) } : null;
      if (oRange) s += `<span>${t("card.temp.out_24h", oRange)}</span>`;
      sum.innerHTML = s;
      leg.innerHTML = `<span><i class="k-pool"></i>${t("card.temp.leg_pool", { min: POOL_AFTER_MIN })}</span><span><i class="k-pipe"></i>${t("card.temp.leg_pipe")}</span>`
        + (oRange ? `<span><i class="k-out"></i>${t("card.temp.leg_out")}</span>` : "")
        + `<span><i class="k-band"></i>${t("card.sec.filtration")}</span>${sc.legend}`;
      box.setAttribute("aria-label", t("card.temp.aria24", { lo: fmt1(Math.min(...vals)), hi: fmt1(Math.max(...vals)) })
        + (oRange ? `. ${t("card.temp.aria_out24", oRange)}` : ""));
    } else {
      // 7 / 30 / 90 j: a bar a day; 1 an: a bar a week. The pool's min–max where it is known; elsewhere (before Min/Max
      // Today had statistics) the probe's mean, dashed: the pipe is in it, as on the 24 h curve.
      const wk = range === "1y", days = wk ? this._tempWeeks() : this._tempDays(T_N[range]), n = days.length;
      const cw = (R - L) / n, cx = (i) => L + cw * (i + 0.5);
      const bw = Math.max(1.5, Math.min(12, cw - (cw > 6 ? 3 : 1))), rx = Math.min(4, bw / 2); // 30 bars on a phone: ~7 px, 3 apart; 90: ~2 px, 1 apart
      const isNow = (d) => (wk ? d.cur : d.ago === 0), per = wk ? "week" : "day";
      const pool = days.filter((d) => d.known), mean = days.filter((d) => !d.known && Number.isFinite(d.mean));
      const vals = [...pool.flatMap((d) => [d.lo, d.hi]), ...mean.map((d) => d.mean)];
      const outs = days.filter((d) => d.oknown), ovals = outs.flatMap((d) => [d.olo, d.ohi]);
      const sc = yScale(vals.length ? vals : [Number.isFinite(this._n("water")) ? this._n("water") : 20], TOP + 6, BOT - 6, ovals);
      g += sc.grid;
      // the outdoors' min – max: a band joining neighbouring days (weeks) behind the bars, a lone one a box
      for (let i = 0; i < n;) {
        if (!days[i].oknown) { i++; continue; }
        let j = i;
        while (j + 1 < n && days[j + 1].oknown) j++;
        const yhi = (d) => sc.y(d.ohi), ylo = (d) => Math.max(sc.y(d.olo), sc.y(d.ohi) + 2);
        if (j === i) g += `<rect class="out-band" x="${(cx(i) - cw * 0.4).toFixed(1)}" y="${yhi(days[i]).toFixed(1)}" width="${(cw * 0.8).toFixed(1)}" height="${(ylo(days[i]) - yhi(days[i])).toFixed(1)}"/>`;
        else {
          const seg = days.slice(i, j + 1), xs = seg.map((_, k) => cx(i + k).toFixed(1));
          const top = seg.map((d, k) => `${k ? "L" : "M"}${xs[k]},${yhi(d).toFixed(1)}`).join("");
          const bot = seg.map((d, k) => `${k ? "L" : "M"}${xs[k]},${ylo(d).toFixed(1)}`).join("");
          const back = seg.map((d, k) => `L${xs[k]},${ylo(d).toFixed(1)}`).reverse().join("");
          g += `<path class="out-band" d="${top}${back}Z"/><path class="out-edge" d="${top}"/><path class="out-edge" d="${bot}"/>`;
        }
        i = j + 1;
      }
      const label = (d, i) => {
        if (wk) { const m = d.date.getMonth(); return i < 2 || m % 2 || days[i - 1].date.getMonth() === m ? "" : F.date(d.date, { month: "short" }); } // every other month's first Monday
        if (d.ago === 0) return n > 30 ? "" : t("common.today_short"); // 90 j: the freeze tag sits there
        return n <= 7 ? F.date(d.date, { weekday: "short" }) : d.ago % (n > 30 ? 14 : 7) ? "" : dayMonth(d.date);
      };
      const long = (d) => {
        if (wk) { const w = t("common.week_of", { date: dayMonth(d.date) }); return d.cur ? t("common.ongoing", { when: w }) : w; }
        return d.ago === 0 ? `${t("common.today")} ${dayMonth(d.date)}` : wdDayMonth(d.date);
      };
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
        tip.innerHTML = `<b></b><span></span>${hd.oknown ? `<span class="o-l"><i class="o"></i><span class="ov"></span></span>` : ""}`;
        tip.querySelector("b").textContent = hd.known ? `${fmt1(hd.lo)} – ${fmt1(hd.hi)} °C` : Number.isFinite(hd.mean) ? `≈ ${fmt1(hd.mean)} °C` : t("card.temp.no_reading");
        tip.querySelector("span").textContent = long(hd) + (hd.known ? (Number.isFinite(hd.hours) ? ` · ${t("card.temp.tip_hours", { hours: fmt1(hd.hours) })}` : "") + belowFz(hd.lo)
          : Number.isFinite(hd.mean) ? ` · ${t(`card.temp.tip_mean.${per}`)}` : "");
        if (hd.oknown) tip.querySelector(".ov").textContent = t("card.temp.tip_out_rng", { lo: fmt1(hd.olo), hi: fmt1(hd.ohi) });
        hovX = cx(this._tHover);
      }
      const k = pool.length + mean.length, span = wk ? t("card.temp.span_12m") : t("card.temp.span_days", { count: n });
      const lohi = k ? { lo: fmt1(Math.min(...vals)), hi: fmt1(Math.max(...vals)), span } : null;
      let s = !k ? t("card.temp.none_yet")
        : mean.length ? (pool.length ? t("card.temp.sum_mixed", lohi) : t(`card.temp.sum_mean.${per}`, lohi)) : t("card.temp.sum_pool", lohi);
      if (mean.length) s += `<span>${pool.length ? t(`card.temp.note_dash.${per}`) : t("card.temp.note_mean")}</span>`;
      const oRange = outs.length ? { lo: fmt1(Math.min(...ovals)), hi: fmt1(Math.max(...ovals)), span } : null;
      if (oRange) s += `<span>${t("card.temp.out_span", oRange)}</span>`;
      if (T_STATS.has(range) && this._statsErr) s += `<span>${t("card.temp.stats_err")}</span>`;
      else if (n > 7 && k < n) s += `<span>${t(`card.temp.measured.${per}`, { count: k, n })}</span>`;
      sum.innerHTML = s;
      leg.innerHTML = (pool.length || !mean.length ? `<span><i class="k-rng"></i>${t(`card.temp.leg_rng.${per}`, { min: POOL_AFTER_MIN })}</span>` : "")
        + (mean.length ? `<span><i class="k-pipe"></i>${t(`card.temp.leg_mean.${per}`)}</span>` : "")
        + (oRange ? `<span><i class="k-out-band"></i>${t(`card.temp.leg_out_rng.${per}`)}</span>` : "") + sc.legend;
      box.setAttribute("aria-label", t("card.temp.aria", { span, items: days.map((d) => (d.known ? t("card.temp.aria_range", { when: long(d), lo: fmt1(d.lo), hi: fmt1(d.hi) })
        : Number.isFinite(d.mean) ? t("card.temp.aria_mean", { when: long(d), temp: fmt1(d.mean) }) : t("card.temp.aria_none", { when: long(d) }))).join(", ") })
        + (oRange ? `. ${t("card.temp.aria_out", oRange)}` : ""));
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
    if (!this._config.recorder) return this._deviceBuckets(range);
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

  /**
   * Without the recorder (the device's own page): the controller's own record. 30 j: Fill Water Days (the 30 closed
   * days, newest first, from the newest's date) and Fill Water Today; 12 mois: Fill Water Months (this month's closed
   * days, then the 11 before) plus today. NaN where it has no record (it was off, or had no clock). null without them.
   */
  _deviceBuckets(range) {
    const m = (range === "12m" ? /^(\d{4})-(\d{2}): (.*)$/ : /^(\d{4})-(\d{2})-(\d{2}): (.*)$/).exec(this._s(range === "12m" ? "fillMonths" : "fillDays") || "");
    const today = this._n("fillToday", 0), now = new Date(), vals = new Map(), out = [];
    if (!m && !this._st("fillToday")) return null;
    const key = (x) => (range === "12m" ? `${x.getFullYear()}-${x.getMonth()}` : dayKey(x));
    if (m) {
      const head = range === "12m" ? new Date(+m[1], +m[2] - 1, 1) : new Date(+m[1], +m[2] - 1, +m[3]);
      m[m.length - 1].trim().split(/\s+/).forEach((v, i) => {
        const x = new Date(head); if (range === "12m") x.setMonth(x.getMonth() - i); else x.setDate(x.getDate() - i);
        vals.set(key(x), v === "-" ? NaN : +v);
      });
    }
    for (let x = this._wStart(range, now); x <= now;) {
      const next = new Date(x); if (range === "12m") next.setMonth(next.getMonth() + 1); else next.setDate(next.getDate() + 1);
      const cur = now < next, v = vals.has(key(x)) ? vals.get(key(x)) : NaN;
      // today is Fill Water Today; this month, its closed days so far plus today
      out.push({ t: x.getTime(), value: cur ? (range === "12m" ? (Number.isFinite(v) ? v : 0) + today : today) : v, cur });
      x = next;
    }
    return out;
  }

  /** The panel's water block shows in « Contrôle » with a recorder and a water meter; the variant always. Neither while
   * Fill Meter is off. */
  _waterShown() {
    if (this._fillOff()) return false; // the meter turned off: no fill water anywhere
    return this._config.variant === "water" || (this._config.recorder && !!this._st("volume"));
  }
  _renderWater() {
    const box = this._$("wChart");
    if (!box || !this._waterShown() || (this._config.variant === "panel" && this._tab !== "pump")) return;
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
    // Fill Running (fill-meter.yaml): since when, and past the alarm's time
    const run = this._st("fillRunning"), fa = this._fillAlarm(), wr = this._$("wRun");
    wr.hidden = !run || run.state !== "on";
    if (!wr.hidden) {
      const txt = fa ? this._t("card.fill.past_alarm", { text: this._fillText(fa, "on"), duration: fmtD(this._n("fillAlarmAfter", 0)) })
        : this._t("card.fill.on_at", { time: fmtT(new Date(Date.parse(run.last_changed))) });
      if (wr.textContent !== txt) wr.textContent = txt;
      wr.classList.toggle("warn", !!fa);
    }

    const W = box.clientWidth, H = box.clientHeight;
    if (!W) return;
    const key = [range, this._wHover, W, H, this._wVer, Math.floor(Date.now() / M_MS), ...["volume", "fillToday", "fillDays", "fillMonths"].map((k) => this._s(k))].join("|");
    if (key === this._wDrawn) return;
    this._wDrawn = key;
    const svg = this._$("wSvg"), tip = this._$("wTip"), empty = this._$("wEmpty"), sum = this._$("wSum"), leg = this._$("wLeg");
    const showEmpty = (msg) => { empty.hidden = false; empty.textContent = msg; svg.innerHTML = ""; tip.hidden = true; sum.innerHTML = ""; leg.innerHTML = ""; box.setAttribute("aria-label", msg); };
    const b = this._waterBuckets(range);
    const t = this._t;
    if (!b) return showEmpty(t(this._config.recorder ? "card.temp.loading_stats" : "card.water.no_device"));
    const known = b.filter((x) => Number.isFinite(x.value));
    if (!known.length) return showEmpty(t(this._wErr[range] ? "card.water.stats_err" : "card.water.no_stats"));
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
      if (range === "30d") return k === 0 ? T("common.today_short") : k % 7 ? "" : dayMonth(t);
      if (range === "90d") return k % 3 ? "" : dayMonth(t);
      return cw >= 30 || k % 2 === 0 ? F.date(t, { month: "short" }) : "";
    };
    const long = (x) => {
      const d = date(x);
      if (range === "30d") return x.cur ? T("common.today") : wdDayMonth(d);
      const w = range === "90d" ? T("common.week_of", { date: dayMonth(d) }) : F.date(d, { month: "long", year: "numeric" });
      return x.cur ? T("common.ongoing", { when: w }) : w;
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
      tip.querySelector("b").textContent = Number.isFinite(hb.value) ? fmtL(hb.value) : t("card.water.no_reading");
      tip.querySelector("span").textContent = long(hb);
      hovX = cx(this._wHover);
    }
    const total = known.reduce((a, x) => a + x.value, 0), closed = known.filter((x) => !x.cur), base = closed.length ? closed : known;
    let s = t(`card.water.sum.${range}`, { total: fmtL(total), avg: fmtL(base.reduce((a, x) => a + x.value, 0) / base.length) });
    const end = (txt) => (txt.endsWith(".") ? txt : `${txt}.`); // « 15 nov. » already ends the sentence
    if (peak.value > 0) s += `<span>${end(t("card.water.peak", { value: fmtL(peak.value), when: long(peak) }))}</span>`;
    const first = b.findIndex((x) => Number.isFinite(x.value));
    if (first > 0) s += `<span>${end(t("card.water.first", { when: long(b[first]) }))}</span>`;
    sum.innerHTML = s;
    leg.innerHTML = `<span><i class="k-bar"></i>${t(`card.water.leg.${range}`)}</span><span><i class="k-cur"></i>${t(`card.water.cur.${range}`)}</span>`;
    box.setAttribute("aria-label", t(`card.water.aria.${range}`, { items: b.map((x) => (Number.isFinite(x.value) ? `${long(x)} ${fmtL(x.value)}` : t("card.water.aria_none", { when: long(x) }))).join(", ") }));
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
  /** A setting's value with its unit; « — » while unknown (the controller offline: unavailable). */
  _numTxt(key, v) {
    if (!isSet(v) || !Number.isFinite(+v)) return "—";
    const step = String(this._attr(key, "step") ?? 1), dec = step.includes(".") ? step.split(".")[1].length : 0;
    const sign = key === "offset" && +v > 0 ? "+" : ""; // the duration adjustment goes both ways: +1 h, −1 h
    return `${sign}${fmtN(+v, dec)} ${this._attr(key, "unit_of_measurement") || ""}`.trim();
  }
  _wireSettings() {
    if (!customElements.get("ha-card")) this._$("setCard").classList.add("plain"); // the device's page: no HA around
    const head = this.shadowRoot.querySelector(".set-h");
    const title = this._config.title ?? this._t("card.tab.settings");
    head.hidden = !title;
    this._$("setTitle").textContent = title;
    this._$("setIcon").innerHTML = this._icon("tune-vertical");
    this._wireSettingRows();
  }
  _refused(err) { console.error("piscine-card:", err); this._toast(this._t("common.refused", { error: (err && err.message) || err }), true); }
  /** Presses a button entity, the button busy meanwhile, then says `ok`. */
  _press(btn, key, ok) {
    btn.classList.add("busy");
    this._hass.callService("button", "press", { entity_id: this._e[key] }).then(() => this._toast(ok), (err) => this._refused(err))
      .finally(() => btn.classList.remove("busy"));
  }
  /**
   * The settings rows (SETTINGS) into #rows, with the pending banner's « Appliquer »: the variant and the panel's tab.
   * The panel's « Réglages » has a second host, #rows2, for the rows after « Appliquer » (its wide layout's right column).
   */
  _wireSettingRows() {
    const refused = (err) => this._refused(err);
    const apply = (btn) => this._press(btn, "apply", this._t("card.applied"));
    this._$("applyNow").addEventListener("click", (ev) => apply(ev.currentTarget));
    const first = this._$("rows"), rest = this._$("rows2") || first;
    let sect = null;
    this._sects = [];
    SETTINGS.forEach((def, i) => {
      const host = i < APPLY_CUT ? first : rest;
      if (def.sect) {
        const el = document.createElement("div"); el.className = "esect"; el.textContent = this._t(def.sect); host.appendChild(el);
        this._sects.push(sect = { el, rows: [] });
        return;
      }
      const row = document.createElement("div"); row.className = "erow";
      row.innerHTML = `<span class="ic"></span><span class="name"><span></span>${def.sub ? "<small></small>" : ""}</span>`
        + (def.button ? `<button class="btn"></button>` : `<span class="ctl"><input type="range"><span class="v num"></span></span>`);
      const label = this._t(`card.row.${def.key}.label`);
      row.querySelector(".name span").textContent = label;
      if (def.sub) row.querySelector("small").textContent = this._t(`card.row.${def.key}.sub`);
      const r = { def, row, input: row.querySelector("input"), out: row.querySelector(".v"), btn: row.querySelector("button"), editing: 0, icon: null };
      if (r.btn) { r.btn.textContent = this._t(def.button); r.btn.addEventListener("click", () => apply(r.btn)); }
      else {
        r.input.setAttribute("aria-label", label);
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
    });
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

  /* ---------- panel, tabs « Réglages » (Plan du jour, Sondes, the settings, 7 derniers jours) and « Réglages contrôleur » ---------- */
  _wirePanes() {
    this._wireSettingRows();
    for (const [host, defs] of [[this._$("planRows"), PLAN_ROWS], [this._$("probeRows"), PROBE_ROWS]]) {
      let sect = null;
      for (const def of defs) {
        if (def.sect) { sect = document.createElement("div"); sect.className = "esect"; sect.textContent = this._t(def.sect); host.appendChild(sect); continue; }
        const row = document.createElement("div"); row.className = def.more ? "erow more" : "erow";
        row.innerHTML = `<span class="ic"></span><span class="name"><span></span><small></small></span>`
          + (def.button ? `<button class="btn"></button>` : `<span class="val num"></span>`)
          + (def.more ? `<span class="chev">${svg("chevron")}</span>` : "");
        row.querySelector(".name span").textContent = this._t(`card.row.${def.key}.label`);
        const r = { def, row, sect, val: row.querySelector(".val"), sub: row.querySelector("small"), btn: row.querySelector("button"), icon: null };
        if (r.btn) {
          r.btn.textContent = this._t(`card.row.${def.key}.button`);
          r.btn.addEventListener("click", () => this._press(r.btn, def.key, this._t(`card.row.${def.key}.ok`)));
        }
        if (def.more) {
          Object.assign(row, { tabIndex: 0, title: this._t("common.open_in_ha") }); row.setAttribute("role", "button");
          row.addEventListener("click", () => this._moreInfo(def.key));
          row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this._moreInfo(def.key); } });
        }
        host.appendChild(row);
        this._paneRows.push(r);
      }
    }
    this._wireRestart();
    this._wireUpdate();
    this._$("posRows").addEventListener("click", (ev) => {
      const b = ev.target.closest('button[data-act="pos-ha"]');
      if (b && !b.disabled) this._posFromHa(b);
    });
  }
  /** « Réglages contrôleur » › Redémarrer: asks first (7 s to answer), then presses the controller's Restart. */
  _wireRestart() {
    const btn = this._$("restartBtn"), cf = this._$("restartCf");
    const ask = (open) => {
      clearTimeout(this._rsTimer);
      cf.hidden = !open; btn.hidden = open;
      if (open) { this._$("restartYes").focus(); this._rsTimer = setTimeout(() => ask(false), 7000); } else btn.focus({ preventScroll: true });
    };
    btn.addEventListener("click", () => ask(true));
    this._$("restartNo").addEventListener("click", () => ask(false));
    this._$("restartYes").addEventListener("click", () => { ask(false); this._press(btn, "restart", this._t("card.restart.ok")); });
  }
  _renderSetPane() {
    for (const r of this._paneRows) {
      const e = this._st(r.def.key);
      r.row.hidden = !e;
      if (r.row.hidden) continue;
      const ic = (e && e.attributes.icon) || r.def.icon;
      if (r.icon !== ic) { r.row.querySelector(".ic").innerHTML = this._icon(ic); r.icon = ic; }
      const sub = r.def.sub ? r.def.sub(this) : "";
      if (r.subText !== sub) { r.subText = sub; r.sub.textContent = sub; r.sub.hidden = !sub; }
      if (r.btn) { r.btn.disabled = !this._online(); continue; }
      r.val.textContent = r.def.val(this);
      const tone = r.def.tone ? r.def.tone(this) : "";
      r.val.classList.toggle("bad", tone === "bad"); r.val.classList.toggle("warn", tone === "warn");
    }
    for (const r of this._paneRows) if (r.sect) r.sect.hidden = this._paneRows.every((x) => x.sect !== r.sect || x.row.hidden);
    this._updateSettings();
    this._renderDays();
  }
  /** « Réglages contrôleur » › Redémarrer: on a firmware with the Restart button, usable while the controller is online. */
  _renderRestart() {
    const restart = this._st("restart");
    this._$("restartSec").hidden = !restart;
    if (restart) {
      const ic = restart.attributes.icon || "restart";
      if (this._rsIcon !== ic) { this._$("restartIc").innerHTML = this._icon(ic); this._rsIcon = ic; }
      this._$("restartBtn").disabled = !this._online();
    }
  }
  /**
   * Closed days from the device's Daily History, plus today so far: hours filtered, the plan's mark, the pool's
   * min–max. A closed day's plan comes from Daily Plan History (firmware that has it, days closed since); a day that
   * filtered more than SHORT_TOLERANCE_H under its plan turns amber.
   */
  _renderDays() {
    const host = this._$("days");
    const key = ["history", "planHistory", "hoursToday", "hoursPlanned", "waterMin", "waterMax"].map((k) => this._s(k)).join("|") + new Date().toDateString();
    if (key === this._daysDrawn) return;
    this._daysDrawn = key;
    const closed = parseDays(this._s("history")), plans = parseDays(this._s("planHistory"));
    const t = this._t;
    const rows = [{ label: t("common.today_cap"), hours: this._n("hoursToday"), planned: this._n("hoursPlanned"), lo: this._n("waterMin"), hi: this._n("waterMax"), today: true }];
    for (let i = 1; i <= 7; i++) {
      const d = dayAgo(i);
      rows.push({ label: i === 1 ? t("common.yesterday_cap") : `${F.date(d, { weekday: "short" })} ${ddmm(d)}`, ...closed[dayKey(d)], planned: plans[dayKey(d)]?.hours });
    }
    const scale = Math.max(1, ...rows.flatMap((r) => [r.hours, r.planned]).filter(Number.isFinite));
    const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
    const water = (r) => (Number.isFinite(r.lo) && Number.isFinite(r.hi) ? `${fmt1(r.lo)}–${fmt1(r.hi)}°` : "—");
    const past = rows.filter((r) => !r.today && Number.isFinite(r.hours));
    host.innerHTML = `<div class="day head"><span></span><span>${t("card.sec.filtration")}</span><span></span><span class="w">${t("card.days.water")}</span></div>`
      + rows.map((r) => {
        const known = Number.isFinite(r.hours), short = !r.today && dayShort(r);
        return `<div class="day${r.today ? " today" : ""}${known ? "" : " missing"}${short ? " short" : ""}" title="${dayTitle(r)}">`
          + `<span class="dl">${r.label}</span><span class="bar">${known ? `<i style="width:${pct(r.hours)}"></i>` : ""}`
          + `${Number.isFinite(r.planned) && r.planned > 0 ? `<b style="left:${pct(r.planned)}"></b>` : ""}</span>`
          + `<span class="v num">${known ? `${fmt1(r.hours)} h` : "—"}</span><span class="w num">${known ? water(r) : ""}</span></div>`;
      }).join("")
      + `<p class="dfoot">${past.length
        ? t("card.days.mean", { hours: fmt1(past.reduce((a, r) => a + r.hours, 0) / past.length), count: past.length })
        : t("card.days.none")} ${t("card.days.legend")}</p>`;
  }

  /* ---------- build ---------- */
  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._use();
    const v = this._config.variant;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>${{ panel: panelHtml, settings: settingsHtml, water: waterHtml, tile: tileHtml }[v](this._t)}`;
    this._built = true;
    if (v === "panel") this._wirePanel(); else if (v === "settings") this._wireSettings(); else if (v === "water") this._wireWater(); else this._wireTile();
  }

  /** Where the light leads: `more_path`, else the controller's device page in Home Assistant (null without a device id). */
  _lightPath() {
    if (this._config.more_path) return this._config.more_path;
    const dev = this._hass && this._hass.entities && this._hass.entities[this._e.online]?.device_id;
    return dev ? `/config/devices/device/${encodeURIComponent(dev)}` : null;
  }
  /** Home Assistant's own navigation (its navigate()): a history entry, then « location-changed » for its router. */
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
    // The light: Home Assistant's device page for the controller (its link, Wi-Fi signal, disconnections), or
    // more_path; without a device id, « Réglages contrôleur »
    this._$("ctlLink").addEventListener("click", () => {
      if (this._light().h === "alarm") { // a fill running too long: « Contrôle », at its banner and « Acquitter »
        this._tab = "pump"; this._update();
        this._$("fillAlert").scrollIntoView({ block: "nearest", behavior: "smooth" });
        this._$("fillAckBtn").focus({ preventScroll: true });
        return;
      }
      const path = this._lightPath();
      if (path) { this._navigate(path); return; }
      const tab = this.shadowRoot.querySelector('#tabs [data-tab="controller"]');
      if (this._$("tabs").hidden || tab.hidden) return;
      this._tab = "controller"; this._update();
      this._$("tabs").scrollIntoView({ block: "nearest" });
      tab.focus({ preventScroll: true });
    });
    // without the recorder only Daily History's 7 days exist: no range to choose
    this._$("tRange").hidden = !this._config.recorder;
    this._wirePanes();

    const backToAuto = () => {
      if (this._pending() || !this._inOvr()) return;
      this._manual = false;
      this._local = { value: "Auto", label: this._t("card.dur.title"), done: this._t("card.cmd.auto_done"), t0: Date.now(), echoed: false };
      this._call("script", "turn_on", { entity_id: this._e.sAuto });
      this._update();
    };
    this._$("autoBtn").addEventListener("click", backToAuto);
    this._$("stuckBtn").addEventListener("click", backToAuto);
    this._$("fillAckBtn").addEventListener("click", (e) =>
      this._press(e.currentTarget, "fillAck", this._t("card.fill.acked_toast")));

    this.shadowRoot.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
      if (this._pending()) return;
      if (b.dataset.mode === "auto") { if (this._inOvr()) backToAuto(); else { this._manual = false; this._update(); } }
      else { this._manual = true; this._update(); }
    }));

    const force = (v) => {
      this._use();
      const t = this._t, min = this._timeoutMin(), time = min ? fmtT(new Date(Date.now() + min * 60000)) : null;
      const what = v === "Off" ? speedTxt("Off") : `${t("common.mode.manual")} ${speedTxt(v)}`;
      const done = v === "Off" ? t("card.cmd.off_done") : t("card.cmd.speed_done", { speed: speedTxt(v) });
      this._local = {
        value: v, t0: Date.now(), echoed: false,
        label: time ? t("card.cmd.until", { what, time }) : what,
        done: time ? t("card.cmd.done_auto", { what: done, time }) : done,
      };
      this._call("script", this._e.sForce.replace(/^script\./, ""), { vitesse: v });
      this._update();
    };
    this.shadowRoot.querySelectorAll("#speedSeg button").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.speed;
      if (this._pending() || this._freeze()) return;
      if (v === this._override()) { this._toast(this._t("card.cmd.already", { speed: speedTxt(v) })); return; }
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
      const m = +b.dataset.dur;
      if (!DURATIONS.includes(m) || m === this._timeoutMin()) return;
      // The firmware restamps its clock on this write, so during an override the new duration counts from now.
      await this._call("number", "set_value", { entity_id: this._e.timeout, value: m });
      this._use();
      if (this._inOvr()) this._toast(m ? this._t("card.cmd.auto_at", { time: fmtT(new Date(Date.now() + m * 60000)) }) : this._t("card.cmd.no_auto"));
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

    // tabs « Contrôle » / « Réglages » / « Réglages contrôleur » (arrows move between the shown ones, as in a tablist)
    this.shadowRoot.querySelectorAll("#tabs button").forEach((b) => {
      b.addEventListener("click", () => { this._tab = b.dataset.tab; this._wHover = null; this._update(); });
      b.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const tabs = [...this.shadowRoot.querySelectorAll("#tabs button:not([hidden])")], i = tabs.indexOf(b);
        const t = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        t.focus(); t.click();
      });
    });
    this._wireWater();
    this._ro.observe(box);
  }

  /** Fill water, in the panel or alone: range, and the bar under the pointer or the arrows. */
  _wireWater() {
    if (!this._config.recorder) this.shadowRoot.querySelector('#wRange [data-r="90d"]').hidden = true; // the controller keeps days and months
    if (this._config.variant === "water" && !customElements.get("ha-card")) this._$("waterCard").classList.add("plain"); // the device's page
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

    this._ro?.disconnect(); // a new setConfig rebuilds the card
    this._ro = new ResizeObserver(() => { if (this._$("tChart")) this._renderTemp(); this._renderWater(); });
    this._ro.observe(wbox);
  }

  /* ---------- update ---------- */
  _update() {
    if (!this._built || !this._hass) return;
    this._use();
    const v = this._config.variant;
    if (v === "panel") { this._loadHistory(); this._trackLive(); this._updatePanel(); }
    else if (v === "settings") this._updateSettings();
    else if (v === "water") { this.style.display = this._fillOff() ? "none" : ""; this._renderWater(); }
    else this._updateTile();
  }

  _tileSecondary() {
    const P = this._pending();
    const hrs = `${fmt1(this._n("hoursToday"))} h / ${fmt1(this._n("hoursPlanned"))} h`;
    const t = this._t;
    if (P) return [t("card.tile.sending"), "s"];
    if (!this._online()) { const L = this._light(); return [this._lightText(L), L.h === "lost" ? "s bad" : "s warn"]; }
    const fill = this._fillAlarm();
    if (fill && !fill.acked) return [this._fillText(fill), "s warn"];
    if (this._freeze()) return [`${t("card.phase.freeze", { speed: speedTxt("Low") })} · ${hrs}`, "s"];
    if (this._stuck()) return [t("card.tile.stuck", { speed: speedTxt(this._override()), duration: fmtD(this._ovrAgeMin()) }), "s bad"];
    if (this._inOvr()) {
      const u = this._ovrUntil();
      return [`${t("common.mode.manual")} ${speedTxt(this._override())} · ${u ? t("card.tile.auto_at", { time: fmtT(u) }) : t("card.tile.no_limit")}`, "s warn"];
    }
    const c = this._commanded();
    return [`${t("common.mode.auto")} · ${c === "Off" ? t("common.stopped") : speedTxt(c)} · ${hrs}`, "s"];
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
    const hm = (m) => clock(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    const sum = blocks.map(([s, e]) => `${hm(s)}–${hm(e)}`).join(" · ");
    this._$("planSum").textContent = `${fmt1(this._n("hoursPlanned"))} h · ${sum || this._t("card.plan.not_computed")}`;
    return seen;
  }

  _updatePanel() {
    const P = this._pending();
    const ph = this._phase();
    const inOvr = this._inOvr(), online = this._online(), freeze = this._freeze(), stuck = this._stuck();
    const until = this._ovrUntil();

    // « Réglages » and « Réglages contrôleur » can be turned off; the latter needs a firmware with a position, updates or
    // the Restart button
    const ctl = ["latitude", "longitude", "timezone", "firmware", "restart"].some((k) => this._st(k));
    const shown = { pump: true, settings: this._config.settings_tab, controller: this._config.settings_tab && ctl };
    if (!shown[this._tab]) this._tab = "pump";
    this._$("tabs").hidden = !shown.settings && !shown.controller;
    this.shadowRoot.querySelector(".panel").dataset.tab = this._tab;
    this.shadowRoot.querySelectorAll("#tabs button").forEach((b) => {
      const on = b.dataset.tab === this._tab;
      b.hidden = !shown[b.dataset.tab];
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    });
    if (this._tab === "settings") this._renderSetPane();
    if (this._tab === "controller") { this._renderPos(); this._renderUpdate(); this._renderRestart(); }
    this._$("waterBlk").hidden = !this._waterShown(); // « Contrôle »: the fill water, with a recorder and a meter

    this._$("ico").className = this._icoClass("ico big");
    this._$("ico").style.setProperty("--spd", this._spinSpeed());
    const st = this._$("status"); st.className = `status ${ph.cls}`; st.textContent = ph.label;
    st.hidden = this._config.controller_light && !online; // offline, the light says it
    this._renderLight();
    this._$("water").innerHTML = `${fmt1(this._n("water"))}<small>°C</small>`;
    this._$("outdoor").innerHTML = `${fmt1(this._n("outdoor"))}<small>°C</small>`;
    // the equipment pad, as a line under Outdoor: a fifth tile would break the readings' grid
    const padC = this._n("pad"), padTxt = this._$("padTxt");
    padTxt.hidden = !Number.isFinite(padC);
    padTxt.textContent = this._t("card.read.pad", { temp: fmt1(padC) });
    const hT = this._n("hoursToday"), hP = this._n("hoursPlanned");
    this._$("hours").innerHTML = `${fmt1(hT)}<small>h / ${fmt1(hP)} h</small>`;
    this._$("hoursBar").style.width = `${hP > 0 ? Math.min(100, (hT / hP) * 100) : 0}%`;
    const nextAt = this._s("nextAt"), nextTo = this._s("nextTo");
    const t = this._t;
    this._$("next").innerHTML = hhmm(nextAt) !== null ? `${clock(nextAt)}<small>→ ${speedTxt(nextTo) || "?"}</small>` : `—<small>${t("card.read.nothing_today")}</small>`;

    // alerts
    this._$("offAlert").hidden = online;
    this._$("offAlert").className = this._light().h === "lost" ? "alert" : "alert amber";
    const onl = this._st("online");
    this._$("offTxt").textContent = t("card.alert.off", { duration: onl ? fmtD((Date.now() - Date.parse(onl.last_changed)) / 60000) : "?" });
    this._$("freezeAlert").hidden = !freeze;
    this._$("freezeTxt").textContent = t("card.alert.freeze", { temp: fmt1(this._n("water")) });
    this._$("planAlert").hidden = this._s("notComputed") !== "on";
    this._$("stuckAlert").hidden = !stuck || !online;
    this._$("stuckTxt").textContent = t("card.override.stuck", { speed: speedTxt(this._override()), duration: fmtD(this._ovrAgeMin()) });
    this._$("stuckBtn").disabled = !!P;
    const fill = this._fillAlarm();
    this._$("fillAlert").hidden = !fill || !online;
    if (fill) {
      const txt = fill.since ? t(fill.acked ? "card.fill.acked_since" : "card.fill.alarm_since", { time: fmtT(fill.since), duration: fmtD(fill.min) })
        : t(fill.acked ? "card.fill.acked_over" : "card.fill.alarm_over", { duration: fmtD(fill.min) });
      if (this._$("fillTxt").textContent !== txt) this._$("fillTxt").textContent = txt;
      this._$("fillAct").hidden = fill.acked || !this._st("fillAck");
    }

    const seen = this._drawTimeline();
    this._$("legOvr").innerHTML = ["Off", "Low", "Medium", "High"].filter((v) => seen.has(v))
      .map((v) => `<span><i class="${v}"></i>${t("card.leg.forced", { speed: speedTxt(v) })}</span>`).join("");

    // big button / confirmation / tracker
    const ab = this._$("autoBtn");
    ab.hidden = !inOvr || this._confirm;
    ab.disabled = !!P;
    this._$("autoBtnTxt").textContent = until ? t("card.back_auto_now", { time: fmtT(until) }) : t("card.back_auto");
    this._$("confirm").hidden = !this._confirm;
    if (this._confirm) {
      const min = this._timeoutMin();
      this._$("confirmTxt").textContent = min ? t("card.confirm.stop_for", { duration: fmtD(min) }) : t("card.confirm.stop_nolimit");
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
    const nextTxt = hhmm(nextAt) !== null ? t("card.hint.next_at", { speed: speedTxt(nextTo), time: clock(nextAt) }) : t("card.hint.stop_at_end");
    let hint;
    if (freeze) hint = t("card.hint.freeze", { temp: fmt1(this._freezeC()) });
    else if (effMode === "auto") hint = planned === "Off"
      ? (hhmm(nextAt) !== null ? t("card.hint.following_off_at", { time: clock(nextAt) }) : t("card.hint.following_off_sunrise"))
      : t("card.hint.following", { speed: speedTxt(planned), next: nextTxt });
    else if (!inOvr) hint = t("card.hint.choose");
    else hint = `${until ? t("card.hint.suspended_until", { time: fmtT(until) }) : t("card.hint.suspended")} ${
      planned !== cmd ? t("card.hint.doing_vs", { speed: speedTxt(cmd), planned: speedTxt(planned) }) : t("card.hint.doing", { speed: speedTxt(cmd) })}`;
    this._$("modeHint").innerHTML = hint;

    // manual block
    this._$("manualBlock").hidden = effMode !== "manual";
    this.shadowRoot.querySelectorAll("#speedSeg button").forEach((b) => {
      b.setAttribute("aria-checked", String(inOvr && b.dataset.speed === this._override()));
      b.classList.toggle("going", !!L && L.value === b.dataset.speed && L.value !== this._override());
      b.disabled = !!P || freeze;
    });
    const durMin = this._timeoutMin();
    this.shadowRoot.querySelectorAll("#durSeg button").forEach((b) => { b.setAttribute("aria-checked", String(+b.dataset.dur === durMin)); b.disabled = !!P; });
    this._$("durHint").textContent = inOvr
      ? (until ? t("card.dur.back_at", { time: fmtT(until), duration: fmtD((until.getTime() - Date.now()) / 60000) }) : t("card.dur.none_running", { min: STUCK_MIN }))
      : (durMin ? t("card.dur.will_return", { duration: fmtD(durMin) }) : t("card.dur.none", { min: STUCK_MIN }));

    // footer
    const sy = this._$("sync");
    const rc = /(\d{2}:\d{2})(:\d{2})?$/.exec(this._s("recomputed") || "");
    sy.textContent = rc ? t("card.foot.computed", { time: clock(rc[1]) }) : ""; // the link: the light, the alert
    this._$("plannedTxt").textContent = t("card.foot.plan_only", { speed: speedTxt(planned) });

    this._renderTemp();
    this._renderWater();
  }
}

/**
 * IANA zone -> POSIX TZ string, for « Utiliser la position et le fuseau de Home Assistant » (PiscineCard.posixTz):
 * every name tzdata knows, zones and links, grouped by the rule in force (each TZif file's footer). Generated.
 */
/* TZ_POSIX begin: tools/tz-posix.py, tzdata 2026f, 598 zones; don't edit by hand */
const TZ_POSIX = {
  "GMT0": "Africa/Abidjan Africa/Accra Africa/Bamako Africa/Banjul Africa/Bissau Africa/Conakry Africa/Dakar Africa/Freetown Africa/Lome Africa/Monrovia Africa/Nouakchott Africa/Ouagadougou Africa/Sao_Tome Africa/Timbuktu America/Danmarkshavn Atlantic/Reykjavik Atlantic/St_Helena Etc/GMT Etc/GMT+0 Etc/GMT-0 Etc/GMT0 Etc/Greenwich GMT GMT+0 GMT-0 GMT0 Greenwich Iceland",
  "EAT-3": "Africa/Addis_Ababa Africa/Asmara Africa/Asmera Africa/Dar_es_Salaam Africa/Djibouti Africa/Kampala Africa/Mogadishu Africa/Nairobi Indian/Antananarivo Indian/Comoro Indian/Mayotte",
  "CET-1": "Africa/Algiers Africa/Tunis",
  "WAT-1": "Africa/Bangui Africa/Brazzaville Africa/Douala Africa/Kinshasa Africa/Lagos Africa/Libreville Africa/Luanda Africa/Malabo Africa/Ndjamena Africa/Niamey Africa/Porto-Novo",
  "CAT-2": "Africa/Blantyre Africa/Bujumbura Africa/Gaborone Africa/Harare Africa/Juba Africa/Khartoum Africa/Kigali Africa/Lubumbashi Africa/Lusaka Africa/Maputo Africa/Windhoek",
  "EET-2EEST,M4.5.5/0,M10.5.4/24": "Africa/Cairo Egypt",
  "<+00>0": "Africa/Casablanca Africa/El_Aaiun",
  "CET-1CEST,M3.5.0,M10.5.0/3": "Africa/Ceuta Arctic/Longyearbyen Atlantic/Jan_Mayen CET Europe/Amsterdam Europe/Andorra Europe/Belgrade Europe/Berlin Europe/Bratislava Europe/Brussels Europe/Budapest Europe/Busingen Europe/Copenhagen Europe/Gibraltar Europe/Ljubljana Europe/Luxembourg Europe/Madrid Europe/Malta Europe/Monaco Europe/Oslo Europe/Paris Europe/Podgorica Europe/Prague Europe/Rome Europe/San_Marino Europe/Sarajevo Europe/Skopje Europe/Stockholm Europe/Tirane Europe/Vaduz Europe/Vatican Europe/Vienna Europe/Warsaw Europe/Zagreb Europe/Zurich MET Poland",
  "SAST-2": "Africa/Johannesburg Africa/Maseru Africa/Mbabane",
  "EET-2": "Africa/Tripoli Europe/Kaliningrad Libya",
  "HST10HDT,M3.2.0,M11.1.0": "America/Adak America/Atka US/Aleutian",
  "AKST9AKDT,M3.2.0,M11.1.0": "America/Anchorage America/Juneau America/Metlakatla America/Nome America/Sitka America/Yakutat US/Alaska",
  "AST4": "America/Anguilla America/Antigua America/Aruba America/Barbados America/Blanc-Sablon America/Curacao America/Dominica America/Grenada America/Guadeloupe America/Kralendijk America/Lower_Princes America/Marigot America/Martinique America/Montserrat America/Port_of_Spain America/Puerto_Rico America/Santo_Domingo America/St_Barthelemy America/St_Kitts America/St_Lucia America/St_Thomas America/St_Vincent America/Tortola America/Virgin",
  "<-03>3": "America/Araguaina America/Argentina/Buenos_Aires America/Argentina/Catamarca America/Argentina/ComodRivadavia America/Argentina/Cordoba America/Argentina/Jujuy America/Argentina/La_Rioja America/Argentina/Mendoza America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan America/Argentina/San_Luis America/Argentina/Tucuman America/Argentina/Ushuaia America/Asuncion America/Bahia America/Belem America/Buenos_Aires America/Catamarca America/Cayenne America/Cordoba America/Coyhaique America/Fortaleza America/Jujuy America/Maceio America/Mendoza America/Montevideo America/Paramaribo America/Punta_Arenas America/Recife America/Rosario America/Santarem America/Sao_Paulo Antarctica/Palmer Antarctica/Rothera Atlantic/Stanley Brazil/East Etc/GMT+3",
  "EST5": "America/Atikokan America/Cancun America/Cayman America/Coral_Harbour America/Jamaica America/Panama America/Rainy_River America/Winnipeg Canada/Central EST Jamaica",
  "CST6": "America/Bahia_Banderas America/Belize America/Chihuahua America/Costa_Rica America/Edmonton America/El_Salvador America/Guatemala America/Inuvik America/Managua America/Merida America/Mexico_City America/Monterrey America/Regina America/Swift_Current America/Tegucigalpa America/Yellowknife Canada/Mountain Canada/Saskatchewan Mexico/General",
  "<-04>4": "America/Boa_Vista America/Campo_Grande America/Caracas America/Cuiaba America/Guyana America/La_Paz America/Manaus America/Porto_Velho Brazil/West Etc/GMT+4",
  "<-05>5": "America/Bogota America/Eirunepe America/Guayaquil America/Lima America/Porto_Acre America/Rio_Branco Brazil/Acre Etc/GMT+5",
  "MST7MDT,M3.2.0,M11.1.0": "America/Boise America/Cambridge_Bay America/Ciudad_Juarez America/Denver America/Shiprock MST7MDT Navajo US/Mountain",
  "CST6CDT,M3.2.0,M11.1.0": "America/Chicago America/Indiana/Knox America/Indiana/Tell_City America/Knox_IN America/Matamoros America/Menominee America/North_Dakota/Beulah America/North_Dakota/Center America/North_Dakota/New_Salem America/Ojinaga America/Rankin_Inlet America/Resolute CST6CDT US/Central US/Indiana-Starke",
  "MST7": "America/Creston America/Dawson America/Dawson_Creek America/Fort_Nelson America/Hermosillo America/Mazatlan America/Phoenix America/Vancouver America/Whitehorse Canada/Pacific Canada/Yukon MST Mexico/BajaSur US/Arizona",
  "EST5EDT,M3.2.0,M11.1.0": "America/Detroit America/Fort_Wayne America/Grand_Turk America/Indiana/Indianapolis America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Vevay America/Indiana/Vincennes America/Indiana/Winamac America/Indianapolis America/Iqaluit America/Kentucky/Louisville America/Kentucky/Monticello America/Louisville America/Montreal America/Nassau America/New_York America/Nipigon America/Pangnirtung America/Port-au-Prince America/Thunder_Bay America/Toronto Canada/Eastern EST5EDT US/East-Indiana US/Eastern US/Michigan",
  "PST8PDT,M3.2.0,M11.1.0": "America/Ensenada America/Los_Angeles America/Santa_Isabel America/Tijuana Mexico/BajaNorte PST8PDT US/Pacific",
  "AST4ADT,M3.2.0,M11.1.0": "America/Glace_Bay America/Goose_Bay America/Halifax America/Moncton America/Thule Atlantic/Bermuda Canada/Atlantic",
  "<-02>2<-01>,M3.5.0/-1,M10.5.0/0": "America/Godthab America/Nuuk America/Scoresbysund",
  "CST5CDT,M3.2.0/0,M11.1.0/1": "America/Havana Cuba",
  "<-03>3<-02>,M3.2.0,M11.1.0": "America/Miquelon",
  "<-02>2": "America/Noronha Atlantic/South_Georgia Brazil/DeNoronha Etc/GMT+2",
  "<-04>4<-03>,M9.1.6/24,M4.1.6/24": "America/Santiago Chile/Continental",
  "NST3:30NDT,M3.2.0,M11.1.0": "America/St_Johns Canada/Newfoundland",
  "<+08>-8": "Antarctica/Casey Asia/Brunei Asia/Choibalsan Asia/Irkutsk Asia/Kuala_Lumpur Asia/Kuching Asia/Singapore Asia/Ulaanbaatar Asia/Ulan_Bator Etc/GMT-8 Singapore",
  "<+07>-7": "Antarctica/Davis Asia/Bangkok Asia/Barnaul Asia/Ho_Chi_Minh Asia/Hovd Asia/Krasnoyarsk Asia/Novokuznetsk Asia/Novosibirsk Asia/Phnom_Penh Asia/Saigon Asia/Tomsk Asia/Vientiane Etc/GMT-7 Indian/Christmas",
  "<+10>-10": "Antarctica/DumontDUrville Asia/Ust-Nera Asia/Vladivostok Etc/GMT-10 Pacific/Chuuk Pacific/Port_Moresby Pacific/Truk Pacific/Yap",
  "AEST-10AEDT,M10.1.0,M4.1.0/3": "Antarctica/Macquarie Australia/ACT Australia/Canberra Australia/Currie Australia/Hobart Australia/Melbourne Australia/NSW Australia/Sydney Australia/Tasmania Australia/Victoria",
  "<+05>-5": "Antarctica/Mawson Antarctica/Vostok Asia/Almaty Asia/Aqtau Asia/Aqtobe Asia/Ashgabat Asia/Ashkhabad Asia/Atyrau Asia/Dushanbe Asia/Oral Asia/Qostanay Asia/Qyzylorda Asia/Samarkand Asia/Tashkent Asia/Yekaterinburg Etc/GMT-5 Indian/Kerguelen Indian/Maldives",
  "NZST-12NZDT,M9.5.0,M4.1.0/3": "Antarctica/McMurdo Antarctica/South_Pole NZ Pacific/Auckland",
  "<+03>-3": "Antarctica/Syowa Asia/Aden Asia/Amman Asia/Baghdad Asia/Bahrain Asia/Damascus Asia/Istanbul Asia/Kuwait Asia/Qatar Asia/Riyadh Etc/GMT-3 Europe/Istanbul Europe/Minsk Turkey",
  "<+00>0<+02>-2,M3.5.0/1,M10.5.0/3": "Antarctica/Troll",
  "<+12>-12": "Asia/Anadyr Asia/Kamchatka Etc/GMT-12 Kwajalein Pacific/Fiji Pacific/Funafuti Pacific/Kwajalein Pacific/Majuro Pacific/Nauru Pacific/Tarawa Pacific/Wake Pacific/Wallis",
  "<+04>-4": "Asia/Baku Asia/Dubai Asia/Muscat Asia/Tbilisi Asia/Yerevan Etc/GMT-4 Europe/Astrakhan Europe/Samara Europe/Saratov Europe/Ulyanovsk Indian/Mahe Indian/Mauritius Indian/Reunion",
  "EET-2EEST,M3.5.0/0,M10.5.0/0": "Asia/Beirut",
  "<+06>-6": "Asia/Bishkek Asia/Dacca Asia/Dhaka Asia/Kashgar Asia/Omsk Asia/Thimbu Asia/Thimphu Asia/Urumqi Etc/GMT-6 Indian/Chagos",
  "IST-5:30": "Asia/Calcutta Asia/Kolkata",
  "<+09>-9": "Asia/Chita Asia/Dili Asia/Khandyga Asia/Yakutsk Etc/GMT-9 Pacific/Palau",
  "CST-8": "Asia/Chongqing Asia/Chungking Asia/Harbin Asia/Macao Asia/Macau Asia/Shanghai Asia/Taipei PRC ROC",
  "<+0530>-5:30": "Asia/Colombo",
  "EET-2EEST,M3.5.0/3,M10.5.0/4": "Asia/Famagusta Asia/Nicosia EET Europe/Athens Europe/Bucharest Europe/Chisinau Europe/Helsinki Europe/Kiev Europe/Kyiv Europe/Mariehamn Europe/Nicosia Europe/Riga Europe/Sofia Europe/Tallinn Europe/Tiraspol Europe/Uzhgorod Europe/Vilnius Europe/Zaporozhye",
  "EET-2EEST,M3.4.4/50,M10.4.4/50": "Asia/Gaza Asia/Hebron",
  "HKT-8": "Asia/Hong_Kong Hongkong",
  "WIB-7": "Asia/Jakarta Asia/Pontianak",
  "WIT-9": "Asia/Jayapura",
  "IST-2IDT,M3.4.4/26,M10.5.0": "Asia/Jerusalem Asia/Tel_Aviv Israel",
  "<+0430>-4:30": "Asia/Kabul",
  "PKT-5": "Asia/Karachi",
  "<+0545>-5:45": "Asia/Kathmandu Asia/Katmandu",
  "<+11>-11": "Asia/Magadan Asia/Sakhalin Asia/Srednekolymsk Etc/GMT-11 Pacific/Bougainville Pacific/Efate Pacific/Guadalcanal Pacific/Kosrae Pacific/Noumea Pacific/Pohnpei Pacific/Ponape",
  "WITA-8": "Asia/Makassar Asia/Ujung_Pandang",
  "PST-8": "Asia/Manila",
  "KST-9": "Asia/Pyongyang Asia/Seoul ROK",
  "<+0630>-6:30": "Asia/Rangoon Asia/Yangon Indian/Cocos",
  "<+0330>-3:30": "Asia/Tehran Iran",
  "JST-9": "Asia/Tokyo Japan",
  "<-01>1<+00>,M3.5.0/0,M10.5.0/1": "Atlantic/Azores",
  "WET0WEST,M3.5.0/1,M10.5.0": "Atlantic/Canary Atlantic/Faeroe Atlantic/Faroe Atlantic/Madeira Europe/Lisbon Portugal WET",
  "<-01>1": "Atlantic/Cape_Verde Etc/GMT+1",
  "ACST-9:30ACDT,M10.1.0,M4.1.0/3": "Australia/Adelaide Australia/Broken_Hill Australia/South Australia/Yancowinna",
  "AEST-10": "Australia/Brisbane Australia/Lindeman Australia/Queensland",
  "ACST-9:30": "Australia/Darwin Australia/North",
  "<+0845>-8:45": "Australia/Eucla",
  "<+1030>-10:30<+11>-11,M10.1.0,M4.1.0": "Australia/LHI Australia/Lord_Howe",
  "AWST-8": "Australia/Perth Australia/West",
  "<-06>6<-05>,M9.1.6/22,M4.1.6/22": "Chile/EasterIsland Pacific/Easter",
  "GMT0IST,M3.5.0/1,M10.5.0": "Eire Europe/Dublin",
  "<-10>10": "Etc/GMT+10 Pacific/Rarotonga Pacific/Tahiti",
  "<-11>11": "Etc/GMT+11 Pacific/Niue",
  "<-12>12": "Etc/GMT+12",
  "<-06>6": "Etc/GMT+6 Pacific/Galapagos",
  "<-07>7": "Etc/GMT+7",
  "<-08>8": "Etc/GMT+8 Pacific/Pitcairn",
  "<-09>9": "Etc/GMT+9 Pacific/Gambier",
  "<+01>-1": "Etc/GMT-1",
  "<+13>-13": "Etc/GMT-13 Pacific/Apia Pacific/Enderbury Pacific/Fakaofo Pacific/Kanton Pacific/Tongatapu",
  "<+14>-14": "Etc/GMT-14 Pacific/Kiritimati",
  "<+02>-2": "Etc/GMT-2",
  "UTC0": "Etc/UCT Etc/UTC Etc/Universal Etc/Zulu UCT UTC Universal Zulu",
  "GMT0BST,M3.5.0/1,M10.5.0": "Europe/Belfast Europe/Guernsey Europe/Isle_of_Man Europe/Jersey Europe/London GB GB-Eire",
  "MSK-3": "Europe/Kirov Europe/Moscow Europe/Simferopol Europe/Volgograd W-SU",
  "<-00>0": "Factory",
  "HST10": "HST Pacific/Honolulu Pacific/Johnston US/Hawaii",
  "<+1245>-12:45<+1345>,M9.5.0/2:45,M4.1.0/3:45": "NZ-CHAT Pacific/Chatham",
  "ChST-10": "Pacific/Guam Pacific/Saipan",
  "<-0930>9:30": "Pacific/Marquesas",
  "SST11": "Pacific/Midway Pacific/Pago_Pago Pacific/Samoa US/Samoa",
  "<+11>-11<+12>,M10.1.0,M4.1.0/3": "Pacific/Norfolk",
};
/* TZ_POSIX end */
let TZ_BY_NAME = null;

if (!customElements.get("piscine-card")) {
  customElements.define("piscine-card", PiscineCard);
  window.customCards = window.customCards || [];
  const t = makeT(DICTS, resolveLang([document.documentElement.lang, ...(navigator.languages || [])]));
  window.customCards.push({ type: "piscine-card", name: t("card.picker.name"), description: t("card.picker.description") });
  console.info(`%c piscine-card %c ${VERSION} `, "background:#0e86c4;color:#fff", "");
}
