"use strict";
/* Google sign-in routes (founder directive, 2026-11-21): Google is the
   front door, the access code stays below it as the recovery door.

   GET  /api/auth?provider=google&step=start      -> Google consent
   GET  /api/auth?provider=google&step=callback   -> the registered
     redirect URI: exchange, verify, upsert the shared identity, set
     the Google session, land back on Hazina.
   GET  /api/auth?provider=google&step=signout    -> clear the Google
     session (and any open workspace session), land back on Hazina.
   GET  /api/auth?provider=google&step=workspaces -> JSON: the signed-in
     person and the businesses linked to their verified email.
   POST /api/auth {action:"open", businessId}     -> open one of the
     caller's own linked businesses (sets the workspace session).
   POST /api/auth {action:"link", code}           -> link a workspace to
     the caller's Google account by its access code, once, then open it.
     A workspace already linked to a different email is refused — a code
     can never move someone else's books onto your account.
   POST /api/auth {action:"create", name}         -> self-serve sign-up
     (founder's live finding, 2026-11-21: a new Google user was told to
     enter an access code they could not have — creation was admin-only).
     Creates a workspace owned by the caller's verified email, generates
     its recovery access code server-side (only the sha256 is stored),
     returns the code ONCE in the response for the owner to save, sets
     the workspace session and opens it. The code door below stays the
     recovery path back in if Google access is ever lost.

   Failures land on a plain page that says what happened in words —
   never a stack, never a silent bounce. */

const crypto = require("crypto");
const { envReady, list, insert, patch, sha256, setSessionCookie, clearSessionCookie, fail } = require("./_lib");
const google = require("./_google");

/* Recovery access codes: 16 characters from an alphabet with no
   look-alikes (no I, L, O, 0, 1), grouped in fours so a person can read
   the code back and type it exactly as shown — the code doors hash the
   string exactly as typed, dashes included. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newRecoveryCode() {
  const chars = [];
  for (let i = 0; i < 16; i++) chars.push(CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]);
  return chars.join("").replace(/(.{4})(?=.)/g, "$1-");
}

function errorPage(res, message) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hazina — sign-in</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F5F8FC;color:#0D1B2A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#fff;border:1px solid #DCE6F2;border-radius:14px;padding:32px 28px;max-width:400px;text-align:center}
a{color:#2563EB}</style></head>
<body><div class="card"><h1 style="font-size:20px;margin:0 0 10px">Sign-in didn't complete</h1>
<p style="font-size:14px;color:#4A5F75;margin:0 0 18px">${message}</p>
<a href="/">Back to Hazina</a></div></body></html>`);
}

function getQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  try {
    const u = new URL(req.url || "", "https://hazina.ansaitechnologies.co.ke");
    const out = {};
    for (const [k, v] of u.searchParams) out[k] = v;
    return out;
  } catch (e) { return {}; }
}

async function businessesForEmail(email) {
  const rows = await list("hz_businesses", "owner_email=eq." + encodeURIComponent(String(email || "")) + "&select=*");
  return rows || [];
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    if (!envReady()) { res.status(503).json({ error: "waiting for setup", detail: "database env not set" }); return; }

    if (req.method === "POST") {
      if (!google.enabled()) { res.status(503).json({ error: "Google sign-in is not switched on yet." }); return; }
      const person = google.getGoogleSession(req);
      if (!person) { res.status(401).json({ error: "Sign in with Google first." }); return; }
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

      if (body.action === "open") {
        const rows = await list("hz_businesses", "id=eq." + String(body.businessId || "") + "&select=*");
        const biz = rows && rows[0];
        if (!biz) { res.status(404).json({ error: "That workspace no longer exists." }); return; }
        if (!google.ownsBusiness(person, biz)) { res.status(403).json({ error: "That workspace isn't linked to your Google account." }); return; }
        setSessionCookie(res, biz);
        res.status(200).json({ ok: true, business: { id: biz.id, name: biz.name } });
        return;
      }

      if (body.action === "create") {
        const name = String(body.name || "").trim();
        if (name.length < 2 || name.length > 80) {
          res.status(400).json({ error: "Give your business a name — 2 to 80 characters." });
          return;
        }
        const recoveryCode = newRecoveryCode();
        const rows = await insert("hz_businesses", [{
          name,
          legal_form: "sole_trader",
          income_stream: "trading",
          kra_pin: null,
          owner_name: person.name || null,
          owner_email: person.email,
          access_code_hash: sha256(recoveryCode)
        }]);
        const biz = rows && rows[0];
        if (!biz || !biz.id) { res.status(500).json({ error: "The workspace could not be created. Nothing was saved — please try again." }); return; }
        setSessionCookie(res, biz);
        res.status(200).json({ ok: true, business: { id: biz.id, name: biz.name }, recoveryCode });
        return;
      }

      if (body.action === "link") {
        const code = String(body.code || "").trim();
        if (!code) { res.status(400).json({ error: "code required" }); return; }
        const rows = await list("hz_businesses", "access_code_hash=eq." + sha256(code) + "&select=*");
        const biz = rows && rows[0];
        if (!biz) { res.status(401).json({ error: "That code doesn't open a workspace." }); return; }
        if (biz.owner_email && !google.ownsBusiness(person, biz)) {
          res.status(409).json({ error: "That workspace is already linked to a different Google account." });
          return;
        }
        if (!biz.owner_email) {
          await patch("hz_businesses", "id=eq." + biz.id, { owner_email: person.email });
        }
        setSessionCookie(res, biz);
        res.status(200).json({ ok: true, business: { id: biz.id, name: biz.name } });
        return;
      }

      res.status(400).json({ error: "unknown action" });
      return;
    }

    /* ---- GET ---- */
    const q = getQuery(req);
    if (q.provider !== "google") {
      res.status(400).json({ error: "unknown provider" });
      return;
    }
    if (q.step === "signout") {
      /* Workspace cookie first (it replaces the header), then the Google
         cookie is appended — both end cleared. */
      clearSessionCookie(res);
      google.clearSessionCookie(res);
      res.setHeader("Location", "/");
      res.status(302).end();
      return;
    }
    if (!google.enabled()) {
      errorPage(res, "Google sign-in is not switched on for Hazina yet. Use your workspace access code below it.");
      return;
    }
    if (q.step === "start") {
      const state = google.newState();
      google.setStateCookie(res, state);
      res.setHeader("Location", google.authorizeUrl(state));
      res.status(302).end();
      return;
    }
    if (q.step === "workspaces") {
      const person = google.getGoogleSession(req);
      if (!person) { res.status(401).json({ error: "no Google session" }); return; }
      const businesses = await businessesForEmail(person.email);
      res.status(200).json({
        person: { name: person.name, email: person.email },
        businesses: businesses.map((b) => ({ id: b.id, name: b.name }))
      });
      return;
    }
    if (q.step === "callback") {
      const cookies = google.parseCookies(req);
      if (!google.verifyState(cookies, q.state)) {
        google.clearStateCookie(res);
        errorPage(res, "That sign-in link went stale or didn't come from this browser. Start again from Hazina's sign-in button.");
        return;
      }
      google.clearStateCookie(res);
      if (q.error) {
        errorPage(res, "Google didn't complete the sign-in. Nothing was changed — you can try again whenever you're ready.");
        return;
      }
      if (!q.code) {
        errorPage(res, "Google sent back no sign-in code. Nothing was changed — please try again.");
        return;
      }
      let claims;
      try {
        const tokens = await google.exchangeCode(q.code);
        claims = await google.verifyIdToken(tokens.id_token);
      } catch (e) {
        console.error("google callback failed:", e && e.message);
        errorPage(res, "We couldn't verify that sign-in with Google. Nothing was changed — please try again.");
        return;
      }
      if (!claims.emailVerified) {
        errorPage(res, "That Google account's email isn't verified, so we can't tie your books to it. Verify the email with Google, then sign in again.");
        return;
      }
      try {
        await google.upsertIdentity(claims);
      } catch (e) {
        /* The session is the door; the identity row is the record.
           A failed upsert is logged server-side but never locks the
           owner out of their own books. */
        console.error("identity upsert failed:", e && e.message);
      }
      google.setSessionCookie(res, claims);
      res.setHeader("Location", "/");
      res.status(302).end();
      return;
    }
    res.status(400).json({ error: "unknown step" });
  } catch (e) { fail(res, e); }
};
