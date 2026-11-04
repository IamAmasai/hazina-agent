const { envReady, getSessionBusiness, clearSessionCookie, idPerson, fail } = require("./_lib");
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") { clearSessionCookie(res); res.status(200).json({ ok: true }); return; }
    const biz = await getSessionBusiness(req);
    const person = await idPerson(req);
    res.status(200).json({
      env: { db: envReady(), modelKey: !!process.env.MODEL_API_KEY, admin: !!process.env.HAZINA_ADMIN_PASSCODE },
      business: biz ? { id: biz.id, name: biz.name, legalForm: biz.legal_form, stream: biz.income_stream } : null,
      person: person ? { id: person.id, name: person.name } : null,
    });
  } catch (e) { fail(res, e); }
};
