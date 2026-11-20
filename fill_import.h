#pragma once
// Pure helpers for Fill Water Import (pool-controller.yaml): reading a line in Fill Water Days' or Fill Water
// Months' own format and writing it into the controller's fill-water record (the fill_days / fill_months globals).
// No ESPHome header on purpose: tools/tests/fill_import_test.cpp compiles this file on the host
// (`make firmware-test`).
//
// The record's invariants, kept here as the midnight rollover (filtration_accrue) keeps them:
//   - fill_days[i] is the day `fill_days_date` minus i (newest first); 0xFFFF = unknown, 0xFFFE = 65534 L or more;
//   - fill_months[j] is the month `fill_months_key` minus j; fill_months[0] holds that month's CLOSED days only
//     (today is Fill Water Today, added at midnight); UINT32_MAX = unknown.
// An import never touches today: its line may start today or this month, those values are skipped.

#include <cstdint>
#include <string>

namespace fill_import {

static const int DAYS = 30;
static const int MONTHS = 12;
static const uint16_t DAY_UNKNOWN = 0xFFFF;
static const uint16_t DAY_MAX = 0xFFFE;  // the record saturates here, as the rollover does
static const uint32_t MONTH_UNKNOWN = UINT32_MAX;

// ------------------------------------------------------------------ dates

/// Days since 1970-01-01 of a YYYYMMDD (H. Hinnant's days_from_civil), as the rollover counts them.
inline int32_t civil(uint32_t ymd) {
  int y = ymd / 10000, m = ymd / 100 % 100, d = ymd % 100;
  y -= m <= 2;
  int era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400;
  int doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

/// The YYYYMMDD of a day count since 1970-01-01 (H. Hinnant's civil_from_days).
inline uint32_t ymd_of(int32_t z) {
  z += 719468;
  int32_t era = (z >= 0 ? z : z - 146096) / 146097;
  int32_t doe = z - era * 146097;
  int32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int32_t mp = (5 * doy + 2) / 153;
  int32_t d = doy - (153 * mp + 2) / 5 + 1;
  int32_t m = mp < 10 ? mp + 3 : mp - 9;
  int32_t y = yoe + era * 400 + (m <= 2);
  return (uint32_t) y * 10000u + (uint32_t) m * 100u + (uint32_t) d;
}

/// A YYYYMM as a month count, so two of them subtract.
inline int32_t month_number(uint32_t ym) { return (int32_t) (ym / 100) * 12 + (int32_t) (ym % 100) - 1; }

inline bool valid_date(uint32_t y, uint32_t m, uint32_t d) {
  if (y < 2000 || y > 9999 || m < 1 || m > 12 || d < 1)
    return false;
  static const uint8_t LEN[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
  return d <= (uint32_t) (LEN[m - 1] + (m == 2 && leap));
}

// ------------------------------------------------------------------ parsing

enum class Error : uint8_t { NONE = 0, FORMAT, DATE, VALUE, TOO_MANY, FUTURE, RECORD_AHEAD };

/// For the entity's state (`refused:<code>`, see outcome()): why a line was refused, as a code the UIs translate
/// (docs/plans/i18n.md). A published code is never renamed: add a new one instead.
inline const char *error_code(Error e) {
  switch (e) {
    case Error::NONE:
      return "ok";
    case Error::FORMAT:
      return "format";
    case Error::DATE:
      return "date";
    case Error::VALUE:
      return "value";
    case Error::TOO_MANY:
      return "too_many";
    case Error::FUTURE:
      return "future";
    case Error::RECORD_AHEAD:
      return "record_ahead";
  }
  return "?";
}

/// For the log only, in English: why a line was refused.
inline const char *error_text(Error e) {
  switch (e) {
    case Error::NONE:
      return "ok";
    case Error::FORMAT:
      return "format (expected \"2026-11-17: 0 19 - 940\" or \"2026-11: 23 950\")";
    case Error::DATE:
      return "invalid date";
    case Error::VALUE:
      return "invalid value (whole litres >= 0, or -)";
    case Error::TOO_MANY:
      return "too many values (30 days or 12 months at most)";
    case Error::FUTURE:
      return "date in the future";
    case Error::RECORD_AHEAD:
      return "the controller's record is dated after yesterday: did its clock go back?";
  }
  return "?";
}

/// A line as Fill Water Days or Fill Water Months prints it: its newest date and its values, newest first.
struct Line {
  bool months = false;  // YYYY-MM: (months) rather than YYYY-MM-DD: (days)
  uint32_t date = 0;    // YYYYMMDD, or YYYYMM for months
  int count = 0;
  uint32_t values[DAYS] = {};
  bool known[DAYS] = {};  // false for "-"
};

/// Reads « 2026-11-17: 0 19 - 940 » (days, at most 30) or « 2026-11: 23 30 950 » (months, at most 12): the date's
/// length tells which. Values are whole litres (digits only) or "-" for unknown, separated by spaces; spaces around
/// the line are allowed, nothing else. Strict: anything off refuses the whole line.
inline Error parse(const std::string &text, Line &out) {
  out = Line{};
  size_t b = text.find_first_not_of(' '), e = text.find_last_not_of(' ');
  if (b == std::string::npos)
    return Error::FORMAT;
  const std::string s = text.substr(b, e - b + 1);
  size_t colon = s.find(':');
  if (colon != 7 && colon != 10)
    return Error::FORMAT;
  out.months = colon == 7;
  auto digits = [&](size_t from, size_t n, uint32_t &v) {
    v = 0;
    for (size_t i = from; i < from + n; i++) {
      if (s[i] < '0' || s[i] > '9')
        return false;
      v = v * 10 + (uint32_t) (s[i] - '0');
    }
    return true;
  };
  uint32_t y, m, d = 1;
  if (!digits(0, 4, y) || s[4] != '-' || !digits(5, 2, m))
    return Error::FORMAT;
  if (!out.months && (s[7] != '-' || !digits(8, 2, d)))
    return Error::FORMAT;
  if (!valid_date(y, m, d))
    return Error::DATE;
  out.date = out.months ? y * 100 + m : y * 10000 + m * 100 + d;
  const int cap = out.months ? MONTHS : DAYS;
  size_t i = colon + 1;
  while (i < s.size()) {
    if (s[i] != ' ')
      return Error::FORMAT;
    while (i < s.size() && s[i] == ' ')
      i++;
    size_t j = i;
    while (j < s.size() && s[j] != ' ')
      j++;
    if (out.count == cap)
      return Error::TOO_MANY;
    const std::string tok = s.substr(i, j - i);
    if (tok == "-") {
      out.known[out.count] = false;
      out.values[out.count] = 0;
    } else {
      if (tok.empty() || tok.size() > 10)
        return Error::VALUE;
      uint64_t v = 0;
      for (char c : tok) {
        if (c < '0' || c > '9')
          return Error::VALUE;
        v = v * 10 + (uint64_t) (c - '0');
      }
      if (v >= MONTH_UNKNOWN)
        return Error::VALUE;
      out.known[out.count] = true;
      out.values[out.count] = (uint32_t) v;
    }
    out.count++;
    i = j;
  }
  return out.count ? Error::NONE : Error::FORMAT;
}

// ------------------------------------------------------------------ the record

/// What an import did: values written, and those left out: "-" (unknown), today or this month (open: never
/// imported), or older than the record keeps (outside); `clamped` days were above 65534 L.
struct Result {
  Error error = Error::NONE;
  bool months = false;
  int written = 0, unknown = 0, open = 0, outside = 0, clamped = 0;
};

/// Dates fill_days at `yesterday` the way the rollover would get there (the days in between unknown), without closing
/// anything: today stays Fill Water Today's. False when the record is dated after yesterday (the clock went back).
inline bool anchor_days(uint16_t days[DAYS], uint32_t &days_date, uint32_t yesterday) {
  int gap = days_date ? civil(yesterday) - civil(days_date) : DAYS;
  if (gap < 0)
    return false;
  int n = gap < DAYS ? gap : DAYS;
  for (int i = DAYS - 1; i >= n; i--)
    days[i] = days[i - n];
  for (int i = 0; i < n; i++)
    days[i] = DAY_UNKNOWN;
  days_date = yesterday;
  return true;
}

/// The same for fill_months at this month: a month the record hasn't reached yet opens at 0 (its closed days so far,
/// recomputed by the caller), the ones in between unknown. False when the record is dated after this month.
inline bool anchor_months(uint32_t months[MONTHS], uint32_t &key, uint32_t this_month) {
  int gap = key ? month_number(this_month) - month_number(key) : MONTHS;
  if (gap < 0)
    return false;
  if (gap == 0)
    return true;
  int k = gap < MONTHS ? gap : MONTHS;
  for (int i = MONTHS - 1; i >= k; i--)
    months[i] = months[i - k];
  for (int i = 1; i < k; i++)
    months[i] = MONTH_UNKNOWN;
  months[0] = 0;
  key = this_month;
  return true;
}

/// This month's closed days in the record (dated `yesterday`), in litres: what fill_months[0] holds. Unknown days
/// count as 0, as the rollover adds nothing for a day the device missed.
inline uint32_t closed_days_of_month(const uint16_t days[DAYS], uint32_t yesterday, uint32_t today) {
  uint32_t sum = 0;
  int32_t newest = civil(yesterday);
  for (int i = 0; i < DAYS; i++) {
    uint32_t ymd = ymd_of(newest - i);
    if (ymd / 100 != today / 100)
      break;
    if (days[i] != DAY_UNKNOWN)
      sum += days[i];
  }
  return sum;
}

/// Writes a parsed line into the record, for every closed day (before `today`, a YYYYMMDD) or closed month (before
/// today's) it has, then sets this month's total to its closed days in the record, so a day is never counted twice:
/// the rollover adds today's litres at midnight, and the page adds them meanwhile. "-" never erases what the record
/// knows. Re-dates the record at yesterday and this month first (anchor_*), as the rollover would. Leaves the
/// record untouched when it returns an error.
inline Result apply(const Line &line, uint32_t today, uint16_t days[DAYS], uint32_t &days_date, uint32_t months[MONTHS],
                    uint32_t &months_key) {
  Result r;
  r.months = line.months;
  const uint32_t this_month = today / 100, yesterday = ymd_of(civil(today) - 1);
  if (line.months ? line.date > this_month : line.date > today) {
    r.error = Error::FUTURE;
    return r;
  }
  if ((days_date && civil(days_date) > civil(yesterday)) ||
      (months_key && month_number(months_key) > month_number(this_month))) {
    r.error = Error::RECORD_AHEAD;
    return r;
  }
  anchor_days(days, days_date, yesterday);
  anchor_months(months, months_key, this_month);
  for (int k = 0; k < line.count; k++) {
    // the k-th value's place in the record: 0 = yesterday (days) or this month (months)
    int idx = line.months ? month_number(this_month) - (month_number(line.date) - k)
                          : civil(yesterday) - (civil(line.date) - k);
    bool open = line.months ? idx == 0 : idx < 0;
    if (open) {
      r.open++;
      continue;
    }
    if (!line.known[k]) {
      r.unknown++;
      continue;
    }
    if (idx >= (line.months ? MONTHS : DAYS)) {
      r.outside++;
      continue;
    }
    if (line.months) {
      months[idx] = line.values[k];
    } else {
      uint32_t v = line.values[k];
      if (v > DAY_MAX) {
        v = DAY_MAX;
        r.clamped++;
      }
      days[idx] = (uint16_t) v;
    }
    r.written++;
  }
  months[0] = closed_days_of_month(days, yesterday, today);
  return r;
}

// ------------------------------------------------------------------ the entity's state

/// Fill Water Import's state when there is no clock to date the line against.
static const char *const REFUSED_NO_CLOCK = "refused:no_clock";

/// Fill Water Import's state after an import, as a code the UIs translate: `imported:days:N`,
/// `imported:months:N` (N values written), or `refused:<error_code>`.
inline std::string outcome(const Result &r) {
  if (r.error != Error::NONE)
    return std::string("refused:") + error_code(r.error);
  return std::string("imported:") + (r.months ? "months:" : "days:") + std::to_string(r.written);
}

}  // namespace fill_import
