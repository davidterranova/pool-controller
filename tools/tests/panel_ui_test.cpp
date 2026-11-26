// Host tests for panel_ui.h (the touch panel's texts, formats, the pump-mode sheet, the override's time left and the
// ignored-touch counter): `make firmware-test` compiles and runs them in the ESPHome image.
#include "../../panel_ui.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

using namespace panel_ui;
using panel_i18n::EN;
using panel_i18n::ES;
using panel_i18n::FR;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)
#define EXPECT_EQ(got, want)                                                                                     \
  do {                                                                                                           \
    std::string g_ = (got), w_ = (want);                                                                         \
    if (g_ != w_) {                                                                                              \
      std::printf("FAIL %s:%d: %s\n  got:  \"%s\"\n  want: \"%s\"\n", __FILE__, __LINE__, #got, g_.c_str(), w_.c_str()); \
      failures++;                                                                                                \
    }                                                                                                            \
  } while (0)

static const std::string NBSP = " ";

static void test_texts() {
  // KEYS sorted by byte, so find_key's binary search finds every one of them.
  for (int i = 1; i < panel_i18n::KEY_COUNT; i++)
    EXPECT(std::strcmp(panel_i18n::KEYS[i - 1], panel_i18n::KEYS[i]) < 0);
  for (int i = 0; i < panel_i18n::KEY_COUNT; i++) {
    EXPECT(find_key(panel_i18n::KEYS[i]) == i);
    for (int l = 0; l < panel_i18n::LANG_COUNT; l++)
      EXPECT(panel_i18n::TEXTS[i][l][0] != '\0');
  }
  EXPECT(find_key("panel.nope") == -1);
  EXPECT(find_key("") == -1);

  EXPECT_EQ(T("panel.home.change", EN), "Change");
  EXPECT_EQ(T("panel.home.change", FR), "Changer");
  EXPECT_EQ(T("panel.home.change", ES), "Cambiar");
  // the card's keys the panel reads: the glossary's speeds
  EXPECT_EQ(T("common.speed.Off", FR), "Arrêt");
  EXPECT_EQ(T("common.speed.Off", ES), "Apagada");

  // The panel's language, from Panel Language's codes; anything else is English.
  EXPECT(lang_from_code("fr") == FR);
  EXPECT(lang_from_code("es") == ES);
  EXPECT(lang_from_code("en") == EN);
  EXPECT(lang_from_code("de") == EN);
  EXPECT(lang_from_code("") == EN);
  EXPECT_EQ(lang_code(ES), "es");
  set_lang(FR);
  EXPECT_EQ(T("panel.home.change"), "Changer");
  set_lang((panel_i18n::Lang) 7);
  EXPECT(current_lang == EN);
}

static std::string missed;
static void test_tr_prefix() {
  on_missing = [](const char *key) { missed = key; };
  EXPECT_EQ(tr_prefix("common.speed.", "Medium", FR), "Moyenne");
  EXPECT(missed.empty());
  // An unknown code shows as itself, never as an empty line, and is reported.
  EXPECT_EQ(tr_prefix("common.speed.", "Turbo", FR), "Turbo");
  EXPECT_EQ(missed, "common.speed.Turbo");
  on_missing = nullptr;
  EXPECT_EQ(tr_prefix("common.speed.", "unknown", EN), "unknown");
}

static void test_fill() {
  EXPECT_EQ(fill("{a} and {b}", {{"a", "1"}, {"b", "2"}}), "1 and 2");
  EXPECT_EQ(fill("{a}{a}", {{"a", "x"}}), "xx");
  // an unknown placeholder, an unclosed brace and a lone } stay as they are (i18n.js does the same)
  EXPECT_EQ(fill("{a} {zz}", {{"a", "1"}}), "1 {zz}");
  EXPECT_EQ(fill("x {a", {{"a", "1"}}), "x {a");
  EXPECT_EQ(fill("} {}", {}), "} {}");
  EXPECT_EQ(fill("", {{"a", "1"}}), "");
}

static void test_formats() {
  EXPECT_EQ(number(25.94f, 1, EN), "25.9");
  EXPECT_EQ(number(25.94f, 1, FR), "25,9");
  EXPECT_EQ(number(25.94f, 1, ES), "25,9");
  EXPECT_EQ(number(-3.25f, 1, FR), "-3,2");
  EXPECT_EQ(number(-0.04f, 1, EN), "0.0");  // no « -0.0 »
  EXPECT_EQ(number(1234.4f, 0, FR), "1234");
  EXPECT_EQ(number(NAN, 1, EN), "—");
  EXPECT_EQ(number(INFINITY, 1, FR), "—");

  EXPECT_EQ(quantity(25.94f, 1, "°C", FR), "25,9" + NBSP + "°C");
  EXPECT_EQ(quantity(120.0f, 0, "L", EN), "120" + NBSP + "L");
  EXPECT_EQ(quantity(NAN, 1, "°C", ES), "—");  // the unit goes with the number

  // 24-hour clock in every language
  EXPECT_EQ(clock(7 * 60 + 5, EN), "07:05");
  EXPECT_EQ(clock(16 * 60, FR), "16:00");
  EXPECT_EQ(clock(23 * 60 + 59, ES), "23:59");
  EXPECT_EQ(clock(24 * 60 + 10, EN), "00:10");
  EXPECT_EQ(clock(-1, FR), "—");

  // whole minutes, rounded up: a running override never reads « 0 min »
  EXPECT_EQ(duration(0, EN), "0 min");
  EXPECT_EQ(duration(1, EN), "1 min");
  EXPECT_EQ(duration(59, FR), "1 min");
  EXPECT_EQ(duration(45 * 60, ES), "45 min");
  EXPECT_EQ(duration(3600, EN), "1 h");
  EXPECT_EQ(duration(3601, EN), "1 h 1 min");
  EXPECT_EQ(duration(72 * 60, FR), "1 h 12 min");
  EXPECT_EQ(duration(120 * 60, ES), "2 h");
}

static void test_override_time() {
  // Auto: the firmware's stamp is 0
  OverrideTime t = override_time(0, 5000, 60);
  EXPECT(!t.active && !t.limited);
  // no time limit (Manual Override Timeout 0)
  t = override_time(1000, 5000, 0);
  EXPECT(t.active && !t.limited);
  // 2 h started 48 min ago: 72 min left
  t = override_time(1000, 1000 + 48u * 60000u, 120);
  EXPECT(t.active && t.limited && t.left_s == 72u * 60u);
  // due (the firmware's 30 s tick is about to return to Auto)
  t = override_time(1000, 1000 + 121u * 60000u, 120);
  EXPECT(t.limited && t.left_s == 0);
  // millis() rolled over since the stamp
  t = override_time(0xFFFFFFF0u, 0x10u, 30);
  EXPECT(t.limited && t.left_s == (30u * 60000u - 0x20u) / 1000u);

  EXPECT(minute_after(15 * 60, 30, 1800) == 15 * 60 + 30);
  EXPECT(minute_after(23 * 60 + 50, 0, 1200) == 10);  // past midnight
  EXPECT(minute_after(-1, 0, 60) == -1);
}

static void test_modes() {
  Mode m;
  EXPECT(mode_from_option("Medium", m) && m == MEDIUM);
  EXPECT(mode_from_option("Auto", m) && m == AUTO);
  EXPECT(!mode_from_option("medium", m) && m == AUTO);
  EXPECT_EQ(mode_option(OFF), "Off");
  EXPECT_EQ(mode_label(AUTO, FR), "Auto");
  EXPECT_EQ(mode_label(OFF, FR), "Arrêt");
  EXPECT_EQ(mode_label(HIGH, ES), "Alta");

  // the mode card: manual with a limit, at 14:20:00, 72 min left
  OverrideTime limited{true, true, 72u * 60u};
  EXPECT_EQ(mode_line(HIGH, "High", -1, limited, 14 * 60 + 20, 0, EN), "High · 1 h 12 min left · Auto at 15:32");
  EXPECT_EQ(mode_line(HIGH, "High", -1, limited, 14 * 60 + 20, 0, FR), "Haute · encore 1 h 12 min · Auto à 15:32");
  EXPECT_EQ(mode_line(HIGH, "High", -1, limited, -1, 0, EN), "High · 1 h 12 min left · Auto at —");
  // manual with no time limit; Off shows as the speed Off
  OverrideTime never{true, false, 0};
  EXPECT_EQ(mode_line(MEDIUM, "Medium", -1, never, 600, 0, EN), "Medium · no time limit");
  EXPECT_EQ(mode_line(OFF, "Off", -1, never, 600, 0, ES), "Apagada · sin límite de tiempo");
  // Auto: the speed now, and until when the next change is known
  OverrideTime none{false, false, 0};
  EXPECT_EQ(mode_line(AUTO, "Medium", 16 * 60, none, 600, 0, EN), "Medium until 16:00");
  EXPECT_EQ(mode_line(AUTO, "Medium", 16 * 60, none, 600, 0, FR), "Moyenne jusqu'à 16:00");
  EXPECT_EQ(mode_line(AUTO, "Off", -1, none, 600, 0, EN), "Off");
}

static void test_sheet() {
  Sheet s;
  EXPECT(!s.is_open());
  s.choose_mode(HIGH);  // closed: nothing staged
  EXPECT(s.mode() == AUTO);

  // Opens on Auto: « For » is disabled, no hint, Apply writes Manual Override only.
  s.open(AUTO, 60);
  EXPECT(s.is_open() && s.mode() == AUTO && !s.minutes_enabled() && s.minutes_choice() == -1);
  EXPECT(s.hint() == Hint::NONE);
  EXPECT_EQ(s.hint_text(600, 0, EN), "");
  s.choose_minutes(30);  // ignored in Auto
  EXPECT(s.minutes() == 60);
  Writes w = s.apply();
  EXPECT(!s.is_open() && !w.set_timeout);
  EXPECT_EQ(w.override_option, "Auto");

  // Opens on the current mode and timeout; a speed for a while: until HH:MM.
  s.open(HIGH, 60);
  EXPECT(s.mode() == HIGH && s.minutes_enabled() && s.minutes_choice() == 1);
  EXPECT(s.hint() == Hint::UNTIL);
  EXPECT_EQ(s.hint_text(14 * 60 + 20, 0, EN), "High until 15:20, then back to Auto");
  EXPECT_EQ(s.hint_text(14 * 60 + 20, 0, FR), "Haute jusqu'à 15:20, puis retour en Auto");
  EXPECT_EQ(s.hint_text(-1, 0, EN), "High for 1 h, then back to Auto");  // no clock yet

  // Never: a restart returns to Auto; Off and Never: filtration stays off.
  s.choose_minutes(0);
  EXPECT(s.hint() == Hint::NEVER && s.minutes_choice() == 3);
  EXPECT_EQ(s.hint_text(600, 0, EN), "A restart returns to Auto.");
  s.choose_mode(OFF);
  EXPECT(s.hint() == Hint::OFF_NEVER);
  EXPECT_EQ(s.hint_text(600, 0, EN), std::string(T("panel.sheet.hint.off_never", EN)));
  s.choose_minutes(120);
  EXPECT(s.hint() == Hint::UNTIL);
  EXPECT_EQ(s.hint_text(23 * 60, 0, ES), "Apagada hasta las 01:00, después vuelve a Auto");

  // Apply: the timeout first, then the override.
  w = s.apply();
  EXPECT(w.set_timeout && w.timeout_min == 120);
  EXPECT_EQ(w.override_option, "Off");

  // A timeout « For » doesn't offer (90, set from the page): no choice lit, Apply keeps it.
  s.open(LOW, 90);
  EXPECT(s.minutes_choice() == -1 && s.hint() == Hint::UNTIL);
  w = s.apply();
  EXPECT(w.set_timeout && w.timeout_min == 90);
  EXPECT_EQ(w.override_option, "Low");

  // Switching to Auto keeps the staged minutes for when a speed is picked again.
  s.open(MEDIUM, 30);
  s.choose_mode(AUTO);
  EXPECT(!s.minutes_enabled() && s.minutes_choice() == -1);
  s.choose_mode(MEDIUM);
  EXPECT(s.minutes_choice() == 0);

  // Cancel and sleep discard what is staged; the next open starts from the controller again.
  s.discard();
  EXPECT(!s.is_open());
  s.open(AUTO, 0);
  EXPECT(s.mode() == AUTO && s.minutes() == 0);
}

static void test_touch_guard() {
  const uint32_t MIN = 60u * 1000u;
  TouchGuard g;
  // four touches in a minute: counted, no burst yet
  for (uint32_t i = 0; i < 4; i++)
    EXPECT(!g.ignored(1000 + i * 10000));
  EXPECT(g.count() == 4 && !g.in_burst());
  // the fifth within ten minutes starts a burst, reported once
  EXPECT(g.ignored(1000 + 5 * MIN));
  EXPECT(g.in_burst());
  EXPECT(!g.ignored(1000 + 6 * MIN));
  EXPECT(g.count() == 6);
  // they slow down: the burst ends, and a new one is reported again
  EXPECT(!g.ignored(1000 + 30 * MIN));
  EXPECT(!g.in_burst());
  for (uint32_t i = 1; i < 4; i++)
    EXPECT(!g.ignored(1000 + 30 * MIN + i * 1000));
  EXPECT(g.ignored(1000 + 31 * MIN));
  // a person waking the screen every few minutes never makes one
  TouchGuard person;
  for (uint32_t i = 0; i < 20; i++)
    EXPECT(!person.ignored(i * 3 * MIN));
  EXPECT(person.count() == 20);
  // millis() rolls over in the middle of a burst
  TouchGuard roll;
  for (uint32_t i = 0; i < 4; i++)
    roll.ignored(0xFFFFFFFFu - 2 * MIN + i * 1000);
  EXPECT(roll.ignored(MIN));
}

int main() {
  test_texts();
  test_tr_prefix();
  test_fill();
  test_formats();
  test_override_time();
  test_modes();
  test_sheet();
  test_touch_guard();
  if (failures != 0) {
    std::printf("panel_ui_test: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("panel_ui_test: ok\n");
  return 0;
}
