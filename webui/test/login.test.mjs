// The login's flow (webui/login.js) against a stand-in for the controller's /login endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { logIn, postLogout, waitText } from "../login.js";

const NONCE = "0123456789abcdef0123456789abcdef";

/** The controller's side: `password` null is setup mode; `answer` overrides POST /login's answer. */
function device({ password = "mot de passe été", answer } = {}) {
  const calls = [];
  const reply = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  const http = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url === "/login/challenge") return password === null ? reply(204) : reply(200, { nonce: NONCE });
    if (url === "/login" && init.method === "POST") {
      if (password === null) return reply(204);
      if (answer) return answer();
      const form = new URLSearchParams(init.body);
      const proof = createHmac("sha256", Buffer.from(password, "utf8")).update(form.get("nonce")).digest("hex");
      return form.get("nonce") === NONCE && form.get("proof") === proof ? reply(204) : reply(401, { retry_after: 0 });
    }
    if (url === "/logout" && init.method === "POST") return reply(204);
    return reply(404);
  };
  return { http, calls };
}

test("the right password: a proof over the nonce, form-encoded, and in", async () => {
  const { http, calls } = device();
  assert.deepEqual(await logIn("mot de passe été", http), { ok: true });
  const post = calls.find((c) => c.url === "/login");
  assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(post.body, /^nonce=[0-9a-f]{32}&proof=[0-9a-f]{64}$/);
  assert.ok(!post.body.includes("passe"), "the password itself never leaves");
});

test("a wrong password: refused, nothing to wait", async () => {
  const { http } = device();
  assert.deepEqual(await logIn("mauvais", http), { ok: false, locked: false, retryAfter: 0 });
});

test("the failure that starts a lockout, then the lockout itself", async () => {
  const started = device({ answer: () => new Response('{"retry_after":30}', { status: 401 }) });
  assert.deepEqual(await logIn("x", started.http), { ok: false, locked: false, retryAfter: 30 });
  const locked = device({ answer: () => new Response('{"retry_after":25}', { status: 429, headers: { "Retry-After": "25" } }) });
  assert.deepEqual(await logIn("x", locked.http), { ok: false, locked: true, retryAfter: 25 });
  const headerOnly = device({ answer: () => new Response("", { status: 429, headers: { "Retry-After": "12" } }) });
  assert.deepEqual(await logIn("x", headerOnly.http), { ok: false, locked: true, retryAfter: 12 });
});

test("setup mode: no Page Password, nothing to prove", async () => {
  const { http, calls } = device({ password: null });
  assert.deepEqual(await logIn("anything", http), { ok: true });
  assert.deepEqual(calls.map((c) => c.url), ["/login/challenge"]);
});

test("anything else throws: the screen says the controller doesn't answer", async () => {
  const broken = device({ answer: () => new Response("", { status: 500 }) });
  await assert.rejects(logIn("x", broken.http), /HTTP 500/);
  await assert.rejects(logIn("x", async () => { throw new TypeError("Failed to fetch"); }), /Failed to fetch/);
});

test("logout: a POST", async () => {
  const { http, calls } = device();
  await postLogout(http);
  assert.deepEqual(calls.map((c) => [c.url, c.method]), [["/logout", "POST"]]);
  await assert.rejects(postLogout(async () => new Response("", { status: 500 })), /HTTP 500/);
});

test("the lockout's countdown", () => {
  assert.equal(waitText(30), "30 s");
  assert.equal(waitText(0.2), "1 s");
  assert.equal(waitText(-3), "0 s");
  assert.equal(waitText(60), "1 min 00 s");
  assert.equal(waitText(65), "1 min 05 s");
  assert.equal(waitText(900), "15 min 00 s");
});
