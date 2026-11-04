// Reset-tools stub E2E: runs the REAL api/data.js handler in-process
// against an in-memory Supabase REST stand-in. Verifies:
//  1. reset_month clears txns/receipts/questions/packs, reopens the month,
//     keeps the month row and writes a month_reset event (trail preserved).
//  2. delete_txn refuses statement lines (400), removes manual lines.
//  3. set_txn refuses amount edits on statement lines (400), edits manual.
//  4. reset_month on a CLOSED month is rejected (409) by the existing guard.
process.env.HAZINA_SUPABASE_URL = "https://stub.local";
process.env.HAZINA_SUPABASE_SERVICE_KEY = "stub";
const lib = require("../api/_lib");
const dataH = require("../api/data");

const BIZ_ID = "11111111-2222-3333-4444-555555555555";
const MONTH_ID = "22222222-3333-4444-5555-666666666666";
const CODE_HASH = lib.sha256("e2e-test-2026");
const COOKIE = "hz_session=" + BIZ_ID + "." + lib.sha256(BIZ_ID + ":" + CODE_HASH);

function seed() {
  return {
    hz_businesses: [{ id: BIZ_ID, name: "Zuri Beauty (stub)", legal_form: "sole", income_stream: "services", access_code_hash: CODE_HASH }],
    hz_months: [{ id: MONTH_ID, business_id: BIZ_ID, period: "2026-08", status: "closing", closed_at: null }],
    hz_txns: [
      { id: "txn-stmt-1", month_id: MONTH_ID, source: "statement", direction: "in", amount: 3200, details: "Sale", txn_date: "2026-08-01" },
      { id: "txn-man-1", month_id: MONTH_ID, source: "manual", direction: "in", amount: 1500, details: "Cash sales", txn_date: "2026-08-02" },
    ],
    hz_receipts: [{ id: "rcpt-1", month_id: MONTH_ID, amount: 800, status: "confirmed" }],
    hz_questions: [{ id: "q-1", month_id: MONTH_ID, status: "open", question: "What was this?" }],
    hz_packs: [{ id: "pack-1", month_id: MONTH_ID, results: {}, pack_text: "x", tot_csv: "y" }],
    hz_events: [{ id: "ev-0", month_id: MONTH_ID, actor: "hazi", kind: "reconciled", detail: "earlier" }],
  };
}
let tables = seed();

const PREFIX = process.env.HAZINA_SUPABASE_URL + "/rest/v1/";
function res(data, status) { status = status || 200; return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }; }
function matches(row, params) {
  for (const [k, v] of params.entries()) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (v.indexOf("eq.") === 0) { if (String(row[k]) !== v.slice(3)) return false; }
    else if (v.indexOf("in.(") === 0) { const set = v.slice(4, -1).split(","); if (!set.includes(String(row[k]))) return false; }
  }
  return true;
}
global.fetch = async (url, opts) => {
  opts = opts || {};
  const s = String(url);
  if (s.indexOf(PREFIX) !== 0) throw new Error("unexpected fetch: " + s);
  const u = new URL(s);
  const segs = u.pathname.split("/");
  const table = segs[segs.length - 1];
  const method = ((opts.method || "GET") + "").toUpperCase();
  if (!tables[table]) tables[table] = [];
  if (method === "GET") return res(tables[table].filter((r) => matches(r, u.searchParams)), 200);
  if (method === "POST") {
    const body = JSON.parse(opts.body || "[]");
    const rows = Array.isArray(body) ? body : [body];
    rows.forEach((r) => { if (!r.id) r.id = "gen-" + Math.random().toString(36).slice(2, 9); tables[table].push(r); });
    return res(rows, 201);
  }
  if (method === "PATCH") {
    const body = JSON.parse(opts.body || "{}");
    const hit = tables[table].filter((r) => matches(r, u.searchParams));
    hit.forEach((r) => Object.assign(r, body));
    return res(hit, 200);
  }
  if (method === "DELETE") {
    tables[table] = tables[table].filter((r) => !matches(r, u.searchParams));
    return res([], 200);
  }
  return res([], 200);
};

function mockRes() {
  return { code: null, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; } };
}
async function call(body) {
  const r = mockRes();
  await dataH({ method: "POST", headers: { cookie: COOKIE }, body, query: {} }, r);
  return r;
}

let pass = 0, failN = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { failN++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}

(async () => {
  // 1. edit protections BEFORE reset
  let r = await call({ action: "set_txn", monthId: MONTH_ID, txnId: "txn-stmt-1", amount: 9999 });
  check("set_txn amount on statement line -> 400", r.code === 400, "got " + r.code);
  r = await call({ action: "set_txn", monthId: MONTH_ID, txnId: "txn-man-1", amount: 2750, details: "Cash sales — corrected", date: "2026-08-03" });
  const man = tables.hz_txns.find((t) => t.id === "txn-man-1");
  check("set_txn on manual line -> 200 + fields updated", r.code === 200 && man.amount === 2750 && man.details === "Cash sales — corrected" && man.txn_date === "2026-08-03", "got " + r.code + " " + JSON.stringify(man));
  r = await call({ action: "set_txn", monthId: MONTH_ID, txnId: "txn-stmt-1", category: "not_sale", is_business: false });
  check("set_txn category on statement line still allowed", r.code === 200, "got " + r.code);

  // 2. delete protections
  r = await call({ action: "delete_txn", monthId: MONTH_ID, txnId: "txn-stmt-1" });
  check("delete_txn on statement line -> 400", r.code === 400, "got " + r.code);
  check("statement line still present", tables.hz_txns.some((t) => t.id === "txn-stmt-1"));
  r = await call({ action: "delete_txn", monthId: MONTH_ID, txnId: "txn-man-1" });
  check("delete_txn on manual line -> 200", r.code === 200, "got " + r.code);
  check("manual line gone", !tables.hz_txns.some((t) => t.id === "txn-man-1"));

  // 3. reset_month
  r = await call({ action: "reset_month", monthId: MONTH_ID });
  check("reset_month -> 200", r.code === 200, "got " + r.code + " " + JSON.stringify(r.body));
  check("txns cleared", tables.hz_txns.filter((t) => t.month_id === MONTH_ID).length === 0);
  check("receipts cleared", tables.hz_receipts.length === 0);
  check("questions cleared", tables.hz_questions.length === 0);
  check("packs cleared", tables.hz_packs.length === 0);
  const m = tables.hz_months.find((x) => x.id === MONTH_ID);
  check("month survives, status open", !!m && m.status === "open", JSON.stringify(m));
  check("reset written to the trail", tables.hz_events.some((e) => e.kind === "month_reset"));
  check("earlier trail preserved", tables.hz_events.some((e) => e.id === "ev-0"));

  // 4. closed month cannot be reset
  tables = seed();
  tables.hz_months[0].status = "closed"; tables.hz_months[0].closed_at = new Date().toISOString();
  r = await call({ action: "reset_month", monthId: MONTH_ID });
  check("reset_month on closed month -> 409", r.code === 409, "got " + r.code);
  check("closed month content untouched", tables.hz_txns.length === 2 && tables.hz_packs.length === 1);

  console.log("\n" + pass + " passed, " + failN + " failed");
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
