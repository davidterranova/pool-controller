// Host tests for components/page_login/page_login_core.h (SHA-256 and HMAC,
// the cookie, the routes, sessions and their idle limit, nonces, the
// lockout): `make firmware-test` compiles and runs them in the ESPHome image.
#include "../../components/page_login/page_login_core.h"

#include <cstdio>
#include <string>

using namespace esphome::page_login;

static int failures = 0;
#define EXPECT(cond)                                              \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

static std::string hex(const uint8_t *b, size_t n) {
  char buf[129];
  to_hex(b, n, buf);
  return buf;
}

static std::string sha256_hex(const std::string &s) {
  Sha256 h;
  h.update(reinterpret_cast<const uint8_t *>(s.data()), s.size());
  uint8_t out[32];
  h.finish(out);
  return hex(out, 32);
}

static std::string hmac_hex(const std::string &key, const std::string &msg) {
  uint8_t out[32];
  hmac_sha256(reinterpret_cast<const uint8_t *>(key.data()), key.size(),
              reinterpret_cast<const uint8_t *>(msg.data()), msg.size(), out);
  return hex(out, 32);
}

static void test_sha256() {
  EXPECT(sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  EXPECT(sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // Two blocks: the padding spills over.
  EXPECT(sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
         "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  EXPECT(sha256_hex(std::string(1000, 'a')) ==
         "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
}

// RFC 4231, test cases 1, 2, 6 (a key longer than a block) and 7.
static void test_hmac_rfc4231() {
  EXPECT(hmac_hex(std::string(20, '\x0b'), "Hi There") ==
         "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  EXPECT(hmac_hex("Jefe", "what do ya want for nothing?") ==
         "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  EXPECT(hmac_hex(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First") ==
         "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  EXPECT(hmac_hex(std::string(131, '\xaa'),
                  "This is a test using a larger than block-size key and a larger than block-size data. The key "
                  "needs to be hashed before being used by the HMAC algorithm.") ==
         "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2");
}

static void test_login_proof() {
  Nonce nonce;
  for (size_t i = 0; i < nonce.size(); i++)
    nonce[i] = static_cast<uint8_t>(i * 17);
  uint8_t proof[32];
  login_proof("mot de passé", nonce, proof);
  // Keyed with the password's UTF-8 bytes, over the nonce's hex: what
  // `printf %s 00112233… | openssl dgst -sha256 -hmac 'mot de passé'` prints.
  EXPECT(hex(proof, 32) == hmac_hex("mot de passé", "00112233445566778899aabbccddeeff"));
}

static void test_hex() {
  uint8_t b[2];
  EXPECT(from_hex("0aFf", b, 2) && b[0] == 0x0a && b[1] == 0xff);
  EXPECT(!from_hex("0aF", b, 2));
  EXPECT(!from_hex("0aFg", b, 2));
  EXPECT(!from_hex("0aFf00", b, 2));
}

static void test_cookie() {
  Token t;
  EXPECT(cookie_token("pool_session=00112233445566778899aabbccddeeff", t) && t[1] == 0x11 && t[15] == 0xff);
  EXPECT(cookie_token("a=1; pool_session=00112233445566778899aabbccddeeff; b=2", t) && t[0] == 0x00);
  EXPECT(!cookie_token("a=1; b=2", t));
  EXPECT(!cookie_token("xpool_session=00112233445566778899aabbccddeeff", t));
  EXPECT(!cookie_token("pool_sessionx=00112233445566778899aabbccddeeff", t));
  EXPECT(!cookie_token("pool_session=", t));
  EXPECT(!cookie_token("pool_session=00112233", t));
  EXPECT(!cookie_token("", t));
}

static void test_routes() {
  EXPECT(classify("GET", "/") == Route::PUBLIC);
  EXPECT(classify("GET", "/0.js") == Route::PUBLIC);
  EXPECT(classify("GET", "/0.css") == Route::PUBLIC);
  EXPECT(classify("OPTIONS", "/switch/pump/turn_on") == Route::PUBLIC);
  EXPECT(classify("GET", "/login/challenge") == Route::CHALLENGE);
  EXPECT(classify("POST", "/login") == Route::LOGIN);
  EXPECT(classify("GET", "/login/session") == Route::SESSION);
  EXPECT(classify("POST", "/logout") == Route::LOGOUT);
  EXPECT(classify("GET", "/events") == Route::EVENTS);
  // Gated: the REST API, and the public paths with another method.
  EXPECT(classify("GET", "/sensor/pool_temperature") == Route::GATED);
  EXPECT(classify("POST", "/switch/pump/turn_on") == Route::GATED);
  EXPECT(classify("POST", "/") == Route::GATED);
  EXPECT(classify("GET", "/login") == Route::GATED);
  EXPECT(classify("POST", "/login/challenge") == Route::GATED);
  EXPECT(classify("GET", "/index.html") == Route::GATED);
}

static Token token(uint8_t seed) {
  Token t;
  for (size_t i = 0; i < t.size(); i++)
    t[i] = static_cast<uint8_t>(seed + i);
  return t;
}

static const uint64_t H = 3600 * 1000;

static void test_sessions() {
  Sessions s;
  int evicted;
  EXPECT(s.find(token(1)) == -1);
  int a = s.add(token(1), 0, evicted);
  EXPECT(evicted == -1 && s.find(token(1)) == a);
  // Idle: more than 6 h since the last activity, not 6 h exactly.
  EXPECT(!s.idle(a, 6 * H, 6 * H));
  EXPECT(s.idle(a, 6 * H + 1, 6 * H));
  s.touch(a, 5 * H);
  EXPECT(!s.idle(a, 6 * H + 1, 6 * H));
  // Full: the 5th login takes the slot idle longest.
  int b = s.add(token(2), 1 * H, evicted);
  s.add(token(3), 2 * H, evicted);
  s.add(token(4), 3 * H, evicted);
  EXPECT(evicted == -1);
  s.add(token(5), 4 * H, evicted);
  EXPECT(evicted == b && s.find(token(2)) == -1 && s.find(token(5)) == b && s.find(token(1)) == a);
  s.remove(a);
  EXPECT(s.find(token(1)) == -1 && !s.used(a));
  s.clear();
  EXPECT(s.find(token(5)) == -1);
  // An all-zero cookie never matches a free slot.
  EXPECT(s.find(Token{}) == -1);
}

static void test_sessions_survive_a_reboot() {
  Sessions before;
  int evicted;
  before.add(token(1), 0, evicted);
  int gone = before.add(token(2), 0, evicted);
  before.remove(gone);
  Sessions::Stored saved = before.stored();
  // The new boot's uptime starts again; the idle clock restarts with it.
  Sessions after;
  after.restore(saved, 1000);
  int a = after.find(token(1));
  EXPECT(a >= 0 && after.find(token(2)) == -1);
  EXPECT(!after.idle(a, 1000 + 6 * H, 6 * H) && after.idle(a, 1001 + 6 * H, 6 * H));
}

static void test_nonces() {
  Nonces n;
  Nonce x = token(10), y = token(20);
  n.issue(x, 0);
  EXPECT(!n.consume(y, 0));  // never issued
  EXPECT(n.consume(x, 60000));  // 60 s: still good
  EXPECT(!n.consume(x, 60000));  // once only
  n.issue(x, 0);
  EXPECT(!n.consume(x, 60001));  // expired, and gone
  EXPECT(!n.consume(x, 0));
  // Four at a time: a fifth pushes out the oldest.
  for (uint8_t i = 0; i < 5; i++)
    n.issue(token(30 + i), i);
  EXPECT(!n.consume(token(30), 10));
  EXPECT(n.consume(token(31), 10) && n.consume(token(34), 10));
}

static void test_lockout() {
  Lockout l;
  for (int i = 0; i < 4; i++)
    EXPECT(l.fail(0) == 0);
  EXPECT(l.remaining_s(0) == 0);
  EXPECT(l.fail(0) == 30);  // the 5th
  EXPECT(l.remaining_s(0) == 30 && l.remaining_s(29001) == 1 && l.remaining_s(30000) == 0);
  EXPECT(l.fail(30000) == 60);
  EXPECT(l.fail(90000) == 120);
  uint32_t lock = 0;
  for (int i = 0; i < 10; i++)
    lock = l.fail(0);
  EXPECT(lock == 900);  // capped at 15 min
  l.succeed();
  EXPECT(l.remaining_s(0) == 0 && l.fail(0) == 0);
}

int main() {
  test_sha256();
  test_hmac_rfc4231();
  test_login_proof();
  test_hex();
  test_cookie();
  test_routes();
  test_sessions();
  test_sessions_survive_a_reboot();
  test_nonces();
  test_lockout();
  if (failures) {
    std::printf("page_login_test: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("page_login_test: ok\n");
  return 0;
}
