import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ========= uTalk (envs obrigatórias) ========= */
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN;                       // defina no Koyeb
const TALK_ORG_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";   // org id
const TALK_FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354"; // remetente E.164 (+55...)

/* ========= IPTV-4K (configuráveis por env) ========= */
// Validação
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

/* ========= 4K IPTV APIs ========= */
// retorna "valid" | "invalid" | "unknown"
async function validateMac(mac) {
  const url = fill(IPTV4K_VALIDATE_URL_TEMPLATE, { mac });
  try {
    const resp = await axios.get(url, { timeout: 8000, validateStatus: () => true });
    const d = resp.data;

    const yes =
      d === true || d === 1 ||
      d?.valid === true || d?.ok === true || d?.exists === true || d?.success === true ||
      d?.valid === 1   || d?.ok === 1   || d?.exists === 1   || d?.success === 1   ||
      String(d?.status || "").toLowerCase() === "valid" ||
      String(d?.result || "").toLowerCase() === "valid";

    const no =
      d === false || d === 0 ||
      d?.valid === false || d?.ok === false || d?.exists === false || d?.success === false ||
      d?.valid === 0   || d?.ok === 0   || d?.exists === 0   || d?.success === 0 ||
      /invalid|not\s*found|nao\s*encontrado|não\s*encontrado/i.test(JSON.stringify(d) || "");

    const state = yes ? "valid" : (no ? "invalid" : "unknown");
    console.log("validateMac:", mac, "status:", resp.status, "state:", state, "raw:", JSON.stringify(d).slice(0, 160));
    return state;
  } catch (e) {
    console.error("validateMac error:", e.message);
    return "unknown";
  }
}

async function uploadPlaylist({ mac, url, name }) {
  const target = fill(IPTV4K_UPLOAD_URL_TEMPLATE, { mac, url, name });

  try {
    if (IPTV4K_UPLOAD_METHOD === "GET") {
      const resp = await axios.get(target, { timeout: 15000, validateStatus: () => true });
      const d = resp.data;
      const ok = d === true || d?.ok === true || d?.success === true || String(d?.status || "").toLowerCase() === "ok";
      console.log("uploadPlaylist GET status:", resp.status, "ok:", !!ok, "raw:", JSON.stringify(d).slice(0, 160));
      return { ok, status: resp.status, raw: d };
    }

    // POST
    let postUrl = IPTV4K_UPLOAD_URL_TEMPLATE; // base
    let body = undefined;
    let headers = {};
    if (IPTV4K_UPLOAD_BODY_STYLE === "json") {
      body = { mac, url, name };
      headers["Content-Type"] = "application/json";
    } else if (IPTV4K_UPLOAD_BODY_STYLE === "form") {
      const params = new URLSearchParams({ mac, url, name });
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      // "query" → já está tudo em {target}
      postUrl = target;
    }

    const resp = await axios.post(postUrl, body, { timeout: 15000, validateStatus: () => true, headers });
    const d = resp.data;
    const ok = d === true || d?.ok === true || d?.success === true || String(d?.status || "").toLowerCase() === "ok";
    console.log("uploadPlaylist POST status:", resp.status, "ok:", !!ok, "raw:", JSON.stringify(d).slice(0, 160));
    return { ok, status: resp.status, raw: d };
  } catch (e) {
    console.error("uploadPlaylist error:", e.message);
    return { ok: false, error: e.message };
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

  // responde já para não estourar timeout
  res.json({ ok: true, accepted: true });

  // processa em background
  (async () => {
    // 1) validação (pode retornar "invalid"/"unknown")
    const macState = await validateMac(macNorm);

    // 2) tenta envio automático MESMO se a validação não confirmar
    const up = await uploadPlaylist({ mac: macNorm, url: userM3U, name: `Cliente ${macNorm}` });

    if (up.ok) {
      const prefix = (macState === "valid")
        ? "✅ MAC validado e lista enviada."
        : "✅ Lista enviada (validação prévia não confirmou, mas o envio foi aceito).";
      await talkSend({ toPhone: reply_to, message: `${prefix}\nAbra a TV e verifique.` });
    } else {
      const manual = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(userM3U)}&name=Cliente%20${encodeURIComponent(macNorm)}`;
      const motivo =
        macState === "invalid" ? "inválido no 4K" :
        macState === "unknown" ? "validação inconclusiva" :
        "API de envio não confirmou";
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
app.get("/health", (_, res) => res.json({ ok: true }));

/* ========= Start ========= */
app.listen(PORT, () => console.log(`ON :${PORT}`));
