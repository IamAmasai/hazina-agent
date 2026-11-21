"use strict";
/* Close payments for Hazina: the M-Pesa prompt, Safaricom's callback,
   and the status read the close screen polls. The callback arrives
   with no session (Safaricom's servers send it), so it is handled
   before the session gate and matched by CheckoutRequestID only;
   everything else needs the workspace session, exactly like data.js. */
const { envReady, getSessionBusiness, list, fail } = require("./_lib");
const daraja = require("./_daraja");

async function ownMonth(biz, monthId) {
  const rows = await list("hz_months", "id=eq." + monthId + "&select=*");
  const m = rows && rows[0];
  return m && m.business_id === biz.id ? m : null;
}

function slimPayment(p) {
  if (!p) return null;
  return {
    status: p.status,
    amountKes: p.amount_kes,
    phone: p.phone || "",
    mpesaReceipt: p.mpesa_receipt || "",
    confirmedVia: p.confirmed_via || "",
    createdAt: p.created_at
  };
}

module.exports = async (req, res) => {
  if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    /* Daraja's callback cannot sign in — handle it before the gate. */
    if (req.method === "POST" && body.Body && body.Body.stkCallback) {
      const r = await daraja.applyStkCallback(body.Body.stkCallback, new Date().toISOString());
      if (r.outcome === "malformed") { res.status(400).json({ ResultCode: 1, ResultDesc: "Rejected" }); return; }
      if (r.outcome !== "unknown_checkout") { res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" }); return; }
      res.status(401).json({ error: "login required" }); return;
    }

    const biz = await getSessionBusiness(req);
    if (!biz) { res.status(401).json({ error: "login required" }); return; }

    if (req.method === "GET") {
      const monthId = (req.query && req.query.month) || null;
      const month = monthId ? await ownMonth(biz, monthId) : null;
      if (!month) { res.status(404).json({ error: "month not found" }); return; }
      let ent = await daraja.entitlement(biz, month);
      /* Reconcile a pending payment by query when the callback has
         had time to arrive and did not (20s age gate, 15s throttle). */
      const p = ent.payment;
      if (p && p.status === "pending") {
        const nowMs = Date.now();
        const ageMs = nowMs - (Date.parse(p.created_at) || 0);
        const lastMs = Date.parse(p.last_query_at || "") || 0;
        if (ageMs >= 20000 && nowMs - lastMs >= 15000) {
          try { await daraja.reconcilePayment(p, daraja.darajaConfig(), new Date().toISOString()); } catch { /* the read stands */ }
          ent = await daraja.entitlement(biz, month);
        }
      }
      res.status(200).json({ free: ent.free, due: ent.due, priceKes: ent.priceKes, payment: slimPayment(ent.payment) });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    if (body.action === "initiate") {
      const month = body.monthId ? await ownMonth(biz, body.monthId) : null;
      if (!month) { res.status(404).json({ error: "month not found" }); return; }
      if (month.status === "closed") { res.status(409).json({ error: "This month is already locked." }); return; }
      const ent = await daraja.entitlement(biz, month);
      if (ent.free) { res.status(409).json({ error: "This close is free — no payment is due." }); return; }
      if (!ent.due) { res.status(409).json({ error: "This month's close is already paid." }); return; }
      const phone = daraja.normalisePhone(body.phone);
      if (!phone) { res.status(400).json({ error: "A valid M-Pesa phone number is required." }); return; }
      const cfg = daraja.darajaConfig();
      if (!cfg.configured) { res.status(503).json({ error: "M-Pesa payment is not available right now — please tell us at hello@ansaitechnologies.co.ke and we will close this month with you." }); return; }
      const sent = await daraja.initiateClosePayment(biz, month, phone, cfg);
      if (!sent.ok) { res.status(502).json({ error: "M-Pesa could not send the prompt — check the number and try again." }); return; }
      res.status(200).json({ ok: true, alreadyPending: !!sent.alreadyPending, payment: slimPayment(sent.payment) });
      return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { fail(res, e); }
};
