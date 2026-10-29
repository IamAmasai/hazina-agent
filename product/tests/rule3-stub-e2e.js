// Rule 3 regression + stub E2E for the Hazina product API.
//
// Runs the REAL handlers (api/login.js, api/data.js, api/extract.js) in
// process against an in-memory stand-in for Supabase REST and the Meta
// Model API — the live-e2e.js flow, step for step, without touching
// production. On top of the happy path it carries the two Rule 3
// regression cases:
//   (b) /api/extract must flag a receipt whose items do not sum to its
//       total (cross_check), never pass the model's JSON through settled.
//   (c) /api/data reconcile must re-verify submitted pairs server-side
//       and drop forged pairs (amount or date disagreement) instead of
//       committing them.
// (Fix (a)'s regression case lives in the pipeline eval, eval/run_eval.py.)
//
//   node tests/rule3-stub-e2e.js
const fs = require("fs");
const crypto = require("crypto");

process.env.HAZINA_SUPABASE_URL = "https://stub.local";
process.env.HAZINA_SUPABASE_SERVICE_KEY = "stub-service-key";
process.env.MODEL_API_KEY = "stub-model-key";

// ---------- in-memory Supabase REST stand-in ----------
const tables = { hz_businesses: [], hz_months: [], hz_txns: [], hz_receipts: [], hz_questions: [], hz_events: [], hz_packs: [] };
const { sha256 } = require("../api/_lib");
const BIZ_ID = "11111111-2222-3333-4444-555555555555";
tables.hz_businesses.push({ id: BIZ_ID, name: "Zuri Beauty (stub)", legal_form: "business_name", income_stream: null, kra_pin: null, owner_name: "Stub Owner", access_code_hash: sha256("e2e-test-2026") });

function rowMatches(row, filters) {
  for (const [col, op, val] of filters) {
    if (op === "eq" && String(row[col]) !== val) return false;
    if (op === "in" && !val.split(",").includes(String(row[col]))) return false;
  }
  return true;
}
function parseQs(qs) {
  const filters = []; let limit = null;
  for (const [k, v] of new URLSearchParams(qs)) {
    if (k === "limit") { limit = parseInt(v, 10); continue; }
    if (k === "select" || k === "order") continue;
    const m = v.match(/^(eq|in)\.(.*)$/);
    if (m) filters.push([k, m[1], m[2].replace(/^\((.*)\)$/, "$1")]);
  }
  return { filters, limit };
}
async function stubFetch(url, opts = {}) {
  const u = String(url);
  if (u.startsWith("https://api.meta.ai/")) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: metaContent } }] }), text: async () => "{}" };
  }
  if (!u.startsWith("https://stub.local/rest/v1/")) throw new Error("unexpected fetch: " + u);
  const rest = u.slice("https://stub.local/rest/v1/".length);
  const [table, qs = ""] = rest.split("?");
  const { filters, limit } = parseQs(qs);
  const method = (opts.method || "GET").toUpperCase();
  let out = null;
  if (method === "GET") {
    out = tables[table].filter(r => rowMatches(r, filters));
    if (limit) out = out.slice(0, limit);
  } else if (method === "POST") {
    const rows = JSON.parse(opts.body || "[]");
    out = rows.map(r => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; tables[table].push(row); return row; });
  } else if (method === "PATCH") {
    const body = JSON.parse(opts.body || "{}");
    out = tables[table].filter(r => rowMatches(r, filters)).map(r => Object.assign(r, body));
  } else if (method === "DELETE") {
    tables[table] = tables[table].filter(r => !rowMatches(r, filters));
    out = null;
  }
  const text = out === null ? "" : JSON.stringify(out);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text || "null") };
}
let metaContent = "{}";
global.fetch = stubFetch;

// ---------- handler invocation ----------
const loginHandler = require("../api/login");
const dataHandler = require("../api/data");
const extractHandler = require("../api/extract");
let cookie = "";
async function call(handler, { method = "POST", body = null, query = {} } = {}) {
  const req = { method, headers: { cookie }, query, body };
  const res = { statusCode: 0, body: null,
    setHeader(k, v) { if (String(k).toLowerCase() === "set-cookie") cookie = String(v).split(";")[0]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; } };
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}
const act = (b) => call(dataHandler, { body: b });
const getMonth = (id) => call(dataHandler, { method: "GET", query: { month: id } });

let passes = 0;
const assert = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (c) passes++; else process.exitCode = 1; };
const MOCK = process.env.HOME + "/workspace/hazina-agent-hackathon/fixtures/mock/";

(async () => {
  // login (same seeded code as live-e2e)
  let r = await call(loginHandler, { body: { code: "e2e-test-2026" } });
  assert(r.status === 200 && r.body.business, "login opens the test workspace");

  // --- regression (b): forced-bad extract response is flagged, not settled
  metaContent = JSON.stringify({ date: "2026-10-17", vendor: "Savanna General Stores", amount_kes: 9999, currency: "KES", items: [{ name: "Towels", amount_kes: 1200 }] });
  r = await call(extractHandler, { body: { image: "data:image/png;base64,AAAA" } });
  assert(r.status === 200 && r.body.cross_check === "items_do_not_sum_to_total" && r.body.items_sum_kes === 1200,
    "REGRESSION(b): bad-sum extraction flagged cross_check=" + (r.body && r.body.cross_check));
  metaContent = JSON.stringify({ date: "2026-10-17", vendor: "Savanna General Stores", amount_kes: 1200, currency: "KES", items: [{ name: "Towels", amount_kes: 1200 }] });
  r = await call(extractHandler, { body: { image: "data:image/png;base64,AAAA" } });
  assert(r.status === 200 && r.body.cross_check === "ok", "extract with summing items passes cross_check=ok");

  // --- happy path, mirroring live-e2e.js ---
  r = await act({ action: "create_month", period: "2026-10" });
  const monthId = r.body.month.id;
  assert(!!monthId, "month 2026-10 created");

  const csv = fs.readFileSync(MOCK + "statement_mpesa_oct2026.csv", "utf8");
  const lines = csv.trim().split("\n").slice(1).filter(Boolean);
  const txns = lines.map((l, i) => {
    const c = l.split(",");
    const pin = parseFloat(c[3]) || 0, pout = parseFloat(c[4]) || 0;
    return { id: "txn-" + String(i + 1).padStart(4, "0"), date: c[0], details: c[2], receipt: c[1], amount: pin || pout, dir: pin ? "in" : "out" };
  });
  r = await act({ action: "import_txns", monthId, txns });
  assert(r.body.count === 22, "statement imported: " + r.body.count + " lines");

  const gt = JSON.parse(fs.readFileSync(MOCK + "ground_truth.json", "utf8"));
  for (const rc of gt.receipts) {
    r = await act({ action: "save_receipt", monthId, receipt: { name: rc.file, vendor: rc.vendor, date: rc.date, amount: rc.amount_kes, items: (rc.items || []).map(i => ({ name: i.name, amount: i.amount_kes })), etims: rc.vendor.includes("GlowLine"), status: "confirmed", sha256: null } });
    if (!r.body.receipt) assert(false, "receipt saved: " + rc.vendor);
  }
  console.log("PASS 5 receipts confirmed"); passes++;

  r = await getMonth(monthId);
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
  assert(r.body.ok === true && r.body.matched === 5 && r.body.dropped === 0, "reconcile committed (" + questions.length + " questions, 0 dropped)");

  r = await getMonth(monthId);
  const catByCode = { QK57DLV109: "transport", QK95CL7712: "wages", QKE5SL4419: "wages", QKN5ST1750: "personal", QKQ7CH2089: "personal" };
  const txnById = Object.fromEntries(r.body.txns.map(t => [t.id, t]));
  for (const q of r.body.questions.filter(q => q.status === "open")) {
    const code = txnById[q.txn_id] && txnById[q.txn_id].receipt_code;
    await act({ action: "answer", monthId, questionId: q.id, category: catByCode[code] || "supplies" });
  }
  console.log("PASS all questions answered"); passes++;

  r = await act({ action: "save_pack", monthId });
  const R = r.body.pack && r.body.pack.results;
  assert(!!R, "pack saved");
  if (R) {
    assert(Math.abs(R.tot - 865.50) < 0.01, "pack TOT = " + R.tot.toFixed(2) + " (expect 865.50)");
    assert(Math.abs(R.gross - 57700) < 0.01, "pack gross = " + R.gross);
    assert(Math.abs(R.profit - (-10420)) < 0.01, "pack profit = " + R.profit + " (expect -10420)");
    assert(R.rulesVersion === "ke-rules-2026-10-28.1", "rules version stamped: " + R.rulesVersion);
    assert(!!(R.inputs && R.inputs.statement_sha256), "input hashes recorded");
  }

  r = await act({ action: "lock_month", monthId });
  assert(r.body.ok === true, "month locked");
  r = await getMonth(monthId);
  assert(r.body.month.status === "closed", "month status = closed");
  r = await act({ action: "add_txn", monthId, direction: "out", amount: 1, details: "should fail" });
  assert(r.status === 409, "closed month refuses changes (409)");

  // --- regression (c): forged reconcile pairs are dropped server-side
  r = await act({ action: "create_month", period: "2026-09" });
  const m2 = r.body.month.id;
  await act({ action: "import_txns", monthId: m2, txns });
  r = await getMonth(m2);
  const outs2 = r.body.txns.filter(t => t.direction === "out");
  const legitTxn = outs2.find(t => Math.abs(t.amount - 13000) <= 0.5);
  const dateTxn = outs2.find(t => t.id !== legitTxn.id && Math.abs(t.amount - 3000) <= 0.5);
  const saveRc = async (receipt) => (await act({ action: "save_receipt", monthId: m2, receipt })).body.receipt;
  const legit = await saveRc({ name: "legit.png", vendor: "GlowLine Beauty Supplies Ltd", date: legitTxn.txn_date, amount: 13000, items: [], status: "confirmed", sha256: null });
  const amountForged = await saveRc({ name: "forged-amount.png", vendor: "Forged Vendor", date: legitTxn.txn_date, amount: 12345, items: [], status: "confirmed", sha256: null });
  const lateDate = new Date(Date.parse(dateTxn.txn_date) + 20 * 86400000).toISOString().slice(0, 10);
  const dateForged = await saveRc({ name: "forged-date.png", vendor: "Forged Dates Ltd", date: lateDate, amount: 3000, items: [], status: "confirmed", sha256: null });
  r = await act({ action: "reconcile", monthId: m2, matches: [
    { receiptId: legit.id, txnId: legitTxn.id },
    { receiptId: amountForged.id, txnId: legitTxn.id },
    { receiptId: dateForged.id, txnId: dateTxn.id },
  ], questions: [] });
  assert(r.body.ok === true && r.body.matched === 1 && r.body.dropped === 2,
    "REGRESSION(c): reconcile verified 1, dropped 2 forged (got matched=" + r.body.matched + " dropped=" + r.body.dropped + ")");
  r = await getMonth(m2);
  const byId = Object.fromEntries(r.body.receipts.map(x => [x.id, x]));
  assert(byId[legit.id].matched_txn_id === legitTxn.id
    && byId[amountForged.id].matched_txn_id === null
    && byId[dateForged.id].matched_txn_id === null,
    "REGRESSION(c): only the conforming pair is committed in the record");

  console.log("STUB E2E DONE — " + passes + " passes");
})().catch(e => { console.error("HARNESS ERROR", e); process.exitCode = 1; });
