#include "page_login.h"

#include <cinttypes>
#include <cstdio>

#include <esp_http_server.h>
#include <esp_timer.h>

#include "esphome/core/log.h"

namespace esphome::page_login {

using web_server_idf::AsyncWebServerRequest;
using web_server_idf::AsyncWebServerResponse;

static const char *const TAG = "page_login";

// The cookie as the device sets it: no Max-Age, the device ends sessions
// itself; no Secure, the page is plain HTTP.
static const char *const COOKIE_ATTRS = "; Path=/; HttpOnly; SameSite=Strict";

// The HTTP server, for closing /events streams from any task.
static std::atomic<httpd_handle_t> server_handle{nullptr};

// Runs on the HTTP task (httpd_queue_work). Only a socket with a session
// context is closed: an /events stream has one, a plain keep-alive doesn't.
static void close_stream_work(void *arg) {
  httpd_handle_t hd = server_handle.load();
  int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
  if (hd != nullptr && httpd_sess_get_ctx(hd, fd) != nullptr)
    httpd_sess_trigger_close(hd, fd);
}

// ------------------------------------------------------------------ the gate

bool GateHandler::canHandle(AsyncWebServerRequest *request) const { return this->parent_->claims_(request); }
void GateHandler::handleRequest(AsyncWebServerRequest *request) { this->parent_->handle_(request); }

// ----------------------------------------------------------------- lifecycle

void PageLogin::setup() {
  this->pref_ = global_preferences->make_preference<Sessions::Stored>(fnv1_hash("page_login_sessions"), true);
  Sessions::Stored stored{};
  if (this->pref_.load(&stored)) {
    LockGuard guard(this->mutex_);
    this->sessions_.restore(stored, now_ms_());
  }
  web_server_base::global_web_server_base->add_handler_without_auth(&this->gate_);
  // Sessions no browser comes back to: ended within a minute of their limit
  // (one that comes back is checked on the spot).
  this->set_interval("expire", 60 * 1000, [this]() { this->expire_idle_(); });
}

void PageLogin::loop() {
  if (!this->dirty_.exchange(false))
    return;
  Sessions::Stored stored;
  {
    LockGuard guard(this->mutex_);
    stored = this->sessions_.stored();
  }
  this->pref_.save(&stored);
}

void PageLogin::dump_config() {
  bool set;
  {
    LockGuard guard(this->mutex_);
    set = !this->password_.empty();
  }
  ESP_LOGCONFIG(TAG,
                "Page login:\n"
                "  Password: %s\n"
                "  Idle timeout: %" PRIu32 " min",
                set ? "set" : "none (setup mode, no login)", this->idle_ms_ / 60000);
}

void PageLogin::set_password(const std::string &password) {
  LockGuard guard(this->mutex_);
  this->password_ = password;
}

void PageLogin::logout_all() {
  LockGuard guard(this->mutex_);
  for (int i = 0; i < static_cast<int>(MAX_SESSIONS); i++)
    if (this->sessions_.used(i))
      this->end_session_(i);
  ESP_LOGI(TAG, "Every session ended");
}

void PageLogin::expire_idle_() {
  LockGuard guard(this->mutex_);
  const uint64_t now = now_ms_();
  for (int i = 0; i < static_cast<int>(MAX_SESSIONS); i++) {
    if (this->sessions_.idle(i, now, this->idle_ms_)) {
      ESP_LOGI(TAG, "A session ended: idle for more than %" PRIu32 " min", this->idle_ms_ / 60000);
      this->end_session_(i);
    }
  }
}

// -------------------------------------------------------------- the decision

bool PageLogin::claims_(AsyncWebServerRequest *request) {
  const Route route = route_of_(request);
  switch (route) {
    case Route::CHALLENGE:
    case Route::LOGIN:
    case Route::SESSION:
    case Route::LOGOUT:
      return true;
    case Route::PUBLIC:
      return false;
    case Route::EVENTS:
    case Route::GATED:
      break;
  }
  LockGuard guard(this->mutex_);
  if (this->password_.empty())
    return false;
  const uint64_t now = now_ms_();
  const int session = this->valid_session_(request, now);
  if (session < 0)
    return true;  // answered with a 401 by handle_()
  if (route == Route::EVENTS) {
    httpd_req_t *req = *request;
    server_handle.store(req->handle);
    this->record_stream_(httpd_req_to_sockfd(req), session);
  } else {
    this->sessions_.touch(session, now);
  }
  return false;
}

void PageLogin::handle_(AsyncWebServerRequest *request) {
  switch (route_of_(request)) {
    case Route::CHALLENGE:
      return this->challenge_(request);
    case Route::LOGIN:
      return this->login_(request);
    case Route::SESSION:
      return this->session_(request);
    case Route::LOGOUT:
      return this->logout_(request);
    default:
      // Deliberately no WWW-Authenticate: the page shows its own login.
      request->send(401, "text/plain", "Login required");
      return;
  }
}

// ----------------------------------------------------------------- endpoints

// A response with no body, Cache-Control: no-store, and the given cookie (or
// none). The header values must live until send(): httpd keeps the pointers.
static void send_empty(AsyncWebServerRequest *request, int code, const char *cookie) {
  AsyncWebServerResponse *res = request->beginResponse(code, nullptr);
  res->addHeader("Cache-Control", "no-store");
  if (cookie != nullptr)
    res->addHeader("Set-Cookie", cookie);
  request->send(res);
}

void PageLogin::challenge_(AsyncWebServerRequest *request) {
  enum { NONE, ISSUED, FAILED } outcome = ISSUED;
  Nonce nonce;
  {
    LockGuard guard(this->mutex_);
    if (this->password_.empty()) {
      outcome = NONE;
    } else if (!random_bytes(nonce.data(), nonce.size())) {
      outcome = FAILED;
    } else {
      this->nonces_.issue(nonce, now_ms_());
    }
  }
  // Responses go out with the lock released: a slow client mustn't hold up
  // the main loop.
  if (outcome == NONE)
    return send_empty(request, 204, nullptr);
  if (outcome == FAILED) {
    ESP_LOGW(TAG, "random_bytes failed");
    return send_empty(request, 500, nullptr);
  }
  char hex[2 * NONCE_LEN + 1];
  to_hex(nonce.data(), nonce.size(), hex);
  char body[48];
  snprintf(body, sizeof(body), "{\"nonce\":\"%s\"}", hex);
  AsyncWebServerResponse *res = request->beginResponse(200, "application/json", std::string(body));
  res->addHeader("Cache-Control", "no-store");
  request->send(res);
}

void PageLogin::login_(AsyncWebServerRequest *request) {
  if (!same_origin_(request))
    return send_empty(request, 403, nullptr);
  const std::string nonce_hex = request->arg("nonce");
  const std::string proof_hex = request->arg("proof");
  enum { SETUP, LOCKED, WRONG, FAILED, LOGGED_IN } outcome;
  uint32_t seconds = 0;  // LOCKED: left; WRONG: the lock this failure started (0: none)
  char cookie[96];  // name, =, 32 hex, COOKIE_ATTRS: 81 with the NUL
  {
    LockGuard guard(this->mutex_);
    const uint64_t now = now_ms_();
    if (this->password_.empty()) {
      outcome = SETUP;
    } else if ((seconds = this->lockout_.remaining_s(now)) > 0) {
      outcome = LOCKED;
    } else {
      Nonce nonce;
      uint8_t proof[32];
      uint8_t expected[32];
      bool ok = from_hex(nonce_hex, nonce.data(), nonce.size()) && from_hex(proof_hex, proof, sizeof(proof)) &&
                this->nonces_.consume(nonce, now);
      if (ok) {
        login_proof(this->password_, nonce, expected);
        ok = equal_ct(proof, expected, sizeof(proof));
      }
      Token token;
      if (!ok) {
        outcome = WRONG;
        seconds = this->lockout_.fail(now);
      } else if (!random_bytes(token.data(), token.size())) {
        outcome = FAILED;
      } else {
        outcome = LOGGED_IN;
        this->lockout_.succeed();
        int evicted;
        const int session = this->sessions_.add(token, now, evicted);
        if (evicted >= 0)
          this->close_streams_(session);  // the slot's previous session is gone: so are its streams
        this->dirty_ = true;
        char hex[2 * TOKEN_LEN + 1];
        to_hex(token.data(), token.size(), hex);
        snprintf(cookie, sizeof(cookie), "%s=%s%s", COOKIE_NAME, hex, COOKIE_ATTRS);
      }
    }
  }
  char body[32];
  char retry[12];
  AsyncWebServerResponse *res;
  switch (outcome) {
    case SETUP:
      return send_empty(request, 204, nullptr);
    case LOGGED_IN:
      ESP_LOGI(TAG, "Logged in");
      return send_empty(request, 204, cookie);
    case FAILED:
      ESP_LOGW(TAG, "random_bytes failed");
      return send_empty(request, 500, nullptr);
    case LOCKED:
      snprintf(body, sizeof(body), "{\"retry_after\":%" PRIu32 "}", seconds);
      snprintf(retry, sizeof(retry), "%" PRIu32, seconds);
      res = request->beginResponse(429, "application/json", std::string(body));
      // The server's status table has no 429 (it would send a 500).
      httpd_resp_set_status(*request, "429 Too Many Requests");
      res->addHeader("Retry-After", retry);
      res->addHeader("Cache-Control", "no-store");
      request->send(res);
      return;
    case WRONG:
      // A wrong proof, or a nonce unknown, expired or used: the same answer.
      if (seconds > 0) {
        ESP_LOGW(TAG, "Failed login; logins refused for %" PRIu32 " s", seconds);
      } else {
        ESP_LOGW(TAG, "Failed login");
      }
      snprintf(body, sizeof(body), "{\"retry_after\":%" PRIu32 "}", seconds);
      res = request->beginResponse(401, "application/json", std::string(body));
      res->addHeader("Cache-Control", "no-store");
      request->send(res);
      return;
  }
}

void PageLogin::session_(AsyncWebServerRequest *request) {
  bool valid = true;
  {
    LockGuard guard(this->mutex_);
    if (!this->password_.empty()) {
      const uint64_t now = now_ms_();
      const int session = this->valid_session_(request, now);
      valid = session >= 0;
      if (valid)
        this->sessions_.touch(session, now);
    }
  }
  send_empty(request, valid ? 204 : 401, nullptr);
}

void PageLogin::logout_(AsyncWebServerRequest *request) {
  if (!same_origin_(request))
    return send_empty(request, 403, nullptr);
  {
    LockGuard guard(this->mutex_);
    const int session = this->valid_session_(request, now_ms_());
    if (session >= 0) {
      this->end_session_(session);
      ESP_LOGI(TAG, "Logged out (session %d)", session);
    }
  }
  char cookie[96];
  snprintf(cookie, sizeof(cookie), "%s=; Max-Age=0%s", COOKIE_NAME, COOKIE_ATTRS);
  send_empty(request, 204, cookie);
}

// ------------------------------------------------------------------- helpers

int PageLogin::valid_session_(AsyncWebServerRequest *request, uint64_t now) {
  char header[384];
  const size_t len = request->get_header_to("Cookie", header);
  Token token;
  if (len == 0 || len == SIZE_MAX || !cookie_token(std::string_view(header, len), token))
    return -1;
  const int session = this->sessions_.find(token);
  if (session < 0)
    return -1;
  // Checked on the spot too, not only by the minute's sweep.
  if (this->sessions_.idle(session, now, this->idle_ms_)) {
    ESP_LOGI(TAG, "A session ended: idle for more than %" PRIu32 " min", this->idle_ms_ / 60000);
    this->end_session_(session);
    return -1;
  }
  return session;
}

void PageLogin::end_session_(int i) {
  this->sessions_.remove(i);
  this->close_streams_(i);
  this->dirty_ = true;
}

// httpd_queue_work only posts to the server's control socket and the work
// never takes mutex_, so this is safe under the lock, from any task.
void PageLogin::close_streams_(int session) {
  httpd_handle_t hd = server_handle.load();
  for (auto &s : this->streams_) {
    if (s.session == session) {
      if (hd != nullptr)
        httpd_queue_work(hd, close_stream_work, reinterpret_cast<void *>(intptr_t(s.fd)));
      s = {};
    }
  }
}

void PageLogin::record_stream_(int fd, int session) {
  for (auto &s : this->streams_) {
    if (s.fd == fd) {
      s.session = static_cast<int8_t>(session);
      return;
    }
  }
  for (auto &s : this->streams_) {
    if (s.fd < 0) {
      s = {fd, static_cast<int8_t>(session)};
      return;
    }
  }
  // All taken (stale entries, most likely): reuse them in turn.
  this->streams_[this->next_stream_] = {fd, static_cast<int8_t>(session)};
  this->next_stream_ = (this->next_stream_ + 1) % MAX_STREAMS;
}

uint64_t PageLogin::now_ms_() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }

Route PageLogin::route_of_(AsyncWebServerRequest *request) {
  char buf[AsyncWebServerRequest::URL_BUF_SIZE];
  const StringRef url = request->url_to(buf);
  return classify(http_method_str(request->method()), std::string_view(url.c_str(), url.size()));
}

bool PageLogin::same_origin_(AsyncWebServerRequest *request) {
  char origin[web_server_base::MAX_ORIGIN_LENGTH + 1];
  char host[web_server_base::MAX_ORIGIN_LENGTH + 1];
  const size_t origin_len = request->get_header_to("Origin", origin);
  size_t host_len = request->get_header_to("Host", host);
  if (origin_len == SIZE_MAX)
    return false;
  if (host_len == SIZE_MAX)
    host_len = 0;
  return web_server_base::is_origin_allowed(origin, origin_len, host, host_len, nullptr);
}

}  // namespace esphome::page_login
