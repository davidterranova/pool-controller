// Host tests for fill_import.h (Fill Water Import: parsing a Fill Water Days / Months line and writing it into the
// record): `make firmware-test` compiles and runs them in the ESPHome image.
#include "../../fill_import.h"

#include <cstdio>
#include <cstring>

using namespace fill_import;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

/// The record as a fresh controller has it: nothing known, never dated.
struct Record {
  uint16_t days[DAYS];
  uint32_t days_date = 0;
  uint32_t months[MONTHS];
  uint32_t months_key = 0;
  Record() {
    for (auto &d : days) d = DAY_UNKNOWN;
    for (auto &m : months) m = MONTH_UNKNOWN;
  }
  Result import(const char *text, uint32_t today) {
    Line line;
    Error e = parse(text, line);
    if (e != Error::NONE) {
      Result r;
      r.error = e;
      return r;
    }
    return apply(line, today, days, days_date, months, months_key);
  }
};

static void test_dates() {
  EXPECT(civil(19700101) == 0);
  EXPECT(ymd_of(0) == 19700101);
  EXPECT(ymd_of(civil(20261118) - 1) == 20261117);
  EXPECT(ymd_of(civil(20260301) - 1) == 20260228);
  EXPECT(ymd_of(civil(20240301) - 1) == 20240229);  // leap year
  EXPECT(ymd_of(civil(20270101) - 1) == 20261231);
  for (int32_t z = civil(20200101); z < civil(20300101); z += 17) EXPECT(civil(ymd_of(z)) == z);
  EXPECT(month_number(202611) - month_number(202512) == 11);
  EXPECT(valid_date(2024, 2, 29));
  EXPECT(!valid_date(2026, 2, 29));
  EXPECT(!valid_date(2026, 13, 1));
  EXPECT(!valid_date(2026, 11, 31));
  EXPECT(!valid_date(1999, 1, 1));
}

static void test_parse() {
  Line l;
  EXPECT(parse("2026-11-17: 0 19 - 940", l) == Error::NONE);
  EXPECT(!l.months && l.date == 20261117 && l.count == 4);
  EXPECT(l.values[1] == 19 && l.known[1] && !l.known[2] && l.values[3] == 940);
  EXPECT(parse("  2026-11: 23 30 950  ", l) == Error::NONE);  // spaces around the line
  EXPECT(l.months && l.date == 202611 && l.count == 3 && l.values[2] == 950);
  EXPECT(parse("2026-11-17:  5   6", l) == Error::NONE && l.count == 2);  // several spaces between values
  EXPECT(parse("2026-11: 4294967294", l) == Error::NONE);
  // refused
  EXPECT(parse("", l) == Error::FORMAT);
  EXPECT(parse("--", l) == Error::FORMAT);  // the sensors' state before a first midnight
  EXPECT(parse("2026-11-17:", l) == Error::FORMAT);  // no value
  EXPECT(parse("2026-11-17:5", l) == Error::FORMAT);
  EXPECT(parse("2026-1-17: 5", l) == Error::FORMAT);
  EXPECT(parse("2026/11/17: 5", l) == Error::FORMAT);
  EXPECT(parse("2026-11-17 5", l) == Error::FORMAT);
  EXPECT(parse("2026-11-17: 5,6", l) == Error::VALUE);
  EXPECT(parse("2026-11-17: -5", l) == Error::VALUE);
  EXPECT(parse("2026-11-17: 1.5", l) == Error::VALUE);
  EXPECT(parse("2026-11-17: 5\t6", l) == Error::VALUE);
  EXPECT(parse("2026-11: 4294967295", l) == Error::VALUE);  // UINT32_MAX means unknown
  EXPECT(parse("2026-11: 99999999999", l) == Error::VALUE);
  EXPECT(parse("2026-02-30: 5", l) == Error::DATE);
  EXPECT(parse("2026-13: 5", l) == Error::DATE);
  std::string days = "2026-11-17:", months = "2026-11:";
  for (int i = 0; i < 30; i++) days += " 1";
  for (int i = 0; i < 12; i++) months += " 1";
  EXPECT(parse(days, l) == Error::NONE && l.count == 30);
  EXPECT(parse(months, l) == Error::NONE && l.count == 12);
  EXPECT(parse(days + " 1", l) == Error::TOO_MANY);
  EXPECT(parse(months + " 1", l) == Error::TOO_MANY);
  // the longest line the record can print fits the entity's 255 characters
  std::string longest = "2026-11-17:";
  for (int i = 0; i < 30; i++) longest += " 65534";
  EXPECT(longest.size() <= 255);
  EXPECT(parse(longest, l) == Error::NONE);
}

static void test_days_into_an_empty_record() {
  // The controller's record started yesterday; Home Assistant has the 30 days before today.
  Record r;
  r.days[0] = 7;  // yesterday, as the device counted it
  r.days_date = 20261117;
  r.months[0] = 7;
  r.months_key = 202611;
  Result res = r.import("2026-11-17: 12 0 - 940 3", 20261118);
  EXPECT(res.error == Error::NONE && !res.months);
  EXPECT(res.written == 4 && res.unknown == 1 && res.open == 0);
  EXPECT(r.days_date == 20261117);
  EXPECT(r.days[0] == 12 && r.days[1] == 0 && r.days[2] == DAY_UNKNOWN && r.days[3] == 940 && r.days[4] == 3);
  EXPECT(r.days[5] == DAY_UNKNOWN);
  // this month: its closed days in the record, once each (today is added by the page and at midnight)
  EXPECT(r.months[0] == 12 + 0 + 940 + 3);
  EXPECT(r.months_key == 202611);
}

static void test_today_is_never_imported() {
  Record r;
  Result res = r.import("2026-11-18: 500 4", 20261118);  // a line that starts today
  EXPECT(res.error == Error::NONE && res.open == 1 && res.written == 1);
  EXPECT(r.days_date == 20261117 && r.days[0] == 4);
  EXPECT(r.months[0] == 4);  // not today's 500
  EXPECT(r.import("2026-11-19: 1", 20261118).error == Error::FUTURE);
  EXPECT(r.import("2026-12: 1", 20261118).error == Error::FUTURE);
}

static void test_days_across_months() {
  // Today is the 3rd: this month has two closed days, the rest of the line is October's.
  Record r;
  Result res = r.import("2026-11-02: 10 20 30 40", 20261103);
  EXPECT(res.error == Error::NONE && res.written == 4);
  EXPECT(r.months[0] == 30);  // the 2nd and the 1st only
  EXPECT(r.months_key == 202611);
  EXPECT(r.months[1] == MONTH_UNKNOWN);  // October's total comes from a months line
  // On the 1st nothing of the month is closed yet.
  Record first;
  first.import("2026-10-31: 10 20", 20261101);
  EXPECT(first.days_date == 20261031 && first.days[0] == 10);
  EXPECT(first.months[0] == 0 && first.months_key == 202611);
}

static void test_older_than_the_record() {
  Record r;
  std::string line = "2026-11-17:";
  for (int i = 0; i < 30; i++) line += " 1";
  Result res = r.import(line.c_str(), 20261120);  // the line ends 2 days before yesterday: its last 2 days fall out
  EXPECT(res.error == Error::NONE && res.written == 28 && res.outside == 2);
  EXPECT(r.days_date == 20261119);
  EXPECT(r.days[0] == DAY_UNKNOWN && r.days[1] == DAY_UNKNOWN && r.days[2] == 1 && r.days[29] == 1);
}

static void test_unknown_never_erases() {
  Record r;
  r.days[0] = 9;
  r.days[1] = 8;
  r.days_date = 20261117;
  r.months_key = 202611;
  r.months[0] = 17;
  r.import("2026-11-17: - 2", 20261118);
  EXPECT(r.days[0] == 9 && r.days[1] == 2);
  EXPECT(r.months[0] == 11);
}

static void test_months() {
  Record r;
  r.days[0] = 5;
  r.days[1] = 6;
  r.days_date = 20261117;
  r.months[0] = 11;
  r.months_key = 202611;
  // Home Assistant's months, this one first (skipped: it is recomputed from the days), then October back.
  Result res = r.import("2026-11: 999 9538 2913 - 120", 20261118);
  EXPECT(res.error == Error::NONE && res.months);
  EXPECT(res.written == 3 && res.open == 1 && res.unknown == 1);
  EXPECT(r.months[0] == 11);
  EXPECT(r.months[1] == 9538 && r.months[2] == 2913 && r.months[3] == MONTH_UNKNOWN && r.months[4] == 120);
  // A line that starts last month: its first value is October's.
  Record s;
  s.import("2026-10: 9538 2913", 20261118);
  EXPECT(s.months_key == 202611 && s.months[0] == 0 && s.months[1] == 9538 && s.months[2] == 2913);
  // 12 months from last month: the oldest one is outside the record.
  std::string line = "2026-10:";
  for (int i = 0; i < 12; i++) line += " 1";
  Record t;
  Result out = t.import(line.c_str(), 20261118);
  EXPECT(out.written == 11 && out.outside == 1);
}

static void test_record_moves_on_as_the_rollover_would() {
  // The record's last day is October 30th (the controller was off since): the days between become unknown, October
  // becomes last month.
  Record r;
  r.days[0] = 50;
  r.days_date = 20261030;
  r.months[0] = 950;
  r.months[1] = 900;
  r.months_key = 202610;
  Result res = r.import("2026-11-02: 1", 20261103);
  EXPECT(res.error == Error::NONE && res.written == 1);
  EXPECT(r.days_date == 20261102);
  EXPECT(r.days[0] == 1 && r.days[1] == DAY_UNKNOWN && r.days[2] == DAY_UNKNOWN && r.days[3] == 50);
  EXPECT(r.months_key == 202611 && r.months[1] == 950 && r.months[2] == 900);
  EXPECT(r.months[0] == 1);  // the 2nd; the 1st is unknown
}

static void test_refused_imports_change_nothing() {
  Record r;
  r.days[0] = 3;
  r.days_date = 20261119;  // after yesterday: the clock went back
  r.months_key = 202611;
  r.months[0] = 3;
  Record before = r;
  EXPECT(r.import("2026-11-17: 1 2", 20261118).error == Error::RECORD_AHEAD);
  EXPECT(std::memcmp(r.days, before.days, sizeof r.days) == 0 && r.days_date == before.days_date);
  EXPECT(std::memcmp(r.months, before.months, sizeof r.months) == 0 && r.months_key == before.months_key);
  Record m;
  m.months_key = 202612;
  EXPECT(m.import("2026-10: 1", 20261118).error == Error::RECORD_AHEAD);
}

static void test_saturation() {
  Record r;
  Result res = r.import("2026-11-17: 70000 65534", 20261118);
  EXPECT(res.written == 2 && res.clamped == 1);
  EXPECT(r.days[0] == DAY_MAX && r.days[1] == DAY_MAX);
}

static void test_import_twice_is_the_same() {
  Record a, b;
  a.import("2026-11-17: 1 2 3", 20261118);
  b.import("2026-11-17: 1 2 3", 20261118);
  b.import("2026-11-17: 1 2 3", 20261118);
  EXPECT(std::memcmp(a.days, b.days, sizeof a.days) == 0 && std::memcmp(a.months, b.months, sizeof a.months) == 0);
  EXPECT(b.months[0] == 6);
}

/// The entity's state is a code (docs/plans/i18n.md), and the log's reason English (plain ASCII).
static void test_outcome() {
  Record r;
  EXPECT(outcome(r.import("2026-11-17: 1 2 3", 20261118)) == "imported:days:3");
  EXPECT(outcome(r.import("2026-11-18: 1", 20261118)) == "imported:days:0");  // today only: nothing written
  EXPECT(outcome(r.import("2026-10: 5 6", 20261118)) == "imported:months:2");
  EXPECT(outcome(r.import("nonsense", 20261118)) == "refused:format");
  EXPECT(outcome(r.import("2026-02-30: 5", 20261118)) == "refused:date");
  EXPECT(outcome(r.import("2026-11-17: 1.5", 20261118)) == "refused:value");
  EXPECT(outcome(r.import("2026-11: 1 2 3 4 5 6 7 8 9 10 11 12 13", 20261118)) == "refused:too_many");
  EXPECT(outcome(r.import("2026-11-19: 1", 20261118)) == "refused:future");
  EXPECT(outcome(r.import("2026-11-01: 1", 20261101)) == "refused:record_ahead");  // the record is dated 11-17
  EXPECT(std::string(REFUSED_NO_CLOCK) == "refused:no_clock");
  for (Error e : {Error::FORMAT, Error::DATE, Error::VALUE, Error::TOO_MANY, Error::FUTURE, Error::RECORD_AHEAD})
    for (const char *c = error_text(e); *c; c++) EXPECT((unsigned char) *c < 0x80);
}

int main() {
  test_dates();
  test_parse();
  test_days_into_an_empty_record();
  test_today_is_never_imported();
  test_days_across_months();
  test_older_than_the_record();
  test_unknown_never_erases();
  test_months();
  test_record_moves_on_as_the_rollover_would();
  test_refused_imports_change_nothing();
  test_saturation();
  test_import_twice_is_the_same();
  test_outcome();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("fill_import: all tests passed\n");
  return 0;
}
