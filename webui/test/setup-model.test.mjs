// node --test webui/test/ (make webui-test): the setup's pure logic and the time zone table.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETUP_ITEMS, parseSetupState, nextStep, andList, parseDetectedProbes, probeTrend, passwordProblem,
  validApiKey, parseDegrees, degreesInput, sunTimes,
} from "../setup-model.js";
import { TIMEZONES, posixOf, validPosix, validZoneName, posixStandardOffset, clockIn } from "../timezones.js";

test("Setup State: configured, the missing items in the wizard's order, or unknown", () => {
  assert.deepEqual(parseSetupState("configured"), []);
  assert.deepEqual(parseSetupState("page_password,wifi,position,probes,api_key"), SETUP_ITEMS);
  assert.deepEqual(parseSetupState("api_key,wifi"), ["wifi", "api_key"]);
  assert.deepEqual(parseSetupState("wifi,some_future_item"), ["wifi"]);
  for (const t of [undefined, "", "unknown", "unavailable"]) assert.equal(parseSetupState(t), null);
});

test("next step: the first missing one after the current, else from the start, 6 when none", () => {
  assert.equal(nextStep(SETUP_ITEMS), 1);
  assert.equal(nextStep(["page_password", "wifi", "api_key"], 1), 2);
  assert.equal(nextStep(["page_password", "wifi", "api_key"], 2), 5); // after a factory reset: Position, Sondes skipped
  assert.equal(nextStep(["page_password"], 3), 1);
  assert.equal(nextStep([], 5), 6);
  assert.equal(andList(["a"]), "a");
  assert.equal(andList(["a", "b", "c"]), "a, b et c");
});

test("Detected Probes: addresses as written, readings, no answer, none", () => {
  assert.deepEqual(parseDetectedProbes("52000000518fe928: 13.6, ff00000026007028: --, 8A00000012345628: -2.5"), [
    { address: "52000000518fe928", celsius: 13.6 },
    { address: "ff00000026007028", celsius: NaN },
    { address: "8A00000012345628", celsius: -2.5 },
  ]);
  assert.deepEqual(parseDetectedProbes("--"), []);
  assert.deepEqual(parseDetectedProbes(undefined), []);
});

test("probe trend: a hand warms it, then it cools; small noise says nothing", () => {
  assert.equal(probeTrend([14.9, 15.0, 14.9]), "");
  assert.equal(probeTrend([14.9, 16.2, 18.4]), "up");
  assert.equal(probeTrend([14.9, 18.4, 18.4]), "up");
  assert.equal(probeTrend([14.9, 18.4, 17.1]), "down");
  assert.equal(probeTrend([15]), "");
});

test("passwords: 8 to 64 characters, typed twice", () => {
  assert.match(passwordProblem("short", "short"), /8 caractères/);
  assert.match(passwordProblem("x".repeat(65), "x".repeat(65)), /64 caractères/);
  assert.match(passwordProblem("longenough", "longenougH"), /diffèrent/);
  assert.equal(passwordProblem("longenough", "longenough"), null);
});

test("API key: base64 of 32 bytes, not all zero", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  assert.equal(validApiKey(key), true);
  assert.equal(validApiKey(Buffer.alloc(32).toString("base64")), false);
  assert.equal(validApiKey(Buffer.alloc(31, 7).toString("base64")), false);
  assert.equal(validApiKey(key.slice(0, 42) + "B="), false); // trailing bits set: not what a 32-byte key encodes to
  assert.equal(validApiKey(""), false);
});

test("degrees: comma or point, rounded to 0.01", () => {
  assert.equal(parseDegrees("48,8566"), 48.86);
  assert.equal(parseDegrees(" -2.35 "), -2.35);
  assert.equal(parseDegrees("abc"), null);
  assert.equal(parseDegrees(""), null);
  assert.equal(degreesInput(2.3), "2,30");
  assert.equal(degreesInput(NaN), "");
});

test("sunrise and sunset: plausible at mid-latitude, polar in the far north", () => {
  const { rise, set } = sunTimes(48.85, 2.35, new Date(Date.UTC(2026, 5, 21)));
  const local = clockIn(rise, "Europe/Paris", "CET-1CEST,M3.5.0,M10.5.0/3");
  assert.ok(local >= "05:42" && local <= "05:52", `Paris's sunrise on 21 June is about 05:47 (got ${local})`);
  assert.ok(set - rise > 16 * 3600e3 && set - rise < 16.5 * 3600e3, "about 16 h of day at the June solstice");
  assert.deepEqual(sunTimes(78, 15, new Date(Date.UTC(2026, 11, 21))), { polar: "nuit" });
  assert.deepEqual(sunTimes(78, 15, new Date(Date.UTC(2026, 5, 21))), { polar: "jour" });
});

test("time zones: the table's rules parse, names are what the firmware takes", () => {
  for (const [name, posix] of TIMEZONES) {
    assert.ok(validPosix(posix), `${name}: ${posix}`);
    assert.ok(validZoneName(name), name);
  }
  const names = TIMEZONES.map(([name]) => name);
  assert.deepEqual(names, [...names].sort(), "sorted by name");
  assert.equal(posixOf("Europe/Paris"), "CET-1CEST,M3.5.0,M10.5.0/3");
  assert.equal(posixOf("Mars/Olympus_Mons"), null);
  for (const bad of ["", "CET", "Paris", "CET-1CEST,M3.5.0", "x".repeat(65)]) assert.equal(validPosix(bad), false, bad);
  assert.equal(validZoneName(""), false);
  assert.equal(validZoneName("Europe/Paris "), false);
  assert.equal(posixStandardOffset("CET-1CEST,M3.5.0,M10.5.0/3"), 60);
  assert.equal(posixStandardOffset("IST-5:30"), 330);
  assert.equal(posixStandardOffset("<-03>3"), -180);
  assert.equal(clockIn(new Date(Date.UTC(2026, 0, 1, 12, 0)), "", "IST-5:30"), "17:30");
  assert.equal(clockIn(new Date(Date.UTC(2026, 6, 1, 12, 0)), "Europe/Paris", ""), "14:00");
});
