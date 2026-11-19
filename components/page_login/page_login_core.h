#pragma once
// The pure logic of page_login (see __init__.py): no ESPHome, no ESP-IDF, so
// tools/tests/page_login_test.cpp runs it on the host (`make firmware-test`).
// Times are milliseconds of uptime, passed in: the device may have no wall
// clock (on its hotspot there's no SNTP), and the tests use a fake one.

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string_view>

namespace esphome::page_login {

// --------------------------------------------------------------------- crypto

/// SHA-256 (FIPS 180-4). Small and portable, so the same code runs on the
/// device and in the host tests; speed doesn't matter for a login.
class Sha256 {
 public:
  Sha256() { this->reset(); }

  void reset() {
    static const uint32_t INIT[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::memcpy(this->h_, INIT, sizeof(INIT));
    this->len_ = 0;
    this->used_ = 0;
  }

  void update(const uint8_t *data, size_t len) {
    for (size_t i = 0; i < len; i++) {
      this->block_[this->used_++] = data[i];
      if (this->used_ == 64) {
        this->compress_();
        this->used_ = 0;
      }
    }
    this->len_ += len;
  }

  void finish(uint8_t out[32]) {
    const uint64_t bits = this->len_ * 8;
    const uint8_t pad = 0x80;
    this->update(&pad, 1);
    const uint8_t zero = 0;
    while (this->used_ != 56)
      this->update(&zero, 1);
    uint8_t len_be[8];
    for (int i = 0; i < 8; i++)
      len_be[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
    this->update(len_be, 8);
    for (int i = 0; i < 8; i++)
      for (int j = 0; j < 4; j++)
        out[4 * i + j] = static_cast<uint8_t>(this->h_[i] >> (24 - 8 * j));
  }

 private:
  static uint32_t rotr_(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

  void compress_() {
    static const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = (uint32_t(this->block_[4 * i]) << 24) | (uint32_t(this->block_[4 * i + 1]) << 16) |
             (uint32_t(this->block_[4 * i + 2]) << 8) | uint32_t(this->block_[4 * i + 3]);
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr_(w[i - 15], 7) ^ rotr_(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr_(w[i - 2], 17) ^ rotr_(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = this->h_[0], b = this->h_[1], c = this->h_[2], d = this->h_[3];
    uint32_t e = this->h_[4], f = this->h_[5], g = this->h_[6], h = this->h_[7];
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = h + (rotr_(e, 6) ^ rotr_(e, 11) ^ rotr_(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      uint32_t t2 = (rotr_(a, 2) ^ rotr_(a, 13) ^ rotr_(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    this->h_[0] += a;
    this->h_[1] += b;
    this->h_[2] += c;
    this->h_[3] += d;
    this->h_[4] += e;
    this->h_[5] += f;
    this->h_[6] += g;
    this->h_[7] += h;
  }

  uint32_t h_[8];
  uint8_t block_[64];
  uint64_t len_;
  size_t used_;
};

/// HMAC-SHA256 (RFC 2104).
inline void hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *msg, size_t msg_len, uint8_t out[32]) {
  uint8_t k[64] = {0};
  if (key_len > 64) {
    Sha256 hk;
    hk.update(key, key_len);
    hk.finish(k);
  } else {
    std::memcpy(k, key, key_len);
  }
  uint8_t pad[64];
  for (int i = 0; i < 64; i++)
    pad[i] = k[i] ^ 0x36;
  Sha256 inner;
  inner.update(pad, 64);
  inner.update(msg, msg_len);
  uint8_t inner_hash[32];
  inner.finish(inner_hash);
  for (int i = 0; i < 64; i++)
    pad[i] = k[i] ^ 0x5c;
  Sha256 outer;
  outer.update(pad, 64);
  outer.update(inner_hash, 32);
  outer.finish(out);
}

/// Compares without an early exit, so the time taken says nothing about
/// where a guess first differs.
inline bool equal_ct(const uint8_t *a, const uint8_t *b, size_t n) {
  uint8_t diff = 0;
  for (size_t i = 0; i < n; i++)
    diff |= a[i] ^ b[i];
  return diff == 0;
}

// ------------------------------------------------------------------------ hex

/// Lowercase hex of `n` bytes into `out` (2n characters, then a NUL).
inline void to_hex(const uint8_t *in, size_t n, char *out) {
  static const char DIGITS[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = DIGITS[in[i] >> 4];
    out[2 * i + 1] = DIGITS[in[i] & 0xf];
  }
  out[2 * n] = '\0';
}

/// Exactly 2n hex digits (either case) into `n` bytes; false on anything else.
inline bool from_hex(std::string_view s, uint8_t *out, size_t n) {
  if (s.size() != 2 * n)
    return false;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9')
      return c - '0';
    if (c >= 'a' && c <= 'f')
      return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
      return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < n; i++) {
    int hi = nibble(s[2 * i]), lo = nibble(s[2 * i + 1]);
    if (hi < 0 || lo < 0)
      return false;
    out[i] = static_cast<uint8_t>(hi << 4 | lo);
  }
  return true;
}

// ------------------------------------------------------------- login protocol

static constexpr size_t TOKEN_LEN = 16;  // 128 bits
static constexpr size_t NONCE_LEN = 16;
using Token = std::array<uint8_t, TOKEN_LEN>;
using Nonce = std::array<uint8_t, NONCE_LEN>;

static constexpr const char *COOKIE_NAME = "pool_session";

/// The proof the page sends: HMAC-SHA256, keyed with the password's bytes
/// (UTF-8, as typed), over the nonce's 32 lowercase hex characters, the form
/// the page received it in. So `openssl dgst -sha256 -hmac` gives it too.
inline void login_proof(std::string_view password, const Nonce &nonce, uint8_t out[32]) {
  char hex[2 * NONCE_LEN + 1];
  to_hex(nonce.data(), nonce.size(), hex);
  hmac_sha256(reinterpret_cast<const uint8_t *>(password.data()), password.size(),
              reinterpret_cast<const uint8_t *>(hex), 2 * NONCE_LEN, out);
}

/// The session token in a Cookie header ("a=1; pool_session=<32 hex>; b=2").
inline bool cookie_token(std::string_view header, Token &out) {
  const std::string_view name = COOKIE_NAME;
  size_t pos = 0;
  while (pos < header.size()) {
    size_t end = header.find(';', pos);
    if (end == std::string_view::npos)
      end = header.size();
    std::string_view pair = header.substr(pos, end - pos);
    while (!pair.empty() && pair.front() == ' ')
      pair.remove_prefix(1);
    while (!pair.empty() && pair.back() == ' ')
      pair.remove_suffix(1);
    if (pair.size() > name.size() && pair.substr(0, name.size()) == name && pair[name.size()] == '=')
      return from_hex(pair.substr(name.size() + 1), out.data(), out.size());
    pos = end + 1;
  }
  return false;
}

/// What a request is to the gate.
enum class Route : uint8_t {
  PUBLIC,     // the page shell and its bundle, CORS preflights: never gated
  CHALLENGE,  // GET /login/challenge
  LOGIN,      // POST /login
  SESSION,    // GET /login/session
  LOGOUT,     // POST /logout
  EVENTS,     // GET /events: gated, and doesn't count as activity
  GATED,      // everything else
};

inline Route classify(std::string_view method, std::string_view path) {
  if (method == "OPTIONS")
    return Route::PUBLIC;
  if (method == "GET") {
    if (path == "/" || path == "/0.js" || path == "/0.css")
      return Route::PUBLIC;
    if (path == "/login/challenge")
      return Route::CHALLENGE;
    if (path == "/login/session")
      return Route::SESSION;
    if (path == "/events")
      return Route::EVENTS;
  }
  if (method == "POST") {
    if (path == "/login")
      return Route::LOGIN;
    if (path == "/logout")
      return Route::LOGOUT;
  }
  return Route::GATED;
}

// ------------------------------------------------------------------- sessions

static constexpr size_t MAX_SESSIONS = 4;

/// The logged-in browsers: one token each, and when each was last active.
/// Only the tokens are saved (the `Stored` form); idle clocks live in RAM and
/// restart at boot, so a reboot or update logs nobody out.
class Sessions {
 public:
  struct Stored {
    uint8_t tokens[MAX_SESSIONS][TOKEN_LEN];
  };

  /// At boot: every saved token is a session, idle since now.
  void restore(const Stored &stored, uint64_t now) {
    for (size_t i = 0; i < MAX_SESSIONS; i++) {
      std::memcpy(this->slots_[i].token.data(), stored.tokens[i], TOKEN_LEN);
      this->slots_[i].used = !is_zero_(this->slots_[i].token);
      this->slots_[i].last_ms = now;
    }
  }

  Stored stored() const {
    Stored s{};
    for (size_t i = 0; i < MAX_SESSIONS; i++)
      if (this->slots_[i].used)
        std::memcpy(s.tokens[i], this->slots_[i].token.data(), TOKEN_LEN);
    return s;
  }

  /// The live session with this token, or -1. Every slot is compared in full,
  /// so the time taken doesn't depend on which one matches.
  int find(const Token &token) const {
    int found = -1;
    for (size_t i = 0; i < MAX_SESSIONS; i++)
      if (equal_ct(this->slots_[i].token.data(), token.data(), TOKEN_LEN) && this->slots_[i].used)
        found = static_cast<int>(i);
    return found;
  }

  void touch(int i, uint64_t now) { this->slots_[i].last_ms = now; }

  /// A new session in a free slot, else in the one idle longest (its index is
  /// in `evicted`, -1 if none was).
  int add(const Token &token, uint64_t now, int &evicted) {
    int slot = -1;
    evicted = -1;
    for (size_t i = 0; i < MAX_SESSIONS && slot < 0; i++)
      if (!this->slots_[i].used)
        slot = static_cast<int>(i);
    if (slot < 0) {
      slot = 0;
      for (size_t i = 1; i < MAX_SESSIONS; i++)
        if (this->slots_[i].last_ms < this->slots_[slot].last_ms)
          slot = static_cast<int>(i);
      evicted = slot;
    }
    this->slots_[slot] = {token, now, true};
    return slot;
  }

  void remove(int i) { this->slots_[i] = {}; }

  void clear() {
    for (auto &s : this->slots_)
      s = {};
  }

  bool used(int i) const { return this->slots_[i].used; }

  /// Whether session i has been idle longer than idle_ms.
  bool idle(int i, uint64_t now, uint64_t idle_ms) const {
    return this->slots_[i].used && now - this->slots_[i].last_ms > idle_ms;
  }

 private:
  struct Slot {
    Token token{};
    uint64_t last_ms{0};
    bool used{false};
  };

  static bool is_zero_(const Token &t) {
    for (uint8_t b : t)
      if (b != 0)
        return false;
    return true;
  }

  std::array<Slot, MAX_SESSIONS> slots_{};
};

// --------------------------------------------------------------------- nonces

/// The challenges handed out: each one answers a single login, within
/// NONCE_TTL_MS. The oldest gives way when all are taken.
class Nonces {
 public:
  static constexpr size_t MAX = 4;
  static constexpr uint64_t NONCE_TTL_MS = 60 * 1000;

  void issue(const Nonce &nonce, uint64_t now) {
    size_t slot = 0;
    for (size_t i = 0; i < MAX; i++) {
      if (!this->slots_[i].used) {
        slot = i;
        break;
      }
      if (this->slots_[i].issued_ms < this->slots_[slot].issued_ms)
        slot = i;
    }
    this->slots_[slot] = {nonce, now, true};
  }

  /// True once for a nonce issued here less than NONCE_TTL_MS ago; it can't
  /// be used again afterwards, whatever the login's outcome.
  bool consume(const Nonce &nonce, uint64_t now) {
    for (auto &s : this->slots_) {
      if (s.used && equal_ct(s.nonce.data(), nonce.data(), NONCE_LEN)) {
        s.used = false;
        return now - s.issued_ms <= NONCE_TTL_MS;
      }
    }
    return false;
  }

 private:
  struct Slot {
    Nonce nonce{};
    uint64_t issued_ms{0};
    bool used{false};
  };
  std::array<Slot, MAX> slots_{};
};

// -------------------------------------------------------------------- lockout

/// One lockout for the whole device: after FREE_FAILURES failed logins in a
/// row, logins are refused for 30 s; every failure after that locks for
/// twice as long, up to 15 min. A success resets it.
class Lockout {
 public:
  static constexpr uint32_t FREE_FAILURES = 5;
  static constexpr uint32_t FIRST_LOCK_S = 30;
  static constexpr uint32_t MAX_LOCK_S = 15 * 60;

  /// Seconds left before a login is accepted again (0: now).
  uint32_t remaining_s(uint64_t now) const {
    return now >= this->until_ms_ ? 0 : static_cast<uint32_t>((this->until_ms_ - now + 999) / 1000);
  }

  /// A failed login; returns the lock it starts, in seconds (0: none).
  uint32_t fail(uint64_t now) {
    this->failures_++;
    if (this->failures_ < FREE_FAILURES)
      return 0;
    uint32_t lock = FIRST_LOCK_S;
    for (uint32_t i = FREE_FAILURES; i < this->failures_ && lock < MAX_LOCK_S; i++)
      lock *= 2;
    if (lock > MAX_LOCK_S)
      lock = MAX_LOCK_S;
    this->until_ms_ = now + uint64_t(lock) * 1000;
    return lock;
  }

  void succeed() {
    this->failures_ = 0;
    this->until_ms_ = 0;
  }

 private:
  uint32_t failures_{0};
  uint64_t until_ms_{0};
};

}  // namespace esphome::page_login
