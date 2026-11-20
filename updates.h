#pragma once
// Pure helpers for updates.yaml (its `esphome: includes:`): when to check for
// a firmware, whether an install may start now, and what Update Status says.
// No ESPHome header on purpose: tools/tests/updates_test.cpp compiles this
// file on the host (`make firmware-test`).

#include <cstdint>
#include <string>

namespace pool_updates {

// ------------------------------------------------------------ check interval

/// Update Check Interval's options, and the hours each one means (0 = only
/// when asked: Check for Update, the page's « Vérifier »). The options are
/// codes the UIs translate (docs/plans/i18n.md), never renamed once
/// published; the choice is stored as hours (update_check_hours), so it
/// survived the move from the French options to these.
struct IntervalOption {
  const char *label;
  uint32_t hours;
};
static const IntervalOption INTERVAL_OPTIONS[] = {
    {"on_request", 0},
    {"6h", 6},
    {"24h", 24},
    {"7d", 7 * 24},
};
static const uint32_t DEFAULT_INTERVAL_HOURS = 24;

/// The hours an option means; an unknown one is the default (24 h).
inline uint32_t interval_hours(const std::string &label) {
  for (const auto &o : INTERVAL_OPTIONS)
    if (label == o.label)
      return o.hours;
  return DEFAULT_INTERVAL_HOURS;
}

/// The option for stored hours; anything else reads as the default, so a
/// value from a later firmware never leaves the select empty.
inline const char *interval_label(uint32_t hours) {
  const char *fallback = INTERVAL_OPTIONS[0].label;
  for (const auto &o : INTERVAL_OPTIONS) {
    if (o.hours == hours)
      return o.label;
    if (o.hours == DEFAULT_INTERVAL_HOURS)
      fallback = o.label;
  }
  return fallback;
}

/// Whether a scheduled check is due: never when checks are on request only,
/// at once when none has run since boot (last_ms 0), else every `hours`.
/// millis() wraps after ~49.7 days; unsigned subtraction handles it, and
/// 7 days (604,800,000 ms) fits.
inline bool check_due(uint32_t now_ms, uint32_t last_ms, uint32_t hours) {
  if (hours == 0)
    return false;
  if (last_ms == 0)
    return true;
  return now_ms - last_ms >= hours * 3600000u;
}

// ------------------------------------------------------------------ the gate

/// What holds an install back. A reboot ends a Manual Override (it is not
/// restored: the controller comes back in Auto) and loses the water meter's
/// pulses of a fill, so an install waits for both to end.
enum class Blocker : uint8_t { NONE = 0, OVERRIDE, FILL };

/// `fill_running` is Fill Running (fill-meter.yaml): the same fill its alarm
/// sees, and never while the meter is turned off. Override first: it is the
/// one the user chose.
inline Blocker gate_blocker(bool override_active, bool fill_running) {
  if (override_active)
    return Blocker::OVERRIDE;
  if (fill_running)
    return Blocker::FILL;
  return Blocker::NONE;
}

/// The blocker as Update Status's argument (`pending:<label>`) and the log
/// name it.
inline const char *blocker_label(Blocker b) {
  switch (b) {
    case Blocker::OVERRIDE:
      return "override";
    case Blocker::FILL:
      return "fill";
    default:
      return "";
  }
}

// --------------------------------------------------------------- Auto Update

/// What Auto Update does after a check. It acts on scheduled checks only: a
/// scheduled check arms it, a manual one disarms it, and an update a manual
/// check (or the `on_request` interval) finds waits for an explicit
/// install. Once the armed check has answered, it installs if Auto Update is
/// on and an update is there, else it just disarms: turning Auto Update on
/// later doesn't install what an earlier check found.
enum class AutoStep : uint8_t { NONE = 0, INSTALL, DISARM };

/// `state_available`: the entity holds an update to install; `pending`: an
/// install is already waiting at the gate. INSTALL disarms too.
inline AutoStep auto_update_step(bool armed, bool checking, bool enabled, bool state_available, bool pending) {
  if (!armed || checking)
    return AutoStep::NONE;
  if (enabled && state_available && !pending)
    return AutoStep::INSTALL;
  return AutoStep::DISARM;
}

// ------------------------------------------------------------- Update Status

/// The update entity's state, as ESPHome's update::UpdateState numbers it
/// (updates.yaml static_asserts the match).
enum class State : uint8_t { UNKNOWN = 0, NO_UPDATE = 1, AVAILABLE = 2, INSTALLING = 3 };

/// The last thing asked of the source entity, to say which one failed.
enum class Op : uint8_t { NONE = 0, CHECK, INSTALL };

struct StatusInputs {
  State state{State::UNKNOWN};
  bool error{false};     // the source entity's last check or install failed
  Op last_op{Op::NONE};
  bool checking{false};  // a check is on its way
  bool pending{false};   // an install was asked for and hasn't started
  Blocker blocker{Blocker::NONE};
};

/// Update Status, as a code the UIs translate (docs/plans/i18n.md):
/// `installing`, `pending:override`, `pending:fill`, `checking`,
/// `error:check`, `error:install`, `available`, `up_to_date`, `unchecked`.
/// An install outranks the rest; a failure shows until the next check that
/// works. A published code is never renamed: add a new one instead.
inline std::string status_text(const StatusInputs &in) {
  if (in.state == State::INSTALLING)
    return "installing";
  if (in.pending && in.blocker != Blocker::NONE)
    return std::string("pending:") + blocker_label(in.blocker);
  if (in.pending)
    return "installing";
  if (in.checking)
    return "checking";
  if (in.error)
    return in.last_op == Op::INSTALL ? "error:install" : "error:check";
  switch (in.state) {
    case State::AVAILABLE:
      return "available";
    case State::NO_UPDATE:
      return "up_to_date";
    default:
      return "unchecked";
  }
}

}  // namespace pool_updates
