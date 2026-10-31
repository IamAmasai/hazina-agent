const { envReady, idPerson, membershipsFor, setSessionCookie, fail } = require("./_lib");
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
    const person = await idPerson(req);
    if (!person) { res.status(401).json({ error: "no Ansai ID session" }); return; }
    const memberships = await membershipsFor(person.id);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    let chosen = null;
    if (body.businessId) {
      chosen = memberships.find((m) => m.business.id === body.businessId) || null;
    } else if (memberships.length === 1) {
      chosen = memberships[0];
    }
    if (!chosen) {
      if (memberships.length === 0) {
        res.status(403).json({ error: "This Ansai ID isn't a member of any Hazina workspace yet." });
        return;
      }
      res.status(400).json({
        error: "choose a workspace",
        workspaces: memberships.map((m) => ({ id: m.business.id, name: m.business.name, role: m.role })),
      });
      return;
    }
    const biz = chosen.business;
    setSessionCookie(res, biz);
    res.status(200).json({ ok: true, business: { id: biz.id, name: biz.name }, person: { id: person.id, name: person.name } });
  } catch (e) { fail(res, e); }
};
