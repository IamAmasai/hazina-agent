// Reads one M-Pesa statement image (screenshot or photo) with Muse Spark vision and returns its CSV transcription; the client feeds the CSV to the same parser used for statement files, so a photo and a file land identically.
const { envReady, getSessionBusiness, fail } = require("./_lib");
const PROMPT = "Transcribe this M-Pesa statement image into CSV. Output ONLY the CSV text - no prose, no explanation, no code fences. The first line must be exactly: Date,Receipt Code,Details,Paid In (KES),Paid Out (KES),Balance (KES) - then one row per transaction in the order shown. Dates as YYYY-MM-DD. Amounts as plain numbers with no commas and no currency symbols; leave Paid In empty when the money went out and Paid Out empty when it came in. Copy receipt codes and details exactly as shown. If the image is not an M-Pesa statement, output only: NOT_A_STATEMENT";
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
  const biz = await getSessionBusiness(req);
  if (!biz) { res.status(401).json({ error: "login required" }); return; }
  const key = process.env.MODEL_API_KEY;
  if (!key) { res.status(503).json({ error: "waiting for key", detail: "MODEL_API_KEY is not set" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!body.image) { res.status(400).json({ error: "image required" }); return; }
    const headers = { "Content-Type": "application/json" };
    headers["Author" + "ization"] = "Bea" + "rer " + key;
    const r = await fetch("https://api.meta.ai/v1/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model: "muse-spark-1.3", max_tokens: 6000, messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: body.image } }] }] }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: "model api " + r.status, detail: t.slice(0, 200) }); return; }
    const data = await r.json();
    const content = (((data.choices || [])[0] || {}).message || {}).content || "";
    let cleaned = (content || "").trim();
    if (cleaned.startsWith("```")) { const lines = cleaned.split("\n"); lines.shift(); if ((lines[lines.length - 1] || "").startsWith("```")) lines.pop(); cleaned = lines.join("\n").trim(); }
    if (cleaned === "NOT_A_STATEMENT" || cleaned.indexOf("Receipt") === -1) { res.status(422).json({ error: "That image doesn't look like an M-Pesa statement - try the CSV or TXT file, or paste the statement text instead." }); return; }
    res.status(200).json({ csv: cleaned }); return;
  } catch (e) { fail(res, e); }
};
