// Signal One — hash-chained append-only threat-signal feed (node-local).
// HAND-WRITTEN 2026-11-04: the Meta Model API returned empty content for this
// file across repeated attempts (prompt .scratch-signal-one/promptC-feed.txt)
// after generating detector.js earlier in the same session — consistent with
// the hackathon credit window closing on the evening of 4 Nov.
// Chain pattern mirrors the swarm's signals.js: every entry carries the hash
// of the previous entry; tampering anywhere breaks verification downstream.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const GENESIS = "0".repeat(64);

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
function sha256hex(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

function createFeed(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const feedPath = path.join(dir, "feed.jsonl");
  const evidencePath = path.join(dir, "evidence.jsonl");

  function lines(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(l => l.trim().length > 0);
  }
  function lastEntry() {
    const ls = lines(feedPath);
    if (!ls.length) return null;
    try { return JSON.parse(ls[ls.length - 1]); } catch (_) { return null; }
  }
  function append(signal) {
    const last = lastEntry();
    const seq = last ? last.seq + 1 : 1;
    const prev_hash = last ? last.entry_hash : GENESIS;
    const entry_hash = sha256hex(prev_hash + "|" + canonical(signal));
    const entry = { seq, prev_hash, entry_hash, signal };
    fs.appendFileSync(feedPath, JSON.stringify(entry) + "\n");
    return entry;
  }
  function verify() {
    const ls = lines(feedPath);
    let prev = GENESIS;
    for (let i = 0; i < ls.length; i++) {
      let e;
      try { e = JSON.parse(ls[i]); } catch (_) { return { ok: false, count: i, head_hash: prev, failed_at: i + 1 }; }
      if (e.seq !== i + 1 || e.prev_hash !== prev) return { ok: false, count: i, head_hash: prev, failed_at: e.seq || i + 1 };
      if (e.entry_hash !== sha256hex(prev + "|" + canonical(e.signal))) return { ok: false, count: i, head_hash: prev, failed_at: e.seq };
      prev = e.entry_hash;
    }
    return { ok: true, count: ls.length, head_hash: prev };
  }
  function readSince(seq) {
    const out = [];
    for (const l of lines(feedPath)) {
      try { const e = JSON.parse(l); if (e.seq > seq) out.push(e); } catch (_) { /* a corrupt line is verify()'s job to report */ }
    }
    return out;
  }
  function head() {
    const last = lastEntry();
    if (!last) return { count: 0, head_hash: GENESIS };
    return { count: last.seq, head_hash: last.entry_hash };
  }
  // Evidence stays on the node: the full local record (incl. the flagged text)
  // is written here and referenced from signals only by its sha256 hash.
  function storeEvidence(record) {
    const line = canonical(record);
    const h = sha256hex(line);
    fs.appendFileSync(evidencePath, line + "\n");
    return "sha256:" + h;
  }
  return { append, verify, readSince, head, storeEvidence, dir, feedPath, evidencePath };
}

module.exports = { createFeed, canonical, sha256hex, GENESIS };
