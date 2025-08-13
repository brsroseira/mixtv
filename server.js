import express from "express";
const app = express();

const PORT = parseInt(process.env.PORT || "8080", 10);

// ===============================
// Rota simples para gerar link
// ===============================
app.get("/go", (req, res) => {
  const { m3uUrl, mac } = req.query;

  if (!m3uUrl || !mac) {
    return res.status(400).send("Faltando m3uUrl ou mac");
  }

  // Formata o MAC
  const safeMac = mac.match(/.{1,2}/g)?.join(":").toUpperCase();
  
  // Codifica a URL M3U para evitar problemas com caracteres especiais
  const encodedUrl = encodeURI(m3uUrl);

  // HTML simples
  const html = `
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Enviar lista M3U</title>
</head>
<body style="font-family:sans-serif; max-width:600px; margin:20px auto;">
  <h1>Enviar sua lista M3U</h1>
  <p>Clique no botão abaixo para enviar sua lista para a TV.</p>
  <form action="https://iptv-4k.live/pt-br/upload-playlist" method="POST" target="_blank">
    <input type="hidden" name="url" value="${encodedUrl}">
    <input type="hidden" name="name" value="${safeMac ? 'Cliente ' + safeMac : 'Cliente IPTV'}">
    <button type="submit" style="padding:10px 20px; font-size:16px;">📤 Enviar lista</button>
  </form>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ===============================
// Healthcheck
// ===============================
app.get("/health", (_, res) => res.json({ ok: true }));

// ===============================
// Inicia servidor
// ===============================
app.listen(PORT, () => console.log(`Servidor ON na porta ${PORT}`));
