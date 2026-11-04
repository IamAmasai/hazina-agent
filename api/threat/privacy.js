// Signal One — privacy gate for estate threat signals.
// HAND-WRITTEN 2026-11-04 after four consecutive empty Meta API responses for
// this file (prompts .scratch-signal-one/promptB*.txt; the detector and feed
// modules were Spark-generated in the same session). A threat signal may carry
// ONLY structural pattern data — never raw prompts, user text, personal data
// or payloads. validateSignal(sig) -> { ok, errors[] }.

const TOP = ["ts", "signal_id", "emitter_node", "emitter_agent", "bound_human", "kind", "class", "pattern", "iocs", "attack_ref", "confidence", "severity", "context", "distribution", "expires_at", "evidence_ref", "signature"];
const BANNED = ["prompt", "question", "text", "message", "body", "payload", "content", "raw", "user_text", "email", "phone", "name", "ip", "address", "detail", "details", "transcript"];
const REQUIRED = ["ts", "signal_id", "emitter_node", "kind", "class", "confidence", "severity", "distribution", "expires_at", "evidence_ref"];
const KINDS = ["threat_detected", "threat_sighting", "threat_correction", "threat_revoke"];
const CLASSES = ["network", "identity", "agent_attack", "transaction", "exposure"];
const DISTS = ["estate", "armada-only", "external-ok"];
const SEVS = ["low", "medium", "high", "critical"];
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(\+\d{1,3}[\s-]?)?(\d[\s-]?){9,14}\d/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function walkKeys(v, errors) {
  if (Array.isArray(v)) { v.forEach(x => walkKeys(x, errors)); return; }
  if (!isObj(v)) return;
  for (const k of Object.keys(v)) {
    if (BANNED.includes(k.toLowerCase())) errors.push("banned field: " + k);
    walkKeys(v[k], errors);
  }
}

// Format-validated identifier fields are exempt from the shape scan: a UUID's
// digit runs can trip the phone regex (found by tests/signal-one.test.js).
const SCAN_SKIP = ["signal_id", "evidence_ref", "signature.value"];

function walkStrings(v, path, errors) {
  if (SCAN_SKIP.includes(path)) return;
  if (typeof v === "string") {
    if (v.length > 300) errors.push("contaminated value at " + path);
    else if (EMAIL_RE.test(v)) errors.push("contaminated value at " + path);
    else if (PHONE_RE.test(v)) errors.push("contaminated value at " + path);
    else if (v.includes("http://") || v.includes("https://")) errors.push("contaminated value at " + path);
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => walkStrings(x, path + "[" + i + "]", errors)); return; }
  if (isObj(v)) for (const k of Object.keys(v)) walkStrings(v[k], path ? path + "." + k : k, errors);
}

function validateSignal(sig) {
  const errors = [];
  if (!isObj(sig)) return { ok: false, errors: ["not an object"] };
  for (const k of Object.keys(sig)) if (!TOP.includes(k)) errors.push("unknown field: " + k);
  walkKeys(sig, errors);
  for (const k of REQUIRED) if (sig[k] === undefined) errors.push("missing field: " + k);
  if (sig.kind !== undefined && !KINDS.includes(sig.kind)) errors.push("bad kind");
  if (sig.class !== undefined && !CLASSES.includes(sig.class)) errors.push("bad class");
  if (sig.distribution !== undefined && !DISTS.includes(sig.distribution)) errors.push("bad distribution");
  if (sig.severity !== undefined && !SEVS.includes(sig.severity)) errors.push("bad severity");
  if (sig.confidence !== undefined && !(typeof sig.confidence === "number" && sig.confidence >= 0 && sig.confidence <= 100)) errors.push("bad confidence");
  if (sig.signal_id !== undefined && !UUID_RE.test(sig.signal_id)) errors.push("bad signal_id");
  if (sig.ts && sig.expires_at && !(Date.parse(sig.expires_at) > Date.parse(sig.ts))) errors.push("bad expires_at");
  // pattern: structural object only
  if (sig.pattern !== undefined) {
    if (!isObj(sig.pattern)) errors.push("pattern must be object");
    else {
      for (const k of Object.keys(sig.pattern)) if (!["summary", "families", "shape"].includes(k)) errors.push("bad pattern." + k);
      const p = sig.pattern;
      if (p.summary !== undefined && !(typeof p.summary === "string" && p.summary.length <= 300)) errors.push("bad pattern.summary");
      if (p.families !== undefined && !(Array.isArray(p.families) && p.families.length <= 8 && p.families.every(f => typeof f === "string" && f.length <= 40))) errors.push("bad pattern.families");
      if (p.shape !== undefined && !(typeof p.shape === "string" && p.shape.length <= 120)) errors.push("bad pattern.shape");
    }
  }
  if (sig.context !== undefined) {
    if (!isObj(sig.context)) errors.push("bad context");
    else {
      for (const k of Object.keys(sig.context)) if (!["component", "surface", "observations", "first_seen", "last_seen"].includes(k)) errors.push("bad context." + k);
      const c = sig.context;
      if (c.component !== undefined && !(typeof c.component === "string" && c.component.length <= 60)) errors.push("bad context.component");
      if (c.surface !== undefined && !(typeof c.surface === "string" && c.surface.length <= 60)) errors.push("bad context.surface");
      if (c.observations !== undefined && typeof c.observations !== "number") errors.push("bad context.observations");
    }
  }
  if (sig.iocs !== undefined) {
    if (!Array.isArray(sig.iocs) || sig.iocs.length > 10) errors.push("bad iocs");
    else for (const io of sig.iocs) {
      if (!isObj(io)) { errors.push("bad iocs"); break; }
      for (const k of Object.keys(io)) if (!["type", "value", "ttl_days"].includes(k)) errors.push("bad iocs." + k);
      if (!["ip", "domain", "hash", "url_host"].includes(io.type)) errors.push("bad iocs.type");
      if (io.value !== undefined && !(typeof io.value === "string" && io.value.length <= 120)) errors.push("bad iocs.value");
    }
  }
  if (sig.signature !== undefined) {
    if (!isObj(sig.signature)) errors.push("bad signature");
    else {
      for (const k of Object.keys(sig.signature)) if (!["alg", "value", "stub"].includes(k)) errors.push("bad signature." + k);
      if (sig.signature.value !== undefined && !(typeof sig.signature.value === "string" && sig.signature.value.length <= 128)) errors.push("bad signature.value");
    }
  }
  if (sig.evidence_ref !== undefined && !/^sha256:[0-9a-f]{64}$/.test(sig.evidence_ref)) errors.push("bad evidence_ref");
  if (sig.emitter_node !== undefined && !(typeof sig.emitter_node === "string" && sig.emitter_node.length <= 60)) errors.push("bad emitter_node");
  if (sig.emitter_agent !== undefined && sig.emitter_agent !== null && !(typeof sig.emitter_agent === "string" && sig.emitter_agent.length <= 80)) errors.push("bad emitter_agent");
  if (sig.bound_human !== undefined && sig.bound_human !== null && !(typeof sig.bound_human === "string" && sig.bound_human.length <= 80)) errors.push("bad bound_human");
  if (sig.attack_ref !== undefined && sig.attack_ref !== null && !(typeof sig.attack_ref === "string" && sig.attack_ref.length <= 20)) errors.push("bad attack_ref");
  walkStrings(sig, "", errors);
  return { ok: errors.length === 0, errors };
}

module.exports = { validateSignal };
