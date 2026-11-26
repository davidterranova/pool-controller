#pragma once
// The panel preview's scenarios and its text dump (tools/panel-preview/preview.yaml). Host build only: the board
// never includes this file.
//
// A run of the preview's program draws one scenario in one language, from the environment:
//   PANEL_SCENARIO   a name of SCENARIOS (default: the first)
//   PANEL_LANG       en, fr or es (default: en)
// Once drawn, it logs every label on the screen (`[preview] label: …`), then `[preview] ready`: shoot.py takes the
// screenshot then, and its check reads the labels.
//
// shoot.py reads the scenario names from SCENARIOS below: one list.

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

#include "esphome/core/log.h"
#include "lvgl.h"

namespace preview {

static const char *const TAG = "preview";

/// What the stand-ins hold: the firmware's entities, under the firmware's ids.
struct Scenario {
  const char *name;
  const char *mode;       // Manual Override's option
  float timeout_min;      // Manual Override Timeout
  uint32_t elapsed_min;   // since the override started (override_since_ms)
  const char *speed;      // the speed commanded now (last_commanded)
  float water, pad, outdoor;  // the probes, °C (NAN: no probe)
  float fill_today;       // Fill Water Today, L (NAN: Fill Meter off)
};

// SCENARIOS (shoot.py reads the names between the first quotes of each line)
inline const Scenario SCENARIOS[] = {
    {"auto", "Auto", 60, 0, "Medium", 26.4f, 18.2f, 21.7f, 140},
    {"manual_limit", "High", 120, 48, "High", 26.4f, 18.2f, 21.7f, 140},
    {"manual_never", "Medium", 0, 5, "Medium", 26.4f, 18.2f, 21.7f, 140},
    {"off", "Off", 0, 5, "Off", 26.4f, 18.2f, 21.7f, 0},
    {"unknown", "Auto", 60, 0, "Low", NAN, NAN, NAN, NAN},
};
// end of SCENARIOS

inline const Scenario &scenario() {
  const char *want = std::getenv("PANEL_SCENARIO");
  if (want == nullptr || *want == '\0')
    return SCENARIOS[0];
  for (const auto &s : SCENARIOS)
    if (std::strcmp(s.name, want) == 0)
      return s;
  ESP_LOGE(TAG, "no scenario %s: drawing %s", want, SCENARIOS[0].name);
  return SCENARIOS[0];
}

inline std::string lang() {
  const char *l = std::getenv("PANEL_LANG");
  return l != nullptr && *l != '\0' ? l : "en";
}

/// Logs the text of every label under `obj`, in drawing order.
inline void dump_labels(lv_obj_t *obj) {
  if (lv_obj_check_type(obj, &lv_label_class) && !lv_obj_is_hidden(obj))
    ESP_LOGI(TAG, "label: %s", lv_label_get_text(obj));
  for (uint32_t i = 0; i < lv_obj_get_child_count(obj); i++)
    dump_labels(lv_obj_get_child(obj, (int32_t) i));
}

/// The screen's labels, then `ready`.
inline void dump() {
  dump_labels(lv_screen_active());
  ESP_LOGI(TAG, "ready");
}

}  // namespace preview
