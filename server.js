import express from "express";
import axios from "axios";
import { chromium } from "@playwright/test";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== ENV (defina no Koyeb) ======
// TALK_API_BASE     ex.: https://app-utalk.umbler.com/api
// TALK_API_TOKEN    ex.: seu_token_umblur
// PORT              (Koyeb usa 8080 por padrão)
const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
const TALK_TOKEN = process.env.TALK_API_TOKEN || "Mix-2025-08-13-2093-08-31--62921E2D9A0FF342106890EEE65177A500E3053FF0566A098178DD368AF642E0";
const PORT = parseInt(process.env.PORT || "8080", 10);
// ====================================

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

async function uploadM3U({ mac, m3uUrl, displayName }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto("https://iptv-4k.live/pt-br/upload-playlist", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Aba "URL"
    const tabURL = page.getByText(/^URL$/i).or(page.getByText(/Link/i));
    if (await tabURL.count()) await tabURL.click();

    // Campo URL
    const urlInput = page.getByLabel(/URL/i)
      .or(page.locator('input[placeholder*="URL" i], input[type="url"]'));
    await urlInput.fill(m3uUrl);

    // Nome (usa MAC)
    const nameInput = page.getByLabel(/Nome|Name/i)
      .or(page.locator('input[placeholder*="Nome" i], input[name*="name" i]'));
    if (await nameInput.count()) await nameInput.fill(displayName || `Cliente ${mac}`);

    // Enviar
    const sendBtn = page.getByRole("button", { name: /Enviar|Upload|Salvar/i });
    await sendBtn.click();

    // Espera curto por feedback
    await page.waitForTimeout(2500);

    // Idempotência
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

// Recebe do Worker: { mac, reply_to }
app.post("/upload", async (req, res) => {
  const { mac, m3uUrl, reply_to } = req.body || {};

  const validMac = normalizeMac(mac);
  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
  if (!m3uUrl) return res.status(400).json({ ok: false, error: "NO_M3U" });
  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });

  const result = await uploadM3U({ mac: validMac, m3uUrl, displayName: `Cliente ${validMac}` });

  if (result.ok) {
    await talkSend({ to: reply_to, text: `✅ Lista enviada para ${validMac}. Verifique na sua TV.` });
    return res.json({ ok: true });
  } else {
    await talkSend({ to: reply_to, text: `❌ Não foi possível concluir para ${validMac}. Tente novamente.` });
    return res.status(502).json({ ok: false, error: result.error || "UPLOAD_FAIL" });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Koyeb uploader ON :${PORT}`));
