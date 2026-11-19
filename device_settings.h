#pragma once
// C++ helpers for device-settings.yaml (its `esphome: includes:`), kept out of
// the YAML so the lambdas there read as what they do. Everything here is about
// the settings a controller gets at run time instead of at build time: the
// OTA password, the API key, the timezone, the temperature probes' roles and
// Wi-Fi's saved network.

#include <algorithm>
#include <array>
#include <cctype>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/core/defines.h"
#include "esphome/core/macros.h"
#include "esphome/core/version.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"
#include "esphome/core/preferences.h"
#include "esphome/components/one_wire/one_wire_bus.h"
#include "esphome/components/select/select.h"
#include "esphome/components/time/posix_tz.h"

// time::set_global_tz() is 2026.11's; 2026.7 doesn't have it
// (docs/plans/secret-free-firmware.md).
static_assert(ESPHOME_VERSION_CODE >= VERSION_CODE(2026, 11, 0), "device-settings.yaml needs ESPHome 2026.11 or later");

namespace pool_settings {

static const char *const TAG = "settings";

// ---------------------------------------------------------------- OTA password

/// 32 hex digits (128 bits) from the hardware RNG: the OTA password until one
/// is set, so OTA is never open.
inline std::string random_password() {
  uint8_t raw[16];
  if (!esphome::random_bytes(raw, sizeof(raw)))
    ESP_LOGW(TAG, "random_bytes failed");
  char buf[33];
  for (size_t i = 0; i < sizeof(raw); i++)
    snprintf(buf + 2 * i, 3, "%02x", raw[i]);
  return buf;
}

// --------------------------------------------------------------------- API key

/// Home Assistant's form of the key: base64 of 32 bytes (44 characters, one
/// `=`). The all-zero key is the well-known « no key » of Noise: refused.
inline bool decode_api_key(const std::string &text, std::array<uint8_t, 32> &out) {
  if (text.size() != 44 || text[43] != '=' || text[42] == '=')
    return false;
  for (size_t i = 0; i < 43; i++) {
    char c = text[i];
    if (!(isalnum((unsigned char) c) || c == '+' || c == '/'))
      return false;
  }
  uint8_t buf[34];
  if (esphome::base64_decode(text, buf, sizeof(buf)) != 32)
    return false;
  bool all_zero = true;
  for (size_t i = 0; i < 32; i++) {
    out[i] = buf[i];
    all_zero &= buf[i] == 0;
  }
  return !all_zero;
}

/// A key nobody sees, for a controller used without Home Assistant (Generate
/// API Key): 32 bytes from the hardware RNG, never all zero.
inline bool random_api_key(std::array<uint8_t, 32> &out) {
  for (int attempt = 0; attempt < 4; attempt++) {
    if (!esphome::random_bytes(out.data(), out.size()))
      return false;
    for (uint8_t b : out)
      if (b != 0)
        return true;
  }
  return false;
}

// -------------------------------------------------------------------- timezone

// A POSIX TZ string ("CET-1CEST,M3.5.0,M10.5.0/3") into the struct
// time::set_global_tz() takes. ESPHome 2026.11 parses the YAML's zone at build
// time and has no parser on the device any more; this is a port of the one
// codegen uses (aioesphomeapi's posix_tz.parse_posix_tz), same rules, same
// results.
namespace tz_detail {
using esphome::time::DSTRule;
using esphome::time::DSTRuleType;

inline bool parse_uint(const char *s, size_t &pos, int &out) {
  size_t start = pos;
  out = 0;
  while (isdigit((unsigned char) s[pos]) && out < 100000)
    out = out * 10 + (s[pos++] - '0');
  return pos != start;
}

inline bool parse_offset(const char *s, size_t &pos, int32_t &out) {
  int sign = 1;
  if (s[pos] == '-') {
    sign = -1;
    pos++;
  } else if (s[pos] == '+') {
    pos++;
  }
  int h, m = 0, sec = 0;
  if (!parse_uint(s, pos, h))
    return false;
  if (s[pos] == ':') {
    pos++;
    if (!parse_uint(s, pos, m))
      return false;
    if (s[pos] == ':') {
      pos++;
      if (!parse_uint(s, pos, sec))
        return false;
    }
  }
  out = sign * (h * 3600 + m * 60 + sec);
  return true;
}

inline bool skip_name(const char *s, size_t &pos) {
  if (s[pos] == '<') {
    while (s[pos] != '\0' && s[pos] != '>')
      pos++;
    if (s[pos] != '>')
      return false;
    pos++;
    return true;
  }
  size_t start = pos;
  while (isalpha((unsigned char) s[pos]))
    pos++;
  return pos - start >= 3;
}

inline bool parse_rule(const char *s, size_t &pos, DSTRule &rule) {
  rule = DSTRule{};
  int v;
  if (s[pos] == 'M' || s[pos] == 'm') {
    rule.type = DSTRuleType::MONTH_WEEK_DAY;
    pos++;
    if (!parse_uint(s, pos, v) || v < 1 || v > 12 || s[pos] != '.')
      return false;
    rule.month = v;
    pos++;
    if (!parse_uint(s, pos, v) || v < 1 || v > 5 || s[pos] != '.')
      return false;
    rule.week = v;
    pos++;
    if (!parse_uint(s, pos, v) || v > 6)
      return false;
    rule.day_of_week = v;
  } else if (s[pos] == 'J' || s[pos] == 'j') {
    rule.type = DSTRuleType::JULIAN_NO_LEAP;
    pos++;
    if (!parse_uint(s, pos, v) || v < 1 || v > 365)
      return false;
    rule.day = v;
  } else if (isdigit((unsigned char) s[pos])) {
    rule.type = DSTRuleType::DAY_OF_YEAR;
    if (!parse_uint(s, pos, v) || v > 365)
      return false;
    rule.day = v;
  } else {
    return false;
  }
  rule.time_seconds = 2 * 3600;
  if (s[pos] == '/') {
    pos++;
    if (!parse_offset(s, pos, rule.time_seconds))
      return false;
  }
  return true;
}
}  // namespace tz_detail

inline bool parse_posix_tz(const std::string &text, esphome::time::ParsedTimezone &out) {
  using namespace tz_detail;
  const char *s = text.c_str();
  size_t pos = 0;
  out = esphome::time::ParsedTimezone{};
  if (text.empty() || !skip_name(s, pos))
    return false;
  if (!(isdigit((unsigned char) s[pos]) || s[pos] == '+' || s[pos] == '-'))
    return false;
  if (!parse_offset(s, pos, out.std_offset_seconds))
    return false;
  if (s[pos] == '\0')
    return true;  // no DST
  if (s[pos] == ',')
    return false;  // rules without a DST name
  if (!(isalpha((unsigned char) s[pos]) || s[pos] == '<'))
    return true;  // no DST, trailing characters ignored (as the reference parser)
  if (!skip_name(s, pos))
    return false;
  if (s[pos] != ',' && (isdigit((unsigned char) s[pos]) || s[pos] == '+' || s[pos] == '-')) {
    if (!parse_offset(s, pos, out.dst_offset_seconds))
      return false;
  } else {
    out.dst_offset_seconds = out.std_offset_seconds - 3600;
  }
  if (s[pos] != ',')
    return true;  // a DST name without rules: no DST
  pos++;
  if (!parse_rule(s, pos, out.dst_start) || s[pos] != ',')
    return false;
  pos++;
  return parse_rule(s, pos, out.dst_end);
}

/// Applies the stored zone; none (or an invalid one, which the Timezone text
/// never stores) = UTC, the zone compiled in the YAML.
inline bool apply_timezone(const std::string &posix) {
  esphome::time::ParsedTimezone tz{};
  bool ok = !posix.empty() && parse_posix_tz(posix, tz);
  if (!ok)
    tz = esphome::time::ParsedTimezone{};
  esphome::time::set_global_tz(tz);
  return ok;
}

/// An IANA zone name, for display only ("Europe/Paris", "America/Argentina/Salta", "Etc/GMT+3").
inline bool valid_zone_name(const std::string &name) {
  if (name.empty() || name.size() > 64)
    return false;
  for (char c : name)
    if (!(isalnum((unsigned char) c) || c == '/' || c == '_' || c == '-' || c == '+'))
      return false;
  return true;
}

// -------------------------------------------------------------------- position

inline bool position_set(double latitude, double longitude) {
  return std::isfinite(latitude) && std::isfinite(longitude);
}

/// Degrees to the hundredth (about 1 km): enough for sunrise and sunset, no
/// more of the pool's location than that.
inline double round_degrees(double value) { return std::round(value * 100.0) / 100.0; }

/// Why today's plan can't be computed, or nullptr when it is: what Schedule
/// Waiting For shows, and what evaluate_speed waits for.
inline const char *schedule_wait_reason(double latitude, double longitude, const std::string &timezone,
                                        bool clock_valid, bool computed_today, bool pool_probe_set,
                                        float pool_temperature) {
  if (!position_set(latitude, longitude))
    return "position";
  if (timezone.empty())
    return "timezone";
  if (!clock_valid)
    return "clock";
  if (computed_today)
    return nullptr;
  if (!pool_probe_set)
    return "pool probe";
  if (std::isnan(pool_temperature))
    return "pool temperature";
  return "sunrise/sunset";
}

// ---------------------------------------------------------------------- probes

/// A probe's address as the role selects and Detected Probes show it: the
/// 16 hex digits of ESPHome's `address:` (and its logs), family code last.
inline std::string format_address(uint64_t address) {
  char buf[17];
  snprintf(buf, sizeof(buf), "%016" PRIx64, address);
  return buf;
}

/// "52000000518fe928", "0x52000000518FE928" -> the address; anything else
/// (« none ») -> 0, no role.
inline uint64_t parse_address(const std::string &text) {
  const char *s = text.c_str();
  if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
    s += 2;
  if (strlen(s) != 16)
    return 0;
  char *end = nullptr;
  uint64_t v = strtoull(s, &end, 16);
  return (end != nullptr && *end == '\0') ? v : 0;
}

static const char *const NO_PROBE = "none";
static constexpr size_t MAX_PROBES = 8;

/// The select options' strings. Option lists keep pointers to them, so a
/// string, once written, is never changed or freed: an address seen during
/// this boot keeps its slot, and the list only ever grows (to MAX_PROBES).
struct ProbeSlots {
  uint64_t address[MAX_PROBES];
  char text[MAX_PROBES][17];
  size_t count;
};

inline ProbeSlots &probe_slots() {
  static ProbeSlots slots{};
  return slots;
}

inline const char *probe_option(uint64_t address) {
  if (address == 0)
    return NO_PROBE;
  auto &slots = probe_slots();
  for (size_t i = 0; i < slots.count; i++)
    if (slots.address[i] == address)
      return slots.text[i];
  if (slots.count == MAX_PROBES) {
    ESP_LOGW(TAG, "More than %u probes; 0x%s left out", (unsigned) MAX_PROBES, format_address(address).c_str());
    return nullptr;
  }
  slots.address[slots.count] = address;
  snprintf(slots.text[slots.count], sizeof(slots.text[0]), "%016" PRIx64, address);
  return slots.text[slots.count++];
}

/// The addresses Detected Probes and the selects list: what the bus answered
/// at the last scan, then any address a role holds that it didn't (a probe
/// unplugged since), so a role never points outside its select's options.
inline std::vector<uint64_t> known_probes(esphome::one_wire::OneWireBus *bus, const uint64_t *roles, size_t n_roles) {
  std::vector<uint64_t> out(bus->get_devices().begin(), bus->get_devices().end());
  for (size_t i = 0; i < n_roles; i++)
    if (roles[i] != 0 && std::find(out.begin(), out.end(), roles[i]) == out.end())
      out.push_back(roles[i]);
  if (out.size() > MAX_PROBES)
    out.resize(MAX_PROBES);
  return out;
}

/// Each role select's options: « none » then the known probes; then each
/// shows its role again (its index may have moved).
inline void set_probe_options(esphome::one_wire::OneWireBus *bus, esphome::select::Select *const *selects,
                              const uint64_t *roles, size_t n_roles) {
  auto probes = known_probes(bus, roles, n_roles);
  esphome::FixedVector<const char *> options;
  options.init(probes.size() + 1);
  options.push_back(NO_PROBE);
  for (uint64_t address : probes) {
    const char *option = probe_option(address);
    if (option != nullptr)
      options.push_back(option);
  }
  for (size_t i = 0; i < n_roles; i++) {
    selects[i]->traits.set_options(options);
    const char *current = probe_option(roles[i]);
    selects[i]->publish_state(current != nullptr ? current : NO_PROBE);
  }
}

/// Every probe on the bus starts a conversion (skip ROM + Convert T); read
/// them about 750 ms later with read_probe().
inline bool start_conversion(esphome::one_wire::OneWireBus *bus) {
  if (!bus->skip())
    return false;
  bus->write8(0x44);
  return true;
}

/// One probe's last conversion in °C, as dallas_temp computes it; false when
/// it doesn't answer, its scratchpad fails the CRC, or it reads its power-up
/// 85 °C.
inline bool read_probe(esphome::one_wire::OneWireBus *bus, uint64_t address, float &out) {
  if (!bus->select(address))
    return false;
  bus->write8(0xBE);  // read scratchpad
  uint8_t pad[9];
  for (auto &b : pad)
    b = bus->read8();
  if (esphome::crc8(pad, 8) != pad[8])
    return false;
  int16_t raw = (int16_t) (pad[0] | (pad[1] << 8));
  uint8_t family = address & 0xff;
  if (family == 0x10) {  // DS18S20
    if (pad[7] == 0)
      return false;
    out = (raw >> 1) + (pad[7] - pad[6]) / float(pad[7]) - 0.25f;
    return true;
  }
  if (family == 0x28 && raw == 85 * 16 && pad[6] == 0x0c)
    return false;  // power-up value, no conversion yet
  out = raw / 16.0f;
  return true;
}

/// Detected Probes' state: "52000000518fe928: 26.4, ff00000026007028: 21.8",
/// `--` for a probe that didn't answer, `--` alone when there is none.
inline std::string read_probes(esphome::one_wire::OneWireBus *bus, const uint64_t *roles, size_t n_roles) {
  std::string out;
  for (uint64_t address : known_probes(bus, roles, n_roles)) {
    char buf[32];
    float c;
    if (read_probe(bus, address, c))
      snprintf(buf, sizeof(buf), "%s%016" PRIx64 ": %.1f", out.empty() ? "" : ", ", address, c);
    else
      snprintf(buf, sizeof(buf), "%s%016" PRIx64 ": --", out.empty() ? "" : ", ", address);
    out += buf;
  }
  return out.empty() ? std::string("--") : out;
}

// ------------------------------------------------------------------------ Wi-Fi

/// Forgets the saved network: the wifi component keeps it under this fixed
/// key when the YAML has none (wifi_component.cpp, WiFiComponent::start), as a
/// 98-byte record. A 1-byte one in its place no longer loads, so the next boot
/// has no network and opens the hotspot.
inline void forget_wifi() {
  static constexpr uint32_t SAVED_WIFI_KEY = 88491487UL;
  uint8_t none = 0;
  auto pref = esphome::global_preferences->make_preference(1, SAVED_WIFI_KEY, true);
  pref.save(&none, 1);
  esphome::global_preferences->sync();
}

}  // namespace pool_settings
