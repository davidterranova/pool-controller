// Host tests for history_import.h (History Import: reading Daily History, Daily Plan History, Daily Outdoor History,
// Daily Equipment Pad History and today's running values back into the controller's record): `make firmware-test`
// compiles and runs them in the ESPHome image.
#include "../../history_import.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

using namespace history_import;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)
#define EXPECT_STR(a, b)                                                                         \
  do {                                                                                           \
    std::string _a = (a), _b = (b);                                                              \
    if (_a != _b) {                                                                              \
      std::printf("FAIL %s:%d: %s\n  got  \"%s\"\n  want \"%s\"\n", __FILE__, __LINE__, #a, _a.c_str(), _b.c_str()); \
      failures++;                                                                                \
    }                                                                                            \
  } while (0)

/// The controller's globals as a fresh one has them (pool-controller.yaml's initial values).
struct Device {
  uint32_t dates[DAYS] = {};
  uint16_t minutes[DAYS] = {};
  int16_t water_min[DAYS], water_max[DAYS], outdoor_min[DAYS], outdoor_max[DAYS], pad_min[DAYS], pad_max[DAYS];
  uint16_t planned[DAYS];
  uint32_t filtration_ms = 0;
  int16_t t_water_min = NO_TEMP, t_water_max = NO_TEMP, t_outdoor_min = NO_TEMP, t_outdoor_max = NO_TEMP,
          t_pad_min = NO_TEMP, t_pad_max = NO_TEMP;
  uint32_t fill = 0;
  Device() {
    for (int i = 0; i < DAYS; i++) {
      water_min[i] = water_max[i] = outdoor_min[i] = outdoor_max[i] = pad_min[i] = pad_max[i] = NO_TEMP;
      planned[i] = NO_PLAN;
    }
  }
  Record record() {
    return Record{dates, minutes, water_min, water_max, outdoor_min, outdoor_max, pad_min, pad_max, planned};
  }
  Today today() {
    return Today{&filtration_ms, &t_water_min, &t_water_max, &t_outdoor_min, &t_outdoor_max, &t_pad_min, &t_pad_max,
                 &fill};
  }
  std::string daily() const { return format_daily(dates, minutes, water_min, water_max); }
  std::string plan() const { return format_plan(dates, planned); }
  std::string outdoor() const { return format_range(dates, outdoor_min, outdoor_max); }
  std::string pad() const { return format_range(dates, pad_min, pad_max); }
  /// As the entity's set_action does it.
  std::string import(const std::string &text, uint32_t today) {
    Line line;
    Result r;
    r.error = parse(text, line);
    if (r.error == Error::NONE) {
      Record rec = record();
      Today t = this->today();
      r = apply(line, today, rec, t);
    }
    return outcome(r);
  }
  bool same(const Device &o) const {
#define SAME(f) (std::memcmp(&f, &o.f, sizeof(f)) == 0)
    return SAME(dates) && SAME(minutes) && SAME(water_min) && SAME(water_max) && SAME(outdoor_min) &&
           SAME(outdoor_max) && SAME(pad_min) && SAME(pad_max) && SAME(planned) && SAME(filtration_ms) &&
           SAME(t_water_min) && SAME(t_water_max) && SAME(t_outdoor_min) && SAME(t_outdoor_max) && SAME(t_pad_min) &&
           SAME(t_pad_max) && SAME(fill);
#undef SAME
  }
};

static const uint32_t TODAY = 20261126;

static void test_print() {
  Device d;
  EXPECT_STR(d.daily(), "--");
  EXPECT_STR(d.plan(), "--");
  EXPECT_STR(d.outdoor(), "--");
  d.dates[0] = 20261125, d.minutes[0] = 385, d.water_min[0] = 259, d.water_max[0] = 266;
  d.dates[1] = 20261124, d.minutes[1] = 402;
  d.outdoor_min[0] = -14, d.outdoor_max[0] = 98;
  d.planned[1] = 360;
  EXPECT_STR(d.daily(), "2026-11-25: 6.41 h 25.9/26.6 °C, 2026-11-24: 6.70 h");
  EXPECT_STR(d.plan(), "2026-11-24: 6.00 h");
  EXPECT_STR(d.outdoor(), "2026-11-25: -1.4/9.8 °C");
}

static void test_parse() {
  Line l;
  EXPECT(parse("daily:2026-11-25: 6.42 h 25.9/26.6 °C, 2026-11-24: 6.70 h", l) == Error::NONE);
  EXPECT(l.kind == Kind::DAILY && l.count == 2);
  EXPECT(l.days[0].date == 20261125 && l.days[0].minutes == 386 && l.days[0].lo == 259 && l.days[0].hi == 266);
  EXPECT(l.days[1].date == 20261124 && l.days[1].minutes == 402 && l.days[1].lo == NO_TEMP);
  EXPECT(parse("  daily: 2026-11-25: 24.00 h  ", l) == Error::NONE && l.days[0].minutes == 1440);
  EXPECT(parse("daily:--", l) == Error::NONE && l.count == 0);
  EXPECT(parse("plan:2026-11-25: 0.00 h", l) == Error::NONE && l.kind == Kind::PLAN && l.days[0].minutes == 0);
  EXPECT(parse("outdoor:2026-11-25: -1.4/-0.5 °C", l) == Error::NONE && l.days[0].lo == -14 && l.days[0].hi == -5);
  EXPECT(parse("pad:2026-11-25: 6.2/11.8 °C", l) == Error::NONE && l.kind == Kind::PAD && l.days[0].hi == 118);

  // tags and shape
  EXPECT(parse("", l) == Error::FORMAT);
  EXPECT(parse("   ", l) == Error::FORMAT);
  EXPECT(parse("daily", l) == Error::FORMAT);
  EXPECT(parse("daily:", l) == Error::FORMAT);
  EXPECT(parse("weekly:2026-11-25: 6.42 h", l) == Error::TAG);
  EXPECT(parse("Daily:2026-11-25: 6.42 h", l) == Error::TAG);
  EXPECT(parse("2026-11-25: 6.42 h", l) == Error::TAG);
  EXPECT(parse("daily:2026-11-25 6.42 h", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.4 h", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42 h,2026-11-24: 6.70 h", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42 h, ", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42 h 25.9/26.6", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42 h 25.9/26.6 C", l) == Error::FORMAT);
  EXPECT(parse("daily:2026-11-25: 6.42 h 25.9 °C", l) == Error::FORMAT);
  EXPECT(parse("daily:--x", l) == Error::FORMAT);
  EXPECT(parse("plan:2026-11-25: 6.42 h 25.9/26.6 °C", l) == Error::FORMAT);  // plan has no range
  EXPECT(parse("outdoor:2026-11-25: 6.42 h", l) == Error::FORMAT);
  EXPECT(parse("outdoor:2026-11-25: 1.40/9.8 °C", l) == Error::FORMAT);

  // dates and values
  EXPECT(parse("daily:2026-02-29: 6.42 h", l) == Error::DATE);
  EXPECT(parse("daily:2026-11-24: 6.42 h, 2026-11-25: 6.42 h", l) == Error::DATE);  // oldest first
  EXPECT(parse("daily:2026-11-25: 6.42 h, 2026-11-25: 6.42 h", l) == Error::DATE);  // twice
  EXPECT(parse("daily:2026-11-25: 24.01 h", l) == Error::VALUE);
  EXPECT(parse("daily:2026-11-25: 6.42 h 26.6/25.9 °C", l) == Error::VALUE);  // min above max
  EXPECT(parse("daily:2026-11-25: 6.42 h, 2026-11-24: 1.00 h, 2026-11-23: 1.00 h, 2026-11-22: 1.00 h, "
               "2026-11-21: 1.00 h, 2026-11-20: 1.00 h, 2026-11-19: 1.00 h",
               l) == Error::NONE);
  EXPECT(l.count == 7);
  EXPECT(parse("daily:2026-11-25: 6.42 h, 2026-11-24: 1.00 h, 2026-11-23: 1.00 h, 2026-11-22: 1.00 h, "
               "2026-11-21: 1.00 h, 2026-11-20: 1.00 h, 2026-11-19: 1.00 h, 2026-11-18: 1.00 h",
               l) == Error::TOO_MANY);

  // today:
  EXPECT(parse("today:2026-11-26 filtration=192 water=25.1/26.0 outdoor=-2.0/8.5 fill=40", l) == Error::NONE);
  EXPECT(l.kind == Kind::TODAY && l.date == 20261126 && l.minutes == 192 && l.water_lo == 251 && l.water_hi == 260 &&
         l.outdoor_lo == -20 && l.outdoor_hi == 85 && !l.has_pad && l.fill_known && l.fill == 40);
  EXPECT(parse("today:2026-11-26 fill=- outdoor=- water=- filtration=0 pad=6.0/9.0", l) == Error::NONE);
  EXPECT(l.water_lo == NO_TEMP && l.outdoor_hi == NO_TEMP && !l.fill_known && l.has_pad && l.pad_lo == 60);
  EXPECT(parse("today:2026-11-26 filtration=192 water=- outdoor=-", l) == Error::FORMAT);  // fill missing
  EXPECT(parse("today:2026-11-26 filtration=1 filtration=2 water=- outdoor=- fill=0", l) == Error::FORMAT);
  EXPECT(parse("today:2026-11-26 filtration=1 water=- outdoor=- fill=0 pump=on", l) == Error::FORMAT);
  EXPECT(parse("today:2026-11-26  filtration=1 water=- outdoor=- fill=0", l) == Error::FORMAT);
  EXPECT(parse("today:2026-11-26 filtration= water=- outdoor=- fill=0", l) == Error::FORMAT);
  EXPECT(parse("today:2026-11-26 filtration=1441 water=- outdoor=- fill=0", l) == Error::VALUE);
  EXPECT(parse("today:2026-11-26 filtration=- water=- outdoor=- fill=0", l) == Error::VALUE);
  EXPECT(parse("today:2026-11-26 filtration=1 water=27/26 outdoor=- fill=0", l) == Error::FORMAT);
  EXPECT(parse("today:2026-11-26 filtration=1 water=27.0/26.0 outdoor=- fill=0", l) == Error::VALUE);
  EXPECT(parse("today:2026-11-26 filtration=1 water=- outdoor=- fill=1.5", l) == Error::VALUE);
  EXPECT(parse("today:2026-11-26 filtration=1 water=- outdoor=- fill=4294967295", l) == Error::VALUE);
  EXPECT(parse("today:2026-11-31 filtration=1 water=- outdoor=- fill=0", l) == Error::DATE);
  EXPECT(parse("today:--", l) == Error::FORMAT);
}

/// Hours: every minute count of a day prints and reads back to itself.
static void test_hours_round_trip() {
  Device d;
  for (uint16_t m = 0; m <= MAX_MINUTES; m++) {
    d.dates[0] = 20261125, d.minutes[0] = m;
    Line l;
    EXPECT(parse("daily:" + d.daily(), l) == Error::NONE);
    EXPECT(l.days[0].minutes == m);
  }
  // A string the firmware never prints (6.02: no minute count gives 2 hundredths) still reads within a minute.
  Line l;
  EXPECT(parse("plan:2026-11-25: 6.02 h", l) == Error::NONE && l.days[0].minutes == 362);
}

/// Temperatures: every tenth the probes can give prints and reads back to itself.
static void test_temps_round_trip() {
  Device d;
  for (int v = -550; v <= 1250; v++) {
    d.dates[0] = 20261125, d.outdoor_min[0] = (int16_t) v, d.outdoor_max[0] = (int16_t) v;
    Line l;
    EXPECT(parse("outdoor:" + d.outdoor(), l) == Error::NONE);
    EXPECT(l.days[0].lo == v && l.days[0].hi == v);
  }
}

/// A full record, as the live controller's could be, moves to a fresh one through its four strings, and the new
/// one prints them back the same.
static void test_record_round_trip() {
  Device src;
  srand(7);
  for (int trial = 0; trial < 500; trial++) {
    src = Device();
    uint32_t date = 20261125;
    int n = rand() % (DAYS + 1);
    for (int i = 0; i < n; i++) {
      src.dates[i] = date;
      date -= 1 + (rand() % 3 == 0);  // a day missed now and then (stays within November)
      src.minutes[i] = (uint16_t) (rand() % (MAX_MINUTES + 1));
      if (rand() % 4) {
        src.water_min[i] = (int16_t) (rand() % 300), src.water_max[i] = (int16_t) (src.water_min[i] + rand() % 30);
      }
      if (rand() % 4) {
        src.outdoor_min[i] = (int16_t) (rand() % 400 - 200);
        src.outdoor_max[i] = (int16_t) (src.outdoor_min[i] + rand() % 150);
      }
      if (rand() % 4) {
        src.pad_min[i] = (int16_t) (rand() % 300 - 50), src.pad_max[i] = (int16_t) (src.pad_min[i] + rand() % 80);
      }
      if (rand() % 4)
        src.planned[i] = (uint16_t) (rand() % (MAX_MINUTES + 1));
    }
    Device dst;
    EXPECT_STR(dst.import("daily:" + src.daily(), TODAY), "imported:daily:" + std::to_string(n));
    EXPECT_STR(dst.import("plan:" + src.plan(), TODAY).substr(0, 14), "imported:plan:");
    EXPECT_STR(dst.import("outdoor:" + src.outdoor(), TODAY).substr(0, 17), "imported:outdoor:");
    EXPECT_STR(dst.import("pad:" + src.pad(), TODAY).substr(0, 13), "imported:pad:");
    EXPECT_STR(dst.daily(), src.daily());
    EXPECT_STR(dst.plan(), src.plan());
    EXPECT_STR(dst.outdoor(), src.outdoor());
    EXPECT_STR(dst.pad(), src.pad());
    EXPECT(("daily:" + src.daily()).size() <= 255);
  }
}

static void test_daily() {
  Device d;
  EXPECT_STR(d.import("daily:2026-11-25: 6.42 h 25.9/26.6 °C, 2026-11-23: 6.70 h", TODAY), "imported:daily:2");
  EXPECT(d.dates[0] == 20261125 && d.dates[1] == 20261123 && d.dates[2] == 0);
  EXPECT(d.minutes[0] == 386 && d.water_min[0] == 259 && d.water_max[1] == NO_TEMP);

  // The other series follow their date: kept for a date that stays, unknown for a new one.
  d.planned[0] = 380, d.outdoor_min[0] = -5, d.outdoor_max[0] = 50, d.pad_min[1] = 40, d.pad_max[1] = 90;
  d.planned[1] = 400;
  EXPECT_STR(d.import("daily:2026-11-25: 7.00 h, 2026-11-24: 5.00 h, 2026-11-23: 6.70 h", TODAY), "imported:daily:3");
  EXPECT(d.minutes[0] == 420 && d.water_min[0] == NO_TEMP);  // the line's own water range replaces the record's
  EXPECT(d.planned[0] == 380 && d.outdoor_min[0] == -5 && d.outdoor_max[0] == 50);
  EXPECT(d.dates[1] == 20261124 && d.planned[1] == NO_PLAN && d.pad_min[1] == NO_TEMP);
  EXPECT(d.dates[2] == 20261123 && d.planned[2] == 400 && d.pad_min[2] == 40 && d.pad_max[2] == 90);

  // A closed day can't be today or later.
  Device before = d;
  EXPECT_STR(d.import("daily:2026-11-26: 1.00 h", TODAY), "refused:future");
  EXPECT_STR(d.import("daily:2026-11-27: 1.00 h, 2026-11-25: 1.00 h", TODAY), "refused:future");
  EXPECT(d.same(before));

  // Never over a record holding newer days.
  EXPECT_STR(d.import("daily:2026-11-24: 1.00 h", TODAY), "refused:record_ahead");
  EXPECT_STR(d.import("daily:--", TODAY), "refused:record_ahead");
  EXPECT(d.same(before));
  // The same newest day is not newer: the line replaces it.
  EXPECT_STR(d.import("daily:2026-11-25: 1.00 h", TODAY), "imported:daily:1");
  EXPECT(d.dates[1] == 0 && d.planned[1] == NO_PLAN && d.minutes[0] == 60);

  // A record dated today or later: the clock went back.
  Device ahead;
  ahead.dates[0] = TODAY;
  EXPECT_STR(ahead.import("daily:2026-11-25: 1.00 h", TODAY), "refused:record_ahead");
  // An empty line on an empty record changes nothing.
  Device empty;
  EXPECT_STR(empty.import("daily:--", TODAY), "imported:daily:0");
  EXPECT(empty.same(Device()));
}

static void test_series() {
  Device d;
  d.import("daily:2026-11-25: 6.42 h, 2026-11-24: 6.70 h, 2026-11-23: 6.00 h", TODAY);
  EXPECT_STR(d.import("plan:2026-11-25: 6.00 h, 2026-11-23: 5.50 h", TODAY), "imported:plan:2");
  EXPECT(d.planned[0] == 360 && d.planned[1] == NO_PLAN && d.planned[2] == 330);
  EXPECT_STR(d.import("outdoor:2026-11-24: -1.4/9.8 °C", TODAY), "imported:outdoor:1");
  EXPECT(d.outdoor_min[1] == -14 && d.outdoor_max[1] == 98 && d.outdoor_min[0] == NO_TEMP);
  EXPECT_STR(d.import("pad:2026-11-25: 6.2/11.8 °C", TODAY), "imported:pad:1");
  EXPECT(d.pad_min[0] == 62 && d.pad_max[0] == 118);

  // The line is the series' whole truth: a day it leaves out becomes unknown, "--" clears it.
  EXPECT_STR(d.import("plan:2026-11-24: 7.00 h", TODAY), "imported:plan:1");
  EXPECT(d.planned[0] == NO_PLAN && d.planned[1] == 420 && d.planned[2] == NO_PLAN);
  EXPECT_STR(d.import("outdoor:--", TODAY), "imported:outdoor:0");
  EXPECT(d.outdoor_min[1] == NO_TEMP && d.outdoor_max[1] == NO_TEMP);
  // ...and never touches the others.
  EXPECT(d.pad_min[0] == 62 && d.minutes[0] == 385 + 1);

  // A date not in the record refuses the whole line.
  Device before = d;
  EXPECT_STR(d.import("plan:2026-11-25: 6.00 h, 2026-11-22: 6.00 h", TODAY), "refused:date");
  EXPECT_STR(d.import("pad:2026-11-26: 6.2/11.8 °C", TODAY), "refused:date");
  EXPECT(d.same(before));
  Device empty;
  EXPECT_STR(empty.import("plan:2026-11-25: 6.00 h", TODAY), "refused:date");
}

static void test_today() {
  Device d;
  d.filtration_ms = 123456, d.t_pad_min = 10, d.t_pad_max = 20, d.fill = 99;
  EXPECT_STR(d.import("today:2026-11-26 filtration=192 water=25.1/26.0 outdoor=-2.0/8.5 fill=40", TODAY),
             "imported:today");
  EXPECT(d.filtration_ms == 192UL * 60000UL && d.t_water_min == 251 && d.t_water_max == 260);
  EXPECT(d.t_outdoor_min == -20 && d.t_outdoor_max == 85 && d.fill == 40);
  EXPECT(d.t_pad_min == 10 && d.t_pad_max == 20);  // no pad= leaves the pad's as they are
  EXPECT_STR(d.import("today:2026-11-26 filtration=0 water=- outdoor=- pad=- fill=-", TODAY), "imported:today");
  EXPECT(d.filtration_ms == 0 && d.t_water_min == NO_TEMP && d.t_outdoor_max == NO_TEMP && d.t_pad_min == NO_TEMP &&
         d.fill == 0);

  Device before = d;
  EXPECT_STR(d.import("today:2026-11-25 filtration=1 water=- outdoor=- fill=0", TODAY), "refused:not_today");
  EXPECT_STR(d.import("today:2026-11-27 filtration=1 water=- outdoor=- fill=0", TODAY), "refused:not_today");
  EXPECT(d.same(before));
  // today: never touches the record.
  EXPECT_STR(d.daily(), "--");
}

static void test_outcome() {
  Result r;
  r.kind = Kind::OUTDOOR, r.written = 5;
  EXPECT_STR(outcome(r), "imported:outdoor:5");
  r.error = Error::NOT_IN_RECORD;
  EXPECT_STR(outcome(r), "refused:date");
  r.error = Error::TOO_MANY;
  EXPECT_STR(outcome(r), "refused:too_many");
  EXPECT_STR(REFUSED_NO_CLOCK, "refused:no_clock");
  Device d;
  EXPECT_STR(d.import("nope", TODAY), "refused:format");
  EXPECT_STR(d.import("nope:x", TODAY), "refused:tag");
  EXPECT_STR(d.import("daily:2026-11-25: 99.00 h", TODAY), "refused:value");
  EXPECT_STR(d.import("daily:2026-13-01: 1.00 h", TODAY), "refused:date");
}

int main() {
  test_print();
  test_parse();
  test_hours_round_trip();
  test_temps_round_trip();
  test_record_round_trip();
  test_daily();
  test_series();
  test_today();
  test_outcome();
  if (failures) {
    std::printf("history_import_test: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("history_import_test: ok\n");
  return 0;
}
