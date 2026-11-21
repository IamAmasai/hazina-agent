const { envReady, list, setSessionCookie, sha256, fail } = require("./_lib");

// Open a workspace with its access code. Only the code's SHA-256 is stored.
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!envReady()) { res.status(503).json({ error: "waiting for setup", detail: "database env not set" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const code = String(body.code || "").trim();
    if (!code) { res.status(400).json({ error: "code required" }); return; }
    const rows = await list("hz_businesses", "access_code_hash=eq." + sha256(code) + "&select=*");
    const biz = rows && rows[0];
    if (!biz) { res.status(401).json({ error: "That code doesn't open a workspace." }); return; }
    setSessionCookie(res, biz);
    res.status(200).json({ ok: true, business: { id: biz.id, name: biz.name } });
  } catch (e) { fail(res, e); }
};
