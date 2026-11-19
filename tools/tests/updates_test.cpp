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

static void test_interval() {
  EXPECT(interval_hours("À la demande") == 0);
  EXPECT(interval_hours("6 h") == 6);
  EXPECT(interval_hours("24 h") == 24);
  EXPECT(interval_hours("7 j") == 168);
  EXPECT(interval_hours("nonsense") == DEFAULT_INTERVAL_HOURS);
  for (const auto &o : INTERVAL_OPTIONS)
    EXPECT(std::string(interval_label(o.hours)) == o.label);
  EXPECT(std::string(interval_label(12)) == "24 h");  // unknown: the default
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
  // Not armed: a manual check, the « À la demande » interval, or already acted.
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
  EXPECT(status_text(in) == "non vérifié");
  in.checking = true;
  EXPECT(status_text(in) == "vérification");
  in.checking = false;
  in.state = State::NO_UPDATE;
  EXPECT(status_text(in) == "à jour");
  in.state = State::AVAILABLE;
  EXPECT(status_text(in) == "disponible");
  in.pending = true;
  in.blocker = Blocker::OVERRIDE;
  EXPECT(status_text(in) == "en attente (mode manuel)");
  in.blocker = Blocker::FILL;
  EXPECT(status_text(in) == "en attente (remplissage)");
  in.blocker = Blocker::NONE;
  EXPECT(status_text(in) == "installation");
  in.pending = false;
  in.state = State::INSTALLING;
  EXPECT(status_text(in) == "installation");
  // A failed install: back to available, with the source's error.
  in.state = State::AVAILABLE;
  in.error = true;
  in.last_op = Op::INSTALL;
  EXPECT(status_text(in) == "erreur (installation)");
  in.last_op = Op::CHECK;
  EXPECT(status_text(in) == "erreur (vérification)");
  // Waiting outranks an old error.
  in.pending = true;
  in.blocker = Blocker::FILL;
  EXPECT(status_text(in) == "en attente (remplissage)");
  // Cancel Update: the request dropped, the update still there.
  in = StatusInputs{};
  in.state = State::AVAILABLE;
  in.pending = true;
  in.blocker = Blocker::OVERRIDE;
  EXPECT(status_text(in) == "en attente (mode manuel)");
  in.pending = false;
  EXPECT(status_text(in) == "disponible");
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
