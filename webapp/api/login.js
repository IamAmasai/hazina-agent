const { passcodeHash, fail } = require("./_lib");
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  try {
    const h = passcodeHash();
    if (!h) { res.status(200).json({ ok: true, gate: false }); return; }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const given = crypto.createHash("sha256").update(String(body.passcode || "")).digest("hex");
    if (given !== h) { res.status(401).json({ error: "wrong passcode" }); return; }
    res.setHeader("Set-Cookie", "hazi_auth=" + h + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
    res.status(200).json({ ok: true, gate: true });
  } catch (e) { fail(res, e); }
};
