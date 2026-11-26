#pragma once
// Pure helpers for History Import (history-import.yaml): printing the controller's 7-day record the way Daily
// History, Daily Plan History, Daily Outdoor History and Daily Equipment Pad History show it, and reading those
// strings back into the record, plus today's running values. No ESPHome header on purpose:
// tools/tests/history_import_test.cpp compiles this file on the host (`make firmware-test`).
//
// The record (pool-controller.yaml's history_* globals), kept here as the midnight rollover (filtration_accrue)
// keeps it: slot 0 is the newest closed day, dates[i] is a YYYYMMDD (0 = empty slot, never printed), minutes[i] how
// long the pump ran, planned[i] the plan's minutes (0xFFFF = unknown), and the min/max pairs in tenths of a degree
// (INT16_MIN = no reading that day).
//
// A line is a tag, then a body:
//   daily:    Daily History's string. Replaces the record's dates, filtration minutes and water min/max. The other
//             series keep their value for a date that stays in the record, and are unknown for a new one.
//   plan:     Daily Plan History's string; outdoor: Daily Outdoor History's; pad: Daily Equipment Pad History's.
//             Every date must already be in the record (import daily: first). The line is that series' whole truth:
//             a record day the line leaves out becomes unknown, as the sensor would have left it out.
//   today:    `YYYY-MM-DD filtration=<min> water=<lo>/<hi> outdoor=<lo>/<hi> fill=<L>`, plus an optional
//             `pad=<lo>/<hi>`, in any order, `-` for unknown (fill: no litres). Sets today's running values, only
//             when the date is the device's today.
// "--" (what the sensors print with no day) is an empty body. Hours read back to within one minute (the sensors
// print hundredths of an hour), temperatures exactly. Anything off refuses the whole line, and a refused line
// changes nothing.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace history_import {

static const int DAYS = 7;
static const int16_t NO_TEMP = INT16_MIN;
static const uint16_t NO_PLAN = 0xFFFF;
static const uint32_t MAX_MINUTES = 24 * 60;  // the rollover caps a closed day at 24 h

// ------------------------------------------------------------------ printing (the sensors' own lambdas)

/// Daily History: « 2026-11-13: 6.42 h 25.9/26.6 °C, 2026-11-12: 6.70 h », newest first, "--" when empty.
inline std::string format_daily(const uint32_t dates[], const uint16_t minutes[], const int16_t water_min[],
                                const int16_t water_max[]) {
  std::string out;
  for (int i = 0; i < DAYS; i++) {
    uint32_t d = dates[i];
    if (d == 0)
      continue;
    uint16_t m = minutes[i];
    char buf[64];
    int len = snprintf(buf, sizeof(buf), "%s%04u-%02u-%02u: %u.%02u h", out.empty() ? "" : ", ",
                       (unsigned) (d / 10000), (unsigned) (d / 100 % 100), (unsigned) (d % 100),
                       (unsigned) (m / 60), (unsigned) ((m % 60) * 100 / 60));
    int16_t lo = water_min[i], hi = water_max[i];
    if (lo != NO_TEMP && hi != NO_TEMP) {
      snprintf(buf + len, sizeof(buf) - len, " %.1f/%.1f °C", lo / 10.0f, hi / 10.0f);
    }
    out += buf;
  }
  return out.empty() ? std::string("--") : out;
}

/// Daily Plan History: the same dates and hours, a day with no known plan left out.
inline std::string format_plan(const uint32_t dates[], const uint16_t planned[]) {
  std::string out;
  for (int i = 0; i < DAYS; i++) {
    uint32_t d = dates[i];
    uint16_t m = planned[i];
    if (d == 0 || m == NO_PLAN)
      continue;
    char buf[32];
    snprintf(buf, sizeof(buf), "%s%04u-%02u-%02u: %u.%02u h", out.empty() ? "" : ", ", (unsigned) (d / 10000),
             (unsigned) (d / 100 % 100), (unsigned) (d % 100), (unsigned) (m / 60), (unsigned) ((m % 60) * 100 / 60));
    out += buf;
  }
  return out.empty() ? std::string("--") : out;
}

/// Daily Outdoor History and Daily Equipment Pad History: « 2026-11-13: -1.4/9.8 °C », a day with no reading left
/// out.
inline std::string format_range(const uint32_t dates[], const int16_t lo_of[], const int16_t hi_of[]) {
  std::string out;
  for (int i = 0; i < DAYS; i++) {
    uint32_t d = dates[i];
    int16_t lo = lo_of[i], hi = hi_of[i];
    if (d == 0 || lo == NO_TEMP || hi == NO_TEMP)
      continue;
    char buf[40];
    snprintf(buf, sizeof(buf), "%s%04u-%02u-%02u: %.1f/%.1f °C", out.empty() ? "" : ", ", (unsigned) (d / 10000),
             (unsigned) (d / 100 % 100), (unsigned) (d % 100), lo / 10.0f, hi / 10.0f);
    out += buf;
  }
  return out.empty() ? std::string("--") : out;
}

// ------------------------------------------------------------------ the device's state

/// The 7-day record: pointers to the firmware's history_* arrays (DAYS each).
struct Record {
  uint32_t *dates;
  uint16_t *minutes;
  int16_t *water_min, *water_max;
  int16_t *outdoor_min, *outdoor_max;
  int16_t *pad_min, *pad_max;
  uint16_t *planned;
};

/// Today's running values: filtration_ms_today, the *_min/max_today globals and fill_today.
struct Today {
  uint32_t *filtration_ms;
  int16_t *water_min, *water_max;
  int16_t *outdoor_min, *outdoor_max;
  int16_t *pad_min, *pad_max;
  uint32_t *fill;
};

// ------------------------------------------------------------------ parsing

enum class Kind : uint8_t { DAILY, PLAN, OUTDOOR, PAD, TODAY };

inline const char *kind_tag(Kind k) {
  switch (k) {
    case Kind::DAILY:
      return "daily";
    case Kind::PLAN:
      return "plan";
    case Kind::OUTDOOR:
      return "outdoor";
    case Kind::PAD:
      return "pad";
    case Kind::TODAY:
      return "today";
  }
  return "?";
}

enum class Error : uint8_t { NONE = 0, FORMAT, TAG, DATE, VALUE, TOO_MANY, FUTURE, RECORD_AHEAD, NOT_TODAY, NOT_IN_RECORD };

/// For the entity's state (`refused:<code>`, see outcome()). A published code is never renamed: add a new one
/// instead. A date missing from the record is `date`, like an invalid one: the log tells them apart.
inline const char *error_code(Error e) {
  switch (e) {
    case Error::NONE:
      return "ok";
    case Error::FORMAT:
      return "format";
    case Error::TAG:
      return "tag";
    case Error::DATE:
    case Error::NOT_IN_RECORD:
      return "date";
    case Error::VALUE:
      return "value";
    case Error::TOO_MANY:
      return "too_many";
    case Error::FUTURE:
      return "future";
    case Error::RECORD_AHEAD:
      return "record_ahead";
    case Error::NOT_TODAY:
      return "not_today";
  }
  return "?";
}

/// For the log only, in English: why a line was refused.
inline const char *error_text(Error e) {
  switch (e) {
    case Error::NONE:
      return "ok";
    case Error::FORMAT:
      return "format (expected a history sensor's own string after its tag, e.g. \"daily:2026-11-13: 6.42 h "
             "25.9/26.6 °C\")";
    case Error::TAG:
      return "unknown tag (daily:, plan:, outdoor:, pad: or today:)";
    case Error::DATE:
      return "invalid date, or dates not newest first";
    case Error::VALUE:
      return "invalid value (hours up to 24, min/max with min <= max, whole litres)";
    case Error::TOO_MANY:
      return "too many days (7 at most)";
    case Error::FUTURE:
      return "a closed day dated today or later";
    case Error::RECORD_AHEAD:
      return "the controller's record holds newer days, or is dated today or later (did its clock go back?)";
    case Error::NOT_TODAY:
      return "today: line not dated the controller's today";
    case Error::NOT_IN_RECORD:
      return "a date not in the 7-day record (import its daily: line first)";
  }
  return "?";
}

/// One day of a history line; lo/hi are NO_TEMP when the line has no range for it.
struct Day {
  uint32_t date = 0;
  uint16_t minutes = 0;
  int16_t lo = NO_TEMP, hi = NO_TEMP;
};

struct Line {
  Kind kind = Kind::DAILY;
  // history tags: the days, newest first
  int count = 0;
  Day days[DAYS];
  // today:
  uint32_t date = 0;
  uint32_t minutes = 0;
  int16_t water_lo = NO_TEMP, water_hi = NO_TEMP, outdoor_lo = NO_TEMP, outdoor_hi = NO_TEMP;
  bool has_pad = false;
  int16_t pad_lo = NO_TEMP, pad_hi = NO_TEMP;
  bool fill_known = false;
  uint32_t fill = 0;
};

inline bool valid_date(uint32_t y, uint32_t m, uint32_t d) {
  if (y < 2000 || y > 9999 || m < 1 || m > 12 || d < 1)
    return false;
  static const uint8_t LEN[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
  return d <= (uint32_t) (LEN[m - 1] + (m == 2 && leap));
}

/// Reads a string left to right; every reader moves on only when it matched.
struct Cursor {
  const std::string &s;
  size_t i;
  bool done() const { return i >= s.size(); }
  bool lit(const char *t) {
    size_t n = strlen(t);
    if (s.compare(i, n, t) != 0)
      return false;
    i += n;
    return true;
  }
  /// min..max digits, and no digit right after them.
  bool digits(size_t min, size_t max, uint64_t &v) {
    size_t j = i;
    v = 0;
    while (j < s.size() && j - i < max && s[j] >= '0' && s[j] <= '9')
      v = v * 10 + (uint64_t) (s[j++] - '0');
    if (j - i < min || (j < s.size() && s[j] >= '0' && s[j] <= '9'))
      return false;
    i = j;
    return true;
  }
};

/// YYYY-MM-DD.
inline Error read_date(Cursor &c, uint32_t &ymd) {
  uint64_t y, m, d;
  if (!c.digits(4, 4, y) || !c.lit("-") || !c.digits(2, 2, m) || !c.lit("-") || !c.digits(2, 2, d))
    return Error::FORMAT;
  if (!valid_date((uint32_t) y, (uint32_t) m, (uint32_t) d))
    return Error::DATE;
  ymd = (uint32_t) (y * 10000 + m * 100 + d);
  return Error::NONE;
}

/// « 6.42 h »: hours and hundredths, as the sensors print minutes (m / 60 . (m % 60) * 100 / 60). The smallest
/// minute count printing those hundredths is ceil(hundredths * 60 / 100): exact for every string the firmware
/// prints, and within a minute for any other.
inline Error read_hours(Cursor &c, uint16_t &minutes) {
  uint64_t h, f;
  if (!c.digits(1, 2, h) || !c.lit(".") || !c.digits(2, 2, f) || !c.lit(" h"))
    return Error::FORMAT;
  uint64_t m = h * 60 + (f * 3 + 4) / 5;
  if (m > MAX_MINUTES)
    return Error::VALUE;
  minutes = (uint16_t) m;
  return Error::NONE;
}

/// « -1.4 »: one decimal, as %.1f prints it, in tenths.
inline Error read_temp(Cursor &c, int16_t &tenths) {
  bool neg = c.lit("-");
  uint64_t whole, frac;
  if (!c.digits(1, 3, whole) || !c.lit(".") || !c.digits(1, 1, frac))
    return Error::FORMAT;
  int v = (int) (whole * 10 + frac);
  tenths = (int16_t) (neg ? -v : v);
  return Error::NONE;
}

/// « -1.4/9.8 »: a day's min/max, min <= max.
inline Error read_range(Cursor &c, int16_t &lo, int16_t &hi) {
  Error e = read_temp(c, lo);
  if (e == Error::NONE && !c.lit("/"))
    e = Error::FORMAT;
  if (e == Error::NONE)
    e = read_temp(c, hi);
  if (e == Error::NONE && lo > hi)
    e = Error::VALUE;
  return e;
}

/// A history sensor's string: days newest first, separated by ", ".
inline Error read_days(Cursor &c, Line &out) {
  if (c.lit("--"))
    return c.done() ? Error::NONE : Error::FORMAT;
  while (true) {
    if (out.count == DAYS)
      return Error::TOO_MANY;
    Day &d = out.days[out.count];
    Error e = read_date(c, d.date);
    if (e != Error::NONE)
      return e;
    if (out.count > 0 && d.date >= out.days[out.count - 1].date)
      return Error::DATE;
    if (!c.lit(": "))
      return Error::FORMAT;
    switch (out.kind) {
      case Kind::DAILY:
        e = read_hours(c, d.minutes);
        if (e == Error::NONE && c.lit(" ")) {
          e = read_range(c, d.lo, d.hi);
          if (e == Error::NONE && !c.lit(" °C"))
            e = Error::FORMAT;
        }
        break;
      case Kind::PLAN:
        e = read_hours(c, d.minutes);
        break;
      default:  // OUTDOOR, PAD
        e = read_range(c, d.lo, d.hi);
        if (e == Error::NONE && !c.lit(" °C"))
          e = Error::FORMAT;
        break;
    }
    if (e != Error::NONE)
      return e;
    out.count++;
    if (c.done())
      return Error::NONE;
    if (!c.lit(", "))
      return Error::FORMAT;
  }
}

/// `-` or a min/max, for today's values.
inline Error read_today_range(const std::string &v, int16_t &lo, int16_t &hi) {
  lo = hi = NO_TEMP;
  if (v == "-")
    return Error::NONE;
  Cursor c{v, 0};
  Error e = read_range(c, lo, hi);
  return e != Error::NONE ? e : c.done() ? Error::NONE : Error::FORMAT;
}

/// `YYYY-MM-DD filtration=<min> water=<lo>/<hi> outdoor=<lo>/<hi> fill=<L>` (+ optional pad=), in any order.
inline Error read_today(Cursor &c, Line &out) {
  Error e = read_date(c, out.date);
  if (e != Error::NONE)
    return e;
  bool seen_filtration = false, seen_water = false, seen_outdoor = false, seen_fill = false;
  while (!c.done()) {
    if (!c.lit(" "))
      return Error::FORMAT;
    size_t eq = c.s.find('=', c.i), end = c.s.find(' ', c.i);
    if (end == std::string::npos)
      end = c.s.size();
    if (eq == std::string::npos || eq >= end)
      return Error::FORMAT;
    const std::string key = c.s.substr(c.i, eq - c.i), value = c.s.substr(eq + 1, end - eq - 1);
    c.i = end;
    if (value.empty())
      return Error::FORMAT;
    if (key == "filtration") {
      if (seen_filtration)
        return Error::FORMAT;
      seen_filtration = true;
      Cursor v{value, 0};
      uint64_t m;
      if (!v.digits(1, 4, m) || !v.done())
        return Error::VALUE;
      if (m > MAX_MINUTES)
        return Error::VALUE;
      out.minutes = (uint32_t) m;
    } else if (key == "water" || key == "outdoor" || key == "pad") {
      bool &seen = key == "water" ? seen_water : key == "outdoor" ? seen_outdoor : out.has_pad;
      if (seen)
        return Error::FORMAT;
      seen = true;
      int16_t &lo = key == "water" ? out.water_lo : key == "outdoor" ? out.outdoor_lo : out.pad_lo;
      int16_t &hi = key == "water" ? out.water_hi : key == "outdoor" ? out.outdoor_hi : out.pad_hi;
      e = read_today_range(value, lo, hi);
      if (e != Error::NONE)
        return e;
    } else if (key == "fill") {
      if (seen_fill)
        return Error::FORMAT;
      seen_fill = true;
      if (value != "-") {
        Cursor v{value, 0};
        uint64_t l;
        if (!v.digits(1, 10, l) || !v.done() || l >= UINT32_MAX)
          return Error::VALUE;
        out.fill_known = true;
        out.fill = (uint32_t) l;
      }
    } else {
      return Error::FORMAT;
    }
  }
  return seen_filtration && seen_water && seen_outdoor && seen_fill ? Error::NONE : Error::FORMAT;
}

/// Reads « <tag>:<body> » (spaces around the line and after the tag allowed). Strict: anything off refuses the
/// whole line.
inline Error parse(const std::string &text, Line &out) {
  out = Line{};
  size_t b = text.find_first_not_of(' '), e = text.find_last_not_of(' ');
  if (b == std::string::npos)
    return Error::FORMAT;
  const std::string s = text.substr(b, e - b + 1);
  size_t colon = s.find(':');
  if (colon == std::string::npos)
    return Error::FORMAT;
  const std::string tag = s.substr(0, colon);
  if (tag == "daily")
    out.kind = Kind::DAILY;
  else if (tag == "plan")
    out.kind = Kind::PLAN;
  else if (tag == "outdoor")
    out.kind = Kind::OUTDOOR;
  else if (tag == "pad")
    out.kind = Kind::PAD;
  else if (tag == "today")
    out.kind = Kind::TODAY;
  else
    return Error::TAG;
  Cursor c{s, colon + 1};
  while (c.lit(" ")) {
  }
  if (c.done())
    return Error::FORMAT;
  return out.kind == Kind::TODAY ? read_today(c, out) : read_days(c, out);
}

// ------------------------------------------------------------------ writing

/// What an import did: the days (or today) written.
struct Result {
  Error error = Error::NONE;
  Kind kind = Kind::DAILY;
  int written = 0;
};

inline int slot_of(const Record &r, uint32_t date) {
  for (int i = 0; i < DAYS; i++)
    if (r.dates[i] == date && date != 0)
      return i;
  return -1;
}

inline Result apply_daily(const Line &line, uint32_t today, Record &r) {
  Result res;
  res.kind = line.kind;
  for (int k = 0; k < line.count; k++)
    if (line.days[k].date >= today) {
      res.error = Error::FUTURE;
      return res;
    }
  uint32_t newest = 0;
  for (int i = 0; i < DAYS; i++)
    if (r.dates[i] > newest)
      newest = r.dates[i];
  if (newest >= today || (newest != 0 && (line.count == 0 || newest > line.days[0].date))) {
    res.error = Error::RECORD_AHEAD;
    return res;
  }
  // The series the line doesn't carry follow their date.
  uint32_t dates[DAYS];
  int16_t omin[DAYS], omax[DAYS], pmin[DAYS], pmax[DAYS];
  uint16_t planned[DAYS];
  for (int i = 0; i < DAYS; i++) {
    dates[i] = r.dates[i];
    omin[i] = r.outdoor_min[i], omax[i] = r.outdoor_max[i];
    pmin[i] = r.pad_min[i], pmax[i] = r.pad_max[i];
    planned[i] = r.planned[i];
  }
  for (int i = 0; i < DAYS; i++) {
    int old = -1;
    if (i < line.count)
      for (int j = 0; j < DAYS; j++)
        if (dates[j] == line.days[i].date)
          old = j;
    r.dates[i] = i < line.count ? line.days[i].date : 0;
    r.minutes[i] = i < line.count ? line.days[i].minutes : 0;
    r.water_min[i] = i < line.count ? line.days[i].lo : NO_TEMP;
    r.water_max[i] = i < line.count ? line.days[i].hi : NO_TEMP;
    r.outdoor_min[i] = old >= 0 ? omin[old] : NO_TEMP;
    r.outdoor_max[i] = old >= 0 ? omax[old] : NO_TEMP;
    r.pad_min[i] = old >= 0 ? pmin[old] : NO_TEMP;
    r.pad_max[i] = old >= 0 ? pmax[old] : NO_TEMP;
    r.planned[i] = old >= 0 ? planned[old] : NO_PLAN;
  }
  res.written = line.count;
  return res;
}

inline Result apply_series(const Line &line, Record &r) {
  Result res;
  res.kind = line.kind;
  for (int k = 0; k < line.count; k++)
    if (slot_of(r, line.days[k].date) < 0) {
      res.error = Error::NOT_IN_RECORD;
      return res;
    }
  for (int i = 0; i < DAYS; i++) {
    const Day *d = nullptr;
    for (int k = 0; k < line.count; k++)
      if (r.dates[i] != 0 && line.days[k].date == r.dates[i])
        d = &line.days[k];
    switch (line.kind) {
      case Kind::PLAN:
        r.planned[i] = d ? d->minutes : NO_PLAN;
        break;
      case Kind::OUTDOOR:
        r.outdoor_min[i] = d ? d->lo : NO_TEMP;
        r.outdoor_max[i] = d ? d->hi : NO_TEMP;
        break;
      default:  // PAD
        r.pad_min[i] = d ? d->lo : NO_TEMP;
        r.pad_max[i] = d ? d->hi : NO_TEMP;
        break;
    }
  }
  res.written = line.count;
  return res;
}

inline Result apply_today(const Line &line, uint32_t today, Today &t) {
  Result res;
  res.kind = Kind::TODAY;
  if (line.date != today) {
    res.error = Error::NOT_TODAY;
    return res;
  }
  *t.filtration_ms = line.minutes * 60000UL;
  *t.water_min = line.water_lo, *t.water_max = line.water_hi;
  *t.outdoor_min = line.outdoor_lo, *t.outdoor_max = line.outdoor_hi;
  if (line.has_pad)
    *t.pad_min = line.pad_lo, *t.pad_max = line.pad_hi;
  *t.fill = line.fill_known ? line.fill : 0;
  res.written = 1;
  return res;
}

/// Writes a parsed line into the record or today's values, `today` being the device's date (YYYYMMDD). Leaves
/// everything untouched when it returns an error.
inline Result apply(const Line &line, uint32_t today, Record &r, Today &t) {
  switch (line.kind) {
    case Kind::DAILY:
      return apply_daily(line, today, r);
    case Kind::TODAY:
      return apply_today(line, today, t);
    default:
      return apply_series(line, r);
  }
}

// ------------------------------------------------------------------ the entity's state

/// History Import's state when there is no clock to date the line against.
static const char *const REFUSED_NO_CLOCK = "refused:no_clock";

/// History Import's state after an import: `imported:<tag>:N` (N days written), `imported:today`, or
/// `refused:<error_code>`.
inline std::string outcome(const Result &r) {
  if (r.error != Error::NONE)
    return std::string("refused:") + error_code(r.error);
  if (r.kind == Kind::TODAY)
    return "imported:today";
  return std::string("imported:") + kind_tag(r.kind) + ":" + std::to_string(r.written);
}

}  // namespace history_import
