"use strict";
/* The Daraja rail for Hazina close payments (founder ruling 2026-11-12:
   first month completely free; every close after that is KSh 999).
   A close is paid by M-Pesa prompt: the Store sends the prompt, the
   owner enters their PIN, Safaricom's callback confirms — and because
   a callback can go missing, a pending payment is also reconciled by
   STK Query when its status is read. The amount is a server-side
   constant; nothing the client sends can change it. */
const { list, insert, patch, logEvent } = require("./_lib");

const CLOSE_PRICE_KES = 999;

/* ---- Daraja configuration ---- */

function darajaConfig(env) {
  env = env || process.env;
  const cfg = {
    consumerKey: String(env.DARAJA_CONSUMER_KEY || ""),
    consumerSecret: String(env.DARAJA_CONSUMER_SECRET || ""),
    shortcode: String(env.DARAJA_SHORTCODE || ""),
    passkey: String(env.DARAJA_PASSKEY || ""),
    callbackUrl: String(env.DARAJA_CALLBACK_URL || ""),
    baseUrl: String(env.DARAJA_BASE_URL || "https://sandbox.safaricom.co.ke").replace(/\/+$/, ""),
    shortcodeType: String(env.DARAJA_SHORTCODE_TYPE || "paybill") === "till" ? "till" : "paybill"
  };
  cfg.configured = !!(cfg.consumerKey && cfg.consumerSecret && cfg.shortcode && cfg.passkey && cfg.callbackUrl);
  return cfg;
}

function normalisePhone(raw) {
  let d = String(raw == null ? "" : raw).replace(/\D+/g, "");
  if (d.startsWith("0")) d = "254" + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = "254" + d;
  return /^254[17]\d{8}$/.test(d) ? d : "";
}

/* Daraja timestamps are Africa/Nairobi wall time, YYYYMMDDHHmmss. */
function darajaTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(date || new Date());
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return p.year + p.month + p.day + p.hour + p.minute + p.second;
}

function stkPassword(shortcode, passkey, ts) {
  return Buffer.from(String(shortcode) + String(passkey) + String(ts)).toString("base64");
}

function basicHeaders(key, secret) {
  return { Authorization: "Basic " + Buffer.from(String(key) + ":" + String(secret)).toString("base64"), "Content-Type": "application/json" };
}
function bearerHeaders(token) {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

/* ---- HTTP seam (real fetch in production; stubbed in tests) ---- */

let testHttp = null;
async function defaultHttp(url, opts) {
  const res = await fetch(url, opts || {});
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
function httpCall() { return testHttp || defaultHttp; }
function __setHttpForTests(fn) { testHttp = fn || null; }

async function darajaToken(cfg, call) {
  try {
    const t = await call(cfg.baseUrl + "/oauth/v1/generate?grant_type=client_credentials", {
      method: "GET",
      headers: basicHeaders(cfg.consumerKey, cfg.consumerSecret)
    });
    return (t.body && t.body.access_token) || "";
  } catch (e) {
    return "";
  }
}

/* ---- entitlement: who pays for this close ---- */

async function latestPayment(monthId) {
  const rows = await list("hz_payments", "month_id=eq." + monthId + "&select=*&order=created_at.desc&limit=1");
  return (rows || [])[0] || null;
}

async function entitlement(biz, month) {
  const payment = await latestPayment(month.id);
  const base = { priceKes: CLOSE_PRICE_KES, payment };
  if (/\(Demo\)\s*$/.test(String(biz.name || ""))) return { ...base, free: true, demo: true, due: false };
  if (payment && payment.status === "confirmed") return { ...base, free: false, due: false };
  const closed = await list("hz_months", "business_id=eq." + biz.id + "&status=eq.closed&id=neq." + month.id + "&select=id");
  if (!closed || closed.length === 0) return { ...base, free: true, due: false };
  return { ...base, free: false, due: true };
}

/* ---- the prompt ---- */

async function initiateClosePayment(biz, month, phone, cfg) {
  cfg = cfg || darajaConfig();
  if (!cfg.configured) return { ok: false, reason: "not_configured" };
  const existing = await latestPayment(month.id);
  if (existing && existing.status === "pending") {
    return { ok: true, alreadyPending: true, payment: existing };
  }
  const call = httpCall();
  const token = await darajaToken(cfg, call);
  if (!token) return { ok: false, reason: "oauth_failed" };
  const ts = darajaTimestamp(new Date());
  const payload = {
    BusinessShortCode: cfg.shortcode,
    Password: stkPassword(cfg.shortcode, cfg.passkey, ts),
    Timestamp: ts,
    TransactionType: cfg.shortcodeType === "till" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    Amount: CLOSE_PRICE_KES,
    PartyA: phone,
    PhoneNumber: phone,
    CallBackURL: cfg.callbackUrl,
    AccountReference: "HZ" + String(month.period || "").replace("-", ""),
    TransactionDesc: "Hazina close " + String(month.period || "")
  };
  if (cfg.shortcodeType === "till") payload.PartyB = cfg.shortcode;
  let body = null;
  try {
    const r = await call(cfg.baseUrl + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify(payload)
    });
    body = r.body || null;
  } catch (e) {
    return { ok: false, reason: "stk_failed" };
  }
  if (!body || String(body.ResponseCode) !== "0" || !body.CheckoutRequestID) {
    return { ok: false, reason: "stk_refused" };
  }
  const rows = await insert("hz_payments", [{
    business_id: biz.id,
    month_id: month.id,
    amount_kes: CLOSE_PRICE_KES,
    phone,
    checkout_request_id: body.CheckoutRequestID,
    merchant_request_id: body.MerchantRequestID || null,
    status: "pending"
  }]);
  await logEvent(month.id, "merchant", "payment_initiated", "M-Pesa prompt sent for the KSh 999 close payment.");
  return { ok: true, payment: (rows || [])[0] || null };
}

/* ---- the callback ---- */

function parseStkCallback(cb) {
  if (!cb || typeof cb !== "object") return null;
  const checkoutRequestId = cb.CheckoutRequestID || cb.CheckoutRequestId || "";
  const resultCode = Number(cb.ResultCode);
  if (!checkoutRequestId || !Number.isFinite(resultCode)) return null;
  const out = { checkoutRequestId, resultCode, resultDesc: String(cb.ResultDesc || ""), amountKes: null, receipt: "", phone: "" };
  if (resultCode === 0) {
    const items = cb.CallbackMetadata && Array.isArray(cb.CallbackMetadata.Item) ? cb.CallbackMetadata.Item : [];
    const byName = {};
    for (const it of items) if (it && it.Name) byName[it.Name] = it.Value;
    if (byName.Amount != null) out.amountKes = Number(byName.Amount);
    if (byName.MpesaReceiptNumber) out.receipt = String(byName.MpesaReceiptNumber);
    if (byName.PhoneNumber) out.phone = String(byName.PhoneNumber);
  }
  return out;
}

async function applyStkCallback(cb, atIso) {
  const parsed = parseStkCallback(cb);
  if (!parsed) return { outcome: "malformed" };
  const rows = await list("hz_payments", "checkout_request_id=eq." + encodeURIComponent(parsed.checkoutRequestId) + "&select=*");
  const row = (rows || [])[0];
  if (!row) return { outcome: "unknown_checkout" };
  if (row.status === "confirmed") return { outcome: "duplicate", payment: row };
  if (row.status !== "pending") return { outcome: "not_pending", payment: row };
  if (parsed.resultCode !== 0) {
    const upd = await patch("hz_payments", "id=eq." + row.id, { status: "failed", result_code: String(parsed.resultCode), result_desc: parsed.resultDesc });
    await logEvent(row.month_id, "hazi", "payment_failed", "The M-Pesa prompt was not completed (code " + parsed.resultCode + "). The month is still open; the owner can try again.");
    return { outcome: "failed", payment: (upd || [])[0] || row };
  }
  if (parsed.amountKes == null || Number(parsed.amountKes) !== Number(row.amount_kes)) {
    const upd = await patch("hz_payments", "id=eq." + row.id, { status: "flagged", result_code: "amount_mismatch", result_desc: "Callback amount " + parsed.amountKes + " does not match " + row.amount_kes });
    await logEvent(row.month_id, "hazi", "payment_flagged", "A payment callback arrived for the wrong amount and was refused. Nothing was charged to the month.");
    return { outcome: "amount_mismatch", payment: (upd || [])[0] || row };
  }
  const upd = await patch("hz_payments", "id=eq." + row.id, {
    status: "confirmed", confirmed_at: atIso, confirmed_via: "stk_callback",
    mpesa_receipt: parsed.receipt || null
  });
  await logEvent(row.month_id, "hazi", "payment_confirmed", "Close paid: KSh 999 by M-Pesa" + (parsed.receipt ? ", receipt " + parsed.receipt : "") + ".");
  return { outcome: "confirmed", payment: (upd || [])[0] || row };
}

/* ---- STK Query reconciliation (a callback can go missing) ---- */

async function queryStkStatus(payment, cfg) {
  cfg = cfg || darajaConfig();
  if (!cfg.configured) return { state: "unknown", reason: "not_configured" };
  const call = httpCall();
  const token = await darajaToken(cfg, call);
  if (!token) return { state: "unknown", reason: "oauth_failed" };
  const ts = darajaTimestamp(new Date());
  let body = null;
  try {
    const r = await call(cfg.baseUrl + "/mpesa/stkpushquery/v1/query", {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify({
        BusinessShortCode: cfg.shortcode,
        Password: stkPassword(cfg.shortcode, cfg.passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: payment.checkout_request_id
      })
    });
    body = r.body || null;
  } catch (e) {
    return { state: "unknown", reason: "query_failed" };
  }
  if (!body) return { state: "unknown", reason: "empty_response" };
  if (body.errorCode === "500.001.1001" || /being processed/i.test(String(body.errorMessage || ""))) {
    return { state: "pending" };
  }
  if (body.ResultCode == null) return { state: "unknown", reason: "no_result_code" };
  const code = String(body.ResultCode);
  if (code === "0") return { state: "confirmed" };
  return { state: "failed", resultCode: code, resultDesc: String(body.ResultDesc || "") };
}

async function reconcilePayment(payment, cfg, atIso) {
  if (!payment || payment.status !== "pending") return { outcome: "not_pending" };
  await patch("hz_payments", "id=eq." + payment.id, { last_query_at: atIso });
  const q = await queryStkStatus(payment, cfg);
  if (q.state === "confirmed") {
    const upd = await patch("hz_payments", "id=eq." + payment.id, { status: "confirmed", confirmed_at: atIso, confirmed_via: "stk_query" });
    await logEvent(payment.month_id, "hazi", "payment_confirmed", "Close paid: KSh 999 by M-Pesa (confirmed by status check — the payment message did not arrive).");
    return { outcome: "confirmed", payment: (upd || [])[0] || payment };
  }
  if (q.state === "failed") {
    const upd = await patch("hz_payments", "id=eq." + payment.id, { status: "failed", result_code: q.resultCode || null, result_desc: q.resultDesc || null });
    await logEvent(payment.month_id, "hazi", "payment_failed", "The M-Pesa prompt was not completed (code " + (q.resultCode || "?") + ", confirmed by status check). The month is still open; the owner can try again.");
    return { outcome: "failed", payment: (upd || [])[0] || payment };
  }
  return { outcome: q.state === "pending" ? "still_pending" : "unknown", payment };
}

module.exports = {
  CLOSE_PRICE_KES, darajaConfig, normalisePhone, darajaTimestamp, stkPassword,
  entitlement, latestPayment, initiateClosePayment, parseStkCallback,
  applyStkCallback, queryStkStatus, reconcilePayment, __setHttpForTests
};
