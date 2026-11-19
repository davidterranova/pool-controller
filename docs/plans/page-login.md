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
   - any `OPTIONS` (CORS preflights; they carry no data).
   - `GET /login/challenge`, `POST /login`, `GET /login/session` and `POST /logout`: served by `page_login` itself.
   
   A claimed request gets **`401` with no `WWW-Authenticate`**, so the browser never shows its own dialog. With no Page Password set (setup mode), the gate claims nothing, as today.
3. **The login screen is part of the existing page** (`webui/`), not a second page served by the firmware. The page loads, its stream (`/events`) or any request gets a 401, and it shows the login screen. That's one bundle, one style (`app.css`), and the mock can do the same. It's a single password field (show/hide toggle, `autocomplete="current-password"`) and a « Se connecter » button. It shows « Mot de passe incorrect » and, while locked out, a countdown.
4. **The password never crosses the network at login (challenge–response).** The README promises « digest auth keeps the password off the wire » and the hotspot is open, so we keep that:
   - `GET /login/challenge` returns a random 128-bit nonce. Each nonce is used once and expires after 60 s. The device keeps up to 4 in RAM.
   - The page sends `POST /login`, form-encoded (`nonce=<hex>&proof=<hex>`). Here `proof` is the lowercase hex of HMAC-SHA256, with key = the password's UTF-8 bytes and message = the nonce's 32 hex characters as the page received them. So `printf %s "$nonce" | openssl dgst -sha256 -hmac "$password"` computes it too.
   - The device computes the same HMAC and compares in constant time. Its SHA-256/HMAC is a small portable one in `page_login_core.h`, not mbedtls, so the host tests run the same code.
   - The page can't use `crypto.subtle` (`http://<ip>` isn't a secure context), so `webui/` bundles a small SHA-256/HMAC (~1.5 KB minified). It's tested against `node:crypto`.
   - The password still travels once, in clear, when it's **set** (the Page Password text entity), as it does today.
5. **One session per browser, ended after 6 h idle.**
   - Each successful login draws a token (128 bits from `random_bytes`). The device keeps **up to 4 sessions**; a 5th login evicts the one idle longest.
   - `page_login` keeps the tokens in NVS itself, as its own preference (key `fnv1_hash("page_login_sessions")`, 4 × 16 bytes; like a global's id, that key is stable forever). It's written only when the sessions change (a login, a logout, a session ending), never on ordinary requests, so flash wear stays low.
   - The cookie is `pool_session=<token hex>; Path=/; HttpOnly; SameSite=Strict`. There's no `Max-Age`: the device enforces the lifetime. There's no `Secure` flag (plain HTTP).
   - **Idle limit: 6 h.**
     - Each session's last activity is kept in RAM, as 64-bit uptime (`esp_timer_get_time()`, so it doesn't wrap). The device may have no wall clock: on the hotspot there's no SNTP.
     - Every authenticated request refreshes it, except the `/events` stream. An open tab streams forever, so counting the stream would mean a session never goes idle.
     - While someone uses the page without sending anything (switching tabs, scrolling), the page refreshes the session with `GET /login/session`. It does this at most every 5 min, and only after user input.
     - A session idle for more than 6 h is deleted: on its next request, or within a minute by a sweep. Deleting it also deletes it from NVS, so a reboot can't bring it back.
     - **The device closes the `/events` streams of an ended session** (idle, logout, logout of everyone, eviction). The gate notes each stream's socket when it lets one through. When the session ends, the device closes those sockets with ESP-IDF's `httpd_sess_trigger_close` (see L0). The page's EventSource reconnects, gets a 401, and the page shows the login screen. So the page needs no 6 h timer of its own.
     - **At boot, every stored session's idle clock restarts.** So a reboot or update doesn't log anyone out, which matters with Auto Update. The cost: a session can last up to 6 h past a reboot.
   - **Everyone is logged out** (all sessions deleted) when:
     - the Page Password changes;
     - Factory Reset runs;
     - someone presses « Déconnecter tous les appareils ».
     
     `POST /logout` deletes only this browser's session.
6. **Brute force.** One counter for the whole device (decided: not per client):
   - After 5 failed logins in a row, `/login` refuses for 30 s, then 60 s, and so on up to 15 min. A success resets it.
   - A failed login gets `401 {"retry_after":N}`, where N is the lock this failure started (0 if none). A login while locked gets `429 {"retry_after":N}` and a `Retry-After: N` header. The page uses N for its countdown.
   - The counter is per device, not per client: someone on the open hotspot can keep the owner locked out while they keep trying. We accept that: Home Assistant and the controller's own schedule don't depend on the page.
7. **CSRF.**
   - The cookie is `SameSite=Strict`.
   - `web_server`'s handlers already reject cross-origin browser requests (`check_origin_`).
   - `page_login`'s own endpoints are added without the guard, so `POST /login` and `POST /logout` do the same origin check themselves (`web_server_base::is_origin_allowed`, 403 otherwise).
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
| `page_login:` (id `page_login_gate`, `idle_timeout: 6h`) | local component, in `device-settings.yaml` | its sessions in its own NVS preference, key `fnv1_hash("page_login_sessions")`: **stable forever** |
| Logout All Devices (« Déconnecter tous les appareils »), id `logout_all_devices` | button, `grp_device`, weight 25 | deletes every session |
| `GET /login/challenge` | `page_login` | `200 {"nonce":"<32 hex>"}`; `204` in setup mode |
| `POST /login` | `page_login` | form body `nonce=…&proof=…`; `204` + `Set-Cookie`; `401 {"retry_after":N}`; `429 {"retry_after":N}` + `Retry-After` while locked; `403` cross-origin; `204` in setup mode |
| `GET /login/session` | `page_login` | `204` and refreshes the idle clock with a valid session; else `401`; `204` in setup mode |
| `POST /logout` | `page_login` | deletes this session; `204` + an expired `Set-Cookie` |
| every other path | `web_server` | unchanged; a `401` `text/plain` `Login required` (no `WWW-Authenticate`) without a valid cookie |

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
- **Testing:** test with `make ota` from the branch, never through a release. **First set Update Check Interval to « À la demande »**, or turn Auto Update off. ESPHome's update entity calls any manifest version that differs from the installed one « available », not only a newer one. So the scheduled check, one minute after boot, finds `v1.9.0` ≠ `v1.9.0-17-g…`, and Auto Update reinstalls the release a minute later. That happened on 2026-11-19, about 2 min after the OTA.

## Status

| WP | What | Status | Branch / PR |
|---|---|---|---|
| L0 | Spike: gate ordering, cookies, SSE on 2026.11 | done (from the source; see L0) | [#56](https://github.com/davidterranova/pool-controller/pull/56) |
| L1 | Firmware: `page_login` component + device-settings wiring | done | [#56](https://github.com/davidterranova/pool-controller/pull/56) |
| L2 | Page: login screen, HMAC, 401 handling, wizard, logout; the mock | done | [#57](https://github.com/davidterranova/pool-controller/pull/57) |
| L3 | Docs | done | [#58](https://github.com/davidterranova/pool-controller/pull/58) |

L1 and L2 can run in parallel once L0 has settled the contract above. L3 goes last.

## Work packages

### L0: spike — done 2026-11-19, from ESPHome 2026.11.0b6's source

The questions were answered by reading `web_server_base`, `web_server_idf` and `web_server` as they're built here (`.esphome/build/…/src/esphome/components/`), then compiling. No throwaway YAML was needed. To confirm on the controller: see Verification.

- **Ordering holds.**
  - `AsyncWebServer::request_handler_` asks the handlers in the order they were added, and the first whose `canHandle()` says yes answers.
  - `web_server`'s setup priority is `WIFI - 1` (249); there it calls `base_->init()`, then `add_handler()` for `/events` and the rest.
  - `PageLogin` sets up at `WIFI` (250), so its `add_handler_without_auth()` comes first. Before `init()`, the handler waits in `WebServerBase::handlers_`, and `init()` adds them in order.
- **No challenge without `auth:`.** `USE_WEBSERVER_AUTH` is undefined, so `GuardMiddlewareHandler::check_auth_()` always passes. Its origin check stays.
- **Headers.**
  - `get_header_to("Cookie", buf)` reads the cookie. `CONFIG_HTTPD_MAX_REQ_HDR_LEN` is 1024 here, and the cookie is about 45 bytes.
  - `addHeader()` only stores the pointer (`httpd_resp_set_hdr`), so the `Set-Cookie` value must live until `send()`. It's built on the handler's stack.
  - EventSource sends same-origin cookies by default.
- **Status codes.** `init_response_()` knows 200, 204, 400, 401, 403, 404, 409 and 422; any other code goes out as a 500. So the 429 sets its status with `httpd_resp_set_status()` after `beginResponse()`.
- **Body.** A form-encoded POST body is read before dispatch and is available through `arg()`. Hence the form body for `/login`, not JSON.
- **Closing a stream.** `web_server` keeps its `AsyncEventSource` and its sessions private. But each SSE stream is an httpd session with a context (`httpd_sess_get_ctx(hd, fd)` is non-null; a plain keep-alive socket has none). So the gate notes `httpd_req_to_sockfd()` when it lets an `/events` request through. To close one, it queues `httpd_sess_trigger_close` on the HTTP task (`httpd_queue_work`), and only if the socket still has a context. ESPHome's SSE response already handles a closed socket (its session-context free callback).
- **Crypto and storage.**
  - mbedtls isn't used: a portable SHA-256/HMAC in `page_login_core.h` keeps the host tests on the same code.
  - The sessions are a preference of `page_login`'s own (`make_preference<Sessions::Stored>`), not a global: the component reads and writes them on the HTTP task, which a global's own save loop (main loop) doesn't expect.

### L1: firmware (`components/page_login/`, `device-settings.yaml`, `device_settings.h`, `pool-controller.yaml`)

- `components/page_login/`:
  - `page_login_core.h`: the pure parts, with no ESPHome or IDF include:
    - SHA-256, HMAC and the login proof;
    - hex;
    - the cookie parser;
    - the route of a request;
    - the session table, with its idle limit and boot restore;
    - the nonces;
    - the lockout.
  - `page_login.h` / `page_login.cpp`: the gate handler and the four endpoints (decisions 2 and 4).
    - The state sits under one mutex: the gate runs on the HTTP task, the setters on the main loop. Responses go out after the lock is released, so a slow client can't stall the main loop.
    - The sessions are saved from `loop()` when they've changed.
    - Idle sessions are swept every minute.
    - Streams are closed through `httpd_queue_work`.
  - `__init__.py`: the `page_login:` schema (`idle_timeout`, default 6 h, at least 1 min).
- `pool-controller.yaml`: `web_server: auth:` removed.
- `device-settings.yaml`:
  - `external_components` + `page_login:` (id `page_login_gate`);
  - `on_boot` gives it the stored password;
  - Page Password calls `set_password()` + `logout_all()`;
  - Factory Reset does the same with an empty password;
  - the Logout All Devices button.
- `device_settings.h`: `set_page_login`, `PAGE_USERNAME` and the double buffer removed.
- `tools/tests/page_login_test.cpp` (in `make firmware-test`):
  - SHA-256 (FIPS vectors) and HMAC (RFC 4231 cases 1, 2, 6, 7);
  - the proof;
  - hex and the cookie;
  - the routes;
  - sessions: idle expiry, eviction, boot restore;
  - nonces: single use, 60 s, 4 at a time;
  - the lockout's steps and cap.
- VERSION 1.10.0.

### L2: page (`webui/`) and the mock (`tools/webui-mock/`)

- `webui/hmac.js` (SHA-256 + HMAC) and `webui/test/hmac.test.mjs` (against `node:crypto`).
- `webui/login.js`: the screen (decision 3) and the challenge/login flow.
- `esphome-hass.js`:
  - on a closed stream, probe `GET /login/session`. A 401 means show the login screen; then reconnect after login. It must stop doing `fetch("/")` to make the browser prompt.
  - a POST that gets a 401 shows the login screen too.
  - the firmware version check and `location.reload()` (decision 10).
- `webui/session.js`: the idle side of decision 5.
  - After user input, it sends `GET /login/session`, at most every 5 min.
  - There's no page-side 6 h timer: the device ends the session and closes the stream itself (L0).
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
- On the controller (`make ota` from the branch, Auto Update held off; see Branches):
  - **Done 2026-11-19** with `curl` (`v1.9.0-17-g90f20a7`, before Auto Update reinstalled v1.9.0):
    - `/`, `/0.js`: 200;
    - `/events`, `GET /sensor/…`, `POST /button/…/press` without a cookie: `401 Login required`, no `WWW-Authenticate`;
    - challenge: a nonce; a wrong proof: `401 {"retry_after":0}`; the same nonce again: 401;
    - a cross-origin `/login` or `/logout`: 403;
    - `/logout`: 204 with an expired cookie;
    - Home Assistant back 4 s after the reboot; the OTA password still accepted.
    
    Found: a POST with no body gets 411 from ESP-IDF's server (`Content-Length` required). Browsers always send one; the docs' `curl` recipe now uses `-d ''`.
  - **Still to do, in a browser:**
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

- None yet.
