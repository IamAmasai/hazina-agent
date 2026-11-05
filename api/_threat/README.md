# Signal One — estate threat-sharing, slice 0 (hazina-prod node)

Monitor-only agent-attack detection on the Ask Hazi surface, emitting v0
threat signals to a node-local, hash-chained feed. Design of record:
`agentic-infra-threat-sharing-brief-2026-11-04.md` §b/§e (estate files).
Nothing blocks anything; everything learns. Detector precision on the
shipped batteries (tests/signal-one.test.js): recall 14/14, false
positives 0/14 — false-positive discipline is the design priority.

## Pieces
- `detector.js` — structural pattern families (override, extraction,
  jailbreak framing, exfiltration, tool escape, policy probe) scored in
  code. No LLM call. Policy probe alone never fires.
- `privacy.js` — the gate. Allowlisted fields only; recursive scan rejects
  emails, phone-shaped strings, URLs, over-long strings, and any banned
  key (prompt/question/text/payload/…) at any depth. A signal that fails
  the gate is dropped (evidence kept locally, error logged).
- `feed.js` — append-only JSONL, sha256 hash chain (`feed.jsonl`), plus a
  node-local `evidence.jsonl`. Evidence (including flagged text) NEVER
  leaves the node; signals reference it by `evidence_ref` hash only.
- `emit.js` — builds the v0 signal (brief §B1 field set), 30-day expiry,
  distribution `estate`, emitter `hazina-prod` / agent `hazi`.
- `../threat-feed.js` — the collector's read endpoint (below).
- Hook: `../ask.js` calls `observeAskHazi()` after month ownership is
  verified, inside try/catch. Ask Hazi's behaviour is unchanged.

## Hand-off contract for Sentinel (the collector)
Sentinel polls; Hazina never pushes.

- **Request:** `GET https://hazina.ansaitechnologies.co.ke/api/threat-feed?since=<seq>`
  with header `x-threat-feed-token: <THREAT_FEED_TOKEN>`.
  (`since` = last seq Sentinel has collected; 0 = from the start.)
- **Founder must set** (Vercel → hazina-app → Environment Variables):
  `THREAT_FEED_TOKEN` — a shared secret Sentinel also holds. Until set,
  the endpoint answers 503 "feed not provisioned"; a wrong token gets 401.
- **Response:** `{ ok, node: "hazina-prod", head: { count, head_hash },
  verify_ok, entries: [{ seq, prev_hash, entry_hash, signal }] }`.
  Sentinel should alert the founder (WhatsApp) when a new entry's
  severity × confidence is high (v0 notice rule: severity "high", or
  confidence ≥ 75), and treat `verify_ok: false` as a tamper alarm.
- **Signal fields** are the brief's §B1 set. `pattern` is structural only
  (families + shape + length bucket) — never the flagged text.

## Known v0 limitations (named, on record)
1. **Signature is a stub.** `signature.alg = "none-stub"`, `stub: true`;
   the value is an integrity hash, not a cryptographic signature.
   Follow-up **SIGNAL_ONE_NODE_KEY**: generate the hazina-prod Ed25519
   keypair, register the public key with the collector, sign for real.
2. **Feed storage is file-backed** (`.threat-local/`, env
   `HAZINA_THREAT_DIR`). On Vercel's ephemeral filesystem this persists
   per-instance only — acceptable for the monitor-only pilot; the named
   follow-up is a Supabase `hz_threat_feed` table behind the same
   createFeed interface before any second node joins.
3. One detector, one surface (Ask Hazi). Failed-auth bursts on Ansai ID
   are slice 1, per the brief.
