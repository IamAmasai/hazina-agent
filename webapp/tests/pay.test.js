"use strict";
/* Hazina close payments — unit tests over a stubbed _lib (in-memory
   tables) and the Daraja HTTP seam. Run: node tests/pay.test.js */
const assert = require("node:assert");
const path = require("node:path");

// --- stub ./_lib before _daraja loads it ---
const tables = { hz_months: [], hz_payments: [] };
let seq = 0;
const fakeLib = {
  async list(table, q) {
    let rows = tables[table].slice();
    for (const part of q.split("&")) {
      const [k, v] = part.split("=");
      if (v === undefined) continue;
      if (k === "select" || k === "order" || k === "limit") continue;
      const [field, op] = k.split(".").length > 1 ? [k, "eq"] : [k, "eq"];
      const m = v.match(/^(eq|neq)\.(.*)$/);
      if (m) rows = rows.filter(r => m[1] === "eq" ? String(r[field]) === decodeURIComponent(m[2]) : String(r[field]) !== decodeURIComponent(m[2]));
    }
    if (q.includes("order=created_at.desc")) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const lim = q.match(/limit=(\d+)/);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return rows;
  },
  async insert(table, rows) {
    const out = rows.map(r => ({ id: "row-" + (++seq), created_at: new Date(Date.now() + seq).toISOString(), ...r }));
    tables[table].push(...out);
    return out;
  },
  async patch(table, q, fields) {
    const idPart = q.split("&").find(p => p.startsWith("id=eq."));
    const id = decodeURIComponent(idPart.slice(6));
    const row = tables[table].find(r => r.id === id);
    if (row) Object.assign(row, fields);
    return row ? [row] : [];
  },
  async logEvent() {}
};
const libPath = require.resolve(path.join(__dirname, "..", "api", "_lib.js"));
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: fakeLib };

const daraja = require(path.join(__dirname, "..", "api", "_daraja.js"));

const CFG = { consumerKey: "k", consumerSecret: "s", shortcode: "174379", passkey: "pk", callbackUrl: "https://hazina.ansaitechnologies.co.ke/api/pay", baseUrl: "https://sandbox.safaricom.co.ke", shortcodeType: "paybill", configured: true };
const biz = { id: "biz-1", name: "Test Shop" };
const month1 = { id: "m-1", business_id: "biz-1", period: "2026-10", status: "closed" };
const month2 = { id: "m-2", business_id: "biz-1", period: "2026-11", status: "closing" };

(async () => {
  // pure helpers
  assert.equal(daraja.normalisePhone("0798435456"), "254798435456");
  assert.equal(daraja.normalisePhone("+254 798 435 456"), "254798435456");
  assert.equal(daraja.normalisePhone("123"), "");
  assert.match(daraja.darajaTimestamp(new Date("2026-11-21T08:00:00Z")), /^20261121110000$/); // EAT = UTC+3
  assert.equal(daraja.stkPassword("174379", "pk", "20261121110000"), Buffer.from("174379pk20261121110000").toString("base64"));

  // entitlement: first close free, second due, demo always free
  tables.hz_months = [];
  let ent = await daraja.entitlement(biz, month2);
  assert.equal(ent.free, true); assert.equal(ent.due, false);
  tables.hz_months = [month1];
  ent = await daraja.entitlement(biz, month2);
  assert.equal(ent.due, true); assert.equal(ent.priceKes, 999);
  ent = await daraja.entitlement({ id: "biz-2", name: "Kijiji Groceries (Demo)" }, month2);
  assert.equal(ent.free, true); assert.equal(ent.demo, true);

  // initiate over the stubbed HTTP seam
  let stkCalls = 0;
  daraja.__setHttpForTests(async (url) => {
    if (url.includes("/oauth/")) return { status: 200, body: { access_token: "tok" } };
    stkCalls++;
    return { status: 200, body: { ResponseCode: "0", CheckoutRequestID: "ws_CO_test1", MerchantRequestID: "mr-1" } };
  });
  const sent = await daraja.initiateClosePayment(biz, month2, "254798435456", CFG);
  assert.equal(sent.ok, true); assert.equal(sent.payment.status, "pending"); assert.equal(sent.payment.amount_kes, 999);
  const again = await daraja.initiateClosePayment(biz, month2, "254798435456", CFG);
  assert.equal(again.alreadyPending, true); assert.equal(stkCalls, 1);

  // callback: success confirms with receipt; replay is a duplicate
  const okCb = { CheckoutRequestID: "ws_CO_test1", ResultCode: 0, ResultDesc: "ok", CallbackMetadata: { Item: [{ Name: "Amount", Value: 999 }, { Name: "MpesaReceiptNumber", Value: "QK123ABC" }, { Name: "PhoneNumber", Value: 254798435456 }] } };
  let r = await daraja.applyStkCallback(okCb, new Date().toISOString());
  assert.equal(r.outcome, "confirmed"); assert.equal(r.payment.mpesa_receipt, "QK123ABC"); assert.equal(r.payment.confirmed_via, "stk_callback");
  r = await daraja.applyStkCallback(okCb, new Date().toISOString());
  assert.equal(r.outcome, "duplicate");
  ent = await daraja.entitlement(biz, month2);
  assert.equal(ent.due, false);

  // wrong amount is flagged, never confirmed
  tables.hz_payments.length = 0;
  const sent2 = await daraja.initiateClosePayment(biz, month2, "254798435456", CFG);
  assert.equal(sent2.ok, true);
  r = await daraja.applyStkCallback({ ...okCb, CallbackMetadata: { Item: [{ Name: "Amount", Value: 500 }, { Name: "MpesaReceiptNumber", Value: "QK999" }] } }, new Date().toISOString());
  assert.equal(r.outcome, "amount_mismatch"); assert.equal(r.payment.status, "flagged");

  // failed prompt (user cancelled) -> failed, and a fresh initiate is allowed after
  tables.hz_payments.length = 0;
  await daraja.initiateClosePayment(biz, month2, "254798435456", CFG);
  r = await daraja.applyStkCallback({ CheckoutRequestID: "ws_CO_test1", ResultCode: 1032, ResultDesc: "cancelled" }, new Date().toISOString());
  assert.equal(r.outcome, "failed");

  // reconciliation by query when the callback never arrives
  tables.hz_payments.length = 0;
  const sent3 = await daraja.initiateClosePayment(biz, month2, "254798435456", CFG);
  daraja.__setHttpForTests(async (url) => {
    if (url.includes("/oauth/")) return { status: 200, body: { access_token: "tok" } };
    return { status: 200, body: { ResponseCode: "0", ResultCode: "0", ResultDesc: "completed" } };
  });
  r = await daraja.reconcilePayment(sent3.payment, CFG, new Date().toISOString());
  assert.equal(r.outcome, "confirmed"); assert.equal(r.payment.confirmed_via, "stk_query"); assert.equal(r.payment.mpesa_receipt, undefined);

  // malformed + unknown callbacks
  assert.equal((await daraja.applyStkCallback({ nope: 1 }, new Date().toISOString())).outcome, "malformed");
  assert.equal((await daraja.applyStkCallback({ CheckoutRequestID: "ws_CO_nope", ResultCode: 0, CallbackMetadata: { Item: [] } }, new Date().toISOString())).outcome, "unknown_checkout");

  daraja.__setHttpForTests(null);
  console.log("pay.test.js: all assertions passed");
})().catch(e => { console.error(e); process.exit(1); });
