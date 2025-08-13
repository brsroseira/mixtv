@@
-import express from "express";
-import axios from "axios";
-import { chromium } from "@playwright/test";
+import express from "express";
+import axios from "axios";
+import { chromium } from "@playwright/test";
@@
-async function uploadM3U({ mac, m3uUrl, displayName }) {
-  const browser = await chromium.launch({
-    headless: true,
-    args: ["--no-sandbox", "--disable-dev-shm-usage"]
-  });
-  const page = await browser.newPage();
-  page.setDefaultTimeout(30000);
+async function uploadM3U({ mac, m3uUrl, displayName }) {
+  const browser = await chromium.launch({
+    headless: true,
+    args: [
+      "--no-sandbox",
+      "--disable-dev-shm-usage",
+      "--disable-blink-features=AutomationControlled"
+    ]
+  });
+  const context = await browser.newContext({
+    userAgent:
+      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
+    viewport: { width: 1366, height: 768 }
+  });
+  const page = await context.newPage();
+  page.setDefaultTimeout(60000);
@@
-    await page.goto("https://iptv-4k.live/pt-br/upload-playlist", { waitUntil: "domcontentloaded", timeout: 30000 });
+    await page.goto("https://iptv-4k.live/pt-br/upload-playlist", { waitUntil: "load", timeout: 60000 });
+    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
@@
-    const sendBtn = page.getByRole("button", { name: /Enviar|Upload|Salvar/i });
-    await sendBtn.click();
+    const sendBtn = page.getByRole("button", { name: /Enviar|Upload|Salvar/i });
+    await sendBtn.click({ trial: false });
 
-    // Espera curto por feedback
-    await page.waitForTimeout(2500);
+    // Espera por feedback/alertas
+    await page.waitForTimeout(3000);
@@
-  } catch (e) {
-    try { await browser.close(); } catch {}
-    return { ok: false, error: e?.message || "upload_exception" };
+  } catch (e) {
+    console.error("upload_exception:", e?.message);
+    try { await browser.close(); } catch {}
+    return { ok: false, error: e?.message || "upload_exception" };
   }
 }
 
 // Recebe do Worker: { mac, reply_to }
-app.post("/upload", async (req, res) => {
-  const { mac, m3uUrl, reply_to } = req.body || {};
-
-  const validMac = normalizeMac(mac);
-  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
-  if (!m3uUrl) return res.status(400).json({ ok: false, error: "NO_M3U" });
-  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });
-
-  const result = await uploadM3U({ mac: validMac, m3uUrl, displayName: `Cliente ${validMac}` });
-
-  if (result.ok) {
-    await talkSend({ to: reply_to, text: `✅ Lista enviada para ${validMac}. Verifique na sua TV.` });
-    return res.json({ ok: true });
-  } else {
-    await talkSend({ to: reply_to, text: `❌ Não foi possível concluir para ${validMac}. Tente novamente.` });
-    return res.status(502).json({ ok: false, error: result.error || "UPLOAD_FAIL" });
-  }
-});
+app.post("/upload", async (req, res) => {
+  const { mac, m3uUrl, reply_to } = req.body || {};
+
+  const validMac = normalizeMac(mac);
+  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
+  if (!m3uUrl) return res.status(400).json({ ok: false, error: "NO_M3U" });
+  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });
+
+  console.log("upload_req", { mac: validMac, hasM3U: !!m3uUrl, reply_to });
+
+  // 🔸 responde já para não estourar o timeout do edge
+  res.json({ ok: true, accepted: true });
+
+  // 🔸 processa em background e avisa no uTalk
+  (async () => {
+    const result = await uploadM3U({ mac: validMac, m3uUrl, displayName: `Cliente ${validMac}` });
+    if (result.ok) {
+      await talkSend({ to: reply_to, text: `✅ Lista enviada para ${validMac}. Verifique na sua TV.` });
+    } else {
+      await talkSend({ to: reply_to, text: `❌ Não foi possível concluir para ${validMac}. Motivo: ${result.error || "UPLOAD_FAIL"}` });
+    }
+  })().catch(err => console.error("bg_task_error:", err?.message));
+});
