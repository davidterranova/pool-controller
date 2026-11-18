// Host tests for fill_meter.h (fills, the long-fill alarm and its
// acknowledgement, the pulse test): `make firmware-test` compiles and runs
// them in the ESPHome image.
#include "../../fill_meter.h"

#include <cstdio>
#include <string>

using namespace pool_fill;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

static const uint32_t MIN = 60000;

// A litre every `every_ms` from `from` up to (not including) `to`.
static Events pour(State &s, bool &detected, uint32_t from, uint32_t to, uint32_t every_ms) {
  Events all;
  for (uint32_t t = from; t < to; t += every_ms) {
    Events e = on_litres(s, detected, t, 1);
    all.fill_started |= e.fill_started;
    all.fill_ended |= e.fill_ended;
    all.alarm_off |= e.alarm_off;
    all.detected |= e.detected;
  }
  return all;
}

static void test_fill_runs_and_ends() {
  State s;
  bool det = true;
  Events e = on_litres(s, det, 1000, 1);
  EXPECT(e.fill_started && s.running && s.started_ms == 1000);
  e = on_litres(s, det, 1000 + 4 * MIN, 1);  // 4 min later: same fill
  EXPECT(!e.fill_started && s.fill_litres == 2);
  e = tick(s, det, 1000 + 8 * MIN, 60);  // 4 min since the last litre
  EXPECT(s.running && !e.fill_ended);
  e = tick(s, det, 1000 + 9 * MIN, 60);  // 5 min: over
  EXPECT(!s.running && e.fill_ended && e.ended_litres == 2 && e.ended_duration_ms == 4 * MIN);
  e = on_litres(s, det, 1000 + 10 * MIN, 1);
  EXPECT(e.fill_started && s.started_ms == 1000 + 10 * MIN && s.fill_litres == 1);
}

static void test_slow_leak_is_not_a_fill() {
  State s;
  bool det = true;
  on_litres(s, det, 0, 1);
  Events e = on_litres(s, det, 6 * MIN, 1);  // 1 L every 6 min
  EXPECT(e.fill_started && s.started_ms == 6 * MIN);
}

static void test_alarm() {
  State s;
  bool det = true;
  pour(s, det, 0, 59 * MIN, 4000);
  Events e = tick(s, det, 59 * MIN, 60);
  EXPECT(!s.too_long && !e.alarm_on);
  pour(s, det, 59 * MIN, 61 * MIN, 4000);
  e = tick(s, det, 61 * MIN, 60);
  EXPECT(s.too_long && e.alarm_on);
  e = tick(s, det, 61 * MIN + 30000, 60);
  EXPECT(s.too_long && !e.alarm_on);  // once
  // Fill Alarm After set to 0 while it's on: off.
  e = tick(s, det, 61 * MIN + 30000, 0);
  EXPECT(!s.too_long && e.alarm_off);
}

static void test_acknowledge() {
  State s;
  bool det = true;
  EXPECT(!acknowledge(s));  // no alarm
  pour(s, det, 0, 6 * MIN, 4000);
  tick(s, det, 6 * MIN, 5);
  EXPECT(s.too_long);
  EXPECT(acknowledge(s) && s.acked);
  EXPECT(!acknowledge(s));  // already
  tick(s, det, 6 * MIN + 30000, 5);
  EXPECT(s.too_long && s.acked);  // still on, still acknowledged
  // The fill ends: alarm and acknowledgement go.
  Events e = tick(s, det, 6 * MIN + 5 * MIN, 5);
  EXPECT(e.fill_ended && e.alarm_off && !s.too_long && !s.acked);
  // The next long fill alarms again.
  uint32_t t0 = 20 * MIN;
  pour(s, det, t0, t0 + 6 * MIN, 4000);
  e = tick(s, det, t0 + 6 * MIN, 5);
  EXPECT(e.alarm_on && s.too_long && !s.acked);
}

static void test_gap_seen_by_a_pulse_first() {
  // The tick hasn't run since the gap: the next litre ends the old fill (and
  // its alarm) before opening a new one.
  State s;
  bool det = true;
  pour(s, det, 0, 6 * MIN, 4000);
  tick(s, det, 6 * MIN, 5);
  EXPECT(s.too_long);
  Events e = on_litres(s, det, 12 * MIN, 1);
  EXPECT(e.fill_ended && e.alarm_off && e.fill_started && !s.too_long && !s.acked);
  EXPECT(e.ended_litres == 90 && e.ended_duration_ms == 6 * MIN - 4000);
}

static void test_pulse_test() {
  State s;
  bool det = false;
  start_test(s, 1000);
  EXPECT(status(true, det, s) == Status::LISTENING);
  on_litres(s, det, 2000, 1);
  on_litres(s, det, 6000, 1);
  EXPECT(!det && s.listening);
  Events e = on_litres(s, det, 10000, 1);
  EXPECT(det && e.detected && !s.listening);
  EXPECT(status(true, det, s) == Status::DETECTED);

  // A test that hears too little fails, and the meter is no longer proven.
  start_test(s, 20 * MIN);
  on_litres(s, det, 20 * MIN + 1000, 2);
  e = tick(s, det, 20 * MIN + DETECT_WINDOW_MS - 1, 60);
  EXPECT(s.listening && !e.test_failed);
  e = tick(s, det, 20 * MIN + DETECT_WINDOW_MS, 60);
  EXPECT(e.test_failed && !s.listening && !det);
  EXPECT(status(true, det, s) == Status::NOT_DETECTED);

  // Window across the millis() wrap.
  State w;
  bool d2 = false;
  start_test(w, 0xFFFFFFFFu - 1000);
  Events f = tick(w, d2, 0xFFFFFFFFu - 500, 60);
  EXPECT(w.listening && !f.test_failed);
  f = tick(w, d2, DETECT_WINDOW_MS, 60);
  EXPECT(!w.listening && f.test_failed);
}

static void test_a_fill_proves_the_meter() {
  State s;
  bool det = false;
  EXPECT(status(true, det, s) == Status::UNTESTED);
  Events e = pour(s, det, 0, 12000, 4000);  // 3 L in 12 s, no test
  EXPECT(det && e.detected);
  // Not when the 3 L come later than the window into the fill.
  State t;
  bool d2 = false;
  on_litres(t, d2, 0, 1);
  on_litres(t, d2, 4 * MIN, 1);
  on_litres(t, d2, 8 * MIN, 1);
  EXPECT(!d2);
}

static void test_disable() {
  State s;
  bool det = true;
  pour(s, det, 0, 6 * MIN, 4000);
  tick(s, det, 6 * MIN, 5);
  start_test(s, 6 * MIN);
  Events e = disable(s);
  EXPECT(e.fill_ended && e.alarm_off);
  EXPECT(!s.running && !s.too_long && !s.acked && !s.listening && !s.detect_failed);
  EXPECT(status(false, det, s) == Status::OFF);
  EXPECT(status(true, det, s) == Status::DETECTED);  // turned back on: still proven
}

static void test_status_words() {
  EXPECT(std::string(status_text(Status::OFF)) == "off");
  EXPECT(std::string(status_text(Status::UNTESTED)) == "untested");
  EXPECT(std::string(status_text(Status::LISTENING)) == "listening");
  EXPECT(std::string(status_text(Status::DETECTED)) == "detected");
  EXPECT(std::string(status_text(Status::NOT_DETECTED)) == "not_detected");
}

int main() {
  test_fill_runs_and_ends();
  test_slow_leak_is_not_a_fill();
  test_alarm();
  test_acknowledge();
  test_gap_seen_by_a_pulse_first();
  test_pulse_test();
  test_a_fill_proves_the_meter();
  test_disable();
  test_status_words();
  if (failures) {
    std::printf("fill_meter_test: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("fill_meter_test: ok\n");
  return 0;
}
