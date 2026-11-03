/*
 * HEROS — sessão Google guardada no Cloudflare.
 *
 * O site continua a ser servido como ficheiros estáticos; este Worker só responde a /auth/*.
 * Com o "client secret" do Google guardado como segredo do Worker (GOOGLE_CLIENT_SECRET),
 * troca o código de autorização por um refresh token e guarda-o cifrado num cookie HttpOnly.
 * Assim o site obtém acessos novos sem pedir nada ao utilizador, durante 7 dias.
 *
 *   POST /auth/exchange  { code }  → entra (guarda a sessão) e devolve um acesso
 *   POST /auth/token               → devolve um acesso novo a partir da sessão guardada
 *   POST /auth/logout              → revoga a sessão no Google e apaga o cookie
 *   POST /auth/me                  → dados do emitente da fatura (segredo EMITENTE), só com sessão
 */
const SESSION_DAYS = 7;
const COOKIE = "__Host-hs_s";
const MAX_AGE = SESSION_DAYS * 86400;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/auth/")) return env.ASSETS.fetch(req);

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "not_configured" }, 503);
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    // só aceita pedidos do próprio site (proteção contra pedidos forjados de outras páginas)
    if (req.headers.get("Origin") !== url.origin) return json({ error: "forbidden" }, 403);
    const site = req.headers.get("Sec-Fetch-Site");
    if (site && site !== "same-origin") return json({ error: "forbidden" }, 403);

    const key = await sessionKey(env.GOOGLE_CLIENT_SECRET);
    try {
      if (url.pathname === "/auth/exchange") return await exchange(req, env, key);
      if (url.pathname === "/auth/token") return await refresh(req, env, key);
      if (url.pathname === "/auth/logout") return await logout(req, key);
      if (url.pathname === "/auth/me") return await me(req, env, key);
    } catch (e) {
      return json({ error: "server_error" }, 500);
    }
    return json({ error: "not_found" }, 404);
  },
};

async function exchange(req, env, key) {
  if (!(req.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "bad_request" }, 400);
  let body = {};
  try { body = await req.json(); } catch (_) {}
  if (!body.code || typeof body.code !== "string" || body.code.length > 512) return json({ error: "bad_request" }, 400);
  const g = await google({
    code: body.code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: "postmessage", grant_type: "authorization_code",
  });
  if (!g.access_token) return json({ error: "google_refused", detail: g.error || "" }, 401);
  // sem refresh token o Google não deixa renovar: o site pede o consentimento outra vez
  if (!g.refresh_token) return json({ error: "no_refresh_token" }, 409);
  const iat = Date.now();
  const cookie = await seal({ rt: g.refresh_token, iat }, key);
  return json({ access_token: g.access_token, expires_in: g.expires_in, until: iat + MAX_AGE * 1000 }, 200, setCookie(cookie, MAX_AGE));
}

async function refresh(req, env, key) {
  const s = await open(readCookie(req), key);
  if (!s || !s.rt || Date.now() - s.iat > MAX_AGE * 1000) return json({ error: "no_session" }, 401, setCookie("", 0));
  const g = await google({
    refresh_token: s.rt, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token",
  });
  if (!g.access_token) {
    if (g.error === "invalid_grant") return json({ error: "no_session" }, 401, setCookie("", 0));
    return json({ error: "google_unavailable" }, 502);
  }
  return json({ access_token: g.access_token, expires_in: g.expires_in, until: s.iat + MAX_AGE * 1000 });
}

async function me(req, env, key) {
  const s = await open(readCookie(req), key);
  if (!s || !s.rt || Date.now() - s.iat > MAX_AGE * 1000) return json({ error: "no_session" }, 401);
  let data = null;
  try { data = env.EMITENTE ? JSON.parse(env.EMITENTE) : null; } catch (_) {}
  return json({ me: data });
}

async function logout(req, key) {
  const s = await open(readCookie(req), key);
  if (s && s.rt) {
    try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: s.rt }) }); } catch (_) {}
  }
  return json({ ok: true }, 200, setCookie("", 0));
}

async function google(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
  });
  try { return await r.json(); } catch (_) { return { error: "bad_response" }; }
}

// ---------- cookie cifrado (AES-GCM com chave derivada do client secret) ----------
async function sessionKey(secret) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("heros"), info: new TextEncoder().encode("session-cookie-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function seal(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, iv.length);
  return b64url(all);
}
async function open(token, key) {
  if (!token) return null;
  try {
    const all = unb64url(token);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (_) { return null; }
}
function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function readCookie(req) {
  const m = /(?:^|;\s*)__Host-hs_s=([^;]+)/.exec(req.headers.get("Cookie") || "");
  return m ? m[1] : "";
}
function setCookie(value, maxAge) {
  return { "Set-Cookie": COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge };
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cross-Origin-Resource-Policy": "same-origin" }, headers),
  });
}
