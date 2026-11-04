/*
 * HEROS. (antes Bezerra) — versão independente (sem Claude).
 * Substitui as funções que a app usa dentro do Claude por serviços Google:
 *   - dados (horas, fatura, etiquetas) → um ficheiro privado no Google Drive (pasta da app)
 *   - agenda → Google Calendar API, com o login Google do próprio utilizador
 *   - downloads → download normal do navegador
 * A app (index.html) chama window.claude.use("db" | "mcp" | "downloads") como no Claude;
 * este ficheiro responde a essas chamadas.
 */
(function () {
  "use strict";
  const CFG = window.BEZERRA_CONFIG || {};
  const CLIENT_ID = String(CFG.googleClientId || "").trim();
  const SCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events";
  const FILE_NAME = "heros-dados.json";
  const CACHE_KEY = "bz-cache";
  const REMEMBER_KEY = "bz-remember", REMEMBER_DAYS = 7;

  // ---------- sessão Google ----------
  let token = null, tokenExp = 0, tokenClient = null, pendingToken = null;
  // lembrar a entrada durante 7 dias (o acesso do Google dura 1 hora e renova-se sem pedir a conta)
  let remember = null;
  try { const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null"); if (r && r.until > Date.now()) remember = r; else localStorage.removeItem(REMEMBER_KEY); } catch (_) {}
  try {
    const t = JSON.parse(localStorage.getItem("bz-token") || sessionStorage.getItem("bz-token") || "null");
    if (remember && t && t.exp > Date.now() + 60000) { token = t.v; tokenExp = t.exp; }
  } catch (_) {}
  function saveRemember(hint) {
    remember = { until: Date.now() + REMEMBER_DAYS * 864e5, hint: hint || (remember && remember.hint) || "" };
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(remember)); } catch (_) {}
  }
  // authed: há sessão Google · ready: dados do Drive carregados
  let resolveAuthed; const authed = new Promise((r) => { resolveAuthed = r; });
  let resolveReady; const ready = new Promise((r) => { resolveReady = r; });

  function gisLoaded() { return window.google && google.accounts && google.accounts.oauth2; }
  function initClient() {
    if (tokenClient || !gisLoaded() || !CLIENT_ID) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: (resp) => {
        const p = pendingToken; pendingToken = null;
        if (resp && resp.access_token) {
          token = resp.access_token; tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          try { localStorage.setItem("bz-token", JSON.stringify({ v: token, exp: tokenExp })); } catch (_) {}
          if (p) p.resolve(token);
        } else if (p) p.reject(new Error((resp && resp.error) || "login"));
      },
      error_callback: (e) => { const p = pendingToken; pendingToken = null; if (p) p.reject(new Error((e && e.type) || "login")); },
    });
  }
  function login(silent) {
    initClient();
    if (!tokenClient) return Promise.reject(new Error("gis"));
    return new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
      const o = { prompt: silent ? "" : "select_account" };
      if (remember && remember.hint) { o.login_hint = remember.hint; o.hint = remember.hint; }
      tokenClient.requestAccessToken(o);
    });
  }
  const hasToken = () => token && tokenExp > Date.now() + 30000;
  function setToken(resp) {
    token = resp.access_token; tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    try { localStorage.setItem("bz-token", JSON.stringify({ v: token, exp: tokenExp })); } catch (_) {}
  }

  // ---------- sessão guardada no Cloudflare (worker.js) ----------
  // Com o servidor configurado, o acesso renova-se sozinho durante 7 dias, sem janelas nem toques.
  // Sem servidor (por exemplo noutro alojamento), fica o modo de cima, com o toque de hora a hora.
  let serverAuth = null; // null: por saber · true: o servidor guarda a sessão · false: não há servidor
  let serverRefresh = null;
  function serverToken() {
    if (serverRefresh) return serverRefresh;
    serverRefresh = (async () => {
      let r;
      try { r = await fetch("/auth/token", { method: "POST", credentials: "same-origin" }); }
      catch (_) { return { ok: false, net: true }; }
      if (r.status === 200) {
        const j = await r.json(); setToken(j); serverAuth = true;
        keepServerSession(j.until); showMode();
        return { ok: true };
      }
      if (r.status === 401) {
        serverAuth = true; token = null; tokenExp = 0;
        try { localStorage.removeItem("bz-token"); localStorage.removeItem(REMEMBER_KEY); } catch (_) {}
        return { ok: false };
      }
      if (r.status === 502) { serverAuth = true; return { ok: false, net: true }; }
      serverAuth = false; return { ok: false };
    })().finally(() => { serverRefresh = null; });
    return serverRefresh;
  }
  // lembra no aparelho até quando vale a sessão (para abrir sem rede com os dados guardados)
  function keepServerSession(until) {
    remember = { until, hint: (remember && remember.hint) || "", server: true };
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(remember)); } catch (_) {}
  }
  // entrada com código de autorização: o Worker troca-o pela sessão de 7 dias
  let codeClient = null, pendingCode = null;
  function codeLogin() {
    if (!gisLoaded()) return Promise.reject(new Error("gis"));
    if (!codeClient) codeClient = google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID, scope: SCOPES, ux_mode: "popup",
      callback: (resp) => { const p = pendingCode; pendingCode = null; if (!p) return; if (resp && resp.code) p.resolve(resp.code); else p.reject(new Error((resp && resp.error) || "login")); },
      error_callback: (e) => { const p = pendingCode; pendingCode = null; if (p) p.reject(new Error((e && e.type) || "login")); },
    });
    return new Promise((resolve, reject) => { pendingCode = { resolve, reject }; codeClient.requestCode(); }).then(async (code) => {
      const r = await fetch("/auth/exchange", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) { setToken(j); keepServerSession(j.until); showMode(); return token; }
      // o Google já tinha autorizado esta app sem sessão longa: retira essa autorização para o próximo toque pedir a completa
      if (r.status === 409) {
        if (j.access_token) try { google.accounts.oauth2.revoke(j.access_token, () => {}); } catch (_) {}
        throw { code: "retry_consent" };
      }
      throw { code: "login_failed" };
    });
  }
  // renovação: com a entrada lembrada, o próximo toque no ecrã pede um acesso novo ao Google sem escolher a conta
  let renewing = null, renewWaiters = [];
  function needToken() {
    if (hasToken()) return Promise.resolve(token);
    if (serverAuth) return serverToken().then((r) => {
      if (r.ok) return token;
      if (r.net) throw { code: "server_unavailable", retryable: true, message: "Sem ligação ao Google" };
      expired(); throw { code: "needs_reauth", message: "Sessão Google terminada" };
    });
    if (!remember) { expired(); return Promise.reject({ code: "needs_reauth", message: "Sessão Google terminada" }); }
    setSync("Toque no ecrã para ligar ao Google");
    return new Promise((resolve, reject) => { renewWaiters.push({ resolve, reject }); });
  }
  function onGesture() {
    if (!renewWaiters.length || renewing || hasToken()) return;
    renewing = login(true).then((t) => {
      setSync("");
      const w = renewWaiters; renewWaiters = []; w.forEach((x) => x.resolve(t));
      afterToken();
    }).catch(() => {
      const w = renewWaiters; renewWaiters = []; w.forEach((x) => x.reject({ code: "needs_reauth", message: "Sessão Google terminada" }));
      expired();
    }).finally(() => { renewing = null; });
  }
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);
  function expired() {
    token = null; tokenExp = 0;
    try { localStorage.removeItem("bz-token"); sessionStorage.removeItem("bz-token"); } catch (_) {}
    showGate("A sessão Google terminou. Entre outra vez para continuar.");
  }
  async function api(url, opts, retried) {
    await authed;
    if (!hasToken()) await needToken();
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + token }, (opts && opts.headers) || {}) })); }
    catch (_) { throw { code: "server_unavailable", retryable: true, message: "Sem ligação à internet" }; }
    if (r.status === 401) { token = null; tokenExp = 0; if ((remember || serverAuth) && !retried) { await needToken(); return api(url, opts, true); } expired(); throw { code: "needs_reauth", message: "Sessão Google terminada" }; }
    if (r.status >= 500) throw { code: "server_unavailable", retryable: true, message: "O Google não respondeu (" + r.status + ")" };
    if (!r.ok) {
      let m = "Erro " + r.status;
      try { const j = await r.json(); m = (j.error && (j.error.message || j.error.status)) || m; } catch (_) {}
      throw { code: "tool_error", message: m };
    }
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }

  // ---------- dados no Google Drive (pasta privada da app) ----------
  let data = { entries: {}, config: {} }, fileId = null, saveT = null, saving = false, dirty = false;
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (c && c.entries) data = c; } catch (_) {}
  const cache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {} };
  async function loadDrive() {
    const q = encodeURIComponent("name='" + FILE_NAME + "'");
    const list = await api("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&q=" + q);
    if (list.files && list.files.length) {
      fileId = list.files[0].id;
      const txt = await api("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media");
      const j = typeof txt === "string" ? JSON.parse(txt || "{}") : txt;
      // alterações feitas antes de ligar ao Drive não se perdem
      data = dirty ? { entries: Object.assign({}, j.entries || {}, data.entries), config: Object.assign({}, j.config || {}, data.config) } : { entries: j.entries || {}, config: j.config || {} };
    } else {
      const boundary = "bz" + Math.random().toString(36).slice(2);
      const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] }) +
        "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(data) + "\r\n--" + boundary + "--";
      const f = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
      fileId = f.id;
    }
    cache();
  }
  function scheduleSave() { dirty = true; cache(); clearTimeout(saveT); saveT = setTimeout(flush, 700); }
  async function flush() {
    if (saving || !dirty || !fileId) return;
    saving = true; dirty = false;
    try {
      await api("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      setSync("");
    } catch (e) {
      dirty = true;
      setSync(e && e.code === "needs_reauth" ? "Por guardar no Drive: entre outra vez." : "Por guardar no Drive: sem ligação. Tenta outra vez sozinho.");
      if (!(e && e.code === "needs_reauth")) { clearTimeout(saveT); saveT = setTimeout(flush, 15000); }
    } finally { saving = false; if (dirty && !saveT) flush(); }
  }
  window.addEventListener("beforeunload", (ev) => { if (dirty) { flush(); ev.preventDefault(); ev.returnValue = ""; } });

  const listeners = new Set();
  const snap = () => ({ docs: Object.keys(data.entries).map((id) => ({ id, exists: true, data: () => data.entries[id] })) });
  const changed = () => { listeners.forEach((f) => { try { f(snap()); } catch (_) {} }); scheduleSave(); };
  const db = {
    collection(name) {
      return {
        onSnapshot(next) { listeners.add(next); next(snap()); return () => listeners.delete(next); },
        doc(id) {
          return {
            set: async (v) => { data.entries[id] = JSON.parse(JSON.stringify(v)); changed(); },
            delete: async () => { delete data.entries[id]; changed(); },
          };
        },
      };
    },
    doc(path) {
      const id = String(path).split("/").pop();
      return {
        get: async () => ({ exists: !!data.config[id], data: () => data.config[id] }),
        set: async (v) => { data.config[id] = JSON.parse(JSON.stringify(v)); scheduleSave(); },
        delete: async () => { delete data.config[id]; scheduleSave(); },
      };
    },
  };

  // ---------- Google Calendar (mesmas chamadas que a app faz dentro do Claude) ----------
  function withOffset(local) {
    if (/[zZ]|[+-]\d\d:\d\d$/.test(local)) return local;
    const [d, t] = local.split("T"), [y, m, dd] = d.split("-").map(Number), [hh, mi] = (t || "00:00").split(":").map(Number);
    const off = -new Date(y, m - 1, dd, hh, mi).getTimezoneOffset(), sg = off >= 0 ? "+" : "-", a = Math.abs(off);
    return d + "T" + (t || "00:00:00") + sg + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
  }
  const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const calendar = {
    async callTool(server, tool, input) {
      input = input || {};
      if (tool === "list_events") {
        const p = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: String(input.pageSize || 250) });
        if (input.startTime) p.set("timeMin", withOffset(input.startTime));
        if (input.endTime) p.set("timeMax", withOffset(input.endTime));
        if (input.timeZone) p.set("timeZone", input.timeZone);
        if (input.pageToken) p.set("pageToken", input.pageToken);
        const r = await api(CAL + "?" + p.toString());
        return { content: [], payload: { events: r.items || [], nextPageToken: r.nextPageToken || "" } };
      }
      if (tool === "create_event") {
        const tz = input.timeZone || undefined, ev = { summary: input.summary };
        if (input.location) ev.location = input.location;
        if (input.description) ev.description = input.description;
        if (input.allDay) { ev.start = { date: input.startTime.slice(0, 10) }; ev.end = { date: input.endTime.slice(0, 10) }; }
        else { ev.start = { dateTime: input.startTime, timeZone: tz }; ev.end = { dateTime: input.endTime, timeZone: tz }; }
        const r = await api(CAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
        return { content: [], payload: r };
      }
      if (tool === "update_event") {
        const tz = input.timeZone || undefined, ev = {};
        if (input.summary != null) ev.summary = input.summary;
        if (input.location != null) ev.location = input.location;
        if (input.description != null) ev.description = input.description;
        if (input.startTime) {
          if (input.allDay) { ev.start = { date: input.startTime.slice(0, 10), dateTime: null }; ev.end = { date: input.endTime.slice(0, 10), dateTime: null }; }
          else { ev.start = { dateTime: input.startTime, timeZone: tz, date: null }; ev.end = { dateTime: input.endTime, timeZone: tz, date: null }; }
        }
        const r = await api(CAL + "/" + encodeURIComponent(input.eventId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
        return { content: [], payload: r };
      }
      if (tool === "delete_event") {
        await api(CAL + "/" + encodeURIComponent(input.eventId), { method: "DELETE" });
        return { content: [], payload: {} };
      }
      throw { code: "bad_request", message: "Ferramenta desconhecida: " + tool };
    },
  };

  // ---------- fotos: ficheiros na pasta privada do Drive ----------
  const photoUrls = new Map();
  const assets = {
    async upload(blob) {
      await ready;
      const boundary = "bz" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name: "foto-" + Date.now() + ".jpg", parents: ["appDataFolder"], mimeType: blob.type || "image/jpeg" });
      const body = new Blob(["--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + boundary + "\r\nContent-Type: " + (blob.type || "image/jpeg") + "\r\n\r\n", blob, "\r\n--" + boundary + "--"]);
      const f = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
      const url = URL.createObjectURL(blob); photoUrls.set(f.id, url);
      return { id: f.id, url, sizeBytes: blob.size, contentType: blob.type };
    },
    async src(id) {
      if (photoUrls.has(id)) return photoUrls.get(id);
      await ready;
      if (!hasToken()) await needToken();
      const r = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?alt=media", { headers: { Authorization: "Bearer " + token } });
      if (!r.ok) throw new Error("foto " + r.status);
      const url = URL.createObjectURL(await r.blob()); photoUrls.set(id, url); return url;
    },
    async delete(id) {
      await api("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id), { method: "DELETE" });
      photoUrls.delete(id);
    },
  };

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data: blobData }) {
      const blob = blobData instanceof Blob ? blobData : new Blob([blobData]);
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { status: "saved" };
    },
  };

  window.claude = {
    use: async (name) => {
      if (name === "downloads") return downloads;
      if (name === "assets") return assets;
      if (name === "mcp") return calendar;
      if (name === "db") { await ready; return db; }
      return null;
    },
  };

  // ---------- ecrã de entrada ----------
  let gate, gateMsg, gateBtn, syncEl, modeEl;
  // indicação discreta de como a sessão está guardada (ajuda a perceber porque pede a entrada)
  function showMode() {
    if (!modeEl || !remember || !remember.until) return;
    const d = new Date(remember.until), dd = String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
    modeEl.textContent = serverAuth ? "Sessão lembrada até " + dd : "Lembrada até " + dd + " · sem servidor: pede um toque de hora a hora";
    modeEl.hidden = false;
  }
  function setSync(t) { if (syncEl) { syncEl.textContent = t; syncEl.hidden = !t; } }
  function showGate(msg) {
    if (!gate) return;
    gateMsg.textContent = msg || "";
    gate.hidden = false; gateBtn.disabled = !CLIENT_ID; gateBtn.focus();
  }
  // depois de ter acesso: carrega o Drive (se ainda não) e guarda o que ficou por guardar
  let loadingDrive = null;
  function afterToken() {
    if (fileId) { if (dirty) flush(); return Promise.resolve(); }
    if (!loadingDrive) loadingDrive = loadDrive().then(() => { listeners.forEach((f) => f(snap())); if (dirty) flush(); setSync(""); })
      .catch(() => { setSync("Não foi possível ler os dados do Drive. Tenta outra vez sozinho."); setTimeout(() => setSync(""), 6000); })
      .finally(() => { loadingDrive = null; });
    return loadingDrive;
  }
  async function enter() {
    gateBtn.disabled = true; gateMsg.textContent = "A entrar…";
    try {
      if (serverAuth) await codeLogin();
      else if (!hasToken()) await login(false);
      resolveAuthed();
      if (!serverAuth) saveRemember();
      showMode();
      if (!serverAuth && !remember.hint) fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: { Authorization: "Bearer " + token } })
        .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.user && j.user.emailAddress) saveRemember(j.user.emailAddress); }).catch(() => {});
      gateMsg.textContent = "A carregar os seus dados…";
      if (!fileId) { await loadDrive(); listeners.forEach((f) => f(snap())); }
      gate.hidden = true; resolveReady();
      if (dirty) flush();
    } catch (e) {
      gateBtn.disabled = false;
      gateMsg.textContent = e && e.code === "retry_consent" ? "Falta um passo: toque outra vez em Entrar com Google e aceite o acesso."
        : e && e.code === "tool_error" ? "O Google recusou: " + e.message : "Não foi possível entrar. Tente outra vez.";
    }
  }

  function build() {
    const css = document.createElement("style");
    css.textContent =
      ".bz-gate{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px));background:var(--bg,#f3f0e8)}" +
      ".bz-card{width:min(400px,100%);background:var(--paper,#fffdf8);color:var(--ink,#1d1c1a);border:1px solid var(--line,#e3ded3);border-radius:12px;box-shadow:var(--shadow-pop,0 18px 40px -22px rgba(29,28,26,.35));padding:34px 28px 26px;display:grid;gap:18px;text-align:center;font-family:var(--body,system-ui,sans-serif)}" +
      ".bz-brand{display:flex;align-items:center;justify-content:center;gap:12px}.bz-brand .mark{width:40px;height:60px}" +
      ".bz-card h1{margin:0;font-family:var(--brand,sans-serif);font-weight:800;font-size:36px;letter-spacing:-.02em;line-height:1}.bz-card h1 b{color:var(--accent,#c2410c)}" +
      ".bz-card p{margin:0;color:var(--muted,#6b675f);font-size:14px;line-height:1.55}" +
      ".bz-go{display:flex;align-items:center;justify-content:center;gap:10px;font:inherit;font-weight:700;font-size:16px;padding:13px 16px;border-radius:8px;border:1px solid var(--ink,#1d1c1a);background:var(--ink,#1d1c1a);color:var(--paper,#fffdf8);cursor:pointer;transition:opacity .15s}" +
      ".bz-go:hover{opacity:.88}.bz-go:active{transform:translateY(1px)}.bz-go:disabled{opacity:.5;cursor:default}" +
      ".bz-go .g{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#fff;flex:none}.bz-go svg{width:17px;height:17px}" +
      ".bz-msg{min-height:1.4em;font-size:13px!important}" +
      ".bz-sync{position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top,0px));z-index:90;background:var(--ink,#1d1c1a);color:var(--paper,#fffdf8);font-size:12.5px;font-weight:700;padding:6px 14px;border-radius:999px}" +
      ".bz-mode{font-size:11.5px;color:var(--muted,#6b675f);align-self:center}.bz-mode[hidden]{display:none}" +
      ".bz-out{font:inherit;font-size:12px;font-weight:700;border:1px solid var(--line,#e3ded3);background:var(--paper,#fffdf8);color:var(--muted,#6b675f);border-radius:999px;padding:5px 12px;cursor:pointer}";
    document.head.appendChild(css);
    gate = document.createElement("div"); gate.className = "bz-gate";
    gate.innerHTML = '<div class="bz-card" role="dialog" aria-labelledby="bz-t"><div class="bz-brand"><svg class="mark" viewBox="3 0 32 48" aria-hidden="true"><g class="m-b2"><polygon points="22.5,21 28.5,21 28.5,27 22.5,27"/></g><g class="m-b1"><rect x="16.5" y="7" width="6" height="36"/><rect x="28.5" y="7" width="6" height="36"/></g><g class="m-pencil"><rect class="m-body" x="5" y="9" width="10" height="29"/><rect class="m-stripe" x="8.3" y="9" width="3.4" height="29"/><rect class="m-eraser" x="5" y="2" width="10" height="6" rx="2.5"/><rect class="m-ferrule" x="5" y="7.5" width="10" height="2.2"/><polygon class="m-wood" points="5,38 15,38 10,47"/><polygon class="m-lead" points="8.3,44 11.7,44 10,47"/></g></svg><h1 id="bz-t">HEROS<b>.</b></h1></div>' +
      '<p>Entre com a sua conta Google. As horas ficam guardadas numa pasta privada do seu Google Drive e a agenda vem do seu Google Calendar.</p>' +
      '<button type="button" class="bz-go" id="bz-go"><span class="g"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg></span>Entrar com Google</button>' +
      '<p class="bz-msg" id="bz-msg" role="status"></p></div>';
    document.body.appendChild(gate);
    gateMsg = gate.querySelector("#bz-msg"); gateBtn = gate.querySelector("#bz-go");
    gateBtn.addEventListener("click", enter);
    syncEl = document.createElement("div"); syncEl.className = "bz-sync"; syncEl.hidden = true; syncEl.setAttribute("role", "status"); document.body.appendChild(syncEl);
    // botão "Sair" junto ao estado
    const st = document.getElementById("status");
    if (st) {
      const out = document.createElement("button"); out.type = "button"; out.className = "bz-out"; out.textContent = "Sair";
      out.addEventListener("click", async () => {
        if (dirty) await flush();
        if (serverAuth) { try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {} }
        try { if (token && gisLoaded()) google.accounts.oauth2.revoke(token, () => {}); } catch (_) {}
        try { sessionStorage.removeItem("bz-token"); localStorage.removeItem("bz-token"); localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(CACHE_KEY); } catch (_) {}
        location.reload();
      });
      st.insertAdjacentElement("afterend", out);
      modeEl = document.createElement("span"); modeEl.className = "bz-mode"; modeEl.hidden = true; out.insertAdjacentElement("afterend", modeEl);
    }
    if (!CLIENT_ID) { showGate("Falta configurar o ID do cliente Google em config.js (veja o LEIA-ME)."); return; }
    gate.hidden = true;
    // sessão guardada no Cloudflare: renova sozinha durante 7 dias; sem servidor, segue o modo antigo
    serverToken().then((r) => {
      if (r.ok || (serverAuth && r.net && remember)) {
        resolveAuthed(); resolveReady();
        const w = setInterval(() => { if (gisLoaded()) { clearInterval(w); initClient(); } }, 200);
        if (r.ok) afterToken(); else setSync("Sem ligação ao Google. Os dados deste aparelho continuam disponíveis.");
        return;
      }
      if (serverAuth) { showGate(""); return; }
      startLocal();
    });
  }
  function startLocal() {
    // entrada lembrada (7 dias): abre logo com os dados guardados no aparelho
    if (remember) {
      gate.hidden = true; resolveAuthed(); resolveReady(); showMode();
      const w = setInterval(() => { if (gisLoaded()) { clearInterval(w); initClient(); } }, 200);
      if (hasToken()) afterToken(); else needToken().catch(() => {});
      return;
    }
    showGate("");
    // já com sessão válida neste separador: entra sem pedir nada
    if (hasToken()) enter();
    else { const w = setInterval(() => { if (gisLoaded()) { clearInterval(w); initClient(); } }, 200); }
  }
  // versão no fundo da página (para confirmar que o aparelho tem a mais recente)
  function showVersion() {
    const meta = document.querySelector('meta[name="bezerra-build"]'); if (!meta) return;
    const v = document.createElement("p"); v.className = "bz-ver"; v.textContent = "Versão " + meta.content.slice(0, 7);
    v.style.cssText = "text-align:center;font-size:11px;color:var(--muted,#888);margin:28px 0 8px;opacity:.7";
    (document.getElementById("app") || document.body).appendChild(v);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { build(); showVersion(); }); else { build(); showVersion(); }
  // versão nova no servidor? recarrega (o iPhone guarda páginas antigas na app do ecrã principal)
  function checkUpdate() {
    const meta = document.querySelector('meta[name="bezerra-build"]'), mine = meta && meta.content;
    if (!mine || !window.fetch) return;
    fetch("index.html?check=" + Date.now(), { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((html) => {
      const m = /name="bezerra-build" content="([^"]+)"/.exec(html);
      if (!m || m[1] === mine) return;
      try { if (sessionStorage.getItem("bz-reloaded") === m[1]) return; sessionStorage.setItem("bz-reloaded", m[1]); } catch (_) {}
      if (dirty) flush().finally(() => location.reload()); else location.reload();
    }).catch(() => {});
  }
  window.addEventListener("load", () => setTimeout(checkUpdate, 1500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
})();
