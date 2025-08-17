// app.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true })); // aceita x-www-form-urlencoded

/* ========= uTalk (fixo) ========= */
const TALK_BASE = "https://app-utalk.umbler.com/api";
const TALK_TOKEN = "MIX-2025-08-16-2093-09-04--221DC8E176B98A8DB9D7BC972F78591F45BAFCB679D88B1CC63E0CFE003A5D84"; // sem "Bearer "
const TALK_ORG_ID = "aF3zZgwcLc4qDRuo";
const TALK_FROM_PHONE = "+5573981731354";
const authHeader = () => `Bearer ${(TALK_TOKEN || "").replace(/^Bearer\s+/i, "").trim()}`;

/* ========= Defaults antigos (mantidos p/ compat) ========= */
const IPTV4K_VALIDATE_URL_TEMPLATE =
  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";
const IPTV4K_UPLOAD_URL_TEMPLATE =
  process.env.IPTV4K_UPLOAD_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/playlist_with_mac";
const IPTV4K_UPLOAD_URL_ALT =
  process.env.IPTV4K_UPLOAD_URL_ALT ||
  "https://iptv-4k.live/api/playlist_with_mac";

/* ========= M3U base (aptxu) ========= */
const M3U_BASE_DEFAULT   = process.env.M3U_BASE_DEFAULT   || "http://aptxu.com/get.php";
const M3U_TYPE_DEFAULT   = process.env.M3U_TYPE_DEFAULT   || "m3u_plus";
const M3U_OUTPUT_DEFAULT = process.env.M3U_OUTPUT_DEFAULT || "hls";

/* ========= Timeouts/Retry ========= */
const VALIDATE_TIMEOUT_MS = parseInt(process.env.IPTV_VALIDATE_TIMEOUT || "8000", 10);
const UPLOAD_TIMEOUT_MS   = parseInt(process.env.IPTV_UPLOAD_TIMEOUT   || "25000", 10);
const UPLOAD_RETRIES      = parseInt(process.env.IPTV_UPLOAD_RETRIES   || "2", 10);

/* ========= Nome padrão exibido ========= */
const IPTV_UPLOAD_NAME_DEFAULT = process.env.IPTV_UPLOAD_NAME_DEFAULT || "MixTV";

/* ========= Circuit breaker simples ========= */
const SAFE_MODE_STRICT = (process.env.SAFE_MODE_STRICT || "true").toLowerCase() === "true";
const UPLOAD_BREAKER_THRESHOLD   = parseInt(process.env.UPLOAD_BREAKER_THRESHOLD   || "3", 10);
const UPLOAD_BREAKER_WINDOW_MS   = parseInt(process.env.UPLOAD_BREAKER_WINDOW_MS   || "60000", 10);
const UPLOAD_BREAKER_COOLDOWN_MS = parseInt(process.env.UPLOAD_BREAKER_COOLDOWN_MS || "120000", 10);
let uploadBreaker = { failures: [], openUntil: 0 };
function breakerAllow() { return Date.now() >= uploadBreaker.openUntil; }
function breakerReport(ok) {
  const now = Date.now();
  uploadBreaker.failures = uploadBreaker.failures.filter(ts => now - ts <= UPLOAD_BREAKER_WINDOW_MS);
  if (ok) { uploadBreaker.failures = []; return; }
  uploadBreaker.failures.push(now);
  if (uploadBreaker.failures.length >= UPLOAD_BREAKER_THRESHOLD) {
    uploadBreaker.openUntil = now + UPLOAD_BREAKER_COOLDOWN_MS;
    uploadBreaker.failures = [];
    console.log("upload breaker: OPEN until", new Date(uploadBreaker.openUntil).toISOString());
  }
}

const PORT = parseInt(process.env.PORT || "8080", 10);

/* ========= Helpers ========= */
function normalizeMac(input) {
  const hex = (String(input || "").match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(":");
}
const e164BR = (n) => {
  const d = String(n || "").replace(/\D/g, "");
  return d.startsWith("55") ? `+${d}` : `+55${d}`;
};
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildM3UFromFields({ base = M3U_BASE_DEFAULT, username, password, type = M3U_TYPE_DEFAULT, output = M3U_OUTPUT_DEFAULT }) {
  if (!username || !password) return null;
  const qs = new URLSearchParams({ username, password, type, output });
  return `${base}?${qs.toString()}`;
}
function normalizeWebhookKeys(body = {}) {
  const out = { ...body };
  // credenciais: o Worker/Sigma manda para cá
  if (!out.username && body.usuario) out.username = body.usuario;
  if (!out.password && (body.senha || body.pass)) out.password = body.senha || body.pass;

  // MAC
  out.mac = out.mac || body.mac || body.mac_address || body.endereco_mac || body.device_mac || body.m;

  // telefone opcional
  if (!out.reply_to && body.telefone) out.reply_to = body.telefone;

  // aceitar chatId de várias chaves
  out.chatId = out.chatId
    || body.chatId
    || body?.Conversa?.Id
    || body?.Chat?.Id
    || body?.Payload?.Chat?.Id
    || body?.Contato?.ChatID
    || body?.contato?.ChatID
    || body?.chat_id;

  // nome exibido
  if (!out.displayName && body.servidor) out.displayName = String(body.servidor);
  if (!out.displayName && body.app) out.displayName = String(body.app);
  return out;
}

/* ========= Headers estilo “site” ========= */
const BROWSER_HEADERS = {
  accept: "application/json",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7,gl;q=0.6",
  "cache-control": "no-cache",
  origin: "https://iptv-4k.live",
  pragma: "no-cache",
  referer: "https://iptv-4k.live/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
};

/* ========= Multi-provedor (sem default) ========= */
const PROVIDER_HOSTS = {
  "iptv 4k": "iptv-4k.live",
  "4k": "iptv-4k.live",
  "iptv player io": "iptvplayer.io",
  "playerio": "iptvplayer.io",
  "ottplayer": "simpletv.live",
  "simpletv": "simpletv.live",
  "tiviplayer iptv": "tiviplayer.io",
  "tiviplayer": "tiviplayer.io",
  "i player": "i-player.live",
  "iplayer": "i-player.live",
  "iptv+": "iptvpluseplayer.live",
  "iptv plus": "iptvpluseplayer.live",
  "iptv pro player": "iptvproplayer.live",
  "iptv star player": "iptv-star.live",
  "iptv next player": "iptvnext.live",
  "play iptv": "tiviplayer.io"
};
const REQUIRE_PROVIDER = (process.env.REQUIRE_PROVIDER || "true").toLowerCase() === "true";

function _sanitizeHost(h) {
  return String(h || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}
function _mapAppToHost(appLike = "") {
  const key = String(appLike).trim().toLowerCase();
  return key && PROVIDER_HOSTS[key] ? PROVIDER_HOSTS[key] : null;
}
function _pickHostFromBody(body = {}) {
  const explicit = body.host || body.uploadHost || body.domain || body.appDomain;
  if (explicit) return _sanitizeHost(explicit);
  const mapped = _mapAppToHost(body.app || body.servidor || body.provider || body.brand);
  if (mapped) return mapped;
  return null; // sem default
}
function buildProviderEndpoints(body = {}) {
  const chosenHost = _pickHostFromBody(body);

  if (!chosenHost && REQUIRE_PROVIDER) {
    return { error: "NO_PROVIDER" };
  }

  const fallbacks = (process.env.UPLOAD_HOST_FALLBACKS || "")
    .split(",")
    .map(_sanitizeHost)
    .filter(Boolean);

  const hosts = chosenHost ? [chosenHost, ...fallbacks] : fallbacks;

  const validateTemplates = hosts.map(h => `https://${h}/api/validate_mac?mac={mac}`);
  const uploadEndpoints   = hosts.map(h => `https://${h}/api/playlist_with_mac`);

  const displayName = body?.displayName || body?.name || body?.app || IPTV_UPLOAD_NAME_DEFAULT;

  return { validateTemplates, uploadEndpoints, displayName, chosenHost };
}

/* ========= uTalk ========= */
async function talkSend({ toContactId, fromChannelId, chatId, toPhone, message }) {
  if (!TALK_TOKEN) { console.error("talkSend: faltando TALK_API_TOKEN"); return; }

  const base = { OrganizationId: TALK_ORG_ID, Message: message };

  let body = null;
  if (toContactId || fromChannelId) {
    body = { ...base, FromPhone: TALK_FROM_PHONE };
    if (toContactId)   body.ToContactId   = toContactId;
    if (fromChannelId) body.FromChannelId = fromChannelId;
  } else if (chatId) {
    body = { ...base, ChatId: chatId, FromPhone: TALK_FROM_PHONE };
  } else if (toPhone) {
    body = { ...base, ToPhone: e164BR(toPhone), FromPhone: TALK_FROM_PHONE };
  }
  if (!body) { console.warn("talkSend: sem destino (id/chat/phone)"); return; }

  try {
    const r = await axios.post(`${TALK_BASE}/v1/messages/simplified`, body,
      { headers: { Authorization: authHeader(), "Content-Type": "application/json", Accept: "application/json" },
        timeout: 15000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300) { console.log("talkSend OK ->", r.status); return; }
    const errTxt = typeof r.data === "string" ? r.data : JSON.stringify(r.data || {});
    throw new Error(`send failed: ${r.status} ${errTxt.slice(0,300)}`);
  } catch (e) {
    const st = e?.response?.status, bd = e?.response?.data;
    console.warn("uTalk erro:", st ?? "-", typeof bd === "string" ? bd : JSON.stringify(bd || e.message));
  }
}

/* ========= Validação MAC ========= */
function decideValidateState(status, data) {
  if (status === 404) return "invalid";
  const txt = typeof data === "string" ? data : JSON.stringify(data || "");
  if (status === 500 && /"mac"\s*length\s*must\s*be\s*17/i.test(txt)) return "invalid";
  if (status >= 200 && status < 300) {
    if (/<!doctype|<html/i.test(txt)) return "unknown";
    if (data && data.error === false && (data?.message?.mac || data?.message?.id)) return "valid";
    const yes = data === true || data === 1 || data?.valid === true || data?.ok === true || data?.exists === true || data?.success === true ||
      String(data?.status || "").toLowerCase() === "valid" || String(data?.result || "").toLowerCase() === "valid" ||
      /\b(ok|true|válido|valido|success)\b/i.test(txt);
    if (yes) return "valid";
    const no = data === false || data === 0 || data?.valid === false || data?.ok === false || data?.exists === false || data?.success === false ||
      /\b(invalid|inválid|nao\s*encontrado|não\s*encontrado|not\s*found)\b/i.test(txt);
    if (no) return "invalid";
    return "unknown";
  }
  return "unknown";
}
async function validateMacDetailed(mac17, validateTemplatesOpt) {
  const templates = (validateTemplatesOpt && validateTemplatesOpt.length)
    ? validateTemplatesOpt
    : [IPTV4K_VALIDATE_URL_TEMPLATE];

  let last = { state: "unknown", status: 0, snippet: "" };

  for (const tpl of templates) {
    const url = fill(tpl, { mac: mac17 });
    try {
      const r = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: VALIDATE_TIMEOUT_MS,
        validateStatus: () => true
      });
      const snippet = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const state = decideValidateState(r.status, r.data);
      console.log("validateMac:", url, "->", state, "status:", r.status);
      last = { state, status: r.status, snippet };

      // para no primeiro resultado conclusivo (valid/invalid) ou em 2xx/404
      if (state !== "unknown" || r.status === 404 || (r.status >= 200 && r.status < 300)) {
        return last;
      }
    } catch (e) {
      last = { state: "unknown", status: 0, snippet: e.message };
    }
  }
  return last;
}
async function validateMacQuick(mac17, timeoutMs = 5000) {
  const url = fill(IPTV4K_VALIDATE_URL_TEMPLATE, { mac: mac17 });
  try {
    const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: timeoutMs, validateStatus: () => true });
    return { state: decideValidateState(r.status, r.data), status: r.status };
  } catch (e) {
    return { state: "unknown", status: 0, error: e.message };
  }
}

/* ========= Upload ========= */
function looksOk(body) {
  if (body && typeof body === "object") {
    if ("error"   in body) return body.error   === false;
    if ("success" in body) return body.success === true;
    if ("ok"      in body) return body.ok      === true;
    if (body.message && typeof body.message === "object") {
      if ("id" in body.message || "url" in body.message) return true;
    }
    return false;
  }
  const txt = String(typeof body === "string" ? body : JSON.stringify(body || "")).toLowerCase();
  if (/(error|erro|fail|falha|invalid|inválid|not\s*ok|nao\s*ok|não\s*ok)/.test(txt)) return false;
  return /\b(ok|success|enviado|enviada|atualizado|atualizada|uploaded|created|update\s*ok)\b/.test(txt);
}
function shouldRetry(status, msg) {
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  if (!status && /ECONNABORTED|timeout|aborted|Network Error|socket hang up/i.test(msg || "")) return true;
  return false;
}
async function postMultipart({ endpoint, mac, url, name }) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const fd = new FormData();
    fd.append("name", name ?? "");
    fd.append("mac", String(mac || "").toLowerCase());
    fd.append("url", url);
    const res = await fetch(endpoint, { method: "POST", headers: BROWSER_HEADERS, body: fd, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    const ok = res.ok && looksOk(json);
    console.log("upload MULTIPART:", res.status, ok, text.slice(0, 200));
    return { ok, status: res.status, raw: json };
  } catch (e) {
    console.log("upload multipart error:", e.message);
    return { ok: false, status: 0, raw: e.message };
  } finally {
    clearTimeout(to);
  }
}
async function postFormURLEncoded({ endpoint, mac, url, name }) {
  try {
    const body = new URLSearchParams({ mac: String(mac).toLowerCase(), url, name }).toString();
    const r = await axios.post(endpoint, body, { headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: UPLOAD_TIMEOUT_MS, validateStatus: () => true });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload FORM:", r.status, ok, (typeof r.data === "string" ? r.data : JSON.stringify(r.data)).slice(0, 200));
    return { ok, status: r.status, raw: r.data };
  } catch (e) {
    return { ok: false, status: 0, raw: e.message };
  }
}
async function postJSON({ endpoint, mac, url, name }) {
  try {
    const r = await axios.post(endpoint, { mac: String(mac).toLowerCase(), url, name }, { headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" }, timeout: UPLOAD_TIMEOUT_MS, validateStatus: () => true });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload JSON:", r.status, ok, (typeof r.data === "string" ? r.data : JSON.stringify(r.data)).slice(0, 200));
    return { ok, status: r.status, raw: r.data };
  } catch (e) {
    return { ok: false, status: 0, raw: e.message };
  }
}
async function uploadPlaylist({ mac, url, name, endpoints }) {
  const endpointsList = (endpoints && endpoints.length)
    ? endpoints
    : [IPTV4K_UPLOAD_URL_TEMPLATE, IPTV4K_UPLOAD_URL_ALT];

  let last = { ok: false, status: 0, raw: "no-attempt" };
  for (const ep of endpointsList) {
    for (let i = 0; i <= UPLOAD_RETRIES; i++) {
      const r = await postMultipart({ endpoint: ep, mac, url, name });
      if (r.ok) return r;
      last = r; if (!shouldRetry(r.status, String(r.raw || ""))) break; await sleep(600 * (i + 1));
    }
    for (let i = 0; i <= UPLOAD_RETRIES; i++) {
      const r = await postFormURLEncoded({ endpoint: ep, mac, url, name });
      if (r.ok) return r;
      last = r; if (!shouldRetry(r.status, String(r.raw || ""))) break; await sleep(600 * (i + 1));
    }
    for (let i = 0; i <= UPLOAD_RETRIES; i++) {
      const r = await postJSON({ endpoint: ep, mac, url, name });
      if (r.ok) return r;
      last = r; if (!shouldRetry(r.status, String(r.raw || ""))) break; await sleep(600 * (i + 1));
    }
  }
  return last;
}
async function uploadPlaylistQuick({ mac, url, name, timeoutMs = 10000 }) {
  try {
    const fd = new FormData();
    fd.append("name", name ?? "");
    fd.append("mac", String(mac || "").toLowerCase());
    fd.append("url", url);
    const res = await fetch(IPTV4K_UPLOAD_URL_TEMPLATE, { method: "POST", headers: BROWSER_HEADERS, body: fd, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok && looksOk(json), status: res.status, body: json };
  } catch (e) {
    return { ok: false, status: 0, body: e.message };
  }
}

/* ========= ENDPOINT SÍNCRONO (retorna sucesso/falha) =========
 * Entrada: { mac, usuario/senha OU username/password, [reply_to], [chatId], [app|host], [displayName], [type], [output] }
 * OBS: NÃO aceita URL M3U pronta — sempre monta a partir de user/pass.
 */
app.post("/gerar-link-sync", async (req, res) => {
  const body = normalizeWebhookKeys(req.body || {});
  const macNorm = normalizeMac(body.mac);
  const reply_to_phone = body.reply_to;
  const reply_to_chat  = body.chatId;

  if (!macNorm) return res.status(400).json({ ok: false, error: "NO_MAC" });

  const prov = buildProviderEndpoints(body);
  if (prov.error === "NO_PROVIDER") {
    return res.status(400).json({
      ok: false,
      error: "NO_PROVIDER",
      message: "Informe 'app' (ex.: OttPlayer) ou 'host' (ex.: simpletv.live) no payload."
    });
  }
  const { validateTemplates, uploadEndpoints, displayName } = prov;

  // OBRIGATÓRIO: montar M3U com user+pass
  const m3u = buildM3UFromFields({
    username: body.username,
    password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT,
    output: body?.output || M3U_OUTPUT_DEFAULT
  });
  if (!m3u) return res.status(400).json({ ok: false, error: "NO_M3U", message: "Credenciais ausentes para montar a M3U." });

  const v = await validateMacDetailed(macNorm, validateTemplates);
  if (v.state === "invalid") {
    return res.json({ ok: false, reason: "INVALID_MAC", validate: { state: v.state, status: v.status } });
  }
  if (SAFE_MODE_STRICT && !breakerAllow()) {
    return res.json({ ok: false, reason: "BREAKER_OPEN" });
  }

  const name = String(displayName || "").slice(0, 64);
  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: uploadEndpoints });
  breakerReport(up.status >= 200 && up.status < 300);
  const success = up.ok && up.status === 200;

  let notify = { attempted: false };
  if (success && (reply_to_phone || reply_to_chat)) {
    try {
      await talkSend({
        chatId: reply_to_chat,
        toPhone: reply_to_phone,
        message: "✅ Serviço incluído com sucesso, feche e abra o aplicativo."
      });
      notify = { attempted: true };
    } catch {
      notify = { attempted: true };
    }
  }

  return res.json({
    ok: success,
    validate: { state: v.state, status: v.status },
    upload:   { status: up.status, ok: up.ok },
    notify
  });
});

/* ========= ENDPOINT ASSÍNCRONO (responde ok:true) =========
 * Entrada: { mac, usuario/senha OU username/password, [reply_to], [chatId], [app|host], [displayName], [type], [output] }
 * OBS: NÃO aceita URL M3U pronta — sempre monta a partir de user/pass.
 */
app.post("/gerar-link", async (req, res) => {
  const body = normalizeWebhookKeys(req.body || {});
  const macNorm = normalizeMac(body.mac);

  const reply_to_phone = body.reply_to;
  const reply_to_chat  = body.chatId;
  const toContactId    = body.toContactId || body.contatoId || body.contactId;
  const fromChannelId  = body.fromChannelId || body.canalId || body.channelId;

  if (!macNorm)  return res.status(400).json({ ok: false, error: "NO_MAC" });

  const prov = buildProviderEndpoints(body);
  if (prov.error === "NO_PROVIDER") {
    return res.status(400).json({
      ok: false,
      error: "NO_PROVIDER",
      message: "Informe 'app' (ex.: OttPlayer) ou 'host' (ex.: simpletv.live) no payload."
    });
  }
  const { validateTemplates, uploadEndpoints, displayName } = prov;

  const m3u = buildM3UFromFields({
    username: body.username,
    password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT,
    output: body?.output || M3U_OUTPUT_DEFAULT
  });
  if (!m3u) return res.status(400).json({ ok: false, error: "NO_M3U", message: "Credenciais ausentes para montar a M3U." });

  res.json({ ok: true });

  (async () => {
    const v = await validateMacDetailed(macNorm, validateTemplates);
    const name = String(displayName || "").slice(0, 64);

    if (v.state === "invalid") return;
    if (SAFE_MODE_STRICT && !breakerAllow()) return;

    const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: uploadEndpoints });
    breakerReport(up.ok);

    const success = up.ok && up.status === 200;
    if (success && (reply_to_phone || reply_to_chat)) {
      await talkSend({
        toContactId, fromChannelId, chatId: reply_to_chat, toPhone: reply_to_phone,
        message: "✅ Serviço incluído com sucesso, feche e abra o aplicativo."
      });
    }
  })().catch(err => console.error("bg_task_error:", err?.message));
});

/* ========= Utilitários ========= */
app.post("/_talk", async (req, res) => {
  try {
    const msg = req.body.message || "✅ Teste de envio (server)";
    await talkSend({
      toContactId: req.body.toContactId,
      fromChannelId: req.body.fromChannelId,
      chatId: req.body.chatId,
      toPhone: req.body.to,
      message: msg
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.post("/_probe", async (req, res) => {
  const body = normalizeWebhookKeys(req.body || {});
  const macNorm = normalizeMac(body.mac || "");
  const prov = buildProviderEndpoints(body);
  if (prov.error === "NO_PROVIDER") {
    return res.status(400).json({ ok: false, error: "NO_PROVIDER", message: "Informe 'app' ou 'host'." });
  }
  const { validateTemplates, uploadEndpoints, displayName } = prov;

  // probe também exige user+pass (sem URL direta)
  const m3u = buildM3UFromFields({
    username: body.username,
    password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT,
    output: body?.output || M3U_OUTPUT_DEFAULT
  });
  const name = String(displayName || "").slice(0, 64);

  if (!macNorm || !m3u) return res.status(400).json({ ok: false, error: "need mac + user/pass" });

  const v = await validateMacDetailed(macNorm, validateTemplates);
  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: uploadEndpoints });

  res.json({
    ok: true,
    mac: macNorm,
    validate: { state: v.state, status: v.status, snippet: String(v.snippet || "").slice(0, 400) },
    upload:   { ok: up.ok, status: up.status, snippet: String(typeof up.raw === "string" ? up.raw : JSON.stringify(up.raw || {})).slice(0, 400) }
  });
});

app.get("/_healthz", (_, res) => res.json({ ok: true }));
app.get("/_readyz",  (_, res) => {
  const missing = [];
  if (!TALK_ORG_ID) missing.push("TALK_ORG_ID");
  if (!TALK_FROM_PHONE) missing.push("TALK_FROM_PHONE");
  if (!TALK_TOKEN) missing.push("TALK_API_TOKEN (apenas necessário para enviar WhatsApp)");
  res.json({ ok: missing.length === 0, missing });
});
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/_utalk_whoami", async (req, res) => {
  try {
    const r = await axios.get(`${TALK_BASE}/v1/member/me`, {
      headers: { Authorization: authHeader(), Accept: "application/json" },
      timeout: 10000, validateStatus: () => true
    });
    res.json({
      status: r.status,
      token_len: (TALK_TOKEN||"").length,
      token_prefix: (TALK_TOKEN||"").slice(0,8),
      token_suffix: (TALK_TOKEN||"").slice(-8),
      org: TALK_ORG_ID,
      from: TALK_FROM_PHONE
    });
  } catch (e) { res.status(500).json({ ok:false, err: e.message }); }
});

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
