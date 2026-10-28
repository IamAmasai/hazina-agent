const { envReady, getSessionBusiness, list, logEvent, compute, fmt, RULES_VERSION, fail } = require("./_lib");

// Ask Hazi: Spark answers questions about ONE month, grounded in that month's
// own record — ledger, receipts, answers, pack, event log — which the server
// assembles. The model never sees another workspace's data, and the figures it
// may quote are the deterministic ones computed here, passed in verbatim.
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
  const biz = await getSessionBusiness(req);
  if (!biz) { res.status(401).json({ error: "login required" }); return; }
  const key = process.env.MODEL_API_KEY;
  if (!key) { res.status(503).json({ error: "waiting for key" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const question = String(body.question || "").trim().slice(0, 500);
    if (!question) { res.status(400).json({ error: "question required" }); return; }
    const months = await list("hz_months", "id=eq." + body.monthId + "&select=*");
    const month = months && months[0];
    if (!month || month.business_id !== biz.id) { res.status(404).json({ error: "month not found" }); return; }
    const [txns, receipts, questions, events, packs] = await Promise.all([
      list("hz_txns", "month_id=eq." + month.id + "&select=*&order=txn_date.asc"),
      list("hz_receipts", "month_id=eq." + month.id + "&select=*"),
      list("hz_questions", "month_id=eq." + month.id + "&select=*"),
      list("hz_events", "month_id=eq." + month.id + "&select=*&order=created_at.desc&limit=25"),
      list("hz_packs", "month_id=eq." + month.id + "&select=results,created_at&order=created_at.desc&limit=1"),
    ]);
    const R = compute(biz, month.period, txns || [], receipts || []);
    const ctx = {
      business: { name: biz.name, legalForm: biz.legal_form, incomeStream: biz.income_stream },
      period: month.period, monthStatus: month.status,
      figures: { grossSales: fmt(R.gross), totPayable: fmt(R.tot), totRate: (R.rate * 100).toFixed(1) + "%", businessCosts: fmt(R.expenses), profit: fmt(R.profit), standardRegimeEstimate: fmt(R.std), annualisedSales: fmt(R.annualised), vatRegistrationRequired: R.vatMust, etimsBackedCosts: fmt(R.etimsBacked), paperOnlyCosts: fmt(R.etimsPaper), nonSaleInflowsExcluded: fmt(R.notSale), grossIsStatementOnly: R.statementOnly, rulesVersion: RULES_VERSION },
      statementLines: (txns || []).map(t => ({ date: t.txn_date, dir: t.direction, amount: +t.amount, details: t.details, category: t.category, countsAsBusiness: t.is_business !== false, source: t.source })),
      receipts: (receipts || []).map(r => ({ vendor: r.vendor || r.file_name, date: r.receipt_date, amount: +r.amount, etims: r.is_etims, status: r.status, matched: !!r.matched_txn_id })),
      questionsAndAnswers: (questions || []).map(q => ({ q: q.question, status: q.status, answer: q.answer })),
      savedPack: packs && packs[0] ? { savedAt: packs[0].created_at } : null,
      recentEvents: (events || []).map(e => ({ actor: e.actor, kind: e.kind, detail: e.detail })),
    };
    const system =
      "You are Hazi, the bookkeeping agent inside Hazina, answering the owner of this business about one month of their books. " +
      "Answer ONLY from the record provided below. Quote figures exactly as given in the record's figures block — never recompute, round differently, or invent a number, a receipt, a rule or a date. " +
      "If the record does not contain the answer, say plainly what is missing and what the owner can do (e.g. add the receipt, answer the open question). " +
      "Tax rules come from versioned config (" + RULES_VERSION + "); you may explain them in plain words but never state a rate that is not in the record. " +
      "Be brief, warm and concrete: 2-5 short sentences, or a short list when listing lines. Use KSh formatting as given. You never file anything and never advise evading tax.";
    const headers = { "Content-Type": "application/json" };
    headers["Author" + "ization"] = "Bea" + "rer " + key;
    const r = await fetch("https://api.meta.ai/v1/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model: "muse-spark-1.3", max_tokens: 6000, messages: [
        { role: "system", content: system },
        { role: "user", content: "THE RECORD (JSON):\n" + JSON.stringify(ctx).slice(0, 24000) + "\n\nTHE OWNER ASKS: " + question },
      ] }),
    });
    if (!r.ok) { const t = await r.text(); res.status(502).json({ error: "model api " + r.status, detail: t.slice(0, 200) }); return; }
    const data = await r.json();
    const answer = ((((data.choices || [])[0] || {}).message || {}).content || "").trim();
    if (!answer) { res.status(502).json({ error: "Hazi returned nothing — try again." }); return; }
    await logEvent(month.id, "merchant", "ask_hazi", question);
    await logEvent(month.id, "hazi", "hazi_answered", answer.slice(0, 400));
    res.status(200).json({ answer });
  } catch (e) { fail(res, e); }
};
