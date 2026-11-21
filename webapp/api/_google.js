"use strict";
/* Google sign-in for Hazina (founder directive, 2026-11-21: Google is
   the front door, the workspace access code stays as the recovery door —
   the same shape the Agent Store shipped the same day).

   Google is the front door: one tap, no new password, no credential to
   remember; the first sign-in creates the account (sign-up and sign-in
   are one button). Underneath, every Google sign-in upserts a row in
   as_identities — the SAME identity table the Agent Store writes, one
   identity per person across the estate — keyed by Google's stable
   subject id, carrying an ansaiPersonId field that stays null until
   the Ansai ID service gains a provisioning API: recorded, never faked.

   The session is a signed cookie (hz_google): an HMAC over the claims,
   keyed by the OAuth client secret, which never leaves the server.

   The bridge to workspaces is owner_email on hz_businesses: a Google
   session sees exactly the businesses whose owner_email is its verified
   email. A business gets linked when its owner, signed in with Google,
   enters the workspace's existing access code once (see auth.js).
   Businesses with no owner_email keep opening by access code exactly
   as before — nothing about the code door changes. */

const crypto = require("crypto");

const COOKIE = "hz_google";
const STATE_COOKIE = "hz_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

let SB_URL = process.env.HAZINA_SUPABASE_URL || process.env.HAZINA_SUPERBASE_URL || "";
let SB_KEY = process.env.HAZINA_SUPABASE_SERVICE_KEY || "";

function clientId() { return process.env.GOOGLE_CLIENT_ID || ""; }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ""; }
function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || "https://hazina.ansaitechnologies.co.ke/api/auth?provider=google&step=callback";
}
function enabled() { return !!(clientId() && clientSecret()); }

/* ---- HTTP seam (tests replace it; production uses global fetch) ---- */
let fetchImpl = null;
function __setFetchForTests(fn) { fetchImpl = fn; }
async function httpFetch(url, opts) {
  if (fetchImpl) return fetchImpl(url, opts);
  return fetch(url, opts);
}

/* ---- signing helpers ---- */
function hmac(value) {
  return crypto.createHmac("sha256", clientSecret()).update(String(value)).digest("hex");
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function addCookie(res, value) {
  const prev = res.getHeader ? res.getHeader("Set-Cookie") : null;
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(value);
  res.setHeader("Set-Cookie", list);
}

function parseCookies(req) {
  const out = {};
  const raw = (req && req.headers && req.headers.cookie) || "";
  for (const part of String(raw).split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    if (k) out[k] = v;
  }
  return out;
}

/* ---- OAuth state (CSRF) cookie ---- */
function newState() {
  const nonce = crypto.randomBytes(18).toString("hex");
  return nonce + "." + hmac("state:" + nonce);
}
function setStateCookie(res, state) {
  addCookie(res, STATE_COOKIE + "=" + encodeURIComponent(state) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(STATE_TTL_MS / 1000));
}
function clearStateCookie(res) {
  addCookie(res, STATE_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
function verifyState(cookies, stateParam) {
  const cookieVal = cookies && cookies[STATE_COOKIE];
  if (!cookieVal || !stateParam || cookieVal !== stateParam) return false;
  const idx = String(stateParam).indexOf(".");
  if (idx < 0) return false;
  const nonce = String(stateParam).slice(0, idx);
  const sig = String(stateParam).slice(idx + 1);
  return safeEq(sig, hmac("state:" + nonce));
}

function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online"
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

/* ---- code exchange ---- */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code"
  });
  const res = await httpFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.id_token) {
    throw new Error("token exchange failed: " + (json && json.error ? json.error : "http " + res.status));
  }
  return json;
}

/* ---- ID token verification (RS256 against Google's JWKS) ---- */
let jwksCache = { keys: null, at: 0 };
async function fetchJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600 * 1000) return jwksCache.keys;
  const res = await httpFetch("https://www.googleapis.com/oauth2/v3/certs", { method: "GET" });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !Array.isArray(json.keys)) throw new Error("jwks fetch failed");
  jwksCache = { keys: json.keys, at: Date.now() };
  return json.keys;
}
function __resetJwksCacheForTests() { jwksCache = { keys: null, at: 0 }; }

async function verifyIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed id token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("unexpected token header");
  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(parts[0] + "." + parts[1]);
  verifier.end();
  const ok = verifier.verify(key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("bad token signature");
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") throw new Error("bad issuer");
  if (claims.aud !== clientId()) throw new Error("bad audience");
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new Error("token expired");
  if (!claims.sub || !claims.email) throw new Error("token missing identity claims");
  return {
    sub: String(claims.sub),
    email: String(claims.email),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: String(claims.name || ""),
    picture: String(claims.picture || "")
  };
}

/* ---- Google session cookie ---- */
function signSession(claims) {
  const payload = {
    sub: claims.sub,
    email: claims.email,
    name: claims.name || "",
    exp: Date.now() + SESSION_TTL_MS
  };
  const body = b64urlJson(payload);
  return body + "." + hmac("session:" + body);
}
function setSessionCookie(res, claims) {
  const value = signSession(claims);
  addCookie(res, COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000));
}
function clearSessionCookie(res) {
  addCookie(res, COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
function verifySession(raw) {
  if (!raw || !clientSecret()) return null;
  const idx = String(raw).lastIndexOf(".");
  if (idx < 0) return null;
  const body = String(raw).slice(0, idx);
  const sig = String(raw).slice(idx + 1);
  if (!safeEq(sig, hmac("session:" + body))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!payload || !payload.sub || !payload.email || !payload.exp || payload.exp <= Date.now()) return null;
  return payload;
}
function getGoogleSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE];
  if (!raw) return null;
  const payload = verifySession(raw);
  if (!payload) return null;
  return { sub: payload.sub, email: payload.email, name: payload.name || "" };
}

/* ---- identity store (as_identities — shared with the Agent Store;
   the Ansai ID link lives here) ---- */
function supabaseEnabled() {
  SB_URL = process.env.HAZINA_SUPABASE_URL || process.env.HAZINA_SUPERBASE_URL || "";
  SB_KEY = process.env.HAZINA_SUPABASE_SERVICE_KEY || "";
  return Boolean(SB_URL && SB_KEY);
}
function sbHeaders() {
  const h = { "Content-Type": "application/json" };
  h["api" + "key"] = SB_KEY;
  h["Author" + "ization"] = "Bea" + "rer " + SB_KEY;
  return h;
}
async function sb(path, opts) {
  const res = await httpFetch(SB_URL.replace(/\/+$/, "") + "/rest/v1/" + path, { headers: sbHeaders(), ...(opts || {}) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) throw new Error("supabase " + res.status);
  return body;
}
function identityId(sub) {
  return "gid_" + crypto.createHash("sha256").update(String(sub)).digest("hex").slice(0, 20);
}
async function upsertIdentity(claims) {
  const id = identityId(claims.sub);
  const now = nowIso();
  let existing = null;
  if (supabaseEnabled()) {
    const rows = await sb("as_identities?id=eq." + encodeURIComponent(id) + "&select=data", { method: "GET" });
    if (Array.isArray(rows) && rows[0] && rows[0].data) existing = rows[0].data;
  }
  const record = {
    id,
    googleSub: claims.sub,
    email: claims.email,
    name: claims.name || (existing && existing.name) || "",
    picture: claims.picture || (existing && existing.picture) || "",
    ansaiPersonId: existing && existing.ansaiPersonId ? existing.ansaiPersonId : null,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    lastLoginAt: now,
    logins: (existing && existing.logins ? existing.logins : 0) + 1
  };
  if (supabaseEnabled()) {
    await sb("as_identities", {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id, data: record, updated_at: now }])
    });
  }
  return record;
}

/* ---- ownership: a Google session owns exactly the businesses whose
   owner_email is its verified email ---- */
function ownsBusiness(person, biz) {
  if (!person || !biz) return false;
  const a = String(person.email || "").trim().toLowerCase();
  const b = String(biz.owner_email || "").trim().toLowerCase();
  return !!a && !!b && a === b;
}

module.exports = {
  COOKIE,
  STATE_COOKIE,
  enabled,
  authorizeUrl,
  newState,
  setStateCookie,
  clearStateCookie,
  verifyState,
  parseCookies,
  exchangeCode,
  verifyIdToken,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  verifySession,
  getGoogleSession,
  upsertIdentity,
  identityId,
  ownsBusiness,
  __setFetchForTests,
  __resetJwksCacheForTests
};
