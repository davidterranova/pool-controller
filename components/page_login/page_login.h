#pragma once
// See __init__.py: the gate in front of web_server, and the login endpoints.
// The protocol's pure parts are in page_login_core.h.

#include <array>
#include <atomic>
#include <string>

#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/core/preferences.h"

#include "page_login_core.h"

namespace esphome::page_login {

class PageLogin;

/// Added to web_server_base ahead of web_server's own handlers, without the
/// auth guard: the first handler whose canHandle() says yes answers.
class GateHandler : public web_server_idf::AsyncWebHandler {
 public:
  explicit GateHandler(PageLogin *parent) : parent_(parent) {}
  bool canHandle(web_server_idf::AsyncWebServerRequest *request) const override;
  void handleRequest(web_server_idf::AsyncWebServerRequest *request) override;

 protected:
  PageLogin *parent_;
};

class PageLogin : public Component {
 public:
  // Before web_server (WIFI - 1), so the gate is registered first.
  float get_setup_priority() const override { return setup_priority::WIFI; }
  void setup() override;
  void loop() override;
  void dump_config() override;

  void set_idle_timeout(uint32_t ms) { this->idle_ms_ = ms; }
  /// The page's password; empty = setup mode, nothing gated. Sessions stay:
  /// a change of password also calls logout_all().
  void set_password(const std::string &password);
  /// Ends every session and closes their /events streams.
  void logout_all();

 protected:
  friend class GateHandler;

  /// The gate's decision for one request (HTTP task): true = answered here.
  bool claims_(web_server_idf::AsyncWebServerRequest *request);
  void handle_(web_server_idf::AsyncWebServerRequest *request);

  void challenge_(web_server_idf::AsyncWebServerRequest *request);
  void login_(web_server_idf::AsyncWebServerRequest *request);
  void session_(web_server_idf::AsyncWebServerRequest *request);
  void logout_(web_server_idf::AsyncWebServerRequest *request);

  // Under mutex_.
  int valid_session_(web_server_idf::AsyncWebServerRequest *request, uint64_t now);
  void end_session_(int i);
  void close_streams_(int session);
  void record_stream_(web_server_idf::AsyncWebServerRequest *request, int session);

  void expire_idle_();

  static uint64_t now_ms_();
  static Route route_of_(web_server_idf::AsyncWebServerRequest *request);
  static bool same_origin_(web_server_idf::AsyncWebServerRequest *request);

  GateHandler gate_{this};
  ESPPreferenceObject pref_;
  uint32_t idle_ms_{6 * 3600 * 1000};

  Mutex mutex_;  // guards everything below: the HTTP task and the main loop both use it
  std::string password_;
  Sessions sessions_;
  Nonces nonces_;
  Lockout lockout_;
  // The open /events streams, by socket, and whose they are: closed when
  // their session ends. A stream that ended by itself leaves a stale entry;
  // its socket may since carry another stream, which then gets closed too,
  // and simply reconnects.
  // A stream opened in setup mode belongs to NO_SESSION: closed when a
  // password is set. A free entry has fd -1.
  static constexpr int NO_SESSION = -1;
  struct Stream {
    int fd{-1};
    int8_t session{NO_SESSION};
  };
  static constexpr size_t MAX_STREAMS = 8;
  std::array<Stream, MAX_STREAMS> streams_{};
  size_t next_stream_{0};

  std::atomic<bool> dirty_{false};  // sessions changed: save them (main loop)
};

}  // namespace esphome::page_login
