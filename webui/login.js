/*
 * The login screen (docs/plans/page-login.md): in place of the page while the controller asks for its Page Password,
 * where the browser used to show its own dialog. One password field, no user name. The password never crosses the
 * network: the controller hands out a nonce (GET /login/challenge), the page answers HMAC-SHA256(password, nonce)
 * (POST /login), and the controller sets its session cookie. That cookie is HttpOnly: the page never sees it, and
 * learns where it stands only from the controller's answers.
 *
 * esphome-hass.js says when a login is needed (its "login-required": the stream or a request got the gate's 401). A
 * login reconnects the stream, with no reload. A new Page Password ends every session, this page's too, so the page
 * logs in again with the one just typed (changePassword), and no login screen flashes in between.
 */
import { hmacSha256Hex } from "./hmac.js";

/**
 * Logs in: {ok: true}, or {ok: false, locked, retryAfter}, `locked` when the controller refused to try (too many
 * failures), `retryAfter` the seconds before the next try (0: right away). Throws when the controller can't be reached
 * or answers something else. With no Page Password set, the controller asks for nothing: ok.
 */
export async function logIn(password, http = fetch) {
  const challenge = await http("/login/challenge", { cache: "no-store" });
  if (challenge.status === 204) return { ok: true };
  if (!challenge.ok) throw new Error(`HTTP ${challenge.status}`);
  const { nonce } = await challenge.json();
  const res = await http("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce, proof: hmacSha256Hex(password, nonce) }).toString(),
  });
  if (res.ok) return { ok: true };
  if (res.status !== 401 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return { ok: false, locked: res.status === 429, retryAfter: Number(body.retry_after ?? res.headers.get("Retry-After")) || 0 };
}

/** Ends this browser's session (the controller expires its cookie). */
export async function postLogout(http = fetch) {
  const res = await http("/logout", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** The lockout's countdown: "30 s", "1 min 05 s". */
export function waitText(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/**
 * The screen in webui/index.html (#login). `onLogin` runs after each login (reconnect), `onLogout` after « Se
 * déconnecter » (disconnect). Returns what the page and setup.js call.
 */
export function mountLogin({ ui: { icon }, onLogin, onLogout }) {
  const $ = (id) => document.getElementById(id);
  const screen = $("login"), form = $("loginForm"), input = $("loginPw"), msg = $("loginMsg"), button = $("loginBtn");
  let note = "", until = 0, busy = false, timer = 0;
  let pending = null, wanted = false; // a login under way; whether the screen was asked for meanwhile

  /** The message under the field and the button, the lockout's countdown with them, every second while it runs. */
  function paint() {
    const left = (until - Date.now()) / 1000, locked = left > 0;
    button.disabled = locked;
    button.classList.toggle("busy", busy);
    msg.textContent = [note, locked ? `Trop d'essais : nouvel essai possible dans ${waitText(left)}.` : ""].filter(Boolean).join(" ");
    msg.hidden = !msg.textContent;
    if (locked && !timer) timer = setInterval(paint, 1000);
    if (!locked && timer) {
      clearInterval(timer);
      timer = 0;
    }
  }
  function reveal() {
    if (!screen.hidden) return;
    screen.hidden = false;
    document.body.classList.add("locked");
    scrollTo({ top: 0 });
    paint();
    input.focus();
  }
  function hide() {
    screen.hidden = true;
    document.body.classList.remove("locked");
    input.value = ""; // never kept
    note = "";
    paint();
  }

  /** Logs in with `password`: true once in; else the note says why. */
  async function enter(password) {
    busy = true;
    paint();
    let ok = false;
    try {
      const r = await logIn(password);
      ok = r.ok;
      note = ok || r.locked ? "" : "Mot de passe incorrect.";
      if (r.retryAfter) until = Date.now() + r.retryAfter * 1000;
    } catch {
      note = "Le contrôleur ne répond pas : réessayez dans un instant.";
    }
    busy = false;
    if (ok) {
      hide();
      onLogin();
    } else paint();
    return ok;
  }
  /** A login the page starts on its own: the screen, with what went wrong, if it fails. */
  async function enterOrAsk(password) {
    const ok = await enter(password);
    if (!ok) reveal();
    return ok;
  }
  /** Runs `job` (resolving true once logged in); a 401 meanwhile waits for it rather than flashing the screen. */
  function guarded(job) {
    const p = job();
    pending = p;
    p.catch(() => false).then((ok) => {
      if (pending === p) pending = null;
      if (!ok && wanted) reveal();
      wanted = false;
    });
    return p;
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!busy && !button.disabled) enter(input.value);
  });
  input.addEventListener("input", () => {
    if (!note) return;
    note = "";
    paint();
  });
  $("loginEye").addEventListener("click", (ev) => {
    const b = ev.currentTarget, show = input.type === "password";
    input.type = show ? "text" : "password";
    b.innerHTML = icon(show ? "eye-off" : "eye");
    b.title = show ? "Masquer" : "Afficher";
  });

  return {
    get shown() {
      return !screen.hidden;
    },
    /** The controller wants a login. */
    show() {
      if (pending) wanted = true;
      else reveal();
    },
    /** `write` sets the Page Password, which ends every session: then logs in with it. `write`'s error is thrown. */
    changePassword: (write, password) => guarded(async () => {
      await write();
      return enterOrAsk(password);
    }),
    /** « Se déconnecter »: this browser's session ends, and the screen asks for the password. */
    async logOut() {
      await postLogout();
      onLogout();
      reveal();
    },
  };
}
