/*
 * Keeping the login session alive while someone uses the page (docs/plans/page-login.md, decision 5). The controller
 * ends a session after 6 h without a request, and the event stream doesn't count: a tab only read, scrolled or switched
 * to sends nothing. So after user input the page sends GET /login/session, at most every 5 min. A tab left alone sends
 * nothing: its session ends on the controller, which closes its stream, and the page shows its login screen.
 */

export const KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * `input()` on each user input calls `send` when the session was last refreshed `every` ms ago or more (true then);
 * `refreshed()` says a request just did it (a login).
 */
export function keepAlive({ send, now = Date.now, every = KEEPALIVE_MS }) {
  let last = -Infinity;
  return {
    input() {
      if (now() - last < every) return false;
      last = now();
      send();
      return true;
    },
    refreshed() {
      last = now();
    },
  };
}
