#pragma once
// The panel preview's scenarios, its text dump and its commands (tools/panel-preview/preview.yaml). Host build only:
// the board never includes this file.
//
// A run of the preview's program draws one scenario in one language, on one screen, from the environment:
//   PANEL_SCENARIO   a name of SCENARIOS (default: the first)
//   PANEL_LANG       en, fr or es (default: en)
//   PANEL_SCREEN     home, sheet or status (default: home)
//   PANEL_SLEEP_S    Panel Sleep After, in seconds, set past the number's 15 s minimum so a flow sleeps quickly
//   PANEL_LEFT_S     seconds left on the scenario's override, so a flow sees it expire
// Once drawn, it logs every label on the screen (`[preview] label: …`), then `[preview] ready`: shoot.py takes the
// screenshot then, and its check reads the labels.
//
// Commands, one per line on the program's stdin (shoot.py's flows): `dump` (the labels again, then `dumped`),
// `auto` (the Auto button: pressed, released), `lang <code>` (Panel Language).
//
// shoot.py reads the scenario names from SCENARIOS below: one list.

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <unistd.h>

#include "esphome/core/log.h"
#include "lvgl.h"

namespace preview {

static const char *const TAG = "preview";

/// What the stand-ins hold: the firmware's entities, under the firmware's ids.
struct Scenario {
  const char *name;
  const char *mode;            // Manual Override's option
  float timeout_min;           // Manual Override Timeout
  uint32_t elapsed_min;        // since the override started (override_since_ms)
  const char *speed;           // the speed commanded now (last_commanded)
  int next_change_min;         // the plan's next change, in minutes from now (sched_next_change); -1: none today
  float water, pad, outdoor;   // the probes, °C (NAN: no probe)
  bool fill_meter;             // Fill Meter
  float fill_today;            // Fill Water Today, L
  uint32_t fill_month_closed;  // this month's closed days, L (fill_months[0]); UINT32_MAX: unknown
  bool fill_too_long;          // Fill Running Too Long
  bool wifi;                   // connected
  const char *update;          // Update Status's code
  const char *setup;           // Setup State's code
};

// SCENARIOS (shoot.py reads the names between the first quotes of each line)
inline const Scenario SCENARIOS[] = {
    {"auto", "Auto", 60, 0, "Medium", 95, 26.4f, 18.2f, 21.7f, true, 140, 950, false, true, "up_to_date", "configured"},
    {"manual_limit", "High", 120, 48, "High", 95, 26.4f, 18.2f, 21.7f, true, 140, 950, false, true, "pending:override", "configured"},
    {"manual_never", "Medium", 0, 5, "Medium", 95, 26.4f, 18.2f, 21.7f, true, 140, 950, false, true, "available", "configured"},
    {"off", "Off", 0, 5, "Off", 95, 26.4f, 18.2f, 21.7f, true, 0, 950, false, true, "up_to_date", "configured"},
    {"fill_off", "Auto", 60, 0, "Low", 40, 26.4f, 18.2f, 21.7f, false, NAN, 950, false, true, "checking", "configured"},
    {"fill_alarm", "Auto", 60, 0, "Medium", 95, 26.4f, 18.2f, 21.7f, true, 1830, 2400, true, true, "pending:fill", "configured"},
    {"freeze", "Auto", 60, 0, "Low", -1, 2.1f, 4.0f, -3.5f, true, 0, 0, false, true, "up_to_date", "configured"},
    {"no_wifi", "Auto", 60, 0, "Medium", 95, 26.4f, 18.2f, 21.7f, true, 140, 950, false, false, "error:check", "wifi,api_key"},
    {"unknown", "Auto", 60, 0, "Low", -1, NAN, NAN, NAN, true, 0, UINT32_MAX, false, true, "unchecked",
     "page_password,position,probes"},
};
// end of SCENARIOS

inline const char *env(const char *name, const char *fallback) {
  const char *v = std::getenv(name);
  return v != nullptr && *v != '\0' ? v : fallback;
}

inline const Scenario &scenario() {
  const char *want = env("PANEL_SCENARIO", SCENARIOS[0].name);
  for (const auto &s : SCENARIOS)
    if (std::strcmp(s.name, want) == 0)
      return s;
  ESP_LOGE(TAG, "no scenario %s: drawing %s", want, SCENARIOS[0].name);
  return SCENARIOS[0];
}

inline std::string lang() { return env("PANEL_LANG", "en"); }
inline std::string screen() { return env("PANEL_SCREEN", "home"); }
inline int env_int(const char *name) { return std::atoi(env(name, "-1")); }

/// Logs the text of every label under `obj`, in drawing order.
inline void dump_labels(lv_obj_t *obj) {
  if (lv_obj_check_type(obj, &lv_label_class) && !lv_obj_is_hidden(obj))
    ESP_LOGI(TAG, "label: %s", lv_label_get_text(obj));
  for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++) {
    lv_obj_t *child = lv_obj_get_child(obj, (int32_t) i);
    if (!lv_obj_is_hidden(child))
      dump_labels(child);
  }
}

/// The screen's labels, then `ready` (or `then`).
inline void dump(const char *then = "ready") {
  dump_labels(lv_screen_active());
  ESP_LOGI(TAG, "%s", then);
}

/// The next command line on stdin, or "" (stdin is non-blocking: the loop never waits).
inline std::string command() {
  static bool init = false;
  static std::string buf;
  if (!init) {
    init = true;
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  }
  char chunk[128];
  ssize_t n;
  while ((n = read(STDIN_FILENO, chunk, sizeof chunk)) > 0)
    buf.append(chunk, (size_t) n);
  size_t nl = buf.find('\n');
  if (nl == std::string::npos)
    return "";
  std::string line = buf.substr(0, nl);
  buf.erase(0, nl + 1);
  return line;
}

}  // namespace preview
