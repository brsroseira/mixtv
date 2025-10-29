// app.js (Koeb) — AUTO tenta todos, 404 HTML = "unknown" (continua tentando)
// Node 18+

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ========= uTalk ========= */
const TALK_BASE = "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_TOKEN || "MIX-2025-08-16-2093-09-04--221DC8E176B98A8DB9D7BC972F78591F45BAFCB679D88B1CC63E0CFE003A5D84";
const TALK_ORG_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";
const TALK_FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354";
const authHeader = () => `Bearer ${(TALK_TOKEN || "").replace(/^Bearer\s+/i, "").trim()}`;

/* ========= M3U base ========= */
const M3U_BASE_DEFAULT   = process.env.M3U_BASE_DEFAULT   || "http://junkb11.com/get.php";
const M3U_TYPE_DEFAULT   = process.env.M3U_TYPE_DEFAULT   || "m3u_plus";
const M3U_OUTPUT_DEFAULT = process.env.M3U_OUTPUT_DEFAULT || "hls";

/* ========= Timeouts/Retry ========= */
const VALIDATE_TIMEOUT_MS = parseInt(process.env.IPTV_VALIDATE_TIMEOUT || "8000", 10);
const UPLOAD_TIMEOUT_MS   = parseInt(process.env.IPTV_UPLOAD_TIMEOUT   || "25000", 10);
const UPLOAD_RETRIES      = parseInt(process.env.IPTV_UPLOAD_RETRIES   || "2", 10);

/* ========= Nome exibido ========= */
const IPTV_UPLOAD_NAME_DEFAULT = process.env.IPTV_UPLOAD_NAME_DEFAULT || "MixTV";

/* ========= Circuit breaker ========= */
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
  if (!out.username && body.usuario) out.username = body.usuario;
  if (!out.password && (body.senha || body.pass)) out.password = body.senha || body.pass;
  out.mac = out.mac || body.mac || body.mac_address || body.endereco_mac || body.device_mac || body.m;
  if (!out.reply_to && body.telefone) out.reply_to = body.telefone;
  out.chatId = out.chatId
    || body.chatId
    || body?.Conversa?.Id
    || body?.Chat?.Id
    || body?.Payload?.Chat?.Id
    || body?.Contato?.ChatID
    || body?.contato?.ChatID
    || body?.chat_id;
  if (!out.displayName && body.servidor) out.displayName = String(body.servidor);
  if (!out.displayName && body.app) out.displayName = String(body.app);
  return out;
}

/* ========= Headers base + headers por host ========= */
const BROWSER_HEADERS_BASE = {
  accept: "application/json",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
};
const pureHost = (h) => String(h || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase().replace(/^api\./, "");
const headersFor = (host) => {
  const baseHost = pureHost(host);
  return {
    ...BROWSER_HEADERS_BASE,
    origin: `https://${baseHost}`,
    referer: `https://${baseHost}/`
  };
};

/* ========= Multi-provedor ========= */
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
const PROVIDER_ORDER = [
  "iptv-4k.live", "simpletv.live", "iptvplayer.io", "tiviplayer.io",
  "i-player.live", "iptvpluseplayer.live", "iptvproplayer.live",
  "iptv-star.live", "iptvnext.live"
];

const HOST_BRAND = {
  "iptv-4k.live": "IPTV 4K",
  "simpletv.live": "OttPlayer",
  "iptvplayer.io": "IPTV Player io",
  "tiviplayer.io": "TiviPlayer IPTV",
  "i-player.live": "I Player",
  "iptvpluseplayer.live": "IPTV+",
  "iptvproplayer.live": "IPTV Pro Player",
  "iptv-star.live": "IPTV Star Player",
  "iptvnext.live": "IPTV Next Player"
};

function _brandHost(h) {
  return String(h || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^api\./, "")
    .toLowerCase();
}
function pickBrand(displayName, host) {
  const h = _brandHost(host);
  return (displayName && String(displayName).trim())
      || HOST_BRAND[h]
      || h.split(".")[0].toUpperCase();
}

function _sanitizeHost(h) {
  return String(h || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
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
  return null;
}
function buildProviderEndpoints(body = {}) {
  const wantAuto =
    String(body.host || body.app || "").trim().toLowerCase() === "auto" ||
    body.auto === true || body.tryAll === true;

  const chosenHost = _pickHostFromBody(body);

  if (!chosenHost && !wantAuto && REQUIRE_PROVIDER) {
    return { error: "NO_PROVIDER" };
  }

  const fallbacks = (process.env.UPLOAD_HOST_FALLBACKS || "")
    .split(",").map(_sanitizeHost).filter(Boolean);

  const hosts = wantAuto ? PROVIDER_ORDER : (chosenHost ? [chosenHost, ...fallbacks] : fallbacks);

  // EXPANSÃO: bare e api.<bare>
  const expandHosts = (arr) => {
    const out = [];
    for (const h0 of arr) {
      const bare = String(h0).replace(/^https?:\/\//,'').replace(/^api\./,'').toLowerCase();
      const api  = `api.${bare}`;
      if (!out.includes(bare)) out.push(bare);
      if (!out.includes(api))  out.push(api);
    }
    return out;
  };
  const allHosts = expandHosts(hosts);

  const validateTemplates = allHosts.map(h => `https://${h}/api/validate_mac?mac={mac}`);
  const uploadEndpoints   = allHosts.map(h => `https://${h}/api/playlist_with_mac`);

  const displayName = body?.displayName || body?.name || body?.app || IPTV_UPLOAD_NAME_DEFAULT;

  return { validateTemplates, uploadEndpoints, displayName, chosenHost, wantAuto };
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
  if (status === 404) {
    const txt404 = typeof data === "string" ? data : JSON.stringify(data || "");
    if (/<!doctype|<html/i.test(txt404)) return "unknown"; // 404 HTML → não conclusivo
    return "invalid";
  }
  const txt = typeof data === "string" ? data : JSON.stringify(data || "");
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
    : [`https://iptv-4k.live/api/validate_mac?mac={mac}`];

  let last = { state: "unknown", status: 0, snippet: "", host: null };

  for (const tpl of templates) {
    const url = fill(tpl, { mac: mac17 });
    try {
      const host = new URL(url).host;
      const r = await axios.get(url, {
        headers: headersFor(host),
        timeout: VALIDATE_TIMEOUT_MS,
        validateStatus: () => true
      });
      const snippet = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const state = decideValidateState(r.status, r.data);
      console.log("validateMac:", host, "->", state, "status:", r.status);
      last = { state, status: r.status, snippet, host };
      if (state === "valid") return last; // só retorna cedo em "valid"
      // invalid/unknown → segue para próximo host
    } catch (e) {
      last = { state: "unknown", status: 0, snippet: e.message, host: null };
    }
  }
  return last;
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
  const host = new URL(endpoint).host;
  const hdrs = headersFor(host);
  try {
    const fd = new FormData();
    fd.append("name", name ?? "");
    fd.append("mac", String(mac || "").toLowerCase());
    fd.append("url", url);
    const res = await fetch(endpoint, { method: "POST", headers: hdrs, body: fd, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    const ok = res.ok && looksOk(json);
    console.log("upload MULTIPART:", host, res.status, ok, text.slice(0, 200));
    return { ok, status: res.status, raw: json };
  } catch (e) {
    console.log("upload multipart error:", host, e.message);
    return { ok: false, status: 0, raw: e.message };
  } finally {
    clearTimeout(to);
  }
}
async function postFormURLEncoded({ endpoint, mac, url, name }) {
  const host = new URL(endpoint).host;
  try {
    const body = new URLSearchParams({ mac: String(mac).toLowerCase(), url, name }).toString();
    const r = await axios.post(endpoint, body, {
      headers: { ...headersFor(host), "Content-Type": "application/x-www-form-urlencoded" },
      timeout: UPLOAD_TIMEOUT_MS,
      validateStatus: () => true
    });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload FORM:", host, r.status, ok, (typeof r.data === "string" ? r.data : JSON.stringify(r.data)).slice(0, 200));
    return { ok, status: r.status, raw: r.data };
  } catch (e) {
    return { ok: false, status: 0, raw: e.message };
  }
}
async function postJSON({ endpoint, mac, url, name }) {
  const host = new URL(endpoint).host;
  try {
    const r = await axios.post(endpoint, { mac: String(mac).toLowerCase(), url, name }, {
      headers: { ...headersFor(host), "Content-Type": "application/json" },
      timeout: UPLOAD_TIMEOUT_MS,
      validateStatus: () => true
    });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload JSON:", host, r.status, ok, (typeof r.data === "string" ? r.data : JSON.stringify(r.data)).slice(0, 200));
    return { ok, status: r.status, raw: r.data };
  } catch (e) {
    return { ok: false, status: 0, raw: e.message };
  }
}
async function uploadPlaylist({ mac, url, name, endpoints }) {
  const endpointsList = (endpoints && endpoints.length)
    ? endpoints
    : [`https://iptv-4k.live/api/playlist_with_mac`, `https://api.iptv-4k.live/api/playlist_with_mac`];

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

/* ========= Trigger inválido ========= */
const TRIGGER_ON_INVALID = (process.env.TRIGGER_ON_INVALID || "true").toLowerCase() === "true";
const TRIGGER_KEYWORD_INVALID = process.env.TRIGGER_KEYWORD_INVALID || "#corrigir-mac";
const TRIGGER_DELAY_MS = parseInt(process.env.TRIGGER_DELAY_MS || "600", 10);
async function triggerBotKeyword({ phone, chatId, keyword }) {
  if (!keyword || (!phone && !chatId)) return;
  await new Promise(r => setTimeout(r, TRIGGER_DELAY_MS));
  await talkSend({ toPhone: phone, chatId, message: keyword });
}

/* ========= /gerar-link-sync ========= */
app.post("/gerar-link-sync", async (req, res) => {
  const body = normalizeWebhookKeys(req.body || {});
  const macNorm = normalizeMac(body.mac);
  const reply_to_phone = body.reply_to;
  const reply_to_chat  = body.chatId;

  if (!macNorm) return res.status(400).json({ ok: false, error: "NO_MAC" });

  const prov = buildProviderEndpoints(body);
  if (prov.error === "NO_PROVIDER") {
    return res.status(400).json({
      ok: false, error: "NO_PROVIDER",
      message: "Informe 'app' (ex.: OttPlayer), 'host' (ex.: simpletv.live) ou use 'auto'."
    });
  }
  const { validateTemplates, uploadEndpoints, displayName, wantAuto } = prov;

  const m3u = buildM3UFromFields({
    username: body.username, password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT, output: body?.output || M3U_OUTPUT_DEFAULT
  });
  if (!m3u) return res.status(400).json({ ok: false, error: "NO_M3U", message: "Credenciais ausentes para montar a M3U." });

  const v = await validateMacDetailed(macNorm, validateTemplates);

  // Se NÃO for AUTO e a validação disse "invalid", encerra
  if (v.state === "invalid" && !wantAuto) {
    if (reply_to_phone || reply_to_chat) {
      await talkSend({
        chatId: reply_to_chat, toPhone: reply_to_phone,
        message: "⚠️ MAC inválido. Digite novamente (12 caracteres; com “:” ou sem)."
      });
      if (TRIGGER_ON_INVALID) await triggerBotKeyword({ phone: reply_to_phone, chatId: reply_to_chat, keyword: TRIGGER_KEYWORD_INVALID });
    }
    return res.status(422).json({ ok: false, reason: "INVALID_MAC", validate: { state: v.state, status: v.status } });
  }

  if (SAFE_MODE_STRICT && !breakerAllow()) {
    return res.status(503).json({ ok: false, reason: "BREAKER_OPEN" });
  }

  const name = String(displayName || "").slice(0, 64);

  // Em AUTO: se validou num host, ancora nele; senão tenta TODOS
  const chosenUpload =
    (wantAuto && v.state === "valid" && v.host)
      ? [`https://${v.host}/api/playlist_with_mac`]
      : uploadEndpoints;

  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: chosenUpload });
  breakerReport(up.status >= 200 && up.status < 300);
  const success = up.ok && up.status === 200;

  const uploadHost = new URL(chosenUpload?.[0] || uploadEndpoints[0]).host;
  const brand = pickBrand(body?.displayName, uploadHost);
  console.log("brand-debug/sync", { uploadHost, brand });

  if (success && (reply_to_phone || reply_to_chat)) {
    await talkSend({
      chatId: reply_to_chat, toPhone: reply_to_phone,
      message: `✅ Serviço inserido automaticamente no **${brand}**. Feche e abra o aplicativo — não precisa login.`
    });
  }

  // Em AUTO: se ninguém aceitou e a validação não foi 'valid', trate como falha infra
  if (!success && wantAuto) {
    return res.status(502).json({
      ok: false,
      reason: "UPLOAD_FAILED",
      message: "Não consegui subir a playlist agora. Tente novamente.",
      validate: { state: v.state, status: v.status },
      upload:   { status: up.status, ok: up.ok }
    });
  }

  return res.json({
    ok: success,
    validate: { state: v.state, status: v.status },
    upload:   { status: up.status, ok: up.ok, brand }
  });
});

/* ========= /gerar-link (assíncrono) ========= */
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
      ok: false, error: "NO_PROVIDER",
      message: "Informe 'app' (ex.: OttPlayer), 'host' (ex.: simpletv.live) ou use 'auto'."
    });
  }
  const { validateTemplates, uploadEndpoints, displayName, wantAuto } = prov;

  const m3u = buildM3UFromFields({
    username: body.username, password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT, output: body?.output || M3U_OUTPUT_DEFAULT
  });
  if (!m3u) return res.status(400).json({ ok: false, error: "NO_M3U", message: "Credenciais ausentes para montar a M3U." });

  res.json({ ok: true });

  (async () => {
    const v = await validateMacDetailed(macNorm, validateTemplates);
    const name = String(displayName || "").slice(0, 64);

    // Se NÃO for AUTO e inválido, encerra
    if (v.state === "invalid" && !wantAuto) {
      if (reply_to_phone || reply_to_chat) {
        await talkSend({
          toContactId, fromChannelId, chatId: reply_to_chat, toPhone: reply_to_phone,
          message: "⚠️ MAC inválido. Digite novamente (12 caracteres; com “:” ou sem)."
        });
        if (TRIGGER_ON_INVALID) await triggerBotKeyword({ phone: reply_to_phone, chatId: reply_to_chat, keyword: TRIGGER_KEYWORD_INVALID });
      }
      return;
    }
    if (SAFE_MODE_STRICT && !breakerAllow()) return;

    const chosenUpload =
      (wantAuto && v.state === "valid" && v.host)
        ? [`https://${v.host}/api/playlist_with_mac`]
        : uploadEndpoints;

    const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: chosenUpload });
    breakerReport(up.ok);

    const success = up.ok && up.status === 200;
    const uploadHost = new URL(chosenUpload?.[0] || uploadEndpoints[0]).host;
    const brand = pickBrand(body?.displayName, uploadHost);
    console.log("brand-debug/async", { uploadHost, brand });

    if (success && (reply_to_phone || reply_to_chat)) {
      await talkSend({
        toContactId, fromChannelId, chatId: reply_to_chat, toPhone: reply_to_phone,
        message: `✅ Serviço inserido automaticamente no **${brand}**. Feche e abra o aplicativo — não precisa login.`
      });
    } else if (!success && wantAuto) {
      await talkSend({
        toContactId, fromChannelId, chatId: reply_to_chat, toPhone: reply_to_phone,
        message: "⚠️ Não consegui subir a playlist agora. Tente novamente."
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
    return res.status(400).json({ ok: false, error: "NO_PROVIDER", message: "Informe 'app' ou 'host' ou 'auto'." });
  }
  const { validateTemplates, uploadEndpoints, displayName, wantAuto } = prov;

  const m3u = buildM3UFromFields({
    username: body.username, password: body.password,
    type: body?.type || M3U_TYPE_DEFAULT, output: body?.output || M3U_OUTPUT_DEFAULT
  });
  const name = String(displayName || "").slice(0, 64);

  if (!macNorm || !m3u) return res.status(400).json({ ok: false, error: "need mac + user/pass" });

  const v = await validateMacDetailed(macNorm, validateTemplates);

  const chosenUpload =
    (wantAuto && v.state === "valid" && v.host)
      ? [`https://${v.host}/api/playlist_with_mac`]
      : uploadEndpoints;

  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name, endpoints: chosenUpload });

  const uploadHost = new URL(chosenUpload?.[0] || uploadEndpoints[0]).host;
  const brand = pickBrand(body?.displayName, uploadHost);
  console.log("brand-debug/probe", { uploadHost, brand });

  res.json({
    ok: true,
    mac: macNorm,
    brand,
    validate: { state: v.state, status: v.status, host: v.host, snippet: String(v.snippet || "").slice(0, 400) },
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

/* ========= JSON inválido (resposta amigável) ========= */
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ ok:false, error:"INVALID_JSON", message:"Body não é JSON válido." });
  }
  next(err);
});

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
