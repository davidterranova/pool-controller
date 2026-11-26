#pragma once
// Pure helpers for the touch panel (local-panel.yaml, docs/plans/s3-panel.md): its texts, the pump-mode sheet, the
// time an override has left, the number, clock and duration formats of each language, and the counter of touches
// ignored while the screen sleeps. No ESPHome header on purpose: tools/tests/panel_ui_test.cpp compiles this file
// on the host (`make firmware-test`), and the preview (tools/panel-preview/) runs it as the board does.
//
// Texts. Every text the panel draws comes from panel_i18n.h, generated from i18n-panel/{en,fr,es}.json and the
// card's keys the panel uses (`make panel-i18n`; .claude/rules/translations.md). Never a literal:
//   T("panel.home.change")             the text in the panel's language (set_lang), as a const char *
//   T("panel.home.change", lang)       in a given language
//   fill(T("panel.sheet.hint.until"), {{"speed", s}, {"time", t}})   its {placeholders} filled
//   tr_prefix("common.speed.", code)   a key built at run time (a firmware code): the code itself when the
//                                      key is missing, never an empty line, and on_missing hears of it
// A literal key is checked at compile time (Key): one that isn't in panel_i18n.h doesn't build.
//
// The sheet writes what the dashboard writes (docs/plans/s3-panel.md, Decisions): Manual Override Timeout first,
// then Manual Override; Auto writes Manual Override only. Nothing here decides how long an override lasts: the
// firmware's expiry does, from override_since_ms and the timeout, which override_time() reads the same way.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>

#include "panel_i18n.h"

namespace panel_ui {

using panel_i18n::Lang;

// ------------------------------------------------------------------ texts

/// A key of panel_i18n.h, looked up at compile time: a literal key that isn't there is a compile error.
struct Key {
  uint16_t index;
  consteval Key(const char *key) : index(find(key)) {}  // implicit, so a literal key reads as in the card

 private:
  static consteval uint16_t find(std::string_view key) {
    for (int i = 0; i < panel_i18n::KEY_COUNT; i++)
      if (key == panel_i18n::KEYS[i])
        return (uint16_t) i;
    // Not a constant expression, so the build stops here: add the key to i18n-panel/en.json (and fr, es), then
    // run `make panel-i18n`.
    throw "panel_ui::Key: no such key in panel_i18n.h";
  }
};

/// The panel's language, as Panel Language (the `panel_lang` global) sets it.
inline Lang current_lang = panel_i18n::EN;

/// A language's code (en, fr, es): Panel Language's options.
inline const char *lang_code(Lang lang) { return panel_i18n::LANG_CODES[lang]; }

/// The language of a code; English for anything else.
inline Lang lang_from_code(std::string_view code) {
  for (int i = 0; i < panel_i18n::LANG_COUNT; i++)
    if (code == panel_i18n::LANG_CODES[i])
      return (Lang) i;
  return panel_i18n::EN;
}

inline void set_lang(Lang lang) { current_lang = lang < panel_i18n::LANG_COUNT ? lang : panel_i18n::EN; }

inline const char *T(Key key, Lang lang) { return panel_i18n::TEXTS[key.index][lang]; }
inline const char *T(Key key) { return T(key, current_lang); }

/// Called with the key when tr_prefix finds none (local-panel.yaml logs it; the preview's check fails on it).
inline void (*on_missing)(const char *key) = nullptr;

/// The index of a key built at run time, or -1. KEYS is sorted (the generator sorts it by byte).
inline int find_key(const std::string &key) {
  int lo = 0, hi = panel_i18n::KEY_COUNT - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    int c = std::strcmp(panel_i18n::KEYS[mid], key.c_str());
    if (c == 0)
      return mid;
    if (c < 0)
      lo = mid + 1;
    else
      hi = mid - 1;
  }
  return -1;
}

/// The text of `prefix` + `code` (a key built from a firmware code: common.speed.Low), or the code itself.
inline std::string tr_prefix(const char *prefix, const std::string &code, Lang lang) {
  std::string key = std::string(prefix) + code;
  int i = find_key(key);
  if (i >= 0)
    return panel_i18n::TEXTS[i][lang];
  if (on_missing != nullptr)
    on_missing(key.c_str());
  return code;
}
inline std::string tr_prefix(const char *prefix, const std::string &code) { return tr_prefix(prefix, code, current_lang); }

using Vars = std::initializer_list<std::pair<const char *, std::string>>;

/// `text` with each {name} replaced by its value in `vars`; an unknown one is left as it is (as i18n.js does).
inline std::string fill(const char *text, Vars vars) {
  std::string out;
  for (const char *p = text; *p != '\0'; p++) {
    if (*p == '{') {
      const char *end = std::strchr(p + 1, '}');
      if (end != nullptr) {
        std::string_view name(p + 1, (size_t) (end - p - 1));
        const std::string *value = nullptr;
        for (const auto &v : vars)
          if (name == v.first)
            value = &v.second;
        if (value != nullptr) {
          out += *value;
          p = end;
          continue;
        }
      }
    }
    out += *p;
  }
  return out;
}

// ------------------------------------------------------------------ formats

/// « — »: what a reading the controller doesn't have shows.
inline std::string unknown(Lang lang) { return T("panel.fmt.unknown", lang); }

/// `value` with `decimals` decimals and the language's decimal separator (25.9, 25,9), or « — » when it isn't a
/// number (an unconnected probe reads NaN). No thousands separator: the panel's numbers stay short.
inline std::string number(float value, int decimals, Lang lang) {
  if (!std::isfinite(value))
    return unknown(lang);
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.*f", decimals, (double) value);
  std::string s = buf;
  if (s[0] == '-' && s.find_first_not_of("-0.") == std::string::npos)
    s.erase(0, 1);  // -0.0 reads 0.0
  size_t dot = s.find('.');
  if (dot != std::string::npos)
    s.replace(dot, 1, T("panel.fmt.decimal_sep", lang));
  return s;
}

/// A number and its unit, with the language's spacing (« 25,9 °C », « 120 L »), or « — » alone.
inline std::string quantity(float value, int decimals, const char *unit, Lang lang) {
  if (!std::isfinite(value))
    return unknown(lang);
  return fill(T("panel.fmt.quantity", lang), {{"value", number(value, decimals, lang)}, {"unit", unit}});
}

/// A minute of the day as a 24-hour clock in every language (« 07:05 », « 16:00 »), or « — » when negative
/// (no clock yet).
inline std::string clock(int minute_of_day, Lang lang) {
  if (minute_of_day < 0)
    return unknown(lang);
  minute_of_day %= 24 * 60;
  char buf[8];
  std::snprintf(buf, sizeof buf, "%02d:%02d", minute_of_day / 60, minute_of_day % 60);
  return buf;
}

/// A duration in whole minutes, rounded up so a running override never reads « 0 min »: « 1 h 12 min », « 2 h »,
/// « 45 min ».
inline std::string duration(uint32_t seconds, Lang lang) {
  uint32_t minutes = (seconds + 59) / 60;
  std::string h = std::to_string(minutes / 60), m = std::to_string(minutes % 60);
  if (minutes < 60)
    return fill(T("panel.fmt.min", lang), {{"m", m}});
  if (minutes % 60 == 0)
    return fill(T("panel.fmt.h", lang), {{"h", h}});
  return fill(T("panel.fmt.h_min", lang), {{"h", h}, {"m", m}});
}

// ------------------------------------------------------------------ the override's time

/// What the mode card says about the current override.
struct OverrideTime {
  bool active;      // a Manual Override other than Auto is running
  bool limited;     // Manual Override Timeout > 0: it ends on its own
  uint32_t left_s;  // seconds left when limited (0 once due: the firmware's 30 s tick returns to Auto)
};

/// From the firmware's own stamp (override_since_ms, 0 in Auto), millis() and Manual Override Timeout, as its
/// expiry and « Manual Override Ends At » read them. Unsigned arithmetic, so millis()'s rollover is harmless.
inline OverrideTime override_time(uint32_t since_ms, uint32_t now_ms, float timeout_min) {
  OverrideTime t{since_ms != 0, false, 0};
  if (!t.active || !(timeout_min > 0))
    return t;
  t.limited = true;
  uint32_t timeout_ms = (uint32_t) (timeout_min * 60000.0f);
  uint32_t elapsed_ms = now_ms - since_ms;
  t.left_s = elapsed_ms >= timeout_ms ? 0 : (timeout_ms - elapsed_ms) / 1000;
  return t;
}

/// The minute of the day `left_s` seconds after now (`now_minute` of the day, `now_second` into it), as the
/// clock will read it then: « Auto at 15:32 ». -1 without a clock (now_minute < 0).
inline int minute_after(int now_minute, int now_second, uint32_t left_s) {
  if (now_minute < 0)
    return -1;
  uint32_t at = (uint32_t) now_minute * 60u + (uint32_t) now_second + left_s;
  return (int) (at / 60u % (24u * 60u));
}

// ------------------------------------------------------------------ the pump mode

/// Manual Override's options, in its order. Their codes are the select's options, never translated.
enum Mode : uint8_t { AUTO = 0, OFF, LOW, MEDIUM, HIGH, MODE_COUNT };

inline const char *mode_option(Mode mode) {
  static const char *const OPTIONS[MODE_COUNT] = {"Auto", "Off", "Low", "Medium", "High"};
  return OPTIONS[mode < MODE_COUNT ? mode : AUTO];
}

/// The Mode of a Manual Override option; false (and Auto) for anything else.
inline bool mode_from_option(std::string_view option, Mode &mode) {
  for (int i = 0; i < MODE_COUNT; i++)
    if (option == mode_option((Mode) i)) {
      mode = (Mode) i;
      return true;
    }
  mode = AUTO;
  return false;
}

/// A mode's label: Auto, or the speed's (the card's words, the glossary's).
inline std::string mode_label(Mode mode, Lang lang) {
  if (mode == AUTO)
    return T("common.mode.auto", lang);
  return tr_prefix("common.speed.", mode_option(mode), lang);
}

/// The mode card's line.
///   Auto: the speed now, and until when when the next change is known (`next_minute` ≥ 0): « Medium until 16:00 ».
///   Manual: « High · 1 h 12 min left · Auto at 15:32 », or « High · no time limit ».
/// `speed` is the speed now, as a code (Off, Low, Medium, High); `now_minute` < 0 without a clock.
inline std::string mode_line(Mode mode, const std::string &speed, int next_minute, const OverrideTime &t, int now_minute,
                             int now_second, Lang lang) {
  std::string speed_label = tr_prefix("common.speed.", speed, lang);
  if (mode == AUTO) {
    if (next_minute < 0)
      return speed_label;
    return fill(T("panel.home.auto_until", lang), {{"speed", speed_label}, {"time", clock(next_minute, lang)}});
  }
  std::string label = mode_label(mode, lang);
  if (!t.limited)
    return fill(T("panel.home.manual_never", lang), {{"speed", label}});
  return fill(T("panel.home.manual_left", lang),
              {{"speed", label},
               {"left", duration(t.left_s, lang)},
               {"time", clock(minute_after(now_minute, now_second, t.left_s), lang)}});
}

// ------------------------------------------------------------------ the pump-mode sheet

/// « For »'s choices, in minutes: 0 = Never (no time limit), as Manual Override Timeout reads it.
inline constexpr uint16_t DURATIONS[] = {30, 60, 120, 0};
inline constexpr int DURATION_COUNT = sizeof DURATIONS / sizeof DURATIONS[0];

/// What Apply writes, in this order: Manual Override Timeout (when set_timeout), then Manual Override.
struct Writes {
  bool set_timeout;
  uint16_t timeout_min;
  const char *override_option;
};

/// The hint under the sheet's choices.
enum class Hint : uint8_t {
  NONE,       // Auto: nothing to say
  OFF_NEVER,  // Off with no time limit: filtration stays off, freeze protection still runs
  NEVER,      // a speed with no time limit: a restart returns to Auto
  UNTIL,      // a speed or Off for a while: until HH:MM, then back to Auto
};

/// The pump-mode sheet: what is staged between Change and Apply. Cancel and sleep discard it.
class Sheet {
 public:
  /// Opens on the current mode and the current Manual Override Timeout (any value it holds, even one « For »
  /// doesn't offer: then no choice is lit, and Apply keeps it).
  void open(Mode current, float timeout_min) {
    open_ = true;
    mode_ = current < MODE_COUNT ? current : AUTO;
    minutes_ = timeout_min > 0 ? (uint16_t) std::lround(timeout_min) : 0;
  }
  void discard() { open_ = false; }
  bool is_open() const { return open_; }

  void choose_mode(Mode mode) {
    if (open_ && mode < MODE_COUNT)
      mode_ = mode;
  }
  /// One of DURATIONS; ignored in Auto, where « For » is disabled.
  void choose_minutes(uint16_t minutes) {
    if (open_ && minutes_enabled())
      minutes_ = minutes;
  }

  Mode mode() const { return mode_; }
  uint16_t minutes() const { return minutes_; }
  bool minutes_enabled() const { return mode_ != AUTO; }
  /// The lit « For » choice (an index in DURATIONS), or -1: in Auto, or for a timeout it doesn't offer.
  int minutes_choice() const {
    if (!minutes_enabled())
      return -1;
    for (int i = 0; i < DURATION_COUNT; i++)
      if (DURATIONS[i] == minutes_)
        return i;
    return -1;
  }

  Hint hint() const {
    if (mode_ == AUTO)
      return Hint::NONE;
    if (minutes_ == 0)
      return mode_ == OFF ? Hint::OFF_NEVER : Hint::NEVER;
    return Hint::UNTIL;
  }

  /// The hint's text; the end time from the clock now (`now_minute` < 0 without one: « for 1 h » instead).
  std::string hint_text(int now_minute, int now_second, Lang lang) const {
    switch (hint()) {
      case Hint::NONE:
        return "";
      case Hint::OFF_NEVER:
        return T("panel.sheet.hint.off_never", lang);
      case Hint::NEVER:
        return T("panel.sheet.hint.never", lang);
      case Hint::UNTIL:
        break;
    }
    std::string label = mode_label(mode_, lang);
    if (now_minute < 0)
      return fill(T("panel.sheet.hint.for", lang), {{"speed", label}, {"duration", duration(minutes_ * 60u, lang)}});
    return fill(T("panel.sheet.hint.until", lang),
                {{"speed", label}, {"time", clock(minute_after(now_minute, now_second, minutes_ * 60u), lang)}});
  }

  /// What Apply writes, and closes the sheet. Auto writes Manual Override only.
  Writes apply() {
    open_ = false;
    if (mode_ == AUTO)
      return {false, 0, mode_option(AUTO)};
    return {true, minutes_, mode_option(mode_)};
  }

 private:
  bool open_ = false;
  Mode mode_ = AUTO;
  uint16_t minutes_ = 0;
};

// ------------------------------------------------------------------ touches while asleep

/// Panel Ignored Touches: every touch on a sleeping screen only wakes it and is counted. Condensation shows as
/// touches nobody made, so BURST_COUNT of them within BURST_WINDOW_MS is a burst, reported once (a warning in the
/// log) until they slow down again. A person wakes the screen at most once a Panel Sleep After (≥ 15 s), and
/// rarely five times in ten minutes.
class TouchGuard {
 public:
  static constexpr uint8_t BURST_COUNT = 5;
  static constexpr uint32_t BURST_WINDOW_MS = 10u * 60u * 1000u;

  /// Counts a touch ignored at `now_ms` (millis()); true when it starts a burst.
  bool ignored(uint32_t now_ms) {
    count_++;
    times_[next_] = now_ms;
    next_ = (uint8_t) ((next_ + 1) % BURST_COUNT);
    if (count_ < BURST_COUNT)
      return false;
    uint32_t oldest = times_[next_];  // the BURST_COUNT-th touch back, this one included
    bool burst = now_ms - oldest <= BURST_WINDOW_MS;
    bool starts = burst && !in_burst_;
    in_burst_ = burst;
    return starts;
  }
  uint32_t count() const { return count_; }
  bool in_burst() const { return in_burst_; }

 private:
  uint32_t times_[BURST_COUNT] = {};
  uint8_t next_ = 0;
  uint32_t count_ = 0;
  bool in_burst_ = false;
};

}  // namespace panel_ui
