#pragma once
// Pure logic for fill-meter.yaml (its `esphome: includes:`): when a fill runs,
// when it has run too long, its acknowledgement, and the meter's pulse test.
// No ESPHome header on purpose: tools/tests/fill_meter_test.cpp compiles this
// file on the host (`make firmware-test`).
//
// Times are millis(): unsigned subtraction survives its ~49.7-day wrap, and a
// fill never comes near that long. Nothing here is kept across a reboot but
// what the caller stores itself (whether the meter was detected).

#include <cstdint>

namespace pool_fill {

/// A fill ends after this long without a pulse: pulse_meter's `timeout`, so
/// Fill Running and the flow reading 0 agree. A leak slower than 1 L in 5 min
/// never counts as a fill.
static const uint32_t GAP_MS = 5 * 60 * 1000UL;
/// The pulse test: this many litres within DETECT_WINDOW_MS. More than one
/// pulse, so a single bounce or glitch on the line can't pass it.
static const uint32_t DETECT_LITRES = 3;
static const uint32_t DETECT_WINDOW_MS = 5 * 60 * 1000UL;

/// Fill Meter Status, in this order of precedence.
enum class Status : uint8_t { OFF = 0, LISTENING, NOT_DETECTED, DETECTED, UNTESTED };

/// The words Fill Meter Status publishes. The card and the page parse them:
/// keep them.
inline const char *status_text(Status s) {
  switch (s) {
    case Status::OFF:
      return "off";
    case Status::LISTENING:
      return "listening";
    case Status::NOT_DETECTED:
      return "not_detected";
    case Status::DETECTED:
      return "detected";
    default:
      return "untested";
  }
}

/// The meter's run-time state, from boot (a reboot starts with no fill).
struct State {
  bool running = false;        // Fill Running
  uint32_t started_ms = 0;     // when the running fill began
  uint32_t last_pulse_ms = 0;  // the last litre counted (valid once any_pulse)
  bool any_pulse = false;      // a litre since boot (or since the meter was turned on)
  uint32_t fill_litres = 0;    // litres of the running (or last) fill
  bool too_long = false;       // Fill Running Too Long
  bool acked = false;          // Fill Alarm Acknowledged
  bool listening = false;      // a pulse test is running
  uint32_t detect_until_ms = 0;
  uint32_t detect_litres = 0;
  bool detect_failed = false;  // the last test ended with too few litres
};

/// What a call changed, for the caller to log and publish.
struct Events {
  bool fill_started = false;
  bool fill_ended = false;
  bool alarm_on = false;
  bool alarm_off = false;
  bool detected = false;     // the meter just proved it counts
  bool test_failed = false;  // a pulse test just ended without enough litres
  uint32_t ended_litres = 0;       // with fill_ended: that fill's litres
  uint32_t ended_duration_ms = 0;  // and its first to last litre
};

/// Ends the running fill into `e`.
inline void end_fill(State &s, Events &e) {
  if (!s.running)
    return;
  s.running = false;
  e.fill_ended = true;
  e.ended_litres = s.fill_litres;
  e.ended_duration_ms = s.last_pulse_ms - s.started_ms;
}

inline Status status(bool enabled, bool detected, const State &s) {
  if (!enabled)
    return Status::OFF;
  if (s.listening)
    return Status::LISTENING;
  if (s.detect_failed)
    return Status::NOT_DETECTED;
  return detected ? Status::DETECTED : Status::UNTESTED;
}

/// The meter counted `litres` (> 0) at `now`. Opens a fill after a gap of at
/// least GAP_MS, and feeds the pulse test. Any fill that reaches
/// DETECT_LITRES within DETECT_WINDOW_MS of its start proves the meter too,
/// test or not: a controller that was already counting needs no test.
inline Events on_litres(State &s, bool &detected, uint32_t now, uint32_t litres) {
  Events e;
  if (!s.running || !s.any_pulse || now - s.last_pulse_ms >= GAP_MS) {
    // A gap the 30 s tick hasn't seen yet still ends the fill before it.
    end_fill(s, e);
    e.alarm_off = s.too_long;
    s.running = true;
    s.started_ms = now;
    s.fill_litres = 0;
    s.too_long = false;
    s.acked = false;
    e.fill_started = true;
  }
  s.last_pulse_ms = now;
  s.any_pulse = true;
  s.fill_litres += litres;
  if (s.listening) {
    s.detect_litres += litres;
    if (s.detect_litres >= DETECT_LITRES) {
      s.listening = false;
      s.detect_failed = false;
      detected = true;
      e.detected = true;
    }
  } else if (!detected && s.fill_litres >= DETECT_LITRES && now - s.started_ms <= DETECT_WINDOW_MS) {
    s.detect_failed = false;
    detected = true;
    e.detected = true;
  }
  return e;
}

/// The periodic check (every 30 s): ends a fill GAP_MS after its last pulse,
/// raises or drops the alarm (alarm_minutes 0 = no alarm), and ends a pulse
/// test whose window has passed.
inline Events tick(State &s, bool &detected, uint32_t now, uint32_t alarm_minutes) {
  Events e;
  if (s.running && now - s.last_pulse_ms >= GAP_MS)
    end_fill(s, e);
  bool too_long = s.running && alarm_minutes > 0 && now - s.started_ms >= alarm_minutes * 60000UL;
  if (too_long != s.too_long) {
    s.too_long = too_long;
    (too_long ? e.alarm_on : e.alarm_off) = true;
  }
  if (!s.too_long)
    s.acked = false;  // the next long fill alarms again
  if (s.listening && (int32_t) (now - s.detect_until_ms) >= 0) {
    s.listening = false;
    s.detect_failed = true;
    detected = false;  // tested and silent: not proven any more
    e.test_failed = true;
  }
  return e;
}

/// Detect Fill Meter: listen for DETECT_LITRES within DETECT_WINDOW_MS.
inline void start_test(State &s, uint32_t now) {
  s.listening = true;
  s.detect_failed = false;
  s.detect_litres = 0;
  s.detect_until_ms = now + DETECT_WINDOW_MS;
}

/// Acknowledge Fill Alarm: only while the alarm is on. Whether it took.
inline bool acknowledge(State &s) {
  if (!s.too_long || s.acked)
    return false;
  s.acked = true;
  return true;
}

/// The controller's one State. A function-local static rather than an
/// ESPHome global: main.cpp declares globals before it includes this header,
/// so a global can't be of a type defined here.
inline State &state() {
  static State s;
  return s;
}

/// Fill Meter turned off: no fill, no alarm, no test. The litres counted so
/// far today stay counted; the caller stops counting new ones.
inline Events disable(State &s) {
  Events e;
  end_fill(s, e);
  e.alarm_off = s.too_long;
  s = State();
  return e;
}

}  // namespace pool_fill
