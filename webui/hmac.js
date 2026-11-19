/*
 * SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), for the login's proof (login.js): the page proves it knows the
 * Page Password without sending it. The page is served over plain http://<ip>, which isn't a secure context, so the
 * browser's crypto.subtle isn't there; this is the little of it the login needs. Strings are taken as UTF-8.
 */

// The round constants and the initial hash: the first 32 bits of the fractional parts of the cube roots of the first
// 64 primes, and of the square roots of the first 8. Computed rather than listed; the tests check the digests.
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const frac32 = (x) => (x - Math.floor(x)) * 2 ** 32 >>> 0;
const K = Uint32Array.from(PRIMES, (p) => frac32(Math.cbrt(p)));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => frac32(Math.sqrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const bytes = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : data);
const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** SHA-256 of a string (UTF-8) or bytes: 32 bytes. */
export function sha256(data) {
  const msg = bytes(data), len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64; // the message, 0x80, zeros, its length in bits on 64 bits
  const m = new Uint8Array(total);
  m.set(msg);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(total - 8, Math.floor(len / 2 ** 29));
  view.setUint32(total - 4, len * 8 >>> 0);
  const h = H0.slice(), w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => (h[i] += v));
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

/** HMAC-SHA256 of `message` under `key`, each a string (UTF-8) or bytes: 32 bytes. */
export function hmacSha256(key, message) {
  let k = bytes(key);
  if (k.length > 64) k = sha256(k);
  const pad = (x) => {
    const p = new Uint8Array(64).fill(x);
    k.forEach((v, i) => (p[i] ^= v));
    return p;
  };
  return sha256(concat(pad(0x5c), sha256(concat(pad(0x36), bytes(message)))));
}

export const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 as lowercase hex: the login's proof is hmacSha256Hex(password, nonce). */
export const hmacSha256Hex = (key, message) => hex(hmacSha256(key, message));
