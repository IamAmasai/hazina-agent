const { envReady, list, insert, sha256, fail } = require("./_lib");

// Workspace creation is admin-gated (HAZINA_ADMIN_PASSCODE). v1 is pilot-shaped:
// Ansai creates a workspace per business and hands the owner its access code.
module.exports = async (req, res) => {
  if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
  const admin = process.env.HAZINA_ADMIN_PASSCODE;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!admin || String(body.passcode || "") !== admin) { res.status(401).json({ error: "admin passcode required" }); return; }
    if (req.method === "GET" || body.action === "list") {
      const rows = await list("hz_businesses", "select=id,name,legal_form,income_stream,owner_name,created_at&order=created_at.asc");
      res.status(200).json({ businesses: rows || [] }); return;
    }
    if (req.method === "POST") {
      const name = String(body.name || "").trim(), code = String(body.access_code || "").trim();
      if (!name || code.length < 6) { res.status(400).json({ error: "name and an access code of 6+ characters are required" }); return; }
      const rows = await insert("hz_businesses", [{
        name, legal_form: body.legal_form || "sole_trader", income_stream: body.income_stream || "trading",
        kra_pin: body.kra_pin || null, owner_name: body.owner_name || null, access_code_hash: sha256(code),
      }]);
      res.status(200).json({ ok: true, business: rows[0] }); return;
    }
    res.status(405).json({ error: "method not allowed" });
  } catch (e) { fail(res, e); }
};
