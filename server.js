import express from "express";
import axios from "axios";
import { chromium } from "@playwright/test";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== ENV no Koyeb ======
// TALK_API_BASE = https://app-utalk.umbler.com/api
// TALK_API_TOKEN = SEU_TOKEN_UMBLER
// (PORT é injetada pelo Koyeb; usamos fallback 8080)
const TALK_BASE  = process.env.TALK_API_BASE  || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN || "";
const PORT = parseInt(process.env.PORT || "8080", 10);
// ==========================

// Normaliza: aceita AA:BB..., AA-BB..., AABB...
function normalizeMacToNoSep(input = "") {
  const hex = (input.match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
  if (hex.length !== 12) return null;
  return hex; // sem separadores
}

// uTalk: envia mensagem fora do fluxo
async function talkSend({ to, text }) {
  if (!TALK_TOKEN || !to) return;
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

// Automatiza upload no site
async function uploadM3U({ macNoSep, m3uUrl, displayName }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto("https://iptv-4k.live/pt-br/upload-playlist", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    // Seleciona aba URL (se existir)
    const tabURL = page.getByText(/^URL$/i).or(page.getByText(/Link/i));
    if (await tabURL.count()) await tabURL.click();

    // Campo URL da lista
    const urlInput = page.getByLabel(/URL/i)
      .or(page.locator('input[placeholder*="URL" i], input[type="url"]'));
    await urlInput.fill(m3uUrl);

    // Nome/Apelido (usa MAC)
    const nameInput = page.getByLabel(/Nome|Name/i)
      .or(page.locator('input[placeholder*="Nome" i], input[name*="name" i]'));
    if (await nameInput.count()) {
      await nameInput.fill(displayName || `Cliente ${macNoSep}`);
    }

    // Enviar
    const sendBtn = page.getByRole("button", { name: /Enviar|Upload|Salvar/i });
    await sendBtn.click();

    // Aguarda feedback curto
    await page.waitForTimeout(2500);

    // Idempotência: "já existe" = OK
    const existsMsg = await page.getByText(/já existe|existe|duplicad/i).first();
    if (await existsMsg.count()) {
      await browser.close();
      return { ok: true, note: "already_exists" };
    }

    // Erro visível
    const errorMsg = await page.getByText(/erro|falha|inválid|invalido|invalid/i).first();
    if (await errorMsg.count()) {
      const txt = (await errorMsg.textContent().catch(() => ""))?.trim();
      await browser.close();
      return { ok: false, error: `site_error:${txt || "unknown"}` };
    }

    await browser.close();
    return { ok: true };
  } catch (e) {
    try { await browser.close(); } catch {}
    return { ok: false, error: e?.message || "upload_exception" };
  }
}

// Recebe do Worker: { mac, m3uUrl, reply_to }
app.post("/upload", async (req, res) => {
  const { mac, m3uUrl, reply_to } = req.body || {};
  const macNoSep = normalizeMacToNoSep(mac);

  if (!macNoSep)  return res.status(400).json({ ok: false, error: "NO_MAC" });
  if (!m3uUrl)    return res.status(400).json({ ok: false, error: "NO_M3U" });
  if (!reply_to)  return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });

  const result = await uploadM3U({
    macNoSep,
    m3uUrl,
    displayName: `Cliente ${macNoSep}`
  });

  if (result.ok) {
    await talkSend({ to: reply_to, text: `✅ Lista enviada para ${macNoSep}. Verifique na sua TV.` });
    return res.json({ ok: true });
  } else {
    await talkSend({ to: reply_to, text: `❌ Não foi possível concluir para ${macNoSep}. Tente novamente.` });
    return res.status(502).json({ ok: false, error: result.error || "UPLOAD_FAIL" });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Koyeb uploader ON :${PORT}`));
