import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true })); // aceita x-www-form-urlencoded

/* ========= uTalk ========= */
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN || "";                 // necessário p/ WhatsApp
const TALK_ORG_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";
const TALK_FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354";

/* ========= IPTV-4K (env/config) ========= */
const IPTV4K_VALIDATE_URL_TEMPLATE =
  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";

const IPTV4K_UPLOAD_URL_TEMPLATE =
  process.env.IPTV4K_UPLOAD_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/playlist_with_mac";

const IPTV4K_UPLOAD_URL_ALT =
  process.env.IPTV4K_UPLOAD_URL_ALT ||
  "https://iptv-4k.live/api/playlist_with_mac";

/* ========= M3U fixo (aptxu) ========= */
const M3U_BASE_DEFAULT   = process.env.M3U_BASE_DEFAULT   || "http://aptxu.com/get.php";
const M3U_TYPE_DEFAULT   = process.env.M3U_TYPE_DEFAULT   || "m3u_plus";
const M3U_OUTPUT_DEFAULT = process.env.M3U_OUTPUT_DEFAULT || "hls";

/* ========= Timeouts/Retry ========= */
const VALIDATE_TIMEOUT_MS = parseInt(process.env.IPTV4K_VALIDATE_TIMEOUT || "8000", 10);
const UPLOAD_TIMEOUT_MS   = parseInt(process.env.IPTV4K_UPLOAD_TIMEOUT   || "25000", 10);
const UPLOAD_RETRIES      = parseInt(process.env.IPTV4K_UPLOAD_RETRIES   || "2", 10);

/* ========= Nome padrão no 4K ========= */
const IPTV4K_UPLOAD_NAME_DEFAULT = process.env.IPTV4K_UPLOAD_NAME_DEFAULT || "MixTV";

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
  if (!n) return "";
  let d = String(n).replace(/\D/g, "");

  // remove código do país se vier (para normalizar)
  if (d.startsWith("55")) d = d.slice(2);

  // remove zeros à esquerda (ex.: 073…)
  d = d.replace(/^0+/, "");

  // valida DDD+número (10 ou 11 dígitos)
  if (d.length < 10 || d.length > 11) {
    console.error("telefone inválido:", d);
    return "";
  }
  return `+55${d}`;
};

function makeProvisionalCreds(phoneE164) {
  const tail = (phoneE164 || "").replace(/\D/g, "").slice(-4)
            || Math.floor(Math.random() * 1e4).toString().padStart(4, "0");
  const stamp = Date.now().toString(36).slice(-5);
  return { username: `tmp${tail}`, password: `p${stamp}${tail}` };
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildM3UFromFields({ base = M3U_BASE_DEFAULT, username, password, type = M3U_TYPE_DEFAULT, output = M3U_OUTPUT_DEFAULT }) {
  if (!username || !password) return null;
  const qs = new URLSearchParams({ username, password, type, output });
  return `${base}?${qs.toString()}`;
}
function decodeM3U(body) {
  if (body?.m3uUrl)    return String(body.m3uUrl);
  if (body?.m3uUrl_b64) { try { return Buffer.from(String(body.m3uUrl_b64), "base64").toString("utf8"); } catch {} }
  if (body?.m3uUrl_enc) { try { return decodeURIComponent(String(body.m3uUrl_enc)); } catch {} }
  for (const k of ["url", "m3u", "playlist"]) {
    if (body?.[k] && /^https?:\/\//i.test(String(body[k]))) return String(body[k]);
    if (body?.[`${k}_enc`]) { try { return decodeURIComponent(String(body[`${k}_enc`])); } catch {} }
    if (body?.[`${k}_b64`]) { try { return Buffer.from(String(body[`${k}_b64`]), "base64").toString("utf8"); } catch {} }
  }
  return null;
}
function normalizeWebhookKeys(body = {}) {
  const out = { ...body };

  // login (Contato.Usuario > usuario)
  if (!out.username && body?.Contato?.Usuario) out.username = String(body.Contato.Usuario);
  if (!out.username && body.usuario) out.username = body.usuario;

  // senha (Contato.Senha > senha/pass)
  if (!out.password && body?.Contato?.Senha) out.password = String(body.Contato.Senha);
  if (!out.password && (body.senha || body.pass)) out.password = body.senha || body.pass;

  // MAC
  out.mac = out.mac || body.mac || body.mac_address || body.endereco_mac || body.device_mac || body.m;

  // telefone (reply_to) — Contato.Telefone/Numero > telefone
  if (!out.reply_to && body?.Contato?.Telefone) out.reply_to = String(body.Contato.Telefone);
  if (!out.reply_to && body?.Contato?.Numero)   out.reply_to = String(body.Contato.Numero);
  if (!out.reply_to && body.telefone)           out.reply_to = body.telefone;

  // nome exibido no 4K
  if (!out.displayName && body.servidor) out.displayName = String(body.servidor);
  if (!out.displayName && body.app)      out.displayName = String(body.app);

  return out;
}

/* ========= Headers estilo “site” ========= */
const BROWSER_HEADERS = {
  "accept": "application/json",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7,gl;q=0.6",
  "cache-control": "no-cache",
  "origin": "https://iptv-4k.live",
  "pragma": "no-cache",
  "referer": "https://iptv-4k.live/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
};

/* ========= uTalk ========= */
async function talkSend({ toPhone, message }) {
  if (!TALK_TOKEN) { console.error("talkSend: faltando TALK_API_TOKEN"); return; }
  const payload = {
    toPhone: e164BR(toPhone),
    fromPhone: e164BR(TALK_FROM_PHONE),
    organizationId: TALK_ORG_ID,
    message
  };
  try {
    const r = await axios.post(
      `${TALK_BASE}/v1/messages/simplified`,
      payload,
      { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000, validateStatus: () => true }
    );
    if (r.status >= 200 && r.status < 300) {
      console.log("talkSend OK ->", payload.toPhone);
    } else {
      console.error("uTalk erro:", r.status, typeof r.data === "string" ? r.data : JSON.stringify(r.data));
      console.error("payload usado:", payload);
    }
  } catch (e) {
    console.error("uTalk exceção:", e?.response?.data || e.message);
    console.error("payload usado:", payload);
  }
}

/* ========= 4K IPTV: validação ========= */
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
async function validateMacDetailed(mac17) {
  const url = fill(IPTV4K_VALIDATE_URL_TEMPLATE, { mac: mac17 });
  try {
    const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: VALIDATE_TIMEOUT_MS, validateStatus: () => true });
    const snippet = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    const state = decideValidateState(r.status, r.data);
    console.log("validateMac:", mac17, "->", state, "status:", r.status, "snippet:", snippet.replace(/\s+/g, " ").slice(0, 200));
    return { state, status: r.status, snippet };
  } catch (e) {
    console.log("validateMac error:", mac17, e.message);
    return { state: "unknown", status: 0, snippet: e.message };
  }
}

/* ========= 4K IPTV: upload ========= */
function looksOk(body) {
  const txt = typeof body === "string" ? body : JSON.stringify(body || "");
  return body === true || body?.ok === true || body?.success === true || body?.error === false ||
         String(body?.status || "").toLowerCase() === "ok" ||
         /\b(ok|success|enviad[oa]|atualizad[oa]|uploaded|created|update\s*ok)\b/i.test(txt);
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
    fd.append("mac", String(mac || "").toLowerCase()); // site manda minúsculo
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
async function uploadPlaylist({ mac, url, name }) {
  const endpoints = [IPTV4K_UPLOAD_URL_TEMPLATE, IPTV4K_UPLOAD_URL_ALT];
  let last = { ok: false, status: 0, raw: "no-attempt" };
  for (const ep of endpoints) {
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

/* ========= ENDPOINT SÍNCRONO (Worker) =========
 * Entrada: { mac, usuario|username, senha|password, telefone|Contato.Telefone, [servidor|app], [type], [output] }
 * Resposta: { ok:true } | { ok:false, reason }
 * Notifica WhatsApp com ícones e salva no histórico.
 */
async function validateMacQuick(mac17, timeoutMs = 5000) {
  const url = fill(IPTV4K_VALIDATE_URL_TEMPLATE, { mac: mac17 });
  try {
    const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: timeoutMs, validateStatus: () => true });
    return { state: decideValidateState(r.status, r.data), status: r.status };
  } catch (e) {
    return { state: "unknown", status: 0, error: e.message };
  }
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

/* ========= NOVO: credenciais provisórias (dentro do fluxo) =========
 * Entrada: { Conversa:{Id}, Contato:{Numero} }
 * Saída:   { ok:true, Retorno:{ telefone, username, password, provisorio:true } }
 */
app.post("/credenciais", async (req, res) => {
  try {
    const numero = req.body?.Contato?.Numero || req.body?.Contato?.Telefone || req.body?.telefone || "";
    const telefone = e164BR(numero);
    if (!telefone) return res.status(200).json({ ok: false, reason: "PHONE_INVALID" });

    const { username, password } = makeProvisionalCreds(telefone);
    return res.json({ ok: true, Retorno: { telefone, username, password, provisorio: true } });
  } catch (e) {
    console.error("credenciais error:", e.message);
    return res.status(200).json({ ok: false, reason: "CREDGEN_ERROR" });
  }
});

app.post("/gerar-link-sync", async (req, res) => {
  const body       = normalizeWebhookKeys(req.body || {});
  const macNorm    = normalizeMac(body.mac);
  const reply_to   = body.reply_to; // Contato.Telefone/Numero ou telefone
  const username   = body.username || ""; // Contato.Usuario > usuario
  const password   = body.password || ""; // Contato.Senha   > senha/pass
  const name       = (body?.displayName || body?.servidor || body?.app || IPTV4K_UPLOAD_NAME_DEFAULT).slice(0, 64);

  const redact = (s) => (s ? String(s).replace(/.(?=.{4})/g, "•") : "");

  if (!macNorm) {
    if (reply_to) await talkSend({ toPhone: reply_to, message: "❌ MAC ausente ou inválido. Confira na TV/app e tente novamente." });
    return res.status(200).json({ ok: false, reason: "NO_MAC" });
  }

  const m3u = (username && password)
    ? buildM3UFromFields({ username, password, type: body?.type || M3U_TYPE_DEFAULT, output: body?.output || M3U_OUTPUT_DEFAULT })
    : null;

  if (!m3u) {
    if (reply_to) await talkSend({ toPhone: reply_to, message: "❌ Não foi possível gerar a playlist (credenciais ausentes). Tente novamente." });
    return res.status(200).json({ ok: false, reason: "NO_M3U" });
  }

  const v = await validateMacQuick(macNorm, 5000);
  if (v.state === "invalid") {
    if (reply_to) await talkSend({ toPhone: reply_to, message: "❌ O MAC informado é inválido. Confira e repita o processo." });
    return res.status(200).json({ ok: false, reason: "INVALID_MAC" });
  }

  console.log("uploadQuick ->", { mac: macNorm, name, username, password: redact(password) });

  const up = await uploadPlaylistQuick({ mac: macNorm, url: m3u, name, timeoutMs: 10000 });

  // ✅ Confirmação com ícones (fica salva no histórico da conversa via uTalk)
  if (reply_to) {
    if (up.ok) {
      const msg =
        `✅ *Confirmação de acesso*\n\n` +
        `📡 *MAC:* ${macNorm}\n` +
        `💻 *App:* ${name}\n\n` +
        `🔑 *Usuário:* ${username}\n` +
        `🔒 *Senha:* ${password}\n\n` +
        `📲 Feche e abra o aplicativo para atualizar.`;
      await talkSend({ toPhone: reply_to, message: msg });
    } else {
      await talkSend({ toPhone: reply_to, message: "⚠️ Não foi possível incluir o serviço agora. Tente novamente em alguns minutos." });
    }
  }

  if (up.ok) {
    return res.status(200).json({
      ok: true,
      Retorno: {
        telefone: e164BR(reply_to || ""),
        username,
        password,
        provisorio: false
      }
    });
  }
  return res.status(200).json({ ok: false, reason: "UPLOAD_FAILED" });
});

/* ========= Endpoints auxiliares ========= */
app.post("/_talk", async (req, res) => {
  try {
    const msg = req.body.message || "✅ Teste de envio (server)";
    await talkSend({ toPhone: req.body.to, message: msg });
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});
app.get("/_healthz", (_, res) => res.json({ ok: true }));
app.get("/_readyz",  (_, res) => {
  const missing = [];
  if (!TALK_ORG_ID) missing.push("TALK_ORG_ID");
  if (!TALK_FROM_PHONE) missing.push("TALK_FROM_PHONE");
  if (!TALK_TOKEN) missing.push("TALK_API_TOKEN (necessário para enviar WhatsApp)");
  res.json({ ok: missing.length === 0, missing });
});
app.get("/health",  (_, res) => res.json({ ok: true }));

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
