"use strict";
/* Google sign-in for Hazina — unit tests over the signed Google session
   (roundtrip, tamper, expiry), the OAuth state cookie (CSRF), ID token
   verification against a test JWKS (valid, wrong audience, expired,
   wrong key), the code exchange through the stubbed HTTP seam,
   business ownership by verified email, the identity upsert's
   no-Supabase path, and the auth handler's open/link bridge over a
   stubbed _lib. No test ever calls Google or the database.
   Run: node tests/google-auth.test.js */
const assert = require("node:assert");
const crypto = require("node:crypto");
const path = require("node:path");

process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret-for-hmac";
process.env.GOOGLE_REDIRECT_URI = "https://hazina.ansaitechnologies.co.ke/api/auth?provider=google&step=callback";
delete process.env.HAZINA_SUPABASE_URL;
delete process.env.HAZINA_SUPERBASE_URL;
delete process.env.HAZINA_SUPABASE_SERVICE_KEY;

const google = require("../api/_google.js");

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

(async () => {
  /* ---- the signed Google session ---- */
  const value = google.signSession({ sub: "123", email: "a@b.co", name: "A B" });
  const payload = google.verifySession(value);
  assert.equal(payload.sub, "123");
  assert.equal(payload.email, "a@b.co");
  assert.equal(payload.name, "A B");

  const [body, sig] = value.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  forged.email = "attacker@x.co";
  assert.equal(google.verifySession(b64url(JSON.stringify(forged)) + "." + sig), null);

  const expiredBody = b64url(JSON.stringify({ sub: "1", email: "a@b.co", name: "", exp: Date.now() - 1000 }));
  const expiredSig = crypto.createHmac("sha256", process.env.GOOGLE_CLIENT_SECRET).update("session:" + expiredBody).digest("hex");
  assert.equal(google.verifySession(expiredBody + "." + expiredSig), null);
  assert.equal(google.verifySession(""), null);
  assert.equal(google.verifySession("no-dot-here"), null);

  /* getGoogleSession reads the hz_google cookie off a request */
  const sess = google.getGoogleSession({ headers: { cookie: "hz_session=x.y; hz_google=" + encodeURIComponent(value) } });
  assert.equal(sess.email, "a@b.co");
  assert.equal(sess.name, "A B");
  assert.equal(google.getGoogleSession({ headers: { cookie: "hz_google=forged.value" } }), null);
  assert.equal(google.getGoogleSession({ headers: {} }), null);

  /* ---- OAuth state (CSRF) ---- */
  const state = google.newState();
  const cookies = { [google.STATE_COOKIE]: state };
  assert.equal(google.verifyState(cookies, state), true);
  assert.equal(google.verifyState(cookies, state + "x"), false);
  assert.equal(google.verifyState({}, state), false);
  const forgedState = "deadbeef." + state.split(".")[1];
  assert.equal(google.verifyState({ [google.STATE_COOKIE]: forgedState }, forgedState), false);

  /* ---- ID token verification against a test JWKS ---- */
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "test-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  function signJwt(claims, key) {
    const header = { alg: "RS256", kid: "test-key-1", typ: "JWT" };
    const data = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
    const s = crypto.createSign("RSA-SHA256").update(data).sign(key || privateKey);
    return data + "." + b64url(s);
  }
  function baseClaims() {
    return {
      iss: "https://accounts.google.com",
      aud: process.env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "99887766",
      email: "owner@example.com",
      email_verified: true,
      name: "Test Owner"
    };
  }
  function stubJwks() {
    google.__resetJwksCacheForTests();
    google.__setFetchForTests(async (url) => {
      if (String(url).includes("googleapis.com/oauth2/v3/certs")) {
        return { ok: true, status: 200, json: async () => ({ keys: [jwk] }), text: async () => "" };
      }
      throw new Error("unexpected fetch " + url);
    });
  }
  stubJwks();
  const claims = await google.verifyIdToken(signJwt(baseClaims()));
  assert.equal(claims.sub, "99887766");
  assert.equal(claims.email, "owner@example.com");
  assert.equal(claims.emailVerified, true);

  stubJwks();
  const wrongAud = baseClaims(); wrongAud.aud = "someone-else";
  await assert.rejects(() => google.verifyIdToken(signJwt(wrongAud)), /bad audience/);

  stubJwks();
  const expired = baseClaims(); expired.exp = Math.floor(Date.now() / 1000) - 60;
  await assert.rejects(() => google.verifyIdToken(signJwt(expired)), /expired/);

  stubJwks();
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(() => google.verifyIdToken(signJwt(baseClaims(), other.privateKey)), /bad token signature/);

  /* ---- code exchange through the seam ---- */
  google.__setFetchForTests(async (url, opts) => {
    assert.ok(String(url).includes("oauth2.googleapis.com/token"));
    assert.ok(String(opts.body).includes("grant_type=authorization_code"));
    return { ok: true, status: 200, json: async () => ({ id_token: "tok", access_token: "at" }), text: async () => "" };
  });
  const out = await google.exchangeCode("the-code");
  assert.equal(out.id_token, "tok");
  google.__setFetchForTests(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "" }));
  await assert.rejects(() => google.exchangeCode("bad"), /token exchange failed/);

  /* ---- ownership: a Google session owns only its email's businesses ---- */
  const person = { email: "Owner@Example.com" };
  assert.equal(google.ownsBusiness(person, { owner_email: "owner@example.com" }), true);
  assert.equal(google.ownsBusiness(person, { owner_email: "other@example.com" }), false);
  assert.equal(google.ownsBusiness(person, { owner_email: null }), false);
  assert.equal(google.ownsBusiness(person, {}), false);
  assert.equal(google.ownsBusiness(null, { owner_email: "owner@example.com" }), false);

  /* ---- identity: stable id; the no-Supabase upsert keeps the link null ---- */
  google.__setFetchForTests(async () => { throw new Error("no network in this test"); });
  assert.equal(google.identityId("99887766"), google.identityId("99887766"));
  assert.ok(google.identityId("99887766").startsWith("gid_"));
  const rec = await google.upsertIdentity({ sub: "99887766", email: "owner@example.com", name: "Test Owner", picture: "" });
  assert.equal(rec.ansaiPersonId, null);
  assert.equal(rec.logins, 1);
  assert.equal(rec.email, "owner@example.com");
  google.__setFetchForTests(null);

  /* ---- the auth handler: open / link over a stubbed _lib ---- */
  const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const businesses = [
    { id: "biz-mine", name: "Mine Ltd", access_code_hash: sha256("mine-code"), owner_email: "owner@example.com" },
    { id: "biz-theirs", name: "Theirs Ltd", access_code_hash: sha256("their-code"), owner_email: "other@example.com" },
    { id: "biz-free", name: "Unlinked Ltd", access_code_hash: sha256("free-code"), owner_email: null }
  ];
  const patchCalls = [];
  const fakeLib = {
    envReady: () => true,
    async list(table, q) {
      assert.equal(table, "hz_businesses");
      let rows = businesses.slice();
      for (const part of q.split("&")) {
        const eq = part.match(/^([a-z_]+)=eq\.(.*)$/);
        if (eq) rows = rows.filter(r => String(r[eq[1]]) === decodeURIComponent(eq[2]));
      }
      return rows;
    },
    async patch(table, q, fields) {
      patchCalls.push({ table, q, fields });
      const id = decodeURIComponent(q.match(/id=eq\.([^&]+)/)[1]);
      const row = businesses.find(b => b.id === id);
      if (row) Object.assign(row, fields);
      return row ? [row] : [];
    },
    sha256,
    setSessionCookie(res, biz) { res.setHeader("Set-Cookie", "hz_session=" + biz.id + ".testhash"); },
    clearSessionCookie(res) { res.setHeader("Set-Cookie", "hz_session=; Max-Age=0"); },
    fail(res, e) { res.status(500).json({ error: "server error", detail: String(e && e.message) }); }
  };
  const libPath = require.resolve(path.join(__dirname, "..", "api", "_lib.js"));
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: fakeLib };
  delete require.cache[require.resolve(path.join(__dirname, "..", "api", "auth.js"))];
  const authHandler = require("../api/auth.js");

  function fakeRes() {
    return {
      headers: {}, statusCode: 0, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
      send(s) { this.body = s; return this; },
      end() { return this; }
    };
  }
  const myCookie = "hz_google=" + encodeURIComponent(google.signSession({ sub: "99887766", email: "owner@example.com", name: "Test Owner" }));
  const post = (bodyObj, cookie) => {
    const req = { method: "POST", headers: cookie ? { cookie } : {}, body: bodyObj, url: "/api/auth" };
    const res = fakeRes();
    return authHandler(req, res).then(() => res);
  };

  // no Google session -> 401
  let r = await post({ action: "open", businessId: "biz-mine" }, null);
  assert.equal(r.statusCode, 401);

  // open my own linked business -> 200 + workspace session cookie
  r = await post({ action: "open", businessId: "biz-mine" }, myCookie);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.business.id, "biz-mine");
  assert.ok(String(r.headers["set-cookie"]).startsWith("hz_session=biz-mine."));

  // open someone else's business -> 403, no cookie
  r = await post({ action: "open", businessId: "biz-theirs" }, myCookie);
  assert.equal(r.statusCode, 403);
  assert.equal(r.headers["set-cookie"], undefined);

  // open an unlinked business without its code -> 403
  r = await post({ action: "open", businessId: "biz-free" }, myCookie);
  assert.equal(r.statusCode, 403);

  // link an unlinked business with its code -> owner_email set, opened
  patchCalls.length = 0;
  r = await post({ action: "link", code: "free-code" }, myCookie);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.business.id, "biz-free");
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].fields.owner_email, "owner@example.com");
  assert.equal(businesses.find(b => b.id === "biz-free").owner_email, "owner@example.com");
  assert.ok(String(r.headers["set-cookie"]).startsWith("hz_session=biz-free."));

  // link a business already linked to another email -> 409, never patched
  patchCalls.length = 0;
  r = await post({ action: "link", code: "their-code" }, myCookie);
  assert.equal(r.statusCode, 409);
  assert.equal(patchCalls.length, 0);
  assert.equal(r.headers["set-cookie"], undefined);

  // link with a wrong code -> 401
  r = await post({ action: "link", code: "no-such-code" }, myCookie);
  assert.equal(r.statusCode, 401);

  // link my already-linked business again -> opens, no second patch
  patchCalls.length = 0;
  r = await post({ action: "link", code: "mine-code" }, myCookie);
  assert.equal(r.statusCode, 200);
  assert.equal(patchCalls.length, 0);

  // workspaces listing shows only my businesses
  const wreq = { method: "GET", headers: { cookie: myCookie }, url: "/api/auth?provider=google&step=workspaces", query: { provider: "google", step: "workspaces" } };
  const wres = fakeRes();
  await authHandler(wreq, wres);
  assert.equal(wres.statusCode, 200);
  assert.deepEqual(wres.body.businesses.map(b => b.id).sort(), ["biz-free", "biz-mine"]);
  assert.equal(wres.body.person.email, "owner@example.com");

  console.log("google-auth.test.js: all assertions passed");
})().catch(e => { console.error(e); process.exit(1); });
