// Signal One — collector read endpoint for the estate threat feed.
// HAND-WRITTEN 2026-11-04 (see api/_threat/feed.js header).
// GET /api/threat-feed?since=<seq> with header  x-threat-feed-token: <secret>
// The secret is env THREAT_FEED_TOKEN, set by the founder; without it the
// endpoint is closed (503) and without the token a poll is refused (401).
// Sentinel (on the founder's hardware) is the intended poller: it collects
// entries into the estate feed and runs the WhatsApp notice threshold.
// Response: { ok, head: { count, head_hash }, verify_ok, entries: [...] }
const { getFeed } = require("./_threat/emit");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }
  const token = process.env.THREAT_FEED_TOKEN;
  if (!token) { res.status(503).json({ error: "feed not provisioned" }); return; }
  if (req.headers["x-threat-feed-token"] !== token) { res.status(401).json({ error: "unauthorised" }); return; }
  try {
    const since = Math.max(0, parseInt((req.query && req.query.since) || "0", 10) || 0);
    const feed = getFeed();
    const v = feed.verify();
    res.status(200).json({
      ok: true,
      node: "hazina-prod",
      head: feed.head(),
      verify_ok: v.ok,
      entries: feed.readSince(since),
    });
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String((e && e.message) || e).slice(0, 200) });
  }
};
