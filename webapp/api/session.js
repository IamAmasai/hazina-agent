const { envReady, getSessionBusiness, clearSessionCookie, idPerson, list, fail } = require("./_lib");
const google = require("./_google");
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") { clearSessionCookie(res); res.status(200).json({ ok: true }); return; }
    const biz = await getSessionBusiness(req);
    const person = await idPerson(req);
    /* The Google door: report the verified Google session and the
       businesses linked to its email, so the gate can offer them
       before any workspace session exists. */
    const g = google.getGoogleSession(req);
    let googleBusinesses = null;
    if (g && envReady()) {
      const rows = await list("hz_businesses", "owner_email=eq." + encodeURIComponent(g.email) + "&select=id,name");
      googleBusinesses = (rows || []).map((b) => ({ id: b.id, name: b.name }));
    }
    res.status(200).json({
      env: { db: envReady(), modelKey: !!process.env.MODEL_API_KEY, admin: !!process.env.HAZINA_ADMIN_PASSCODE },
      business: biz ? { id: biz.id, name: biz.name, legalForm: biz.legal_form, stream: biz.income_stream } : null,
      person: person ? { id: person.id, name: person.name } : null,
      google: g ? { name: g.name, email: g.email } : null,
      googleBusinesses,
    });
  } catch (e) { fail(res, e); }
};
