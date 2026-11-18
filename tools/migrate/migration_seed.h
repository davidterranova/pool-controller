#pragma once
// `make migrate` (docs/plans/secret-free-firmware.md, WP8): the boot step that
// carries a controller built with secrets.yaml over to the generic firmware in
// one OTA. The generated, local-only .migrate/migration.yaml includes this
// header and calls seed_all() at on_boot priority 750 with the values the
// controller was built with until now.
//
// Never part of a normal or CI build: only .migrate/migration.yaml includes it.
//
// Rules:
// - Only an empty setting is filled; a set one is never overwritten.
// - Once per migration build: a run id (a restored global, in the generated
//   package) records that this build has seeded, so a Factory Reset while it
//   is still installed doesn't bring the old values back.
// - Nothing secret is logged: only which settings were filled or kept.
//
// Why priority 750 (ESPHome 2026.11): every value must be in place before
// what reads it, and a restored global must be filled after its restore:
//   800  globals restore (HARDWARE). An on_boot at 800 would tie with it, and
//        a tie runs in registration order, which codegen interleaves with
//        its awaits: the first on_boot trigger registers before the globals,
//        the others after. Run before the restore, a value set with nothing
//        stored becomes the global's "last saved" copy and is never written.
//   750  this step: globals restored, nothing below has started.
//   700  device-settings.yaml applies the settings (page login, OTA password,
//        position, timezone, probe roles).
//   250  wifi loads its saved network (WiFiComponent::start).
//   200  the API server loads its saved key (APIServer::setup), then listens.
// Wi-Fi and the API key are ESPHome's own records: written here straight to
// their NVS keys, in their own layout, and synced, so wifi and the API server
// load them as if they had saved them. save_noise_psk() can't be used here: its
// preference only exists once APIServer::setup() has run (it would return
// false), and after that it drops clients and applies 100 ms later.

#include <array>
#include <cmath>
#include <cstring>
#include <string>

#include "esphome/core/defines.h"
#include "esphome/core/log.h"
#include "esphome/core/preferences.h"
#include "esphome/core/version.h"
#include "esphome/components/api/api_server.h"
#include "esphome/components/wifi/wifi_component.h"
#include "device_settings.h"

// The two NVS keys below are private constants of ESPHome's sources: re-read
// them (wifi_component.cpp, api_server.cpp) before allowing another version.
static_assert(ESPHOME_VERSION_CODE >= VERSION_CODE(2026, 11, 0) && ESPHOME_VERSION_CODE < VERSION_CODE(2026, 12, 0),
              "migration_seed.h was checked against ESPHome 2026.11 only");
#if !defined(USE_API_NOISE) || defined(USE_API_NOISE_PSK_FROM_YAML)
#error "migration_seed.h needs `api: encryption: {}` (a key saved at run time, none in the YAML)"
#endif

namespace pool_migration {

static const char *const TAG = "migration";

/// wifi_component.cpp, WiFiComponent::start(): the saved network's key when
/// the YAML has none (the generic firmware). device_settings.h's forget_wifi()
/// uses the same one.
static constexpr uint32_t SAVED_WIFI_KEY = 88491487UL;
/// api_server.cpp, NOISE_PSK_PREF_HASH: the key HA or the page saved.
static constexpr uint32_t SAVED_API_KEY_KEY = 88491486UL;

static_assert(sizeof(esphome::wifi::SavedWifiSettings) == 33 + 65, "wifi's saved-network layout changed");
static_assert(sizeof(esphome::api::SavedNoisePsk) == 32, "the API's saved-key layout changed");

enum class Outcome : uint8_t {
  SEEDED,   // was empty, now holds the old value
  KEPT,     // already set: left as it is
  SKIPPED,  // no old value for it
  INVALID,  // the old value doesn't fit the setting: left empty
  FAILED,   // NVS refused the write: the next boot tries again
};

/// The settings each outcome applied to, for one log line each.
struct Report {
  std::string seeded, kept, skipped, invalid, failed;

  void add(const char *setting, Outcome outcome) {
    std::string &list = this->list_(outcome);
    if (!list.empty())
      list += ", ";
    list += setting;
  }
  bool any_failed() const { return !this->failed.empty(); }
  bool any_seeded() const { return !this->seeded.empty(); }

  void log() const {
    ESP_LOGI(TAG, "Filled: %s", this->seeded.empty() ? "nothing" : this->seeded.c_str());
    if (!this->kept.empty())
      ESP_LOGI(TAG, "Already set, kept: %s", this->kept.c_str());
    if (!this->skipped.empty())
      ESP_LOGI(TAG, "No old value: %s", this->skipped.c_str());
    if (!this->invalid.empty())
      ESP_LOGW(TAG, "Old value refused, left empty: %s", this->invalid.c_str());
    if (!this->failed.empty())
      ESP_LOGE(TAG, "Not saved, retried next boot: %s", this->failed.c_str());
  }

 private:
  std::string &list_(Outcome outcome) {
    switch (outcome) {
      case Outcome::SEEDED:
        return this->seeded;
      case Outcome::KEPT:
        return this->kept;
      case Outcome::SKIPPED:
        return this->skipped;
      case Outcome::INVALID:
        return this->invalid;
      default:
        return this->failed;
    }
  }
};

// ----------------------------------------------------- ESPHome's own records

/// The saved network wifi loads at its start, if none is saved yet.
inline Outcome seed_wifi(const char *ssid, const char *password) {
  using esphome::wifi::SavedWifiSettings;
  SavedWifiSettings fresh{};
  if (ssid[0] == '\0' || strlen(ssid) >= sizeof(fresh.ssid) || strlen(password) >= sizeof(fresh.password))
    return Outcome::INVALID;
  auto pref = esphome::global_preferences->make_preference<SavedWifiSettings>(SAVED_WIFI_KEY, true);
  SavedWifiSettings saved{};
  // A forgotten network (Factory Reset) is a 1-byte record: it doesn't load.
  if (pref.load(&saved) && saved.ssid[0] != '\0')
    return Outcome::KEPT;
  strncpy(fresh.ssid, ssid, sizeof(fresh.ssid) - 1);
  strncpy(fresh.password, password, sizeof(fresh.password) - 1);
  if (!pref.save(&fresh) || !esphome::global_preferences->sync())
    return Outcome::FAILED;
  return Outcome::SEEDED;
}

/// The API key the API server loads at its setup, if none is saved yet; in
/// Home Assistant's form (base64 of 32 bytes), checked like the API Key text.
inline Outcome seed_api_key(const char *base64) {
  using esphome::api::SavedNoisePsk;
  std::array<uint8_t, 32> key{};
  if (!pool_settings::decode_api_key(base64, key))
    return Outcome::INVALID;
  auto pref = esphome::global_preferences->make_preference<SavedNoisePsk>(SAVED_API_KEY_KEY, true);
  SavedNoisePsk saved{};
  // Forget API Key saves the all-zero key: no key.
  if (pref.load(&saved) && !esphome::noise::NoiseContext::is_all_zeros(saved.psk))
    return Outcome::KEPT;
  SavedNoisePsk fresh{};
  std::copy(key.begin(), key.end(), fresh.psk.begin());
  if (!pref.save(&fresh) || !esphome::global_preferences->sync())
    return Outcome::FAILED;
  return Outcome::SEEDED;
}

// ----------------------------------------- device-settings.yaml's own globals

/// A page or OTA password: up to 64 bytes (the global's restore size).
inline Outcome seed_password(std::string &setting, const char *value) {
  if (!setting.empty())
    return Outcome::KEPT;
  if (value[0] == '\0' || strlen(value) > 64)
    return Outcome::INVALID;
  setting = value;
  return Outcome::SEEDED;
}

/// Latitude or longitude, already rounded to 0.01° by the generator.
inline Outcome seed_degrees(double &setting, double value, double limit) {
  if (std::isfinite(setting))
    return Outcome::KEPT;
  if (!std::isfinite(value) || std::fabs(value) > limit)
    return Outcome::INVALID;
  setting = pool_settings::round_degrees(value);
  return Outcome::SEEDED;
}

/// The POSIX zone, if the device's own parser takes it (as the Timezone text).
inline Outcome seed_timezone(std::string &setting, const char *posix) {
  if (!setting.empty())
    return Outcome::KEPT;
  if (posix[0] == '\0')
    return Outcome::SKIPPED;
  esphome::time::ParsedTimezone tz{};
  if (strlen(posix) > 64 || !pool_settings::parse_posix_tz(posix, tz))
    return Outcome::INVALID;
  setting = posix;
  return Outcome::SEEDED;
}

/// The IANA name, display only (as the Timezone Name text).
inline Outcome seed_timezone_name(std::string &setting, const char *name) {
  if (!setting.empty())
    return Outcome::KEPT;
  if (name[0] == '\0')
    return Outcome::SKIPPED;
  if (!pool_settings::valid_zone_name(name))
    return Outcome::INVALID;
  setting = name;
  return Outcome::SEEDED;
}

/// A probe role's address, unless the role has one, or another role already
/// holds this probe (one role per probe, as the role selects).
inline Outcome seed_probe(uint64_t &role, uint64_t address, const uint64_t *const others[], size_t n_others) {
  if (role != 0)
    return Outcome::KEPT;
  if (address == 0)
    return Outcome::SKIPPED;
  for (size_t i = 0; i < n_others; i++)
    if (*others[i] == address)
      return Outcome::INVALID;
  role = address;
  return Outcome::SEEDED;
}

// --------------------------------------------------------------- everything

/// The values the controller was built with until now (the generated package
/// fills one in from secrets.yaml and the old probe addresses).
struct OldSettings {
  const char *wifi_ssid;
  const char *wifi_password;
  const char *api_key;
  const char *page_password;
  const char *ota_password;
  double latitude;
  double longitude;
  const char *timezone_posix;
  const char *timezone_name;
  uint64_t pool_probe;
  uint64_t pad_probe;
  uint64_t outdoor_probe;
};

/// device-settings.yaml's globals, by reference.
struct Settings {
  std::string &page_password;
  std::string &ota_password;
  double &latitude;
  double &longitude;
  std::string &timezone_posix;
  std::string &timezone_name;
  uint64_t &pool_probe;
  uint64_t &pad_probe;
  uint64_t &outdoor_probe;
};

/// Fills every empty setting from `old`, once per migration build: `run`
/// holds the last build that seeded (a restored global), `run_id` is this
/// build's. Returns true when the globals changed and must be committed.
inline bool seed_all(const OldSettings &old, const Settings &to, uint32_t &run, uint32_t run_id) {
  if (run == run_id) {
    ESP_LOGI(TAG, "Already migrated by this build: nothing filled");
    return false;
  }
  ESP_LOGI(TAG, "Filling empty settings with the ones this controller was built with");
  Report report;
  report.add("wifi", seed_wifi(old.wifi_ssid, old.wifi_password));
  report.add("api_key", seed_api_key(old.api_key));
  report.add("page_password", seed_password(to.page_password, old.page_password));
  report.add("ota_password", seed_password(to.ota_password, old.ota_password));
  report.add("latitude", seed_degrees(to.latitude, old.latitude, 90.0));
  report.add("longitude", seed_degrees(to.longitude, old.longitude, 180.0));
  report.add("timezone", seed_timezone(to.timezone_posix, old.timezone_posix));
  report.add("timezone_name", seed_timezone_name(to.timezone_name, old.timezone_name));
  // Pool first: it is the one the plan and freeze protection read.
  const uint64_t *not_pool[] = {&to.pad_probe, &to.outdoor_probe};
  report.add("pool_probe", seed_probe(to.pool_probe, old.pool_probe, not_pool, 2));
  const uint64_t *not_pad[] = {&to.pool_probe, &to.outdoor_probe};
  report.add("pad_probe", seed_probe(to.pad_probe, old.pad_probe, not_pad, 2));
  const uint64_t *not_outdoor[] = {&to.pool_probe, &to.pad_probe};
  report.add("outdoor_probe", seed_probe(to.outdoor_probe, old.outdoor_probe, not_outdoor, 2));
  report.log();
  // A write NVS refused is tried again next boot: the run isn't recorded.
  if (!report.any_failed())
    run = run_id;
  return true;
}

}  // namespace pool_migration
