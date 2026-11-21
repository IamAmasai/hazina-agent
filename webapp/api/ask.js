const { envReady, getSessionBusiness, list, logEvent, compute, fmt, RULES_VERSION, fail, idPerson } = require("./_lib");
const { observeAskHazi } = require("./_threat/emit");

// Ask Hazi: Spark answers questions about ONE month, grounded in that month's
// own record — ledger, receipts, answers, pack, event log — which the server
// assembles, or general questions with no month chosen, grounded in the
// business's months overview plus product knowledge. The model never sees
// another workspace's data, and the figures it may quote are the deterministic
// ones computed here, passed in verbatim.
const PRODUCT_KNOWLEDGE = {
  whatHazinaIs: "Hazina is a bookkeeping product for Kenyan small and micro businesses. Each business has its own workspace, and Hazi — the agent inside Hazina — works the books month by month with the owner.",
  howAMonthWorks: "The month runs import → reconcile → close → filing pack. Import: the owner brings in the M-Pesa or bank statement (file, photo or pasted text) and photos of receipts. Reconcile: Hazi matches receipts to statement lines and asks the owner about every payment line that has no proof. Close: the owner answers the open questions and approves the month. Filing pack: Hazina saves the pack — the month's figures, the Turnover Tax values file for iTax and the evidence trail — and locks the month; a locked month can be reopened if something must change.",
  turnoverTax: "Turnover Tax (TOT) is 1.5% of gross sales, for businesses with annual turnover between KSh 1,000,000 and KSh 25,000,000. It is charged on gross sales with no deductions, it is a final tax, and it is filed and paid monthly by the 20th of the following month. eTIMS is mandatory, and KRA validates returns against eTIMS. Hazina prepares the filing pack; the owner files on iTax — Hazi never files.",
  pricing: "the first month is completely free — the whole month, including the close and the filing pack. After that, each month's close is KSh 999: pay per close, no contract, stop any time.",
  dataHandling: "Records stay in the business's own workspace in Hazina's database in the EU. Photos of receipts and statements are read once to extract the figures and are never kept; only the extracted figures and a fingerprint (hash) of each photo are stored.",
  signIn: "Owners open their workspace with its access code, or with Ansai ID if their Ansai ID is a member of the workspace. There is no email sign-in in Hazina — email is how a business asks for a workspace (hello@ansaitechnologies.co.ke)."
};

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
    // Signal One (monitor-only): watch for agent-attack patterns on this
    // surface. Never blocks, alters or delays the owner's question.
    try { const person = await idPerson(req).catch(() => null); observeAskHazi(question, { boundHuman: person && person.id }); } catch (_) { /* the watch never breaks the product */ }
    let ctx;
    let system;
    let month = null;
    if (body.monthId) {
      const months = await list("hz_months", "id=eq." + body.monthId + "&select=*");
      month = months && months[0];
      if (!month || month.business_id !== biz.id) { res.status(404).json({ error: "month not found" }); return; }
      const [txns, receipts, questions, events, packs] = await Promise.all([
        list("hz_txns", "month_id=eq." + month.id + "&select=*&order=txn_date.asc"),
        list("hz_receipts", "month_id=eq." + month.id + "&select=*"),
        list("hz_questions", "month_id=eq." + month.id + "&select=*"),
        list("hz_events", "month_id=eq." + month.id + "&select=*&order=created_at.desc&limit=25"),
        list("hz_packs", "month_id=eq." + month.id + "&select=results,created_at&order=created_at.desc&limit=1"),
      ]);
      const R = compute(biz, month.period, txns || [], receipts || []);
      ctx = {
        business: { name: biz.name, legalForm: biz.legal_form, incomeStream: biz.income_stream },
        period: month.period, monthStatus: month.status,
        figures: { grossSales: fmt(R.gross), totPayable: fmt(R.tot), totRate: (R.rate * 100).toFixed(1) + "%", businessCosts: fmt(R.expenses), profit: fmt(R.profit), standardRegimeEstimate: fmt(R.std), annualisedSales: fmt(R.annualised), vatRegistrationRequired: R.vatMust, etimsBackedCosts: fmt(R.etimsBacked), paperOnlyCosts: fmt(R.etimsPaper), nonSaleInflowsExcluded: fmt(R.notSale), grossIsStatementOnly: R.statementOnly, rulesVersion: RULES_VERSION },
        statementLines: (txns || []).map(t => ({ date: t.txn_date, dir: t.direction, amount: +t.amount, details: t.details, category: t.category, countsAsBusiness: t.is_business !== false, source: t.source })),
        receipts: (receipts || []).map(r => ({ vendor: r.vendor || r.file_name, date: r.receipt_date, amount: +r.amount, etims: r.is_etims, status: r.status, matched: !!r.matched_txn_id })),
        questionsAndAnswers: (questions || []).map(q => ({ q: q.question, status: q.status, answer: q.answer })),
        savedPack: packs && packs[0] ? { savedAt: packs[0].created_at } : null,
        recentEvents: (events || []).map(e => ({ actor: e.actor, kind: e.kind, detail: e.detail })),
      };
      system =
        "You are Hazi, the bookkeeping agent inside Hazina, answering the owner of this business about one month of their books. " +
        "Answer ONLY from the record provided below. Quote figures exactly as given in the record's figures block — never recompute, round differently, or invent a number, a receipt, a rule or a date. " +
        "If the record does not contain the answer, say plainly what is missing and what the owner can do (e.g. add the receipt, answer the open question). " +
        "Tax rules come from versioned config (" + RULES_VERSION + "); you may explain them in plain words but never state a rate that is not in the record. " +
        "Be brief, warm and concrete: 2-5 short sentences, or a short list when listing lines. Use KSh formatting as given. You never file anything and never advise evading tax.";
    } else {
      const allMonths = await list("hz_months", "business_id=eq." + biz.id + "&select=*&order=period.asc") || [];
      let allTxns = [];
      let allReceipts = [];
      if (allMonths.length) {
        const ids = allMonths.map(m => m.id);
        const [tRows, rRows] = await Promise.all([
          list("hz_txns", "month_id=in.(" + ids.join(",") + ")&select=*"),
          list("hz_receipts", "month_id=in.(" + ids.join(",") + ")&select=*"),
        ]);
        allTxns = tRows || [];
        allReceipts = rRows || [];
      }
      const txnsByMonth = {};
      const receiptsByMonth = {};
      for (const t of allTxns) { (txnsByMonth[t.month_id] = txnsByMonth[t.month_id] || []).push(t); }
      for (const r0 of allReceipts) { (receiptsByMonth[r0.month_id] = receiptsByMonth[r0.month_id] || []).push(r0); }
      let sumGross = 0;
      let sumTot = 0;
      const monthRows = allMonths.map(m => {
        const R = compute(biz, m.period, txnsByMonth[m.id] || [], receiptsByMonth[m.id] || []);
        sumGross += R.gross;
        sumTot += R.tot;
        return { period: m.period, status: m.status, grossSales: fmt(R.gross), totPayable: fmt(R.tot), totRate: (R.rate * 100).toFixed(1) + "%", businessCosts: fmt(R.expenses), profit: fmt(R.profit) };
      });
      ctx = {
        mode: "general",
        business: { name: biz.name, legalForm: biz.legal_form, incomeStream: biz.income_stream },
        months: monthRows,
        totals: { monthsOnRecord: allMonths.length, monthsClosed: allMonths.filter(m => m.status === "closed").length, monthsInProgress: allMonths.filter(m => m.status !== "closed").length, totalGrossSales: fmt(sumGross), totalTotPayable: fmt(sumTot) },
        product: PRODUCT_KNOWLEDGE
      };
      system =
        "You are Hazi, the bookkeeping agent inside Hazina, answering the owner of this business without a specific month chosen. " +
        "Answer general questions about how Hazina works from the record's product block, and questions about this business as a whole from the record's business, months and totals blocks. " +
        "Quote figures exactly as given in the record — never recompute, round differently, or invent a number, a receipt, a rule or a date. " +
        "If the answer needs one month's detail that is not in the record, say so plainly and suggest opening that month and asking there. " +
        "Tax rules come from versioned config (" + RULES_VERSION + ") and the product block; you may explain them in plain words but never state a rate that is not in the record. " +
        "Be brief, warm and concrete: 2-5 short sentences, or a short list when listing months. Use KSh formatting as given. You never file anything and never advise evading tax.";
    }
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
    if (month) {
      await logEvent(month.id, "merchant", "ask_hazi", question);
      await logEvent(month.id, "hazi", "hazi_answered", answer.slice(0, 400));
    }
    res.status(200).json({ answer });
  } catch (e) { fail(res, e); }
};
