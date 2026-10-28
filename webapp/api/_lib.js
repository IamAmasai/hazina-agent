// Shared helpers for the Hazi API (not a route: underscore prefix).
const crypto = require("crypto");

function passcodeHash() {
  const p = process.env.HAZI_PASSCODE;
  if (!p) return null;
  return crypto.createHash("sha256").update(p).digest("hex");
}

function passcodeOk(req) {
  const h = passcodeHash();
  if (!h) return true; // gate disabled until HAZI_PASSCODE is set
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)hazi_auth=([a-f0-9]{64})/);
  return !!(m && m[1] === h);
}

function fail(res, e) {
  res.status(500).json({ error: "server error", detail: String((e && e.message) || e).slice(0, 300) });
}

module.exports = { passcodeHash, passcodeOk, fail };
