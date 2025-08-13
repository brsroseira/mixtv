 import express from "express";
 import axios from "axios";

 const app = express();
 app.use(express.json({ limit: "1mb" }));

 // ===== uTalk =====
 const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
-const TALK_TOKEN = process.env.TALK_API_TOKEN;                 // já configurado no Koyeb
-const ORGANIZATION_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo"; // <- seu orgId
-const FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354";    // <- seu remetente em E.164
+const TALK_TOKEN = process.env.TALK_API_TOKEN;                 // defina no Koyeb
+const ORGANIZATION_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";
+const FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354";

 // ===== IPTV-4K API =====
 // valida MAC
-const IPTV4K_VALIDATE_URL_TEMPLATE =
-  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
-  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";
+const IPTV4K_VALIDATE_URL_TEMPLATE =
+  process.env.IPTV4K_VALIDATE_URL_TEMPLATE ||
+  "https://api.iptv-4k.live/api/validate_mac?mac={mac}";

-// Envio (antes estava usando M3U_URL fixo) — agora vamos aceitar por requisição
-const IPTV4K_UPLOAD_URL_TEMPLATE = process.env.IPTV4K_UPLOAD_URL_TEMPLATE || "";
-const IPTV4K_UPLOAD_METHOD = (process.env.IPTV4K_UPLOAD_METHOD || "GET").toUpperCase(); // GET|POST
-const IPTV4K_UPLOAD_BODY_STYLE = (process.env.IPTV4K_UPLOAD_BODY_STYLE || "query").toLowerCase();
+// Envio automático
+const IPTV4K_UPLOAD_URL_TEMPLATE =
+  process.env.IPTV4K_UPLOAD_URL_TEMPLATE ||
+  "https://api.iptv-4k.live/api/playlist_with_mac?mac={mac}&url={url}&name={name}";
+const IPTV4K_UPLOAD_METHOD = (process.env.IPTV4K_UPLOAD_METHOD || "GET").toUpperCase(); // GET|POST
+const IPTV4K_UPLOAD_BODY_STYLE = (process.env.IPTV4K_UPLOAD_BODY_STYLE || "query").toLowerCase();

 // --------- utils ----------
 function normalizeMac(input) {
   const hex = (input?.match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
   if (hex.length !== 12) return null;
   return hex.match(/.{1,2}/g).join(":");
 }
 function formatBRPhoneE164(n) {
   const digits = String(n || "").replace(/\D/g, "");
   if (digits.startsWith("55")) return `+${digits}`;
   return `+55${digits}`;
 }
 function fillTemplate(tpl, vars) {
   return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
 }
+// aceita m3uUrl puro, url-encoded ou base64
+function decodeM3UFromBody(body) {
+  if (body?.m3uUrl) return String(body.m3uUrl);
+  if (body?.m3uUrl_b64) {
+    try { return Buffer.from(String(body.m3uUrl_b64), "base64").toString("utf8"); } catch {}
+  }
+  if (body?.m3uUrl_enc) {
+    try { return decodeURIComponent(String(body.m3uUrl_enc)); } catch {}
+  }
+  return null;
+}
+// monta m3u a partir de username/password (evita “&” no body)
+function buildM3UFromFields({ base = "http://aptxu.com/get.php", username, password, type = "m3u_plus", output = "hls" }) {
+  if (!username || !password) return null;
+  const qs = new URLSearchParams({ username, password, type, output });
+  return `${base}?${qs.toString()}`;
+}

 async function talkSend({ toPhone, message }) {
   if (!TALK_TOKEN) {
     console.error("Falta TALK_API_TOKEN no ambiente");
     return;
   }
   try {
     await axios.post(
       `${TALK_BASE}/v1/messages/simplified`,
       {
         toPhone: formatBRPhoneE164(toPhone),
         fromPhone: FROM_PHONE,
         organizationId: ORGANIZATION_ID,
         message
       },
       { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
     );
   } catch (e) {
     console.error("uTalk erro:", e?.response?.data || e.message);
   }
 }

 async function validateMacViaApi(mac) {
   const url = fillTemplate(IPTV4K_VALIDATE_URL_TEMPLATE, { mac });
   try {
     const resp = await axios.get(url, { timeout: 8000, validateStatus: () => true });
     const data = resp.data;
     const ok =
       (data === true) || data?.valid === true || data?.ok === true ||
       String(data?.status || "").toLowerCase() === "valid" ||
       data?.exists === true || data?.success === true || data?.result === "valid";
     return { ok: Boolean(ok), status: resp.status, raw: data };
   } catch (e) {
     return { ok: false, error: e.message };
   }
 }

 async function uploadViaApi({ mac, url, name }) {
   if (!IPTV4K_UPLOAD_URL_TEMPLATE) return { ok: false, error: "NO_UPLOAD_TEMPLATE" };

   const filled = fillTemplate(IPTV4K_UPLOAD_URL_TEMPLATE, { mac, url, name });

   try {
     if (IPTV4K_UPLOAD_METHOD === "GET") {
       const resp = await axios.get(filled, { timeout: 15000, validateStatus: () => true });
       const data = resp.data;
       const ok =
         (data === true) || data?.ok === true || data?.success === true ||
         String(data?.status || "").toLowerCase() === "ok";
       return { ok: Boolean(ok), status: resp.status, raw: data };
     } else {
       let axiosConf = { timeout: 15000, validateStatus: () => true };
       let postUrl = filled;
       let body = null;
       let headers = {};
       if (IPTV4K_UPLOAD_BODY_STYLE === "json") {
         postUrl = IPTV4K_UPLOAD_URL_TEMPLATE;
         body = { mac, url, name };
         headers["Content-Type"] = "application/json";
       } else if (IPTV4K_UPLOAD_BODY_STYLE === "form") {
         postUrl = IPTV4K_UPLOAD_URL_TEMPLATE;
         const params = new URLSearchParams({ mac, url, name });
         body = params.toString();
         headers["Content-Type"] = "application/x-www-form-urlencoded";
       }
       const resp = await axios.post(postUrl, body, { ...axiosConf, headers });
       const data = resp.data;
       const ok =
         (data === true) || data?.ok === true || data?.success === true ||
         String(data?.status || "").toLowerCase() === "ok";
       return { ok: Boolean(ok), status: resp.status, raw: data };
     }
   } catch (e) {
     return { ok: false, error: e.message };
   }
 }

-// ===== Endpoint: validar e enviar link (antes usava M3U_URL fixo) =====
+// ===== Endpoint: validar e ENVIAR com M3U por usuário =====
 app.post("/gerar-link", async (req, res) => {
-  const { mac, reply_to } = req.body || {};
+  const { mac, reply_to } = req.body || {};
   const validMac = normalizeMac(mac);
-  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
-  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });
+  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
+  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });
+
+  // M3U por requisição (prioridades: m3uUrl / b64 / enc) ou (username/password)
+  const userM3U =
+    decodeM3UFromBody(req.body) ||
+    buildM3UFromFields({
+      base: req.body?.base,      // opcional (default aptxu)
+      username: req.body?.username,
+      password: req.body?.password,
+      type: req.body?.type,
+      output: req.body?.output
+    });
+  if (!userM3U) return res.status(400).json({ ok: false, error: "NO_M3U" });

   // responde rápido pro caller
   res.json({ ok: true, accepted: true });

   // valida MAC via API
   const check = await validateMacViaApi(validMac);
   if (!check.ok) {
     await talkSend({ toPhone: reply_to, message: `❌ MAC *${validMac}* não validado. Tente novamente.` });
     return;
   }

   // tenta enviar via API do 4K
-  // (antes usava M3U_URL env — removido)
-  const m3uUrl = M3U_URL;
-  const finalLink = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(m3uUrl)}&name=Cliente%20${validMac}`;
-  const up = await uploadViaApi({ mac: validMac, url: m3uUrl, name: `Cliente ${validMac}` });
+  const up = await uploadViaApi({ mac: validMac, url: userM3U, name: `Cliente ${validMac}` });

   if (up.ok) {
     await talkSend({
       toPhone: reply_to,
-      message: `✅ MAC *${validMac}* válido e lista enviada.\nAbra a TV e verifique.`
+      message: `✅ MAC *${validMac}* válido e lista enviada.\nAbra a TV e verifique.`
     });
   } else {
-    await talkSend({
-      toPhone: reply_to,
-      message: `⚠️ MAC *${validMac}* válido, mas não consegui enviar automaticamente (API retornou erro).\nVocê pode tentar manualmente por aqui:\n${finalLink}`
-    });
+    const manual = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(userM3U)}&name=Cliente%20${encodeURIComponent(validMac)}`;
+    await talkSend({ toPhone: reply_to, message: `⚠️ MAC *${validMac}* válido, mas não consegui enviar automaticamente.\nEnvie manualmente:\n${manual}` });
   }
 });
