/*
 * Time zones for the controller (docs/plans/secret-free-firmware.md): it applies a POSIX TZ string
 * (Timezone) and only shows the IANA name beside it (Timezone Name), so whoever sets one writes both.
 * Browsers know IANA names but not their POSIX rules, hence:
 *   - posixOf(), the one IANA -> POSIX conversion the page uses: the card's full table
 *     (PiscineCard.posixTz, generated from tzdata by tools/tz-posix.py), which the page loads before
 *     this module; the list below only when the card isn't there (unit tests);
 *   - TIMEZONES, the zones a pool owner here is likely to be in, with the rule in force (each zone
 *     file's footer line, tzdata 2025): the position form's dropdown. A zone posixOf() doesn't know is
 *     typed as a POSIX string, with its name.
 */

const CET = "CET-1CEST,M3.5.0,M10.5.0/3";
const EET = "EET-2EEST,M3.5.0/3,M10.5.0/4";
const WET = "WET0WEST,M3.5.0/1,M10.5.0";
const US = ",M3.2.0,M11.1.0";

/** The dropdown's zones: [IANA name, POSIX TZ], sorted by name. */
export const TIMEZONES = [
  ["Africa/Abidjan", "GMT0"],
  ["Africa/Algiers", "CET-1"],
  ["Africa/Tunis", "CET-1"],
  ["America/Cayenne", "<-03>3"],
  ["America/Chicago", `CST6CDT${US}`],
  ["America/Denver", `MST7MDT${US}`],
  ["America/Guadeloupe", "AST4"],
  ["America/Los_Angeles", `PST8PDT${US}`],
  ["America/Martinique", "AST4"],
  ["America/Miquelon", `<-03>3<-02>${US}`],
  ["America/New_York", `EST5EDT${US}`],
  ["America/Phoenix", "MST7"],
  ["America/Toronto", `EST5EDT${US}`],
  ["Asia/Dubai", "<+04>-4"],
  ["Asia/Kolkata", "IST-5:30"],
  ["Atlantic/Canary", WET],
  ["Atlantic/Madeira", WET],
  ["Australia/Perth", "AWST-8"],
  ["Australia/Sydney", "AEST-10AEDT,M10.1.0,M4.1.0/3"],
  ["Europe/Amsterdam", CET],
  ["Europe/Andorra", CET],
  ["Europe/Athens", EET],
  ["Europe/Berlin", CET],
  ["Europe/Brussels", CET],
  ["Europe/Bucharest", EET],
  ["Europe/Budapest", CET],
  ["Europe/Copenhagen", CET],
  ["Europe/Dublin", "GMT0IST,M3.5.0/1,M10.5.0"],
  ["Europe/Helsinki", EET],
  ["Europe/Lisbon", WET],
  ["Europe/London", "GMT0BST,M3.5.0/1,M10.5.0"],
  ["Europe/Luxembourg", CET],
  ["Europe/Madrid", CET],
  ["Europe/Monaco", CET],
  ["Europe/Oslo", CET],
  ["Europe/Paris", CET],
  ["Europe/Prague", CET],
  ["Europe/Rome", CET],
  ["Europe/Stockholm", CET],
  ["Europe/Vienna", CET],
  ["Europe/Warsaw", CET],
  ["Europe/Zurich", CET],
  ["Indian/Mayotte", "EAT-3"],
  ["Indian/Reunion", "<+04>-4"],
  ["Pacific/Noumea", "<+11>-11"],
  ["Pacific/Tahiti", "<-10>10"],
  ["Pacific/Wallis", "<+12>-12"],
  ["UTC", "UTC0"],
];

/** The POSIX string of an IANA name, or null when unknown. The page's only conversion: see the header. */
export const posixOf = (name) =>
  globalThis.customElements?.get("piscine-card")?.posixTz?.(name) ?? TIMEZONES.find(([iana]) => iana === name)?.[1] ?? null;

/** A POSIX TZ string as the controller's parser takes it: std offset [dst [offset] [,rule,rule]]. */
const NAME = "(?:<[+-]?[A-Za-z0-9]+>|[A-Za-z]{3,})";
const OFFSET = "[+-]?\\d{1,2}(?::\\d{2}){0,2}";
const RULE = "(?:M\\d{1,2}\\.[1-5]\\.[0-6]|J?\\d{1,3})(?:\\/[+-]?\\d{1,3}(?::\\d{2}){0,2})?";
const POSIX_RE = new RegExp(`^${NAME}${OFFSET}(?:${NAME}(?:${OFFSET})?(?:,${RULE},${RULE})?)?$`);
export const validPosix = (text) => String(text).length <= 64 && POSIX_RE.test(String(text));

/** What the controller's Timezone Name takes (valid_zone_name in device_settings.h). */
export const validZoneName = (text) => /^[A-Za-z0-9/_+-]{1,64}$/.test(String(text));

/** This browser's IANA zone ("" when it won't say). */
export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** A POSIX string's standard offset east of UTC, in minutes ("CET-1…" -> 60: POSIX counts west as positive). */
export function posixStandardOffset(posix) {
  const m = new RegExp(`^${NAME}([+-]?)(\\d{1,2})(?::(\\d{2}))?`).exec(String(posix));
  if (!m) return 0;
  return (m[1] === "-" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/**
 * "HH:MM" of `date` in a zone: by its IANA name when this browser knows it (summer time included),
 * else by the POSIX string's standard offset.
 */
export function clockIn(date, name, posix, locale = "fr-FR") {
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (name) {
    try {
      return date.toLocaleTimeString(locale, { ...opts, timeZone: name });
    } catch {
      // not a zone this browser knows: the POSIX offset below
    }
  }
  const shifted = new Date(date.getTime() + posixStandardOffset(posix) * 60000);
  return shifted.toLocaleTimeString(locale, { ...opts, timeZone: "UTC" });
}
