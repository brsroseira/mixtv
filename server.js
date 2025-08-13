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
// Validação (template – usamos URL direta abaixo, mas mantém por compat.)
const IPTV4K_VALIDATE_URL_TEMPLATE =
  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";

// Envio automático (GET por padrão)
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
  return hex.match(/.{1,2}/g).join(":");
}
const e164BR = n => {
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
function buildM3UFromFields({ base = "http://aptxu.com/get.php", username, password, type = "m3u_plus", output = "hls" }) {
  if (!username || !password) return null;
  const qs = new URLSearchParams({ username, password, type, output });
  return `${base}?${qs.toString()}`;
}

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
/**
 * Retorna "valid" | "invalid" | "unknown"
 * Regra principal: HTTP 404 => invalid (não tenta enviar).
 * Tenta com mac no formato "AA:BB:.." e "AABB..", além de minúsculo.
 */
async function validateMac(mac) {
  const candidates = [mac, mac.replace(/:/g, ""), mac.toLowerCase()];

  const decideBody = (data) => {
    const txt = typeof data === "string" ? data : JSON.stringify(data || "");
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
  };

  for (const macFmt of candidates) {
    const url = `https://api.iptv-4k.live/api/validate_mac?mac=${encodeURIComponent(macFmt)}`;
    try {
      const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000, validateStatus: () => true });

      if (r.status === 404) {
        console.log("validateMac:", macFmt, "-> invalid (404)");
        return "invalid";
      }
      if (r.status >= 200 && r.status < 300) {
        const state = decideBody(r.data);
        console.log("validateMac:", macFmt, "->", state, "status:", r.status);
        if (state !== "unknown") return state;
        continue; // tenta próximo formato se inconclusivo
      }

      console.log("validateMac:", macFmt, "status:", r.status, "=> unknown");
    } catch (e) {
      console.log("validateMac error:", macFmt, e.message);
    }
  }
  return "unknown";
}

/* ========= 4K IPTV: envio ========= */
function looksOk(body) {
  const txt = typeof body === "string" ? body : JSON.stringify(body || "");
  return body === true || body?.ok === true || body?.success === true ||
         String(body?.status || "").toLowerCase() === "ok" ||
         /\b(ok|success|enviado|enviada|atualizada|updated)\b/i.test(txt);
}

async function uploadPlaylist({ mac, url, name }) {
  const target = fill(IPTV4K_UPLOAD_URL_TEMPLATE, { mac, url, name });

  // tentativa primária (GET ou POST conforme env)
  try {
    if (IPTV4K_UPLOAD_METHOD === "GET") {
      const r = await axios.get(target, { headers: BROWSER_HEADERS, timeout: 15000, validateStatus: () => true });
      const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
      console.log("upload GET:", r.status, ok, String(r.data).slice(0, 200));
      if (ok) return { ok: true, status: r.status, raw: r.data, headers: r.headers };
    } else {
      let postUrl = IPTV4K_UPLOAD_URL_TEMPLATE;
      let body, headers = { ...BROWSER_HEADERS };
      if (IPTV4K_UPLOAD_BODY_STYLE === "json") {
        body = { mac, url, name };
        headers["Content-Type"] = "application/json";
      } else if (IPTV4K_UPLOAD_BODY_STYLE === "form") {
        body = new URLSearchParams({ mac, url, name }).toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else {
        postUrl = target; // query
      }
      const r = await axios.post(postUrl, body, { headers, timeout: 15000, validateStatus: () => true });
      const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
      console.log("upload POST:", r.status, ok, String(r.data).slice(0, 200));
      if (ok) return { ok: true, status: r.status, raw: r.data, headers: r.headers };
    }
  } catch (e) {
    console.log("upload primary error:", e.message);
  }

  // fallback automático: POST form
  try {
    const r = await axios.post(
      IPTV4K_UPLOAD_URL_TEMPLATE,
      new URLSearchParams({ mac, url, name }).toString(),
      { headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000, validateStatus: () => true }
    );
    const ok = (r.status >= 200 && r.status < 300 && looksOk(r.data));
    console.log("upload fallback POST-form:", r.status, ok, String(r.data).slice(0, 200));
    if (ok) return { ok: true, status: r.status, raw: r.data, headers: r.headers };
  } catch (e) {
    console.log("upload fallback error:", e.message);
  }

  return { ok: false };
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
    // 1) valida MAC
    const macState = await validateMac(macNorm);

    if (macState === "invalid") {
      // 404 no validate ⇒ não tenta enviar
      await talkSend({
        toPhone: reply_to,
        message: `❌ MAC *${macNorm}* inválido no 4K. Verifique no app e envie novamente (12 dígitos hex, ex.: 78DD125C81EC).`
      });
      return;
    }

    // 2) tenta envio automático se "valid" ou "unknown"
    const up = await uploadPlaylist({ mac: macNorm, url: userM3U, name: `Cliente ${macNorm}` });

    if (up.ok) {
      const prefix = (macState === "valid")
        ? "✅ MAC validado e lista enviada."
        : "✅ Lista enviada (validação prévia não confirmou, mas o envio foi aceito).";
      await talkSend({ toPhone: reply_to, message: `${prefix}\nAbra a TV e verifique.` });
    } else {
      const manual = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(userM3U)}&name=Cliente%20${encodeURIComponent(macNorm)}`;
      const motivo = (macState === "unknown") ? "validação inconclusiva" : "API de envio não confirmou";
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

  const vState = await validateMac(macNorm);
  const up = await uploadPlaylist({ mac: macNorm, url: m3u, name: `Cliente ${macNorm}` });

  res.json({
    ok: true,
    mac: macNorm,
    validate_state: vState,
    upload: { ok: up.ok, status: up.status, snippet: String(up.raw || "").slice(0, 400) }
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
