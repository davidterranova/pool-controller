# Page login: a password-only login screen instead of the browser's digest prompt

Tracking document. One session per work package (WP). Planned against main at v1.9.0 (ESPHome 2026.11.0b6).

## Why

The controller's page is behind ESPHome's own HTTP auth (`web_server: auth: type: digest`, [pool-controller.yaml](../../pool-controller.yaml)). The user is fixed to `admin` ([device_settings.h](../../device_settings.h) `PAGE_USERNAME`) and only the password is a setting. So:

- The browser's native dialog asks for a **username nobody chooses**. The setup wizard and the docs have to explain « identifiant admin, fixe ».
- The dialog can't be styled, can't say what went wrong, and doesn't work with password managers the way a normal form does.
- There's **no logout**. Safari and Chrome cache digest credentials until the browser quits.
- Mid-wizard, after step 1 sets the Page Password, the next request gets a 401 and the browser prompt appears with no context.

The goal is a login screen in the page itself that asks for **the password only**, then lets the browser stay logged in.

## How ESPHome checks the login today (and where ours goes)

- `web_server` registers its handler with `WebServerBase::add_handler()`. That wraps it in `GuardMiddlewareHandler`: origin check, then `check_auth_()`, which sends a `401` with `WWW-Authenticate` when the digest is missing or wrong. That header is what makes the browser show its dialog.
- With no `auth:` in the YAML, `USE_WEBSERVER_AUTH` is undefined and `check_auth_()` always passes.
- `WebServerBase::add_handler_without_auth()` adds a handler with no guard. On ESP32 (`web_server_idf`), `AsyncWebServer::request_handler_` asks each handler in **registration order**, and the first one whose `canHandle()` returns true takes the request.

So the plan is: drop `auth:` and register our own **gate** handler **before** `web_server`'s. Its `canHandle()` claims every request that isn't allowed through and answers it. Every other request goes on to `web_server` as before.

## Decisions

1. **The device checks a session cookie, not digest.** `auth:` leaves `web_server`. A new local component, `page_login` (`components/page_login/`, like `gated_update`), does the check.
2. **The gate.** While a Page Password is set, it claims every request that has no valid `pool_session` cookie, except:
   - `GET /`, `GET /0.js` and `GET /0.css`: the page shell and its bundle. They're the open-source UI and hold no state, and they're what draws the login screen.
   - `GET /login/challenge`, `POST /login`, `GET /login/session` and `POST /logout`: served by `page_login` itself.
   
   A claimed request gets **`401` with no `WWW-Authenticate`**, so the browser never shows its own dialog. With no Page Password set (setup mode), the gate claims nothing, as today.
3. **The login screen is part of the existing page** (`webui/`), not a second page served by the firmware. The page loads, its stream (`/events`) or any request gets a 401, and it shows the login screen. That's one bundle, one style (`app.css`), and the mock can do the same. It's a single password field (show/hide toggle, `autocomplete="current-password"`) and a « Se connecter » button. It shows « Mot de passe incorrect » and, while locked out, a countdown.
4. **The password never crosses the network at login (challenge–response).** The README promises « digest auth keeps the password off the wire » and the hotspot is open, so we keep that:
   - `GET /login/challenge` returns a random 128-bit nonce. Each nonce is used once and expires after 60 s. The device keeps up to 4 in RAM.
   - The page sends `POST /login` with `{nonce, proof}`, where `proof = hex(HMAC-SHA256(key = password, msg = nonce))`.
   - The device computes the same HMAC from `page_password` (mbedtls) and compares in constant time.
   - The page can't use `crypto.subtle` (`http://<ip>` isn't a secure context), so `webui/` bundles a small SHA-256/HMAC (~1.5 KB minified). It's tested against `node:crypto`.
   - The password still travels once, in clear, when it's **set** (the Page Password text entity), as it does today.
5. **One session per browser, ended after 6 h idle.**
   - Each successful login draws a token (128 bits from `random_bytes`). The device keeps **up to 4 sessions**; a 5th login evicts the one idle longest.
   - The tokens are kept in a new restored global, `session_tokens` (4 × 16 bytes; like every global id, stable forever). It's written only on login, logout and « log out everyone », never on ordinary requests, so flash wear stays low.
   - The cookie is `pool_session=<token hex>; Path=/; HttpOnly; SameSite=Strict`. There's no `Max-Age`: the device enforces the lifetime. There's no `Secure` flag (plain HTTP).
   - **Idle limit: 6 h.**
     - Each session's last activity is kept in RAM, as uptime (`millis_64()`, so it doesn't wrap). The device may have no wall clock: on the hotspot there's no SNTP.
     - Every authenticated request refreshes it, except the `/events` stream. An open tab streams forever, so counting the stream would mean a session never goes idle.
     - While someone uses the page without sending anything (switching tabs, scrolling), the page refreshes the session with `GET /login/session`. It does this at most every 5 min, and only after user input.
     - A session idle for more than 6 h is deleted. The next request gets a 401, and the page shows the login screen.
     - The device has no hook to close a `/events` stream that's already open (see L0). So the page also counts 6 h without user input, then calls `POST /logout` and shows the login screen.
     - **At boot, every stored session's idle clock restarts.** So a reboot or update doesn't log anyone out, which matters with Auto Update. The cost: a session can last up to 6 h past a reboot.
   - **Everyone is logged out** (all sessions deleted) when:
     - the Page Password changes;
     - Factory Reset runs;
     - someone presses « Déconnecter tous les appareils ».
     
     `POST /logout` deletes only this browser's session.
6. **Brute force.** One counter for the whole device (decided: not per client):
   - After 5 failed logins in a row, `/login` refuses for 30 s, then 60 s, and so on up to 15 min. A success resets it.
   - The 401 body carries `retry_after` for the countdown.
   - The counter is per device, not per client: someone on the open hotspot can keep the owner locked out while they keep trying. We accept that: Home Assistant and the controller's own schedule don't depend on the page.
7. **CSRF.**
   - The cookie is `SameSite=Strict`.
   - `web_server`'s handlers already reject cross-origin browser requests (`check_origin_`).
   - `page_login`'s own endpoints are added without the guard, so they do the same origin check themselves (`is_request_origin_allowed`).
8. **Scripts lose digest.** `curl --digest -u admin:…` stops working. POOL-CONTROLLER.md gets a short `curl` recipe instead: the challenge, the HMAC computed with `openssl dgst -hmac`, `-c`/`-b` for the cookie jar. Keeping digest as a second way in would need the `WWW-Authenticate` header, and that brings the browser's dialog back.
9. **Nothing to migrate.** `page_password` keeps its id and its NVS key. After the update, a browser that was logged in with digest sees the login screen once.
10. **The page reloads itself after a firmware update.**
    - At load, the page notes the controller's firmware version (the Firmware update entity's `current_version`).
    - When the stream reconnects after a reboot and reports another version, the page calls `location.reload()`. The new page then loads, along with its new code.
    - A reboot on the same version (a power cut, a Wi-Fi change) doesn't reload.
    - This only works from 1.10.0 on. A tab still running the 1.9.0 page code needs one manual reload, so the release notes say so. Until then, that tab's retry loop gets a 401 every 5 s, which does no harm.

## Entity and endpoint contract

| What | Kind | Notes |
|---|---|---|
| `session_tokens` | global `std::array<uint8_t, 64>` (4 × 16 bytes), restored | new; **id stable forever**; all zero = no session |
| Logout All Devices (« Déconnecter tous les appareils ») | button, `grp_device` | deletes every session |
| `GET /login/challenge` | `page_login` | `200 {"nonce":"<32 hex>"}`; `204` in setup mode |
| `POST /login` | `page_login` | body `{"nonce","proof"}`; `204` + `Set-Cookie`, or `401 {"retry_after":s}` |
| `GET /login/session` | `page_login` | `204` and refreshes the idle clock with a valid session; else `401`; `204` in setup mode |
| `POST /logout` | `page_login` | deletes this session; `204` + an expired `Set-Cookie` |
| every other path | `web_server` | unchanged; a `401` (no `WWW-Authenticate`) without a valid cookie |

Page Password, Setup State and Factory Reset keep their names. Only their lambdas change.

## Branches

The firmware and the page ship as one image (the page is embedded), and the firmware change alone would lock out the old page. So, as for the fill meter:

```
main ── feat/page-login ──┬── feat/page-login-l0-spike ─────┐
                          ├── feat/page-login-l1-firmware ──┤ PRs into the feature branch
                          ├── … l2-page, l3-docs ───────────┘
                          └── one PR into main = one release = the update
```

To claim a WP:
1. Check `gh pr list --base feat/page-login` and the Status table below.
2. Branch from `feat/page-login` as `feat/page-login-l<n>-<topic>`. In the first commit, set its row to `in progress` with the branch name.
3. Open the PR **into `feat/page-login`**, not main. The PR that finishes the WP sets its row to `done` and links itself.
4. Once it merges, the WPs that depend on it rebase onto the feature branch.

The feature branch's other rules:
- **Version:** VERSION is `const VERSION` in `home-assistant/piscine-card.js`.
  - The first WP that changes the firmware (L1, or L2 if it lands first) bumps it to the next unreleased minor, 1.10.0. This plan commit doesn't: release.yml's check only fails when the card or the firmware changed.
  - Whenever main releases the version the branch holds, the next sync of main bumps it again.
- **Keeping up with main:** merge main into the feature branch whenever main moves, and at least before the final PR. Then each open WP branch merges the feature branch in.
- **Testing:** test with `make ota` from the branch, never through a release.

## Status

| WP | What | Status | Branch / PR |
|---|---|---|---|
| L0 | Spike: gate ordering, cookies, SSE on 2026.11 | todo | |
| L1 | Firmware: `page_login` component + device-settings wiring | todo | |
| L2 | Page: login screen, HMAC, 401 handling, wizard, logout; the mock | todo | |
| L3 | Docs | todo | |

L1 and L2 can run in parallel once L0 has settled the contract above. L3 goes last.

## Work packages

### L0: spike (`tools/spike/`)

A throwaway YAML on a dev board, or the controller with `make ota`, that checks:
- A handler added with `add_handler_without_auth()` from a component whose `setup_priority` is above `web_server`'s gets asked **before** `web_server`'s handler. Its `canHandle()` can read `Cookie` (`get_header_to`).
- With `auth:` removed, nothing else sends a challenge.
- `AsyncWebServerResponse::addHeader("Set-Cookie", …)` reaches the browser, and `EventSource("/events")` sends the cookie.
- The cookie fits under `CONFIG_HTTPD_MAX_REQ_HDR_LEN`.
- mbedtls HMAC-SHA256 links with no extra component.
- Whether a component can close `web_server`'s open `/events` connections. If it can, the device itself ends the stream of a session that has gone idle, and the page's own 6 h timer (decision 5) becomes a fallback.
- A `std::array<uint8_t, 64>` global restores from NVS.

Write the results here. If ordering by setup priority doesn't hold, the fallback is to register the gate from `on_boot` at a priority above 249 (`WIFI - 1`) through `global_web_server_base`.

### L1: firmware (`components/page_login/`, `device-settings.yaml`, `device_settings.h`, `pool-controller.yaml`)

- `page_login.h` / `__init__.py`:
  - the gate handler (decision 2);
  - the challenge, login, session and logout endpoints (4);
  - the session table, with the 6 h idle limit and the idle clocks restarted at boot (5);
  - the backoff (6);
  - the origin check (7).
  
  Small pure helpers (allowlist match, cookie parse, HMAC verify, backoff) go in a header with no ESPHome dependency, so they can be tested.
- `pool-controller.yaml`: remove `web_server: auth:` and its comment. Add `page_login:` with `password_id: page_password`, `sessions_id: session_tokens` and `idle_timeout: 6h`.
- `device-settings.yaml`:
  - the `session_tokens` global;
  - Page Password's `on_value` deletes every session instead of calling `set_page_login`;
  - Factory Reset deletes them too;
  - the Logout All Devices button;
  - `on_boot` no longer touches the login.
- `device_settings.h`: remove `set_page_login`, `PAGE_USERNAME` and the double buffer. The gate runs on the HTTP task, so `page_login` keeps its own copy of the password and of the session table under a lock, and is told about changes through setters.
- `tools/tests/page_login_test.cpp`: the helpers, built like `fill_meter_test.cpp`. They cover:
  - the HMAC, against the RFC 4231 test vectors;
  - the idle expiry and eviction, on a fake clock;
  - the idle clocks restarting at boot.

### L2: page (`webui/`) and the mock (`tools/webui-mock/`)

- `webui/hmac.js` (SHA-256 + HMAC) and `webui/test/hmac.test.mjs` (against `node:crypto`).
- `webui/login.js`: the screen (decision 3) and the challenge/login flow.
- `esphome-hass.js`:
  - on a closed stream, probe `GET /login/challenge`. A 200 means show the login screen; then reconnect after login. It must stop doing `fetch("/")` to make the browser prompt.
  - a POST that gets a 401 shows the login screen too.
  - the firmware version check and `location.reload()` (decision 10).
- `webui/session.js`: the idle side of decision 5.
  - After user input, it sends `GET /login/session`, at most every 5 min.
  - After 6 h with no input, it sends `POST /logout` and shows the login screen.
  - The timing logic is pure, so it can be unit-tested with a fake clock.
- `setup.js` / `setup-model.js`:
  - after step 1 sets the password, log in with it right away, so the wizard carries on with no prompt;
  - drop every « identifiant admin » text, including the hidden `username` input (`setup.js:107`);
  - the reconnection step (`setup.js:534`) says « la page demande le mot de passe ».
- « Réglages contrôleur » › Accès:
  - « Se déconnecter » (`POST /logout`);
  - « Déconnecter tous les appareils » (the button);
  - after changing the Page Password, log in again with the new one.
- `mock_server.py`:
  - replace `_digest_ok` and `authorized()` with the same gate, endpoints, session table and backoff;
  - an option to shorten the idle limit (for example `--idle 60s`), to test expiry;
  - a way to fake a firmware update (a reboot onto another version), to test the reload.
  
  `make mock-webui` should show the login screen once a password is set.

### L3: docs

- README: the wizard and setup-mode lines. Line 167 (« the mock has no auth ») may now be wrong: check it.
- POOL-CONTROLLER.md:
  - the Page Password entry (around line 257): no « user admin, digest »;
  - the « Log in as admin » paragraph (~794);
  - the LAN-only note (~833): challenge–response at login, and the cookie travels in clear like any HTTP session;
  - the scripting recipe (decision 8);
  - the hotspot paragraph.
- `wifi-setup.yaml` and `device-settings.yaml` header comments that say « web_server login ».
- Release notes: the one-time login after the update, and that `--digest` scripts break.

## Verification

- `make test` (the new C++ and JS tests), `make webui`, and `make compile` on the pinned ESPHome.
- In the mock:
  - a fresh run has no login;
  - setting a password in the wizard logs in at once;
  - a reload keeps the session;
  - « Se déconnecter » shows the login screen;
  - 5 wrong passwords show the countdown;
  - changing the password logs out a second browser;
  - with a short idle limit, an untouched tab goes to the login screen, while a tab in use stays logged in;
  - a faked update to another version reloads the page by itself, and a reboot on the same version doesn't.
- On the controller (`make ota` from the branch):
  - no browser dialog anywhere;
  - a reboot or OTA keeps the session, and an OTA to a new version reloads the open page;
  - Factory Reset goes back to setup mode with no login;
  - the hotspot at 192.168.4.1 shows the login screen;
  - `curl` without the cookie gets 401 on `/events` and on `POST /switch/...`;
  - Home Assistant (native API) and `make ota` (OTA password) are unaffected.
- A packet capture of a login (Wireshark on the hotspot) shows no password.

## Settled (2026-11-19)

- Sessions end after **6 h idle** (decision 5).
- The lockout is **per device**, not per client (decision 6).
- The page **reloads itself after a firmware update** (decision 10).

## Open questions

- If L0 finds that the device can't close an open `/events` stream, is the page's own 6 h timer enough? A tab already open on an old page code wouldn't run it.
