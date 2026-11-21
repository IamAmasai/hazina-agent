// Signal One — emitter: Ask Hazi question -> detector -> (evidence | signal).
// HAND-WRITTEN 2026-11-04 (Meta API window closed mid-session; see feed.js).
// Monitor-only by design: observeAskHazi NEVER blocks, alters or delays the
// owner's question. It returns the appended feed entry, or null when the
// question is clean, the signal fails the privacy gate, or anything errors —
// the caller wraps it in try/catch and Ask Hazi proceeds regardless.
const crypto = require("crypto");
const path = require("path");
const { detect } = require("./detector");
const { validateSignal } = require("./privacy");
const { createFeed, sha256hex, canonical } = require("./feed");

const SIGNAL_TTL_DAYS = 30; // v0: agent-attack patterns age out in 30 days

function feedDir() {
  return process.env.HAZINA_THREAT_DIR || path.join(__dirname, "..", "..", ".threat-local");
}
function getFeed() { return createFeed(feedDir()); }

// SIGNING STUB — node key signing is NOT yet provisioned. The brief (§B2)
// requires every node to hold an Ed25519 keypair registered with the
// collector. Until the founder provisions the hazina-prod node key (named
// follow-up: SIGNAL_ONE_NODE_KEY), the signature field carries an integrity
// hash over the canonical signal, clearly marked stub:true so no consumer
// mistakes it for a cryptographic signature.
function signStub(signal) {
  return { alg: "none-stub", value: sha256hex(canonical(signal)), stub: true };
}

function buildSignal(det, evidenceRef, identity) {
  const now = new Date();
  const sig = {
    ts: now.toISOString(),
    signal_id: crypto.randomUUID(),
    emitter_node: "hazina-prod",
    emitter_agent: "hazi",
    bound_human: identity && identity.boundHuman ? String(identity.boundHuman).slice(0, 80) : null,
    kind: "threat_detected",
    class: "agent_attack",
    pattern: {
      summary: det.patternSummary,
      families: det.families.slice(0, 8),
      shape: "ask_hazi_question;len_bucket=" + (det.patternSummary.split("len_bucket=")[1] || "").split(";")[0],
    },
    iocs: [],
    attack_ref: det.attackRef,
    confidence: det.confidence,
    severity: det.severity,
    context: {
      component: "hazina-app",
      surface: "ask_hazi",
      observations: 1,
      first_seen: now.toISOString(),
      last_seen: now.toISOString(),
    },
    distribution: "estate",
    expires_at: new Date(now.getTime() + SIGNAL_TTL_DAYS * 86400000).toISOString(),
    evidence_ref: evidenceRef,
  };
  sig.signature = signStub(sig);
  return sig;
}

function observeAskHazi(question, identity) {
  const det = detect(question);
  if (!det.fired) return null;
  const feed = getFeed();
  // The full local evidence record — including the flagged question text —
  // is written ONLY to the node's evidence store. It never enters the signal.
  const evidenceRef = feed.storeEvidence({
    kind: "ask_hazi_detection",
    ts: new Date().toISOString(),
    surface: "ask_hazi",
    question: String(question || "").slice(0, 500),
    families: det.families,
    confidence: det.confidence,
    severity: det.severity,
    attack_ref: det.attackRef,
  });
  const signal = buildSignal(det, evidenceRef, identity);
  const check = validateSignal(signal);
  if (!check.ok) {
    // Privacy gate refused our own signal: drop it, keep the evidence, shout locally.
    console.error("signal-one: privacy gate rejected signal:", check.errors.join("; "));
    return null;
  }
  return feed.append(signal);
}

module.exports = { observeAskHazi, buildSignal, signStub, getFeed, SIGNAL_TTL_DAYS };
