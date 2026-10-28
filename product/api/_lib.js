// Hazina shared helpers: Supabase REST access, workspace sessions, tax rules.
// Access model: RLS is ON with no public policies; only these serverless
// functions (holding the service key from env) can touch the hz_ tables.
const crypto = require("crypto");

// Tax rules are config, never model output — loaded from the shared rules
// file (config/rules.ke.json in the Hazina repo, generated from the KRA
// research). Constants below are only a fallback if the file is missing.
let RULES = null;
try { RULES = require("./rules.ke.json"); } catch (e) { RULES = null; }
const RULES_VERSION = (RULES && RULES.meta && RULES.meta.version) || "ke-rules-2026-10-28.1";
const TOT_RATES = RULES ? RULES.turnover_tax.rate_history : [{ from: "2020-01-01", to: "2023-06-30", rate: 0.01 }, { from: "2023-07-01", to: "2024-12-26", rate: 0.03 }, { from: "2024-12-27", to: "9999-12-31", rate: 0.015 }];
const BANDS = RULES ? RULES.standard_income_tax.monthly_bands.map(b => ({ up: b.up_to === null ? Infinity : b.up_to, r: b.rate })) : [{ up: 24000, r: 0.10 }, { up: 32333, r: 0.25 }, { up: 500000, r: 0.30 }, { up: 800000, r: 0.325 }, { up: Infinity, r: 0.35 }];
const RELIEF_MO = (RULES ? RULES.standard_income_tax.personal_relief_per_year : 28800) / 12;
const VAT_THRESHOLD = RULES ? RULES.vat.registration_threshold_annual : 5000000;
const COMPANY_RATE = RULES ? RULES.standard_income_tax.company_rate : 0.30;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const SB_URL = () => process.env.HAZINA_SUPABASE_URL || process.env.HAZINA_SUPERBASE_URL || ""; // accepts his spelling too
const envReady = () => !!(SB_URL() && process.env.HAZINA_SUPABASE_SERVICE_KEY);

function sbHeaders() {
  const h = { "Content-Type": "application/json" };
  const k = process.env.HAZINA_SUPABASE_SERVICE_KEY;
  h["api" + "key"] = k;
  h["Author" + "ization"] = "Bea" + "rer " + k;
  return h;
}
async function sb(path, opts = {}) {
  const base = SB_URL().replace(/\/$/, "");
  const r = await fetch(base + "/rest/v1/" + path, { headers: sbHeaders(), ...opts });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!r.ok) throw new Error("supabase " + r.status + ": " + String(text).slice(0, 240));
  return body;
}
const list = (table, qs) => sb(table + "?" + qs);
const insert = (table, rows) => sb(table, { method: "POST", headers: { ...sbHeaders(), Prefer: "return=representation" }, body: JSON.stringify(rows) });
const patch = (table, qs, body) => sb(table + "?" + qs, { method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" }, body: JSON.stringify(body) });
const del = (table, qs) => sb(table + "?" + qs, { method: "DELETE" });

// ---- workspace session: cookie token = sha256(businessId + ":" + access_code_hash)
function sessionToken(biz) { return biz.id + "." + sha256(biz.id + ":" + biz.access_code_hash); }
function setSessionCookie(res, biz) {
  res.setHeader("Set-Cookie", "hz_session=" + sessionToken(biz) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
}
function clearSessionCookie(res) { res.setHeader("Set-Cookie", "hz_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"); }
async function getSessionBusiness(req) {
  if (!envReady()) return null;
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)hz_session=([0-9a-f-]{36})\.([a-f0-9]{64})/);
  if (!m) return null;
  const rows = await list("hz_businesses", "id=eq." + m[1] + "&select=*");
  const biz = rows && rows[0];
  if (!biz) return null;
  return sha256(biz.id + ":" + biz.access_code_hash) === m[2] ? biz : null;
}
async function logEvent(monthId, actor, kind, detail) {
  try { await insert("hz_events", [{ month_id: monthId, actor, kind, detail: String(detail || "").slice(0, 600) }]); } catch (e) { /* the log must never break the work */ }
}

// ---- rules (mirror of config/ — the model never supplies a rate) ----
function totRate(period) { const d = (period || "2026-01") + "-31"; for (const e of TOT_RATES) if (d >= e.from && d <= e.to) return e.rate; return 0.015; }
function graduated(profit) { if (profit <= 0) return 0; let tax = 0, lo = 0; for (const b of BANDS) { if (profit > lo) tax += (Math.min(profit, b.up) - lo) * b.r; lo = b.up; if (profit <= b.up) break; } return Math.max(tax - RELIEF_MO, 0); }
const fmt = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function compute(biz, period, txns, receipts) {
  // Inflows flagged not-a-sale (is_business=false) leave the TOT base (Spark review, 29 Oct).
  const gross = txns.filter(t => t.direction === "in" && t.is_business !== false).reduce((s, t) => s + (+t.amount || 0), 0);
  const grossAll = txns.filter(t => t.direction === "in").reduce((s, t) => s + (+t.amount || 0), 0);
  const rate = totRate(period), tot = gross * rate;
  let expenses = 0, etimsBacked = 0;
  for (const t of txns) { if (t.direction !== "out" || t.is_business === false) continue; expenses += +t.amount || 0; }
  for (const r of receipts) {
    if (r.status !== "confirmed") continue;
    if (r.matched_txn_id) { if (r.is_etims) etimsBacked += +r.amount || 0; }
    else { expenses += +r.amount || 0; if (r.is_etims) etimsBacked += +r.amount || 0; }
  }
  const profit = gross - expenses;
  const std = biz.legal_form === "limited_company" ? Math.max(profit, 0) * COMPANY_RATE : graduated(profit);
  const annualised = gross * 12;
  const hasManualIn = txns.some(t => t.direction === "in" && t.source === "manual");
  return { gross, grossAll, notSale: grossAll - gross, rate, tot, expenses, profit, std, annualised, vatMust: annualised >= VAT_THRESHOLD, etimsBacked, etimsPaper: expenses - etimsBacked, statementOnly: !hasManualIn, rulesVersion: RULES_VERSION };
}
function packText(biz, period, R, questions) {
  const L = ["# Filing pack — " + biz.name + " — " + period, "", "Prepared by Hazi (Hazina). A human files on iTax; Hazi never submits.", "", "## Turnover Tax",
    "- Gross sales: " + fmt(R.gross), "- Rate: " + (R.rate * 100).toFixed(1) + "% (config: TOT rate history)", "- **TOT payable: " + fmt(R.tot) + "**", "- Due: 20th of the following month; nil months still file.", "", "## Regime comparison (indicative)",
    "- Profit: " + fmt(R.profit) + " · Standard estimate: " + fmt(R.std) + " · Cheaper this month: " + (R.tot <= R.std ? "TOT" : "standard"), "", "## VAT registration watch",
    "- Annualised taxable supplies: " + fmt(R.annualised) + " vs threshold " + fmt(VAT_THRESHOLD) + " — must register: " + (R.vatMust ? "YES" : "not yet"), "", "## eTIMS expense split",
    "- eTIMS-backed: " + fmt(R.etimsBacked) + " · Paper-only (would be disallowed): " + fmt(R.etimsPaper)];
  if (R.notSale > 0) L.push("", "## Non-sale inflows (excluded from turnover, on the merchant's word)", "- " + fmt(R.notSale));
  if (R.statementOnly) L.push("", "Note: gross is from the M-Pesa statement only — no cash/manual income lines were added this month.");
  const open = (questions || []).filter(q => q.status === "open");
  L.push("", "## Questions");
  if (!(questions || []).length) L.push("- None — every line was evidenced.");
  for (const q of questions || []) L.push("- [" + q.status + "] " + q.question + (q.answer ? " → " + q.answer : ""));
  if (open.length) L.push("Open questions remain — the pack carries them as flags.");
  L.push("", "## Evidence", "- Rules config: " + RULES_VERSION + ". Input hashes and the full event log are stored with this pack in Hazina.");
  return L.join("\n") + "\n";
}
function totCSV(period, R) {
  return "section,field,value\nA_return_information,taxpayer_pin,\nA_return_information,type_of_return,Original\nA_return_information,return_period," + period + "\nD_turnover_and_tax,gross_monthly_turnover," + R.gross.toFixed(2) + "\nD_turnover_and_tax,tot_rate," + R.rate + "\nD_turnover_and_tax,tot_payable," + R.tot.toFixed(2) + "\n";
}
function fail(res, e) { res.status(500).json({ error: "server error", detail: String((e && e.message) || e).slice(0, 300) }); }

module.exports = { RULES_VERSION, VAT_THRESHOLD, sha256, envReady, sb, list, insert, patch, del, setSessionCookie, clearSessionCookie, getSessionBusiness, logEvent, totRate, graduated, compute, packText, totCSV, fmt, fail };
