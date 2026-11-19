// The login session's keep-alive (webui/session.js), on a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepAlive, KEEPALIVE_MS } from "../session.js";

const MIN = 60 * 1000;

function rig() {
  let t = 1_000_000;
  const sent = [];
  const session = keepAlive({ send: () => sent.push(t), now: () => t });
  return { session, sent, wait: (ms) => (t += ms), at: () => t };
}

test("the first input refreshes at once, then at most every 5 min", () => {
  const { session, sent, wait, at } = rig();
  assert.equal(KEEPALIVE_MS, 5 * MIN);
  const start = at();
  assert.equal(session.input(), true);
  for (let i = 0; i < 20; i++) {
    wait(10 * 1000);
    session.input(); // a click every 10 s
  }
  assert.deepEqual(sent, [start]);
  wait(5 * MIN - 201 * 1000);
  assert.equal(session.input(), false, "4 min 59 s after the last one");
  wait(1000);
  assert.equal(session.input(), true, "5 min after the last one");
  assert.equal(sent.length, 2);
});

test("no input, nothing sent: the controller ends the session on its own", () => {
  const { session, sent, wait } = rig();
  session.input();
  wait(7 * 3600 * 1000);
  assert.equal(sent.length, 1);
  assert.equal(session.input(), true, "the next input after a long pause refreshes at once");
});

test("a login counts as a refresh", () => {
  const { session, sent, wait } = rig();
  session.refreshed();
  wait(4 * MIN);
  assert.equal(session.input(), false);
  wait(MIN);
  assert.equal(session.input(), true);
  assert.equal(sent.length, 1);
});
