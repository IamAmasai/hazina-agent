"use strict";
/* Hazina first-run wizard + eTIMS invoices — tests over a stubbed _lib
   (in-memory tables) and the real data.js handler / _etims helper.
   No live network, no live DB. Run: node tests/etims-wizard.test.js */
const assert = require("node:assert");
const path = require("node:path");

// --- stub ./_lib (and ./_daraja) before data.js loads them ---
const tables = { hz_businesses: [], hz_months: [], hz_txns: [], hz_receipts: [], hz_questions: [], hz_events: [], hz_packs: [], hz_invoices: [] };
let seq = 0;
let currentBiz = null;
const fakeLib = {
  envReady: () => true,
  getSessionBusiness: async () => currentBiz,
  RULES_VERSION: "test-rules",
  sha256: (s) => "sha:" + String(s).length,
  compute: () => ({}), packText: () => "", totCSV: () => "",
  fail: (res, e) => res.status(500).json({ error: "server error", detail: String(e && e.message || e) }),
  async logEvent() {},
  async list(table, q) {
    let rows = (tables[table] || []).slice();
    for (const part of q.split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq), v = part.slice(eq + 1);
      if (k === "select" || k === "order" || k === "limit") continue;
      const m = v.match(/^(eq|neq)\.(.*)$/);
      if (m) { const val = decodeURIComponent(m[2]); rows = rows.filter(r => m[1] === "eq" ? String(r[k]) === val : String(r[k]) !== val); continue; }
      const im = v.match(/^in\.\((.*)\)$/);
      if (im) { const vals = im[1].split(","); rows = rows.filter(r => vals.includes(String(r[k]))); }
    }
    if (q.includes("order=created_at.asc")) rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (q.includes("order=created_at.desc")) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (q.includes("order=period.desc")) rows.sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const lim = q.match(/limit=(\d+)/);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return rows;
  },
  async insert(table, rows) {
    const out = rows.map(r => ({ id: "row-" + (++seq), created_at: new Date(Date.now() + seq * 1000).toISOString(), ...r }));
    tables[table].push(...out);
    return out;
  },
  async patch(table, q, fields) {
    const idPart = q.split("&").find(p => p.startsWith("id=eq."));
    const id = decodeURIComponent(idPart.slice(6));
    const row = (tables[table] || []).find(r => r.id === id);
    if (row) Object.assign(row, fields);
    return row ? [row] : [];
  },
  async del(table, q) {
    const idPart = q.split("&").find(p => p.startsWith("id=eq."));
    if (idPart) { const id = decodeURIComponent(idPart.slice(6)); tables[table] = tables[table].filter(r => r.id !== id); }
    return [];
  }
};
const libPath = require.resolve(path.join(__dirname, "..", "api", "_lib.js"));
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: fakeLib };
const darajaPath = require.resolve(path.join(__dirname, "..", "api", "_daraja.js"));
require.cache[darajaPath] = { id: darajaPath, filename: darajaPath, loaded: true, exports: { entitlement: async () => ({ free: true, due: false, priceKes: 999, payment: null }) } };

const handler = require(path.join(__dirname, "..", "api", "data.js"));
const etims = require(path.join(__dirname, "..", "api", "_etims.js"));

function mockRes() { return { code: null, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } }; }
async function call(method, body, query) {
  const res = mockRes();
  await handler({ method, headers: {}, body: body || {}, query: query || {} }, res);
  return res;
}

(async () => {
  const biz1 = { id: "biz-1", name: "Kijiji Groceries", legal_form: "sole_trader", income_stream: "trading", kra_pin: null, owner_name: "Owner One", access_code_hash: "x", meta: {} };
  const biz2 = { id: "biz-2", name: "Second Shop", legal_form: "sole_trader", income_stream: "trading", kra_pin: "A099999999Z", owner_name: "Owner Two", access_code_hash: "y", meta: {} };
  tables.hz_businesses = [biz1, biz2];
  currentBiz = biz1;

  // --- wizard flag round-trip: unseen → seen, carried by the bundle ---
  let r = await call("GET");
  assert.equal(r.code, 200); assert.equal(r.body.wizardSeen, false);
  r = await call("POST", { action: "set_wizard_seen" });
  assert.equal(r.code, 200); assert.equal(r.body.wizardSeen, true);
  assert.equal(biz1.meta.wizardSeen, true);
  r = await call("GET");
  assert.equal(r.body.wizardSeen, true);

  // --- business details: KRA PIN stored (normalised), junk rejected ---
  r = await call("POST", { action: "set_business_details", kraPin: "a012345678b" });
  assert.equal(r.code, 200); assert.equal(r.body.kraPin, "A012345678B");
  assert.equal(biz1.kra_pin, "A012345678B");
  r = await call("POST", { action: "set_business_details", kraPin: "123" });
  assert.equal(r.code, 400);
  r = await call("GET");
  assert.equal(r.body.business.kraPin, "A012345678B");

  // --- a month to hold the invoices ---
  r = await call("POST", { action: "create_month", period: "2026-11" });
  assert.equal(r.code, 200);
  const month1 = r.body.month;
  assert.equal(month1.business_id, "biz-1");

  // --- invoice total is computed server-side; the client's total is ignored ---
  const items = [{ description: "Sugar 2kg", qty: 2, amount: 1500 }, { description: "Tea leaves", qty: 1, amount: 250.5 }];
  r = await call("POST", { action: "save_invoice", monthId: month1.id, invoice: { buyerName: "Mama Njoroge", buyerPin: "", items, total: 1 } });
  assert.equal(r.code, 200);
  const inv1 = r.body.invoice;
  assert.equal(inv1.total, 3250.5);
  assert.equal(inv1.status, "draft");
  assert.equal(inv1.items[0].lineTotal, 3000);

  // --- numbering: per-workspace sequence INV-0001, INV-0002, … ---
  assert.equal(inv1.number, "INV-0001");
  r = await call("POST", { action: "save_invoice", monthId: month1.id, invoice: { buyerName: "Boda Stage SACCO", items: [{ description: "Airtime", qty: 3, amount: 100 }] } });
  assert.equal(r.body.invoice.number, "INV-0002");
  assert.equal(r.body.invoice.total, 300);

  // a different workspace runs its own sequence from INV-0001
  currentBiz = biz2;
  r = await call("POST", { action: "create_month", period: "2026-11" });
  const month2 = r.body.month;
  r = await call("POST", { action: "save_invoice", monthId: month2.id, invoice: { buyerName: "Client", items: [{ description: "Consult", qty: 1, amount: 5000 }] } });
  assert.equal(r.body.invoice.number, "INV-0001");
  currentBiz = biz1;

  // --- the month bundle carries the invoices ---
  r = await call("GET", null, { month: month1.id });
  assert.equal(r.code, 200);
  assert.equal(r.body.invoices.length, 2);
  assert.equal(r.body.invoices[0].number, "INV-0001");

  // --- render gate: draft → rendered; a rendered invoice can't be edited ---
  r = await call("POST", { action: "set_invoice_status", monthId: month1.id, invoiceId: inv1.id, status: "rendered" });
  assert.equal(r.code, 200); assert.equal(r.body.invoice.status, "rendered");
  r = await call("POST", { action: "save_invoice", monthId: month1.id, invoice: { id: inv1.id, buyerName: "Changed", items } });
  assert.equal(r.code, 409);

  // --- transmit gate: unconnected workspace → connected:false, nothing mutates ---
  const before = JSON.stringify(tables.hz_invoices.find(x => x.id === inv1.id));
  r = await call("POST", { action: "transmit_invoice", monthId: month1.id, invoiceId: inv1.id });
  assert.equal(r.code, 200);
  assert.equal(r.body.connected, false);
  assert.equal(r.body.transmitted, false);
  const after = tables.hz_invoices.find(x => x.id === inv1.id);
  assert.equal(after.status, "rendered");
  assert.equal(after.cu_invoice_no, undefined);
  assert.equal(JSON.stringify(after), before);

  // --- _etims units: totals, numbering, payload shape, transmit gate ---
  assert.equal(etims.invoiceTotal(items), 3250.5);
  assert.equal(etims.invoiceNumber(1), "INV-0001");
  assert.equal(etims.invoiceNumber(12), "INV-0012");
  const payload = etims.buildEtimsPayload(after, biz1);
  assert.equal(payload.seller.pin, "A012345678B");
  assert.equal(payload.seller.name, "Kijiji Groceries");
  assert.equal(payload.buyer.name, "Mama Njoroge");
  assert.equal(payload.invoice.number, "INV-0001");
  assert.equal(payload.invoice.items.length, 2);
  assert.equal(payload.invoice.items[0].amount, 3000);
  assert.equal(payload.invoice.total, 3250.5);

  let t = await etims.transmit(biz1, after);
  assert.deepEqual(t, { connected: false, transmitted: false });
  // connected path: control values come only from the eTIMS response
  const bizConn = { ...biz1, meta: { etims: { connected: true, endpoint: "https://etims.example.test/invoices", clientId: "c", clientSecret: "s" } } };
  t = await etims.transmit(bizConn, after, async () => ({ status: 200, body: { cuInvoiceNo: "CU-2026-0001", qrPayload: "QR-DATA" } }));
  assert.equal(t.transmitted, true); assert.equal(t.cuInvoiceNo, "CU-2026-0001"); assert.equal(t.qrPayload, "QR-DATA");
  t = await etims.transmit(bizConn, after, async () => ({ status: 200, body: {} }));
  assert.equal(t.transmitted, false); // a 200 without a control number is not a transmission

  console.log("etims-wizard.test.js: all assertions passed");
})().catch(e => { console.error(e); process.exit(1); });
