import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG ======
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN || "Mix-2025-08-13-2093-08-31--62921E2D9A0FF342106890EEE65177A500E3053FF0566A098178DD368AF642E0";
const PORT = parseInt(process.env.PORT || "8080", 10);

// ====== FUNÇÕES ======
function normalizeMac(input) {
  const hex = (input?.match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{1,2}/g).join(":");
}

async function talkSend({ to, text }) {
  try {
    await axios.post(
      `${TALK_BASE}/v1/messages/simplified`,
      { to, message: text },
      { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
  } catch (e) {
    console.error("uTalk erro:", e?.response?.data || e.message);
  }
}

// ====== ROTAS ======
// Recebe: { mac, reply_to }
app.post("/gerar-link", async (req, res) => {
  const { mac, reply_to } = req.body || {};

  const validMac = normalizeMac(mac);
  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });

  // M3U fixo
  const m3uUrl = `http://aptxu.com/get.php?username=R462rvB7E&password=uw3D6DeJx&type=m3u_plus&output=hls`;

  // Link pronto para abrir no site
  const finalLink = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(m3uUrl)}&name=Cliente%20${validMac}`;

  // Responde no WhatsApp
  await talkSend({ to: reply_to, text: `✅ Seu link para MAC ${validMac}:\n${finalLink}` });

  return res.json({ ok: true, link: finalLink });
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ====== START ======
app.listen(PORT, () => console.log(`Servidor gerador de link ON :${PORT}`));
