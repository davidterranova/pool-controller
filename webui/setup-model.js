/*
 * The setup's logic, without the DOM or the device (setup.js draws from it): what Setup State and
 * Detected Probes say, which wizard step comes next, what the page checks before it writes a setting,
 * and today's sunrise and sunset, the position step's sanity check.
 */

/** Setup State's items, in the wizard's order: one item per step (step n = item n - 1). */
export const SETUP_ITEMS = ["page_password", "wifi", "position", "probes", "api_key"];

/**
 * Setup State ("configured", or the missing items: "page_password,wifi,…") -> the missing items in
 * the wizard's order ([] once configured), or null while the device hasn't said.
 */
export function parseSetupState(text) {
  const t = String(text ?? "").trim();
  if (!t || t === "unknown" || t === "unavailable") return null;
  if (t === "configured") return [];
  const listed = t.split(",").map((item) => item.trim());
  return SETUP_ITEMS.filter((item) => listed.includes(item));
}

/** The step (1-5) of the first missing item after step `after`, else from the start; 6 when none is missing. */
export function nextStep(missing, after = 0) {
  const steps = SETUP_ITEMS.map((item, i) => (missing.includes(item) ? i + 1 : 0)).filter(Boolean);
  return steps.find((n) => n > after) ?? steps[0] ?? 6;
}

/** "a", "a et b", "a, b et c". */
export const andList = (items) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;

/**
 * Detected Probes ("52000000518fe928: 13.6, ff00000026007028: --", or "--" for none) ->
 * [{address, celsius}], in the device's order; celsius is NaN for a probe that didn't answer.
 * The address is kept as the device wrote it: it is also the role selects' option.
 */
export function parseDetectedProbes(text) {
  return [...String(text ?? "").matchAll(/([0-9A-Fa-f]{16}): (-?\d+(?:\.\d+)?|--)/g)]
    .map((m) => ({ address: m[1], celsius: m[2] === "--" ? NaN : Number(m[2]) }));
}

/** "…e928": enough of an address to tell probes apart in a sentence. */
export const shortAddress = (address) => `…${String(address).slice(-4)}`;

/**
 * Whether a probe is being warmed in a hand (the way to tell probes apart): from its last readings,
 * oldest first, "up" while it climbs, "down" once it cools back, "" when it stays within 1 °C.
 */
export function probeTrend(readings) {
  const r = readings.filter(Number.isFinite);
  if (r.length < 2 || Math.max(...r) - Math.min(...r) < 1) return "";
  const last = r[r.length - 1];
  const prev = r.slice(0, -1).reverse().find((v) => v !== last);
  if (prev === undefined) return "";
  return last > prev ? "up" : "down";
}

/** What's wrong with a new password and its confirmation (the firmware takes 8 to 64 characters), or null. */
export function passwordProblem(password, confirmation) {
  if (password.length < 8) return "Mot de passe : 8 caractères au moins.";
  if (password.length > 64) return "Mot de passe : 64 caractères au plus.";
  if (password !== confirmation) return "Les deux saisies diffèrent.";
  return null;
}

/**
 * An API key as the firmware takes it (decode_api_key): base64 of 32 bytes, 44 characters ending in
 * one « = », not all zero.
 */
export function validApiKey(text) {
  if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(String(text))) return false;
  return [...atob(text)].some((c) => c !== "\0");
}

/** Degrees typed with a comma or a point -> rounded to 0.01° (as the controller keeps them), or null. */
export function parseDegrees(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (!/^[+-]?\d+(\.\d*)?$|^[+-]?\.\d+$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}

/** 43.3 -> "43,30" (an input's value), NaN -> "". */
export const degreesInput = (v) => (Number.isFinite(v) ? v.toFixed(2).replace(".", ",") : "");

/** Schedule Waiting For -> what the plan waits for, in a sentence ("Le plan attend …"). */
export const WAITING_FOR = {
  position: "la position",
  timezone: "le fuseau horaire",
  clock: "l'heure",
  "pool probe": "la sonde du bassin",
  "pool temperature": "une mesure de la sonde du bassin",
  "sunrise/sunset": "le lever et le coucher du soleil",
};

/**
 * Sunrise and sunset on `date`'s day (UTC), from NOAA's approximation: {rise, set} as Dates, or
 * {polar: "jour" | "nuit"} when the sun doesn't rise or set. A minute or two off: a sanity check.
 */
export function sunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayOfYear = Math.round((midnight - Date.UTC(date.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1) return { polar: "nuit" };
  if (cosH < -1) return { polar: "jour" };
  const ha = Math.acos(cosH) / rad;
  const at = (minutes) => new Date(midnight + minutes * 60000);
  return { rise: at(720 - 4 * (lon + ha) - eqTime), set: at(720 - 4 * (lon - ha) - eqTime) };
}
