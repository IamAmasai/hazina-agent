process.env.HAZINA_SUPABASE_URL = "https://stub.local";
process.env.HAZINA_SUPABASE_SERVICE_KEY = "stub";
process.env.ANSAI_ID_URL = "https://id.stub.local";
const lib = require("../api/_lib");
const idWorkspaces = require("../api/id-workspaces");
const idLogin = require("../api/id-login");
const sessionH = require("../api/session");
const loginH = require("../api/login");
const BIZ_ID = "11111111-2222-3333-4444-555555555555";
const tables = {
  hz_businesses: [{ id: BIZ_ID, name: "Zuri Beauty (stub)", legal_form: "sole", income_stream: "services", access_code_hash: lib.sha256("e2e-test-2026") }],
  hz_workspace_members: [{ business_id: BIZ_ID, person_id: "person-member", role: "owner" }],
};
const SUPA_PREFIX = process.env.HAZINA_SUPABASE_URL + "/rest/v1/";
function supaRes(data, status) {
  status = status || 200;
  return { ok: status >= 200 && status < 300, status: status, json: async () => data, text: async () => JSON.stringify(data) };
}
global.fetch = async (url, opts) => {
  opts = opts || {};
  const s = String(url);
  if (s.indexOf(SUPA_PREFIX) === 0) {
    const u = new URL(s);
    const segs = u.pathname.split("/");
    const table = segs[segs.length - 1];
    const method = ((opts.method || "GET") + "").toUpperCase();
    if (method === "GET") {
      const rows = tables[table] || [];
      const filtered = rows.filter((row) => {
        for (const [k, v] of u.searchParams.entries()) {
          if (k === "select" || k === "order" || k === "limit" || k === "offset") continue;
          if (v.indexOf("eq.") === 0) { if (String(row[k]) !== v.slice(3)) return false; }
        }
        return true;
      });
      return supaRes(filtered, 200);
    }
    if (method === "POST") {
      let body = null;
      try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (_) { body = {}; }
      if (!tables[table]) tables[table] = [];
      if (Array.isArray(body)) { body.forEach((r) => tables[table].push(r)); return supaRes(body, 201); }
      if (body && typeof body === "object") { tables[table].push(body); return supaRes(body, 201); }
      return supaRes(body, 201);
    }
    return supaRes([], 200);
  }
  if (s.indexOf(process.env.ANSAI_ID_URL) === 0) {
    const h = opts.headers || {};
    const cookie = h.Cookie || h.cookie || "";
    let person = null;
    if (cookie.indexOf("ansai_id_session=tok-member") !== -1) person = { id: "person-member", name: "Member One", status: "active" };
    else if (cookie.indexOf("ansai_id_session=tok-outsider") !== -1) person = { id: "person-outsider", name: "Out Sider", status: "active" };
    else if (cookie.indexOf("ansai_id_session=tok-suspended") !== -1) person = { id: "person-suspended", name: "Sus Pended", status: "suspended" };
    if (!person) return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }), text: async () => JSON.stringify({ error: "unauthorized" }) };
    return { ok: true, status: 200, json: async () => ({ person: person }), text: async () => JSON.stringify({ person: person }) };
  }
  throw new Error("unexpected fetch: " + s);
};
function mockReq(method, cookie, body) { return { method: method, headers: { cookie: cookie || "" }, body: body || {} }; }
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader: function (k, v) { this.headers[String(k).toLowerCase()] = v; },
    status: function (n) { this.statusCode = n; return this; },
    json: function (o) { this.body = o; return this; },
  };
}
function assert(c, m) { if (!c) throw new Error(m); }
(async () => {
  let passed = 0; const total = 7;
  let hzCookie = "";
  try {
    { const req = mockReq("GET", "", {}); const res = mockRes(); await idWorkspaces(req, res); assert(res.statusCode === 401, "case1 expected 401 got " + res.statusCode); assert(res.body && res.body.error === "no Ansai ID session", "case1 body"); passed++; console.log("pass 1/7 id-workspaces no cookie 401"); }
    { const req = mockReq("GET", "ansai_id_session=tok-member", {}); const res = mockRes(); await idWorkspaces(req, res); assert(res.statusCode === 200, "case2 expected 200 got " + res.statusCode); assert(res.body && res.body.workspaces && res.body.workspaces.length === 1, "case2 length"); assert(res.body.workspaces[0].name === "Zuri Beauty (stub)", "case2 name"); assert(res.body.person && res.body.person.name === "Member One", "case2 person"); passed++; console.log("pass 2/7 id-workspaces member 1 workspace"); }
    { const req = mockReq("POST", "ansai_id_session=tok-member", {}); const res = mockRes(); await idLogin(req, res); assert(res.statusCode === 200, "case3 expected 200 got " + res.statusCode); const sc = res.headers["set-cookie"] || ""; assert(typeof sc === "string" && sc.indexOf("hz_session=") === 0, "case3 set-cookie"); hzCookie = sc.split(";")[0]; passed++; console.log("pass 3/7 id-login member sets hz_session"); }
    { const req1 = mockReq("GET", "ansai_id_session=tok-outsider", {}); const res1 = mockRes(); await idWorkspaces(req1, res1); assert(res1.statusCode === 200, "case4a expected 200 got " + res1.statusCode); assert(res1.body && res1.body.workspaces && res1.body.workspaces.length === 0, "case4a 0 workspaces"); const req2 = mockReq("POST", "ansai_id_session=tok-outsider", {}); const res2 = mockRes(); await idLogin(req2, res2); assert(res2.statusCode === 403, "case4b expected 403 got " + res2.statusCode); passed++; console.log("pass 4/7 outsider 0 workspaces + 403"); }
    { const req = mockReq("GET", "ansai_id_session=tok-suspended", {}); const res = mockRes(); await idWorkspaces(req, res); assert(res.statusCode === 401, "case5 expected 401 got " + res.statusCode); passed++; console.log("pass 5/7 suspended 401"); }
    { const req = mockReq("POST", "", { code: "e2e-test-2026" }); const res = mockRes(); await loginH(req, res); assert(res.statusCode === 200, "case6 expected 200 got " + res.statusCode + " " + JSON.stringify(res.body)); passed++; console.log("pass 6/7 legacy login fallback 200"); }
    { const req = mockReq("GET", hzCookie, {}); const res = mockRes(); await sessionH(req, res); assert(res.statusCode === 200, "case7 expected 200 got " + res.statusCode); assert(res.body && res.body.business && res.body.business.name === "Zuri Beauty (stub)", "case7 business"); passed++; console.log("pass 7/7 session with hz_session"); }
    console.log("ID-CUTOVER E2E: " + passed + "/" + total + " passed");
  } catch (e) { console.error("FAIL: " + (e && e.message)); console.log("ID-CUTOVER E2E: " + passed + "/" + total + " passed"); process.exit(1); }
})();
