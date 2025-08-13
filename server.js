import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ========= uTalk (envs obrigatórias) ========= */
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN;                       // defina no Koyeb
const TALK_ORG_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";   // seu orgId
const TALK_FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354"; // remetente E.164 (+55...)

/* ========= IPTV-4K (configuráveis por env) ========= */
const IPTV4K_VALIDATE_URL_TEMPLATE =
  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";

const IPTV4K_UPLOAD_URL_TEMPLATE =
  process.env.IPTV4K_UPLOAD_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/playlist_with_mac?mac={mac}&url={url}&name={name}";

const IPTV4K_UPLOAD_METHOD = (process.env.IPTV4K_UPLOAD_METHOD || "GET").toUpperCase(); // GET|POST
const IPTV4K_UPLOAD_BODY_STYLE = (process.env.IPTV4K_UPLOAD_BODY_STYLE || "query").toLowerCase(); // query|json|form

const PORT = parseInt(process.env.PORT || "8080", 10);

/* ========= Helpers ========= */
function normalizeMac(input) {
  const hex = (String(input || "").match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(":"); // "AA:BB:CC:DD:EE:FF" (17 chars com ':')
}

const e164BR = (n) => {
  const d = String(n || "").replace(/\D/g, "");
  return d.startsWith("55") ? `+${d}` : `+55${d}`;
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));

function decodeM3U(body) {
  if (body?.m3uUrl) return String(body.m3uUrl);
  if (body?.m3uUrl_b64) {
    try { return Buffer.from(String(body.m3uUrl_b64), "base64").toString("utf8"); } catch {}
  }
  if (body?.m3uUrl_enc) {
    try { return decodeURIComponent(String(body.m3uUrl_enc)); } catch {}
  }
  return null;
}

function buildM3UFromFields({
  base = "http://line.iptv-4k.live/get.php", // default alinhado aos testes
  username, password, type = "m3u_plus", output = "hls"
}) {
  if (!username || !password) return null;
  const qs = new URLSearchParams({ username, password, type, output });
  return `${base}?${qs.toString()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========= Headers de navegador (evita WAF) ========= */
const BROWSER_HEADERS = {
  "accept": "*/*",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  "origin": "https://iptv-4k.live",
  "pragma": "no-cache",
  "referer": "https://iptv-4k.live/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
};

/* ========= uTalk ========= */
async function talkSend({ toPhone, message }) {
  if (!TALK_TOKEN) {
    console.error("talkSend: faltando TALK_API_TOKEN no ambiente");
    return;
  }
  try {
    await axios.post(
      `${TALK_BASE}/v1/messages/simplified`,
      {
        toPhone: e164BR(toPhone),
        fromPhone: TALK_FROM_PHONE,
        organizationId: TALK_ORG_ID,
        message
      },
      { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    console.log("talkSend OK ->", toPhone);
  } catch (e) {
    console.error("uTalk erro:", e?.response?.data || e.message);
  }
}

/* ========= 4K IPTV: validação ========= */
/** Trata 404 como inválido; 500 com "mac length 17" também como inválido. */
function decideValidateState(status, data) {
  if (status === 404) return "invalid";
  const txt = typeof data === "string" ? data : JSON.stringify(data || "");
  if (status === 500 && /"mac"\s*length\s*must\s*be\s*17/i.test(txt)) return "invalid";
  if (status >= 200 && status < 300) {
    if (/<!doctype|<html/i.test(txt)) return "unknown"; // HTML/WAF
    const yes =
      data === true || data === 1 ||
      data?.valid === true || data?.ok === true || data?.exists === true || data?.success === true ||
      String(data?.status || "").toLowerCase() === "valid" ||
      String(data?.result || "").toLowerCase() === "valid" ||
      /\b(ok|true|válido|valido|success)\b/i.test(txt);
    const no =
      data === false || data === 0 ||
      data?.valid === false || data?.ok === false || data?.exists === false || data?.success === false ||
      /\b(invalid|inválid|nao\s*encontrado|não\s*encontrado|not\s*found)\b/i.test(txt);
    return yes ? "valid" : (no ? "invalid" : "unknown");
  }
  return "unknown";
}

async function validateMacDetailed(mac17) {
  const url = fill(IPTV4K_VALIDATE_URL_TEMPLATE, { mac: mac17 });
  try {
    const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000, validateStatus: () => true });
    const snippet = String(r.data ?? "").slice(0, 600);
    const state = decideValidateState(r.status, r.data);
    console.log("validateMac:", mac17, "->", state, "status:", r.status, "snippet:", snippet.replace(/\s+/g, " ").slice(0, 200));
    return { state, status: r.status, snippet };
  } catch (e) {
    console.log("validateMac error:", mac17, e.message);
    return { state: "unknown", status: 0, snippet: e.message };
  }
}

async function validateMac(mac17) {
  const { state } = await validateMacDetailed(mac17);
  return state;
}

/* ========= 4K IPTV: envio ========= */
function looksOk(body) {
  const txt = typeof body === "string" ? body : JSON.stringify(body || "");
  return body === true || body?.ok === true || body?.success === true ||
         String(body?.status || "").toLowerCase() === "ok" ||
         /\b(ok|success|enviad[oa]|atualizad[oa]|uploaded|created|update\s*ok)\b/i.test(txt);
}

function shouldRetry(status, errMsg) {
  if (status >= 500 && status < 600) return true;
  if (!status) { // timeout / abort / DNS / network
    if (/ECONNABORTED|timeout|Network Error|socket hang up/i.test(errMsg || "")) return true;
  }
  return false;
}

async function uploadOnce({ method, url, name, mac, encUrl }) {
  if (method === "GET") {
    const target = fill(IPTV4K_UPLOAD_URL_TEMPLATE, { mac, url: encUrl, name });
    const r = await axios.get(target, { headers: BROWSER_HEADERS, timeout: 12000, validateStatus: () => true });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload GET:", r.status, ok, String(r.data).slice(0, 200));
    return { ok, status: r.status, raw: r.data, headers: r.headers };
  } else {
    let postUrl = IPTV4K_UPLOAD_URL_TEMPLATE;
    let body; const headers = { ...BROWSER_HEADERS };
    if (IPTV4K_UPLOAD_BODY_STYLE === "json") {
      body = { mac, url: decodeURIComponent(encUrl), name };
      headers["Content-Type"] = "application/json";
    } else if (IPTV4K_UPLOAD_BODY_STYLE === "form") {
      body = new URLSearchParams({ mac, url: decodeURIComponent(encUrl), name }).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      postUrl = fill(IPTV4K_UPLOAD_URL_TEMPLATE, { mac, url: encUrl, name }); // query
    }
    const r = await axios.post(postUrl, body, { headers, timeout: 12000, validateStatus: () => true });
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload POST:", r.status, ok, String(r.data).slice(0, 200));
    return { ok, status: r.status, raw: r.data, headers: r.headers };
  }
}

async function uploadPlaylist({ mac, url, name }) {
  const encUrl = encodeURIComponent(url);
  // tentativa primária
  try {
    const r1 = await uploadOnce({ method: IPTV4K_UPLOAD_METHOD, url, name, mac, encUrl });
    if (r1.ok) return r1;
    // retries apenas em 5xx/timeout
    const retryable = shouldRetry(r1.status, "");
    if (!retryable) {
      // fallback automático: POST form
      try {
        const rfb = await axios.post(
          IPTV4K_UPLOAD_URL_TEMPLATE,
          new URLSearchParams({ mac, url, name }).toString(),
          { headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000, validateStatus: () => true }
        );
        const ok = (rfb.status >= 200 && rfb.status < 300 && looksOk(rfb.data));
        console.log("upload fallback POST-form:", rfb.status, ok, String(rfb.data).slice(0, 200));
        if (ok) return { ok, status: rfb.status, raw: rfb.data, headers: rfb.headers };
      } catch (e) {
        console.log("upload fallback error:", e.message);
      }
      return { ok: false, status: r1.status, raw: r1.raw };
    }

    // retries com backoff (1–2 tentativas)
    let last = r1;
    for (let i = 1; i <= 2; i++) {
      await sleep(500 * i); // backoff linear simples
      try {
        const ri = await uploadOnce({ method: IPTV4K_UPLOAD_METHOD, url, name, mac, encUrl });
        if (ri.ok) return ri;
        last = ri;
      } catch (e) {
        last = { ok: false, status: 0, raw: e.message };
      }
    }

    // fallback após retries
    try {
      const rfb = await axios.post(
        IPTV4K_UPLOAD_URL_TEMPLATE,
        new URLSearchParams({ mac, url, name }).toString(),
        { headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000, validateStatus: () => true }
      );
      const ok = (rfb.status >= 200 && rfb.status < 300 && looksOk(rfb.data));
      console.log("upload fallback POST-form (after retries):", rfb.status, ok, String(rfb.data).slice(0, 200));
      if (ok) return { ok, status: rfb.status, raw: rfb.data, headers: rfb.headers };
    } catch (e) {
      console.log("upload fallback after retries error:", e.message);
    }

    return { ok: false, status: last.status, raw: last.raw };
  } catch (e) {
    console.log("upload primary error:", e.message);
    return { ok: false, status: 0, raw: e.message };
  }
}

/* ========= Endpoint principal ========= */
/**
 * Body aceito:
 * {
 *   mac, reply_to,
 *   m3uUrl | m3uUrl_b64 | m3uUrl_enc
 *   // ou:
 *   username, password, [base, type, output]
 * }
 */
app.post("/gerar-link", async (req, res) => {
  const { mac, reply_to } = req.body || {};
  const macNorm = normalizeMac(mac);

  if (!macNorm) return res.status(400).json({ ok: false, error: "NO_MAC" });
  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });

  const userM3U = decodeM3U(req.body) || buildM3UFromFields({
    base: req.body?.base,
    username: req.body?.username,
    password: req.body?.password,
    type: req.body?.type,
    output: req.body?.output
  });
  if (!userM3U) return res.status(400).json({ ok: false, error: "NO_M3U" });

  // responde já (evita timeout 502)
  res.json({ ok: true, accepted: true });

  // processa em background
  (async () => {
    // 1) valida MAC (sempre no formato 17 chars com ':')
    const v = await validateMacDetailed(macNorm);

    if (v.state === "invalid") {
      await talkSend({
        toPhone: reply_to,
        message: `❌ MAC *${macNorm}* inválido no 4K. Verifique no app e envie novamente (12 dígitos hex, ex.: 78DD125C81EC).`
      });
      return;
    }

    // 2) tenta envio automático se "valid" ou "unknown"
    const up = await uploadPlaylist({ mac: macNorm, url: userM3U, name: `Cliente ${macNorm}` });

    if (up.ok) {
      const prefix = (v.state === "valid")
        ? "✅ MAC validado e lista enviada."
        : "✅ Lista enviada (validação prévia não confirmou, mas o envio foi aceito).";
      await talkSend({ toPhone: reply_to, message: `${prefix}\nAbra a TV e verifique.` });
    } else {
      const manual = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(userM3U)}&name=Cliente%20${encodeURIComponent(macNorm)}`;
      const motivo = (v.state === "unknown") ? "validação inconclusiva" : "API de envio não confirmou";
      await talkSend({ toPhone: reply_to, message: `⚠️ MAC *${macNorm}* ${motivo}.\nTente manualmente:\n${manual}` });
    }
  })().catch(err => console.error("bg_task_error:", err?.message));
});

/* ========= Rotas utilitárias ========= */
app.post("/_talk", async (req, res) => {
  try {
    await talkSend({ toPhone: req.body.to, message: "✅ Teste de envio (server)" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// Diagnóstico: mostra status/trecho das respostas da validação e upload
app.post("/_probe", async (req, res) => {
  const macNorm = normalizeMac(req.body.mac || "");
  const m3u = decodeM3U(req.body) || buildM3UFromFields(req.body) || req.body.url;
  if (!macNorm || !m3u) return res.status(400).json({ ok: false, error: "need mac + m3u/url" });

  const v = await validateMacDetailed(macNorm);
  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name: `Cliente ${macNorm}` });

  res.json({
    ok: true,
    mac: macNorm,
    validate: { state: v.state, status: v.status, snippet: String(v.snippet || "").slice(0, 400) },
    upload:   { ok: up.ok, status: up.status, snippet: String(up.raw || "").slice(0, 400) }
  });
});

app.get("/_healthz", (_, res) => res.json({ ok: true }));
app.get("/_readyz", (_, res) => {
  const missing = [];
  if (!TALK_ORG_ID) missing.push("TALK_ORG_ID");
  if (!TALK_FROM_PHONE) missing.push("TALK_FROM_PHONE");
  if (!TALK_TOKEN) missing.push("TALK_API_TOKEN (apenas necessário para enviar WhatsApp)");
  res.json({ ok: missing.length === 0, missing });
});

// Compat legado
app.get("/health", (_, res) => res.json({ ok: true }));

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
