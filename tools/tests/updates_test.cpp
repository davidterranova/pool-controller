// Host tests for updates.h (the update schedule, the install gate and Update
// Status): `make firmware-test` compiles and runs them in the ESPHome image.
#include "../../updates.h"

#include <cmath>
#include <cstdio>

using namespace pool_updates;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

/// A code as docs/plans/i18n.md's contract has it: ASCII, lower snake case,
/// `:` before an argument (`pending:fill`), letters or digits on each side.
static bool is_code(const std::string &s) {
  if (s.empty() || s.front() == ':' || s.back() == ':' || s.front() == '_')
    return false;
  for (char c : s)
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == ':'))
      return false;
  return s.find("::") == std::string::npos;
}

static void test_interval() {
  EXPECT(interval_hours("on_request") == 0);
  EXPECT(interval_hours("6h") == 6);
  EXPECT(interval_hours("24h") == 24);
  EXPECT(interval_hours("7d") == 168);
  EXPECT(interval_hours("nonsense") == DEFAULT_INTERVAL_HOURS);
  // The options before 1.11.0 are gone (the select refuses them); the choice
  // itself is kept as hours, so it reads back as its code.
  EXPECT(interval_hours("6 h") == DEFAULT_INTERVAL_HOURS);
  EXPECT(std::string(interval_label(6)) == "6h");
  EXPECT(std::string(interval_label(0)) == "on_request");
  for (const auto &o : INTERVAL_OPTIONS) {
    EXPECT(std::string(interval_label(o.hours)) == o.label);
    EXPECT(is_code(o.label));
  }
  EXPECT(std::string(interval_label(12)) == "24h");  // unknown: the default
}

static void test_check_due() {
  EXPECT(!check_due(1000, 0, 0));  // on request only
  EXPECT(check_due(60000, 0, 24));  // none since boot
  EXPECT(!check_due(6 * 3600000u, 1, 6));
  EXPECT(check_due(6 * 3600000u + 1, 1, 6));
  EXPECT(check_due(168 * 3600000u + 5, 5, 168));
  // millis() wrapped: last check just before, now just after
  EXPECT(!check_due(1000, 0xFFFFF000u, 24));
  EXPECT(check_due(24 * 3600000u, 0xFFFFF000u, 24));
}

static void test_gate() {
  EXPECT(gate_blocker(false, false) == Blocker::NONE);  // no fill, or the meter is off
  EXPECT(gate_blocker(false, true) == Blocker::FILL);
  EXPECT(gate_blocker(true, false) == Blocker::OVERRIDE);
  EXPECT(gate_blocker(true, true) == Blocker::OVERRIDE);
}

static void test_auto_update() {
  // Not armed: a manual check, the on_request interval, or already acted.
  EXPECT(auto_update_step(false, false, true, true, false) == AutoStep::NONE);
  // Armed by a scheduled check still on its way: wait for its answer.
  EXPECT(auto_update_step(true, true, true, true, false) == AutoStep::NONE);
  // The scheduled check found one and Auto Update is on: install.
  EXPECT(auto_update_step(true, false, true, true, false) == AutoStep::INSTALL);
  // Auto Update off, nothing found, or an install already waiting: just disarm.
  EXPECT(auto_update_step(true, false, false, true, false) == AutoStep::DISARM);
  EXPECT(auto_update_step(true, false, true, false, false) == AutoStep::DISARM);
  EXPECT(auto_update_step(true, false, true, true, true) == AutoStep::DISARM);
}

static void test_status() {
  StatusInputs in;
  EXPECT(status_text(in) == "unchecked");
  in.checking = true;
  EXPECT(status_text(in) == "checking");
  in.checking = false;
  in.state = State::NO_UPDATE;
  EXPECT(status_text(in) == "up_to_date");
  in.state = State::AVAILABLE;
  EXPECT(status_text(in) == "available");
  in.pending = true;
  in.blocker = Blocker::OVERRIDE;
  EXPECT(status_text(in) == "pending:override");
  in.blocker = Blocker::FILL;
  EXPECT(status_text(in) == "pending:fill");
  in.blocker = Blocker::NONE;
  EXPECT(status_text(in) == "installing");
  in.pending = false;
  in.state = State::INSTALLING;
  EXPECT(status_text(in) == "installing");
  // A failed install: back to available, with the source's error.
  in.state = State::AVAILABLE;
  in.error = true;
  in.last_op = Op::INSTALL;
  EXPECT(status_text(in) == "error:install");
  in.last_op = Op::CHECK;
  EXPECT(status_text(in) == "error:check");
  // Waiting outranks an old error.
  in.pending = true;
  in.blocker = Blocker::FILL;
  EXPECT(status_text(in) == "pending:fill");
  // Cancel Update: the request dropped, the update still there.
  in = StatusInputs{};
  in.state = State::AVAILABLE;
  in.pending = true;
  in.blocker = Blocker::OVERRIDE;
  EXPECT(status_text(in) == "pending:override");
  in.pending = false;
  EXPECT(status_text(in) == "available");
  // Every state is a code: the UIs translate it.
  for (State s : {State::UNKNOWN, State::NO_UPDATE, State::AVAILABLE, State::INSTALLING})
    for (Blocker b : {Blocker::NONE, Blocker::OVERRIDE, Blocker::FILL})
      for (int flags = 0; flags < 16; flags++) {
        StatusInputs x;
        x.state = s;
        x.blocker = b;
        x.pending = flags & 1;
        x.checking = flags & 2;
        x.error = flags & 4;
        x.last_op = flags & 8 ? Op::INSTALL : Op::CHECK;
        EXPECT(is_code(status_text(x)));
      }
}

int main() {
  test_interval();
  test_check_due();
  test_gate();
  test_auto_update();
  test_status();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("updates.h: all tests pass\n");
  return 0;
}
