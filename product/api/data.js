const { envReady, getSessionBusiness, list, insert, patch, del, sha256, logEvent, compute, packText, totCSV, RULES_VERSION, fail } = require("./_lib");

// The workhorse: month bundles out, workspace actions in. Every request is
// scoped to the session's business; a month id from another workspace is a 404.
async function ownMonth(biz, monthId) {
  const rows = await list("hz_months", "id=eq." + monthId + "&select=*");
  const m = rows && rows[0];
  return m && m.business_id === biz.id ? m : null;
}
async function bundle(monthId) {
  const [txns, receipts, questions, events, packs] = await Promise.all([
    list("hz_txns", "month_id=eq." + monthId + "&select=*&order=txn_date.asc,created_at.asc"),
    list("hz_receipts", "month_id=eq." + monthId + "&select=*&order=created_at.asc"),
    list("hz_questions", "month_id=eq." + monthId + "&select=*&order=created_at.asc"),
    list("hz_events", "month_id=eq." + monthId + "&select=*&order=created_at.desc&limit=120"),
    list("hz_packs", "month_id=eq." + monthId + "&select=*&order=created_at.desc&limit=1"),
  ]);
  return { txns: txns || [], receipts: receipts || [], questions: questions || [], events: events || [], pack: (packs || [])[0] || null };
}

module.exports = async (req, res) => {
  if (!envReady()) { res.status(503).json({ error: "waiting for setup" }); return; }
  try {
    const biz = await getSessionBusiness(req);
    if (!biz) { res.status(401).json({ error: "login required" }); return; }

    if (req.method === "GET") {
      const monthId = (req.query && req.query.month) || null;
      if (!monthId) {
        const months = await list("hz_months", "business_id=eq." + biz.id + "&select=*&order=period.desc");
        const packs = months && months.length ? await list("hz_packs", "month_id=in.(" + months.map(m => m.id).join(",") + ")&select=month_id,results,created_at&order=created_at.desc") : [];
        const latest = {};
        for (const p of packs || []) if (!latest[p.month_id]) latest[p.month_id] = p;
        res.status(200).json({ business: { id: biz.id, name: biz.name, legalForm: biz.legal_form, stream: biz.income_stream, kraPin: biz.kra_pin, owner: biz.owner_name }, months: months || [], packs: latest });
        return;
      }
      const month = await ownMonth(biz, monthId);
      if (!month) { res.status(404).json({ error: "month not found" }); return; }
      res.status(200).json({ month, ...(await bundle(monthId)) });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const act = b.action;

    if (act === "create_month") {
      const period = String(b.period || "");
      if (!/^\d{4}-\d{2}$/.test(period)) { res.status(400).json({ error: "period must be YYYY-MM" }); return; }
      const rows = await insert("hz_months", [{ business_id: biz.id, period }]);
      res.status(200).json({ month: rows[0] }); return;
    }

    const month = b.monthId ? await ownMonth(biz, b.monthId) : null;
    if (!month) { res.status(404).json({ error: "month not found" }); return; }
    if (month.status === "closed" && !["reopen_month", "event"].includes(act)) { res.status(409).json({ error: "This month is locked. Reopen it to make changes." }); return; }

    if (act === "import_txns") {
      await del("hz_txns", "month_id=eq." + month.id + "&source=eq.statement");
      const rows = (b.txns || []).slice(0, 5000).map(t => ({
        month_id: month.id, ext_id: String(t.id || ""), txn_date: t.date || null, details: String(t.details || ""), receipt_code: String(t.receipt || ""),
        amount: +t.amount || 0, direction: t.dir === "in" ? "in" : "out", is_business: true, category: null, source: "statement",
      }));
      if (rows.length) await insert("hz_txns", rows);
      await logEvent(month.id, "merchant", "statement_imported", rows.length + " statement lines imported for " + month.period + ".");
      res.status(200).json({ ok: true, count: rows.length }); return;
    }
    if (act === "add_txn") {
      const rows = await insert("hz_txns", [{ month_id: month.id, ext_id: "manual-" + Date.now(), txn_date: b.date || null, details: String(b.details || "Manual entry"), receipt_code: "", amount: Math.abs(+b.amount || 0), direction: b.direction === "in" ? "in" : "out", is_business: true, category: b.category || null, source: "manual" }]);
      await logEvent(month.id, "merchant", "manual_txn", (b.direction === "in" ? "Money in" : "Money out") + " added by hand: " + rows[0].details + " — KSh " + rows[0].amount + ".");
      res.status(200).json({ txn: rows[0] }); return;
    }
    if (act === "set_txn") {
      const upd = {};
      if (typeof b.is_business === "boolean") upd.is_business = b.is_business;
      if (typeof b.category === "string") upd.category = b.category || null;
      const rows = await patch("hz_txns", "id=eq." + b.txnId + "&month_id=eq." + month.id, upd);
      res.status(200).json({ txn: (rows || [])[0] || null }); return;
    }
    if (act === "save_receipt") {
      const r = b.receipt || {};
      const row = { month_id: month.id, file_name: String(r.name || "receipt"), vendor: r.vendor || null, receipt_date: r.date || null, amount: +r.amount || 0, items: Array.isArray(r.items) ? r.items : [], is_etims: !!r.etims, status: r.status || "draft", sha256: r.sha256 || null, matched_txn_id: r.matchedTxn || null };
      let rows;
      if (r.id) rows = await patch("hz_receipts", "id=eq." + r.id + "&month_id=eq." + month.id, row);
      else rows = await insert("hz_receipts", [row]);
      res.status(200).json({ receipt: (rows || [])[0] }); return;
    }
    if (act === "delete_receipt") {
      await del("hz_receipts", "id=eq." + b.receiptId + "&month_id=eq." + month.id);
      res.status(200).json({ ok: true }); return;
    }
    if (act === "reconcile") {
      const matches = b.matches || [], questions = b.questions || [];
      for (const rc of await list("hz_receipts", "month_id=eq." + month.id + "&select=id")) {
        await patch("hz_receipts", "id=eq." + rc.id, { matched_txn_id: null });
      }
      for (const m of matches) await patch("hz_receipts", "id=eq." + m.receiptId + "&month_id=eq." + month.id, { matched_txn_id: m.txnId });
      await del("hz_questions", "month_id=eq." + month.id + "&status=eq.open");
      if (questions.length) await insert("hz_questions", questions.map(q => ({ month_id: month.id, txn_id: q.txnId, question: String(q.text || ""), status: "open" })));
      if (month.status === "open") await patch("hz_months", "id=eq." + month.id, { status: "closing" });
      await logEvent(month.id, "hazi", "reconciled", matches.length + " receipt(s) matched to statement lines; " + questions.length + " payment line(s) need the merchant's word.");
      res.status(200).json({ ok: true }); return;
    }
    if (act === "answer") {
      const qs = await list("hz_questions", "id=eq." + b.questionId + "&month_id=eq." + month.id + "&select=*");
      const q = qs && qs[0];
      if (!q) { res.status(404).json({ error: "question not found" }); return; }
      const cat = String(b.category || "");
      const answer = cat === "personal" ? "Merchant: personal, not a business cost." : cat === "not_sale" ? "Merchant: not a sale — not turnover." : "Merchant: business — " + cat + ".";
      await patch("hz_questions", "id=eq." + q.id, { status: "answered", category: cat, answer, answered_at: new Date().toISOString() });
      if (q.txn_id) await patch("hz_txns", "id=eq." + q.txn_id, { category: cat === "not_sale" ? "not_sale" : cat, is_business: !(cat === "personal" || cat === "not_sale") });
      await logEvent(month.id, "merchant", "answered", q.question + " → " + answer);
      res.status(200).json({ ok: true }); return;
    }
    if (act === "save_pack") {
      const data = await bundle(month.id);
      const R = compute(biz, month.period, data.txns, data.receipts);
      const stmtHash = sha256(data.txns.filter(t => t.source === "statement").map(t => [t.ext_id, t.txn_date, t.amount, t.direction].join("|")).join(";"));
      const inputs = { statement_sha256: stmtHash, receipts: data.receipts.filter(r => r.status === "confirmed").map(r => ({ vendor: r.vendor || r.file_name, sha256: r.sha256 || sha256([r.vendor, r.receipt_date, r.amount].join("|")) })) };
      const results = { ...R, inputs, savedAt: new Date().toISOString() };
      const text = packText(biz, month.period, R, data.questions);
      const csv = totCSV(month.period, R);
      const rows = await insert("hz_packs", [{ month_id: month.id, results, pack_text: text, tot_csv: csv }]);
      await logEvent(month.id, "hazi", "pack_saved", "Filing pack prepared: TOT " + "KSh " + R.tot.toFixed(2) + " on gross " + "KSh " + R.gross.toFixed(2) + " (" + RULES_VERSION + ").");
      res.status(200).json({ pack: rows[0] }); return;
    }
    if (act === "lock_month") {
      const packs = await list("hz_packs", "month_id=eq." + month.id + "&select=id&limit=1");
      if (!packs || !packs.length) { res.status(409).json({ error: "Save the pack before locking the month." }); return; }
      const open = await list("hz_questions", "month_id=eq." + month.id + "&status=eq.open&select=id");
      await patch("hz_months", "id=eq." + month.id, { status: "closed", closed_at: new Date().toISOString() });
      await logEvent(month.id, "merchant", "month_locked", "Month approved and locked by the merchant" + (open && open.length ? " with " + open.length + " open question(s) carried as flags" : "") + ".");
      res.status(200).json({ ok: true }); return;
    }
    if (act === "reopen_month") {
      await patch("hz_months", "id=eq." + month.id, { status: "closing", closed_at: null });
      await logEvent(month.id, "merchant", "month_reopened", "Month reopened for changes.");
      res.status(200).json({ ok: true }); return;
    }
    if (act === "event") {
      await logEvent(month.id, b.actor === "hazi" ? "hazi" : "merchant", String(b.kind || "note"), String(b.detail || ""));
      res.status(200).json({ ok: true }); return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { fail(res, e); }
};
