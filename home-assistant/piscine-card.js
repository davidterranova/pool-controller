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
 *   30 j   the same two sensors' long-term statistics (state_class since firmware 2026-11-17), each day read
 *          from its 23:00 hourly row: Min Today only falls and Max Today only rises within a day, so that row
 *          holds the day's final values, while HA's 00:00 hour still carries yesterday's until the reset.
 * `recorder: false` (the device's own page) leaves only 7 j, which the device keeps itself.
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
  endsAt: "sensor.piscine_pool_controller_manual_override_ends_at",
  sForce: "script.piscine_forcer_vitesse",
  sAuto: "script.piscine_retour_auto",
};
const SPEEDS = { Off: "Arrêt", Low: "Low", Medium: "Medium", High: "High" };
const DURATIONS = [["30 min", 30], ["1 h", 60], ["2 h", 120], ["Jamais", 0]];
const FREEZE_C = 3;       // firmware: below this the pump is forced to Low, whatever the override
const STUCK_MIN = 30;     // firmware: Manual Override Active after this long off Auto
const CMD_TIMEOUT = 15000;
const MORE_PATH = "/dashboard-piscine/0";
const H_MS = 3600000, M_MS = 60000;
const POOL_AFTER_MIN = 10; // firmware: a reading counts as the pool after this long pumping (Pool Water Min/Max Today)
const T_STEP_MIN = 5;      // 24 h curve: one point per 5 min, the sensor's own pace
const T_RANGES = { "24h": "24 h", "7d": "7 j", "30d": "30 j" };
const WD = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MO = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

const ICONS = {
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
ha-card.tile { display:flex; align-items:center; gap:12px; padding:12px; cursor:pointer; height:100%;
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
.temp-h { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.temp-h .lbl { margin:0; }
.seg.mini { display:inline-grid; grid-template-columns:repeat(3,auto); border-radius:10px; padding:3px; gap:2px; }
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
.chart .rng.today { opacity:1; } .chart .rng.hov { opacity:.8; }
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

/* Wide panel (Bubble popup_mode: adaptive-dialog on a screen, width_desktop 760px): day plan and pool
   temperature across the full width under the header (24 h on ~700 px), then readings/alerts/Auto on the left,
   Pilotage and the manual controls on the right. Phones never reach 680 px. */
@container (min-width: 680px) {
  .panel { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 28px; align-items:start; padding:6px 6px 4px; }
  .sh-head, .foot, .plan, .temp { grid-column:1 / -1; }
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
    <div class="t"><h3>Pompe piscine</h3><span class="status" id="status"></span></div>
    <button class="x" id="close" aria-label="Fermer">${svg("close")}</button>
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
  <button class="link" id="more"><span>Planning, réglages et remplissage</span>${svg("chevron")}</button>
  </div>
  <div class="foot"><span class="num" id="sync"></span><span class="num" id="plannedTxt"></span></div>
  <div class="toast" id="toast" role="status"></div>
</div>`;

const TILE_HTML = `
<ha-card class="tile" id="tile" role="button" tabindex="0" aria-haspopup="dialog">
  <span class="ico" id="ico">${svg("pump")}</span>
  <span class="txt"><span class="p">Pompe piscine</span><span class="s" id="sec"></span></span>
  <span class="val num" id="val"></span>
  <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS.chevron}"/></svg>
</ha-card>`;

class PiscineCard extends HTMLElement {
  setConfig(config) {
    const variant = config.variant || "tile";
    if (!["tile", "panel"].includes(variant)) throw new Error("variant must be tile or panel");
    this._config = { variant, layout: config.layout || "horizontal", popup_hash: config.popup_hash || "#piscine", more_path: config.more_path || MORE_PATH,
      recorder: config.recorder !== false };
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
    this._stats = null;        // 30 j: { "YYYY-MM-DD": {lo, hi} } from the statistics
    this._statsAt = 0; this._statsLoading = false; this._statsErr = false;
    this._tVer = 0; this._tDrawn = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this.toggleAttribute("dark", !!(hass.themes && hass.themes.darkMode));
    this._update();
  }
  connectedCallback() {
    this._timer = setInterval(() => this._hass && this._update(), 1000);
    if (this._ro && this._built) this._ro.observe(this._$("tChart"));
  }
  disconnectedCallback() { clearInterval(this._timer); clearTimeout(this._toastTimer); this._ro?.disconnect(); }

  getCardSize() { return this._config.variant === "panel" ? 15 : 1; }
  getGridOptions() {
    if (this._config.variant === "panel") return { columns: "full", rows: "auto" };
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
  /** 30 j: hourly statistics of Pool Water Min/Max Today, at most once an hour, only while that range is shown. */
  _loadStats() {
    if (!this._config.recorder || this._statsLoading || Date.now() - this._statsAt < H_MS) return;
    this._statsLoading = true;
    const { waterMin, waterMax } = this._e;
    this._hass.callWS({ type: "recorder/statistics_during_period", start_time: dayAgo(30).toISOString(),
      statistic_ids: [waterMin, waterMax], period: "hour", types: ["min", "max"] })
      .then((r) => {
        // Only the 23:00 row of each day: Min Today only falls and Max Today only rises within a day, so it holds
        // the day's final values. HA's daily min/max would not do: its 00:00 hour still has yesterday's value.
        const out = {};
        const take = (id, type, field) => {
          for (const row of (r && r[id]) || []) {
            const d = new Date(typeof row.start === "number" ? row.start : Date.parse(row.start));
            if (d.getHours() !== 23 || !Number.isFinite(row[type])) continue;
            (out[dayKey(d)] ||= { lo: NaN, hi: NaN })[field] = row[type];
          }
        };
        take(waterMin, "min", "lo");
        take(waterMax, "max", "hi");
        this._stats = out; this._statsErr = false;
      })
      .catch((err) => { console.warn("piscine-card: temperature statistics unavailable", err); this._stats = {}; this._statsErr = true; })
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
  _freeze() { const w = this._n("water"); return Number.isFinite(w) && w < FREEZE_C; }
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
    if (!this._online()) return { label: "Hors ligne", cls: "danger" };
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
  /** n days, oldest first, today last: Daily History, else (30 j) the statistics; today from Min/Max Today. */
  _tempDays(n) {
    const hist = parseDays(this._s("history")), stats = this._stats || {}, out = [];
    for (let ago = n - 1; ago >= 1; ago--) {
      const date = dayAgo(ago), k = dayKey(date), h = hist[k], s = stats[k];
      const src = h && Number.isFinite(h.lo) && Number.isFinite(h.hi) ? h : s;
      out.push({ ago, date, lo: src ? src.lo : NaN, hi: src ? src.hi : NaN, hours: h ? h.hours : NaN });
    }
    out.push({ ago: 0, date: dayAgo(0), lo: this._n("waterMin"), hi: this._n("waterMax"), hours: this._n("hoursToday") });
    return out.map((d) => ({ ...d, known: Number.isFinite(d.lo) && Number.isFinite(d.hi) }));
  }

  _renderTemp() {
    const box = this._$("tChart");
    if (!box) return;
    const range = this._range, rec = this._config.recorder;
    this.shadowRoot.querySelectorAll("#tRange button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === range)));
    if (range === "30d") this._loadStats();
    const W = box.clientWidth, H = box.clientHeight;
    if (!W) return; // not laid out: the pop-up is closed
    const now = Date.now();
    const key = [range, this._tHover, W, H, this._tVer, Math.floor(now / M_MS),
      ...["water", "waterMin", "waterMax", "history", "hoursToday"].map((k) => this._s(k))].join("|");
    if (key === this._tDrawn) return;
    this._tDrawn = key;

    const svg = this._$("tSvg"), tip = this._$("tTip"), empty = this._$("tEmpty"), sum = this._$("tSum"), leg = this._$("tLeg");
    const showEmpty = (msg, summary = "") => {
      empty.hidden = false; empty.textContent = msg; svg.innerHTML = ""; tip.hidden = true;
      sum.innerHTML = summary; leg.innerHTML = ""; box.setAttribute("aria-label", msg);
    };
    const nowTxt = `<b>${fmt1(this._n("water"))} °C</b> maintenant`;
    if (!rec && range !== "7d") {
      return showEmpty(`Pas d'historique sur le contrôleur : ${range === "24h" ? "la courbe des 24 h est" : "les 30 jours sont"} dans Home Assistant. Les 7 derniers jours, eux, sont gardés par le contrôleur.`, nowTxt);
    }
    if (range === "24h" && !this._wHist) return showEmpty("Chargement de l'historique…", nowTxt);
    if (range === "30d" && !this._stats) return showEmpty("Chargement des statistiques…", nowTxt);
    empty.hidden = true;

    const L = 8, R = W - 34, TOP = 10, BOT = H - 20;
    const yScale = (vals, top, bot) => {
      let lo = Math.floor((Math.min(...vals) - 0.1) * 2) / 2, hi = Math.ceil((Math.max(...vals) + 0.1) * 2) / 2;
      if (hi - lo < 1) { const m = (hi + lo) / 2; lo = Math.floor((m - 0.5) * 2) / 2; hi = lo + 1; } // a flat day isn't a storm
      const step = hi - lo > 2.5 ? 1 : 0.5, y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
      let g = "";
      for (let v = lo; v <= hi + 1e-9; v += step)
        g += `<line class="gl" x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}"/><text x="${R + 5}" y="${y(v) + 3.5}">${fmt1(v)}°</text>`;
      return { y, grid: g };
    };
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
          hov.ok ? "bassin, pompe en marche" : hov.on ? `pompe en marche depuis moins de ${POOL_AFTER_MIN} min` : "tuyau, pompe arrêtée"}`;
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
      leg.innerHTML = `<span><i class="k-pool"></i>Bassin (pompe en marche depuis ${POOL_AFTER_MIN} min)</span><span><i class="k-pipe"></i>Tuyau, pompe arrêtée</span><span><i class="k-band"></i>Filtration</span>`;
      box.setAttribute("aria-label", `Température du bassin sur 24 h, de ${fmt1(Math.min(...vals))} à ${fmt1(Math.max(...vals))} °C`);
    } else {
      const n = range === "30d" ? 30 : 7, days = this._tempDays(n), cw = (R - L) / n, cx = (i) => L + cw * (i + 0.5);
      const bw = Math.min(12, cw - 3), rx = Math.min(4, bw / 2); // 30 bars on a phone: ~7 px each, 3 px apart
      const known = days.filter((d) => d.known), vals = known.flatMap((d) => [d.lo, d.hi]);
      const sc = yScale(vals.length ? vals : [Number.isFinite(this._n("water")) ? this._n("water") : 20], TOP + 6, BOT - 6);
      g += sc.grid;
      const label = (d) => (d.ago === 0 ? "auj." : n <= 7 ? WD[d.date.getDay()] : d.ago % 7 ? "" : `${d.date.getDate()} ${MO[d.date.getMonth()]}`);
      const long = (d) => `${d.ago === 0 ? "aujourd'hui" : WD[d.date.getDay()]} ${d.date.getDate()} ${MO[d.date.getMonth()]}`;
      days.forEach((d, i) => {
        g += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle">${label(d)}</text>`;
        if (!d.known) { // a dash on 7 days; on 30, a row of them before the statistics start would be noise
          if (n <= 7) g += `<text x="${cx(i)}" y="${(TOP + BOT) / 2}" text-anchor="middle">–</text>`;
          return;
        }
        const y1 = sc.y(d.hi), y2 = Math.max(sc.y(d.lo), y1 + 4);
        g += `<rect class="rng${d.ago === 0 ? " today" : ""}${this._tHover === i ? " hov" : ""}" x="${cx(i) - bw / 2}" y="${y1}" width="${bw}" height="${y2 - y1}" rx="${rx}"/>`;
        if (d.ago === 0) g += `<text class="vl" x="${cx(i)}" y="${y1 - 4}" text-anchor="middle">${fmt1(d.hi)}</text><text class="vl" x="${cx(i)}" y="${y2 + 11}" text-anchor="middle">${fmt1(d.lo)}</text>`;
      });
      const hd = this._tHover !== null ? days[this._tHover] : null;
      if (hd) {
        tip.innerHTML = "<b></b><span></span>";
        tip.querySelector("b").textContent = hd.known ? `${fmt1(hd.lo)} – ${fmt1(hd.hi)} °C` : "Pas de mesure";
        tip.querySelector("span").textContent = long(hd) + (Number.isFinite(hd.hours) ? ` · ${fmt1(hd.hours)} h de filtration` : "");
        hovX = cx(this._tHover);
      }
      let s = known.length ? `<b>${fmt1(Math.min(...known.map((d) => d.lo)))} – ${fmt1(Math.max(...known.map((d) => d.hi)))} °C</b> sur ${n} jours, pompe en marche`
        : "Pas encore de mesure";
      if (range === "30d" && this._statsErr) s += "<span>Statistiques de Home Assistant indisponibles : seuls les 7 derniers jours sont connus.</span>";
      else if (range === "30d" && known.length < n) s += `<span>${known.length} jour${known.length > 1 ? "s" : ""} mesuré${known.length > 1 ? "s" : ""} sur ${n}.</span>`;
      sum.innerHTML = s;
      leg.innerHTML = `<span><i class="k-rng"></i>Min – max du jour, pompe en marche depuis ${POOL_AFTER_MIN} min</span>`;
      box.setAttribute("aria-label", `Température du bassin, min et max des ${n} derniers jours : ${days.map((d) => `${long(d)} ${d.known ? `${fmt1(d.lo)} à ${fmt1(d.hi)} °C` : "pas de mesure"}`).join(", ")}`);
    }
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = g;
    tip.hidden = hovX === null;
    // Beside the crosshair, on the side with room, so it never hides the point being read nor the y labels.
    if (hovX !== null) { const tw = tip.offsetWidth; tip.style.left = `${Math.min(Math.max(4, hovX > W / 2 ? hovX - tw - 10 : hovX + 10), W - tw - 4)}px`; }
  }

  /* ---------- build ---------- */
  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const panel = this._config.variant === "panel";
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>${panel ? PANEL_HTML : TILE_HTML}`;
    this._built = true;
    if (panel) this._wirePanel(); else this._wireTile();
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
    this._$("more").addEventListener("click", () => this._navigate(this._config.more_path));

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
    const days = () => (this._range === "30d" ? 30 : 7);
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
    this._ro?.disconnect(); // a new setConfig rebuilds the panel
    this._ro = new ResizeObserver(() => this._renderTemp());
    this._ro.observe(box);
  }

  /* ---------- update ---------- */
  _update() {
    if (!this._built || !this._hass) return;
    if (this._config.variant === "panel") { this._loadHistory(); this._trackLive(); }
    if (this._config.variant === "panel") this._updatePanel(); else this._updateTile();
  }

  _tileSecondary() {
    const P = this._pending();
    const hrs = `${fmt1(this._n("hoursToday"))} h / ${fmt1(this._n("hoursPlanned"))} h`;
    if (P) return ["Envoi au contrôleur…", "s"];
    if (!this._online()) { const o = this._st("online"); return [`Hors ligne depuis ${o ? fmtD((Date.now() - Date.parse(o.last_changed)) / 60000) : "?"}`, "s bad"]; }
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
    if (this._stuck() || !this._online()) { const d = document.createElement("span"); d.className = "dot"; ico.appendChild(d); }
    const [sec, cls] = this._tileSecondary();
    this._$("sec").textContent = sec; this._$("sec").className = cls;
    this._$("val").textContent = `${fmt1(this._n("water"))} °C`;
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

    this._$("ico").className = this._icoClass("ico big");
    this._$("ico").style.setProperty("--spd", this._spinSpeed());
    const st = this._$("status"); st.className = `status ${ph.cls}`; st.textContent = ph.label;
    this._$("water").innerHTML = `${fmt1(this._n("water"))}<small>°C</small>`;
    this._$("outdoor").innerHTML = `${fmt1(this._n("outdoor"))}<small>°C</small>`;
    const hT = this._n("hoursToday"), hP = this._n("hoursPlanned");
    this._$("hours").innerHTML = `${fmt1(hT)}<small>h / ${fmt1(hP)} h</small>`;
    this._$("hoursBar").style.width = `${hP > 0 ? Math.min(100, (hT / hP) * 100) : 0}%`;
    const nextAt = this._s("nextAt"), nextTo = this._s("nextTo");
    this._$("next").innerHTML = hhmm(nextAt) !== null ? `${nextAt}<small>→ ${SPEEDS[nextTo] || nextTo || "?"}</small>` : `—<small>plus rien aujourd'hui</small>`;

    // alerts
    this._$("offAlert").hidden = online;
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
    if (freeze) hint = `Hors gel : le contrôleur impose Low tant que le bassin est sous ${FREEZE_C} °C. Le pilotage reprendra ensuite.`;
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
    sy.textContent = online ? `Contrôleur en ligne${rc ? " · plan calculé à " + rc[1] : ""}`
      : `Contrôleur injoignable depuis ${onl ? fmtD((Date.now() - Date.parse(onl.last_changed)) / 60000) : "?"}`;
    sy.className = "num" + (online ? "" : " stale");
    this._$("plannedTxt").textContent = `Plan seul : ${SPEEDS[planned]}`;

    this._renderTemp();
  }
}

if (!customElements.get("piscine-card")) {
  customElements.define("piscine-card", PiscineCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "piscine-card", name: "Pompe piscine", description: "Tile and panel for the pool pump (Pool Controller)" });
  console.info(`%c piscine-card %c ${VERSION} `, "background:#0e86c4;color:#fff", "");
}
