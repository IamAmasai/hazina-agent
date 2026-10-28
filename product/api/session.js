const { envReady, getSessionBusiness, clearSessionCookie, fail } = require("./_lib");

module.exports = async (req, res) => {
  try {
    if (req.method === "POST") { clearSessionCookie(res); res.status(200).json({ ok: true }); return; }
    const biz = await getSessionBusiness(req);
    res.status(200).json({
      env: { db: envReady(), modelKey: !!process.env.MODEL_API_KEY, admin: !!process.env.HAZINA_ADMIN_PASSCODE },
      business: biz ? { id: biz.id, name: biz.name, legalForm: biz.legal_form, stream: biz.income_stream } : null,
    });
  } catch (e) { fail(res, e); }
};
