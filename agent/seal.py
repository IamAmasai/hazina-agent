"""Sealing: Hazi's decisions are written to Attest (Ansai's attestation
infrastructure — pre-existing, external, declared in the submission). If
Attest is unreachable, the seal degrades honestly to a local content hash
marked deferred; it never pretends a remote attestation exists.
"""
import hashlib
import json
import os
import urllib.request

BASE = os.environ.get("ATTEST_BASE_URL",
                      "https://attestation.ansaitechnologies.co.ke")


def _content_hash(payload):
    blob = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()


def seal_decision(record, decision):
    # Attest's record contract (api/attestations/index.ts): the seal is the
    # SHA-256 of the decision content. The content lives in Hazi's record;
    # anyone can re-hash it and walk the chain via GET ?hash=.
    blob = {
        "business": record.data["business"],
        "period": record.data["period"],
        "kind": decision.get("kind"),
        "detail": decision.get("detail"),
        "actor": decision.get("actor"),
    }
    digest = _content_hash(blob)
    decision["content_sha256"] = digest
    payload = {
        "type": "record",  # Attest's type vocabulary: identity | payment | record
        "subject": {"kind": "business",
                    "id": record.data["business"].lower().replace(" ", "-")},
        "record": {"hash": digest, "recordedBy": "hazi-agent"},
    }
    try:
        req = urllib.request.Request(
            BASE + "/api/attestations",
            data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
        att_id = body.get("id") or (body.get("attestation") or {}).get("id")
        if not att_id:
            raise ValueError("no id in Attest response")
        decision["attestation_id"] = att_id
        decision["seal_status"] = "attested"
    except Exception as exc:  # degrade honestly, never silently
        detail = ""
        try:
            detail = exc.read().decode()[:120]  # HTTPError carries the API's reason
        except Exception:
            detail = str(exc)[:120]
        decision["attestation_id"] = "local:" + digest[:24]
        decision["seal_status"] = f"deferred ({type(exc).__name__}: {detail})"
    record.log("system", "decision_sealed",
               f"{decision.get('kind')} -> {decision['attestation_id']} "
               f"[{decision['seal_status']}]")
    return decision


def seal_run(record):
    """Seal every unsealed decision in the record."""
    sealed = []
    for decision in record.data["decisions"]:
        if not decision.get("attestation_id"):
            sealed.append(seal_decision(record, decision))
    return sealed
