// The login's SHA-256 and HMAC-SHA256 (webui/hmac.js), against RFC 4231's vectors and Node's own crypto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { sha256, hmacSha256, hmacSha256Hex, hex } from "../hmac.js";

const nodeSha = (data) => createHash("sha256").update(data).digest("hex");
const nodeHmac = (key, data) => createHmac("sha256", key).update(data).digest("hex");

test("SHA-256: the classic digests", () => {
  assert.equal(hex(sha256("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("SHA-256: every length across the padding's block boundaries, as Node hashes it", () => {
  for (let len = 0; len <= 200; len++) {
    const data = randomBytes(len);
    assert.equal(hex(sha256(new Uint8Array(data))), nodeSha(data), `${len} bytes`);
  }
});

// RFC 4231 § 4: test cases 1-4, 6 and 7 (5 is a truncated output).
const RFC4231 = [
  [Buffer.alloc(20, 0x0b), Buffer.from("Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
  [Buffer.from("Jefe"), Buffer.from("what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
  [Buffer.alloc(20, 0xaa), Buffer.alloc(50, 0xdd), "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
  [Buffer.from(Array.from({ length: 25 }, (_, i) => i + 1)), Buffer.alloc(50, 0xcd),
    "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"],
  [Buffer.alloc(131, 0xaa), Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First"),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
  [Buffer.alloc(131, 0xaa), Buffer.from("This is a test using a larger than block-size key and a larger than block-size data. "
    + "The key needs to be hashed before being used by the HMAC algorithm."),
  "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"],
];

test("HMAC-SHA256: RFC 4231's test vectors", () => {
  RFC4231.forEach(([key, data, mac], i) => {
    assert.equal(hex(hmacSha256(new Uint8Array(key), new Uint8Array(data))), mac, `test case ${i < 4 ? i + 1 : i + 2}`);
    assert.equal(nodeHmac(key, data), mac);
  });
});

test("HMAC-SHA256: random keys and messages, as Node computes them", () => {
  for (let i = 0; i < 300; i++) {
    const key = randomBytes(i % 150), data = randomBytes((i * 7) % 300);
    assert.equal(hex(hmacSha256(new Uint8Array(key), new Uint8Array(data))), nodeHmac(key, data), `key ${key.length} B, data ${data.length} B`);
  }
});

test("the login's proof: a password as UTF-8, over the nonce's 32 hex characters", () => {
  const nonce = "00112233445566778899aabbccddeeff";
  for (const password of ["motdepasse", "Piscine été 2026 !", "naïve-ŒUVRE", "密码密码密码密码", "🏊‍♀️ nage libre 🌊", "x".repeat(64), "y".repeat(200)]) {
    const proof = hmacSha256Hex(password, nonce);
    assert.match(proof, /^[0-9a-f]{64}$/);
    assert.equal(proof, nodeHmac(Buffer.from(password, "utf8"), nonce), password);
  }
  for (let i = 0; i < 50; i++) {
    const password = randomBytes(12).toString("base64") + "é€", challenge = randomBytes(16).toString("hex");
    assert.equal(hmacSha256Hex(password, challenge), nodeHmac(Buffer.from(password, "utf8"), challenge));
  }
});
