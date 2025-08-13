import express from "express";
import axios from "axios";

// ====== CONFIG ======
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN || "SEU_TOKEN_AQUI";
const PORT = parseInt(process.env.PORT || "8080", 10);
// ====================

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

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/gerar-link", async (req, res) => {
  const { mac, reply_to } = req.body || {};
  const validMac = normalizeMac(mac);

  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });

  // URL base da lista M3U
  const m3uUrl = `http://aptxu.com/get.php?username=R462rvB7E&password=uw3D6DeJx&type=m3u_plus&output=hls`;
  // Link final para upload
  const finalLink = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(m3uUrl)}&name=Cliente%20${validMac}`;

  // Envia no WhatsApp
  await talkSend({ to: reply_to, text: `📺 Seu link está pronto: ${finalLink}` });

  res.json({ ok: true, link: finalLink });
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Gerador de link ON :${PORT}`));
