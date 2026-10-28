const { envReady, getSessionBusiness, fail } = require("./_lib");

// Reads one receipt image with Muse Spark vision and returns strict JSON.
// Key lives only in the Vercel env (MODEL_API_KEY); without it the endpoint
// answers 503 and the UI falls back to merchant-confirmed entry.
const PROMPT =
  "Extract the data from this receipt or invoice image. Return strict JSON " +
  "only, no prose: {\"date\": \"YYYY-MM-DD\", \"vendor\": string, " +
  "\"amount_kes\": number (the total), \"currency\": \"KES\", " +
  "\"items\": [{\"name\": string, \"amount_kes\": number}]}. " +
  "If there are no itemised lines, items is an empty list.";

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
      body: JSON.stringify({ model: "muse-spark-1.3", max_tokens: 3000, messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: body.image } }] }] }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: "model api " + r.status, detail: t.slice(0, 200) }); return; }
    const data = await r.json();
    const content = (((data.choices || [])[0] || {}).message || {}).content || "";
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (e) { /* fall through */ }
    if (!parsed) { res.status(502).json({ error: "model returned non-JSON" }); return; }
    res.status(200).json(parsed);
  } catch (e) { fail(res, e); }
};
