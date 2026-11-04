const { envReady, idPerson, membershipsFor, fail } = require("./_lib");
module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }
    if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
    const person = await idPerson(req);
    if (!person) { res.status(401).json({ error: "no Ansai ID session" }); return; }
    const mems = await membershipsFor(person.id);
    res.status(200).json({
      person: { id: person.id, name: person.name },
      workspaces: mems.map((m) => ({ id: m.business.id, name: m.business.name, role: m.role })),
    });
  } catch (e) { fail(res, e); }
};
