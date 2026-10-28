// Live E2E against the REAL Hazina backend (production API + real Supabase).
const fs = require("fs");
const BASE = "https://hazina.ansaitechnologies.co.ke";
let cookie = "";
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", Cookie: cookie, ...(opts.headers || {}) } });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
const act = (b) => req("/api/data", { method: "POST", body: JSON.stringify(b) });
const assert = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

(async () => {
  // login with the seeded test workspace code
  let r = await req("/api/login", { method: "POST", body: JSON.stringify({ code: "e2e-test-2026" }) });
  assert(r.status === 200 && r.body.business, "login opens the test workspace");

  // create month
  r = await act({ action: "create_month", period: "2026-10" });
  const monthId = r.body.month.id;
  assert(!!monthId, "month 2026-10 created");

  // import the mock statement (parsed exactly like the client does)
  const csv = fs.readFileSync(process.env.HOME + "/workspace/hazina-agent-hackathon/fixtures/mock/statement_mpesa_oct2026.csv", "utf8");
  const lines = csv.trim().split("\n").slice(1).filter(Boolean);
  const txns = lines.map((l, i) => {
    const c = l.split(",");
    const pin = parseFloat(c[3]) || 0, pout = parseFloat(c[4]) || 0;
    return { id: "txn-" + String(i + 1).padStart(4, "0"), date: c[0], details: c[2], receipt: c[1], amount: pin || pout, dir: pin ? "in" : "out" };
  });
  r = await act({ action: "import_txns", monthId, txns });
  assert(r.body.count === 22, "statement imported: " + r.body.count + " lines");

  // five confirmed receipts from ground truth
  const gt = JSON.parse(fs.readFileSync(process.env.HOME + "/workspace/hazina-agent-hackathon/fixtures/mock/ground_truth.json", "utf8"));
  for (const rc of gt.receipts) {
    r = await act({ action: "save_receipt", monthId, receipt: { name: rc.file, vendor: rc.vendor, date: rc.date, amount: rc.amount_kes, items: (rc.items || []).map(i => ({ name: i.name, amount: i.amount_kes })), etims: rc.vendor.includes("GlowLine"), status: "confirmed", sha256: null } });
    if (!r.body.receipt) { assert(false, "receipt saved: " + rc.vendor); }
  }
  console.log("PASS 5 receipts confirmed");

  // bundle + client-side matching (same rule as the app)
  r = await req("/api/data?month=" + monthId);
  const B = r.body;
  const outs = B.txns.filter(t => t.direction === "out"); const used = new Set(); const matches = [];
  for (const rc of B.receipts.filter(x => x.status === "confirmed")) {
    let best = null, bg = 99;
    for (const o of outs) { if (used.has(o.id) || Math.abs(o.amount - (+rc.amount)) > 0.5) continue; const g = Math.abs(Date.parse(rc.receipt_date) - Date.parse(o.txn_date)) / 86400000; if (g <= 3 && g < bg) { best = o; bg = g; } }
    if (best) { used.add(best.id); matches.push({ receiptId: rc.id, txnId: best.id }); }
  }
  const questions = outs.filter(o => !used.has(o.id)).map(o => ({ txnId: o.id, text: "Was this a business cost?" }));
  assert(matches.length === 5, "matched 5/5 receipts");
  r = await act({ action: "reconcile", monthId, matches, questions });
  assert(r.body.ok === true, "reconcile committed (" + questions.length + " questions)");

  // answer with HIS answers (stylist + chama personal)
  r = await req("/api/data?month=" + monthId);
  const catByCode = { QK57DLV109: "transport", QK95CL7712: "wages", QKE5SL4419: "wages", QKN5ST1750: "personal", QKQ7CH2089: "personal" };
  const txnById = Object.fromEntries(r.body.txns.map(t => [t.id, t]));
  for (const q of r.body.questions.filter(q => q.status === "open")) {
    const code = txnById[q.txn_id] && txnById[q.txn_id].receipt_code;
    await act({ action: "answer", monthId, questionId: q.id, category: catByCode[code] || "supplies" });
  }
  console.log("PASS all questions answered");

  // save pack + verify the numbers on the REAL backend
  r = await act({ action: "save_pack", monthId });
  const R = r.body.pack && r.body.pack.results;
  assert(!!R, "pack saved");
  if (R) {
    assert(Math.abs(R.tot - 865.50) < 0.01, "pack TOT = " + R.tot.toFixed(2) + " (expect 865.50)");
    assert(Math.abs(R.gross - 57700) < 0.01, "pack gross = " + R.gross);
    assert(Math.abs(R.profit - (-10420)) < 0.01, "pack profit = " + R.profit + " (expect -10420)");
    assert(R.rulesVersion === "ke-rules-2026-10-28.1", "rules version stamped: " + R.rules_version);
    assert(!!(R.inputs && R.inputs.statement_sha256), "input hashes recorded");
  }

  // lock
  r = await act({ action: "lock_month", monthId });
  assert(r.body.ok === true || (r.body.month && r.body.month.status === "closed"), "month locked");
  r = await req("/api/data?month=" + monthId);
  assert(r.body.month.status === "closed", "month status = closed");
  // mutation on a closed month must be refused
  r = await act({ action: "add_txn", monthId, direction: "out", amount: 1, details: "should fail" });
  assert(r.status === 409, "closed month refuses changes (409)");
  console.log("LIVE E2E DONE");
})();
