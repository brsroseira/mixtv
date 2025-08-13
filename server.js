@@
-import axios from "axios";
+import axios from "axios";

 const app = express();
 app.use(express.json({ limit: "1mb" }));

-// ====== CONFIG ======
-const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
-const TALK_TOKEN = process.env.TALK_API_TOKEN || "SEU_TOKEN_AQUI";
-const PORT = parseInt(process.env.PORT || "8080", 10);
+// ====== uTalk ======
+const TALK_BASE = process.env.TALK_API_BASE || "https://app-utalk.umbler.com/api";
+const TALK_TOKEN = process.env.TALK_API_TOKEN;                    // (env no Koyeb)
+const TALK_ORG_ID = process.env.TALK_ORG_ID || "aF3zZgwcLc4qDRuo";
+const TALK_FROM_PHONE = process.env.TALK_FROM_PHONE || "+5573981731354";
+const PORT = parseInt(process.env.PORT || "8080", 10);

@@
-function normalizeMac(input) {
+function normalizeMac(input) {
   const hex = (input?.match(/[0-9a-fA-F]/g) || []).join("").toUpperCase();
   if (hex.length !== 12) return null;
   return hex.match(/.{1,2}/g).join(":");
 }
+const e164BR = n => (String(n).replace(/\D/g,"").startsWith("55") ? `+${String(n).replace(/\D/g,"")}` : `+55${String(n).replace(/\D/g,"")}`);

-async function talkSend({ to, text }) {
+async function talkSend({ toPhone, message }) {
   try {
     await axios.post(
-      `${TALK_BASE}/v1/messages/simplified`,
-      { to, message: text },
-      { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
+      `${TALK_BASE}/v1/messages/simplified`,
+      { toPhone: e164BR(toPhone), fromPhone: TALK_FROM_PHONE, organizationId: TALK_ORG_ID, message },
+      { headers: { Authorization: `Bearer ${TALK_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
     );
   } catch (e) {
     console.error("uTalk erro:", e?.response?.data || e.message);
   }
 }
+
+// -------- IPTV-4K (API) --------
+const VALIDATE_TPL = process.env.IPTV4K_VALIDATE_URL_TEMPLATE || "https://api.iptv-4k.live/api/validate_mac?mac={mac}";
+const UPLOAD_TPL   = process.env.IPTV4K_UPLOAD_URL_TEMPLATE   || "https://api.iptv-4k.live/api/playlist_with_mac?mac={mac}&url={url}&name={name}";
+const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g,(_,k)=> encodeURIComponent(vars[k]??""));
+async function validateMac(mac){
+  const url = fill(VALIDATE_TPL,{mac});
+  const r = await axios.get(url,{timeout:8000,validateStatus:()=>true}).catch(err=>({data:null,status:0,error:err.message}));
+  const d = r.data;
+  const ok = d===true || d?.valid===true || d?.ok===true || d?.exists===true || d?.success===true || String(d?.status||"").toLowerCase()==="valid" || d?.result==="valid";
+  return !!ok;
+}
+async function uploadPlaylist({mac,url,name}){
+  const final = fill(UPLOAD_TPL,{mac,url,name});
+  const r = await axios.get(final,{timeout:15000,validateStatus:()=>true}).catch(err=>({data:null,status:0,error:err.message}));
+  const d = r.data;
+  const ok = d===true || d?.ok===true || d?.success===true || String(d?.status||"").toLowerCase()==="ok";
+  return { ok, raw:d, status:r.status };
+}
+const buildM3U = ({base="http://aptxu.com/get.php",username,password,type="m3u_plus",output="hls"})=>{
+  if(!username||!password) return null;
+  const qs = new URLSearchParams({username,password,type,output});
+  return `${base}?${qs.toString()}`;
+}
+const decodeM3U = b => b?.m3uUrl ?? (b?.m3uUrl_b64 ? Buffer.from(String(b.m3uUrl_b64),"base64").toString("utf8") : (b?.m3uUrl_enc ? decodeURIComponent(String(b.m3uUrl_enc)) : null));

-// Recebe: { mac, reply_to }
-app.post("/gerar-link", async (req, res) => {
-  const { mac, reply_to } = req.body || {};
-  const validMac = normalizeMac(mac);
-  if (!validMac) return res.status(400).json({ ok: false, error: "NO_MAC" });
-  if (!reply_to) return res.status(400).json({ ok: false, error: "NO_REPLY_TO" });
-
-  // M3U fixo
-  const m3uUrl = `http://aptxu.com/get.php?username=R462rvB7E&password=uw3D6DeJx&type=m3u_plus&output=hls`;
-
-  // Link pronto para abrir no site
-  const finalLink = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(m3uUrl)}&name=Cliente%20${validMac}`;
-
-  // Responde no WhatsApp
-  await talkSend({ to: reply_to, text: `✅ Seu link para MAC ${validMac}:\n${finalLink}` });
-
-  return res.json({ ok: true, link: finalLink });
-});
+// Recebe: { mac, reply_to, username/password OU m3uUrl/m3uUrl_b64/m3uUrl_enc }
+app.post("/gerar-link", async (req, res) => {
+  const { mac, reply_to } = req.body || {};
+  const macNorm = normalizeMac(mac);
+  if (!macNorm) return res.status(400).json({ ok:false, error:"NO_MAC" });
+  if (!reply_to) return res.status(400).json({ ok:false, error:"NO_REPLY_TO" });
+
+  // monta M3U do usuário
+  const userM3U = decodeM3U(req.body) || buildM3U({
+    base: req.body?.base,
+    username: req.body?.username,
+    password: req.body?.password,
+    type: req.body?.type,
+    output: req.body?.output
+  });
+  if (!userM3U) return res.status(400).json({ ok:false, error:"NO_M3U" });
+
+  // responde rápido (evita 502)
+  res.json({ ok:true, accepted:true });
+
+  // 1) valida MAC pela API
+  const isValid = await validateMac(macNorm);
+  if (!isValid) {
+    await talkSend({ toPhone: reply_to, message: `❌ MAC *${macNorm}* inválido no 4K. Confira e envie novamente.` });
+    return;
+  }
+  // 2) tenta enviar playlist por API
+  const up = await uploadPlaylist({ mac: macNorm, url: userM3U, name: `Cliente ${macNorm}` });
+  if (up.ok) {
+    await talkSend({ toPhone: reply_to, message: `✅ MAC *${macNorm}* validado e lista enviada. Abra a TV e verifique.` });
+  } else {
+    const manual = `https://iptv-4k.live/pt-br/upload-playlist?url=${encodeURIComponent(userM3U)}&name=Cliente%20${encodeURIComponent(macNorm)}`;
+    await talkSend({ toPhone: reply_to, message: `⚠️ MAC *${macNorm}* válido, mas a API de envio falhou. Tente manualmente:\n${manual}` });
+  }
+});
