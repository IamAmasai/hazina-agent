"use strict";
/* eTIMS sales invoices for Hazina (helper — not an endpoint).
   Hazina can shape a sale as an eTIMS invoice and render it in eTIMS
   format today. Transmitting it to KRA goes through the eTIMS
   system-to-system (OSCU) route, which needs the workspace's own eTIMS
   credentials — issued to the business by KRA, stored on the workspace
   record (meta.etims). Until a workspace is connected, transmit() is an
   honest no-op: it reports { connected: false } and nothing is sent,
   stamped or invented. No control-unit number or QR payload is ever
   fabricated here — those only ever come back from KRA. */

/* Line items: [{ description, qty, amount }] where amount is the unit
   price in KSh. The total is always computed here, server-side — a
   total sent by the client is never trusted. */
function cleanItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const qty = Math.abs(+it.qty || 0) || 1;
    const amount = Math.abs(+it.amount || 0);
    const description = String(it.description || "").slice(0, 200);
    if (!description && !amount) continue;
    out.push({ description, qty, amount, lineTotal: Math.round(qty * amount * 100) / 100 });
  }
  return out.slice(0, 100);
}
function invoiceTotal(items) {
  return Math.round(cleanItems(items).reduce((s, it) => s + it.lineTotal, 0) * 100) / 100;
}
function invoiceNumber(seq) {
  return "INV-" + String(Math.max(1, Math.floor(+seq || 1))).padStart(4, "0");
}

/* The workspace's eTIMS connection, if KRA has issued one and it has
   been recorded on the workspace. Anything less than a recorded,
   connected credential set counts as not connected. */
function etimsCredentials(biz) {
  const e = biz && biz.meta && typeof biz.meta === "object" ? biz.meta.etims : null;
  if (!e || e.connected !== true || !e.endpoint) return null;
  return { endpoint: String(e.endpoint), clientId: String(e.clientId || ""), clientSecret: String(e.clientSecret || "") };
}

/* The OSCU system-to-system payload shape: who sold (the workspace's
   KRA PIN and name), who bought, and the invoice itself. */
function buildEtimsPayload(invoice, business) {
  const items = cleanItems(invoice.items);
  return {
    seller: { pin: business.kra_pin || "", name: business.name || "" },
    buyer: { name: invoice.buyer_name || "", pin: invoice.buyer_pin || null },
    invoice: {
      number: invoice.number,
      date: String(invoice.created_at || new Date().toISOString()).slice(0, 10),
      currency: "KES",
      items: items.map(it => ({ description: it.description, qty: it.qty, unitPrice: it.amount, amount: it.lineTotal })),
      total: invoiceTotal(items)
    },
    tax: { regime: "turnover_tax", note: "Seller files Turnover Tax at 1.5% of gross sales; no VAT is charged on this invoice." }
  };
}

/* Transmit one invoice to KRA via the workspace's eTIMS connection.
   Not connected → { connected: false } and nothing is sent. Connected →
   the payload is posted to the recorded endpoint; only a response that
   carries KRA's own control number counts as transmitted. */
async function transmit(biz, invoice, httpPost) {
  const creds = etimsCredentials(biz);
  if (!creds) return { connected: false, transmitted: false };
  const post = httpPost || (async (url, body, headers) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
    return { status: r.status, body: parsed };
  });
  const payload = buildEtimsPayload(invoice, biz);
  const headers = creds.clientId ? { "X-Client-Id": creds.clientId, "X-Client-Secret": creds.clientSecret } : {};
  const r = await post(creds.endpoint, payload, headers);
  const cu = r && r.body && (r.body.cuInvoiceNo || r.body.cu_invoice_no);
  if (r && r.status >= 200 && r.status < 300 && cu) {
    return { connected: true, transmitted: true, cuInvoiceNo: String(cu), qrPayload: r.body.qrPayload || r.body.qr_payload || null };
  }
  return { connected: true, transmitted: false, error: "eTIMS did not return a control number (HTTP " + (r && r.status) + ")." };
}

module.exports = { cleanItems, invoiceTotal, invoiceNumber, etimsCredentials, buildEtimsPayload, transmit };
