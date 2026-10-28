"""The audited run record — the centre of Hazi.

Every stage reads and writes this one JSON record. Entries are actor-stamped
(agent / verification / human / system) so the finished pack can always answer
"why is this number what it is?" Documents are registered by SHA-256 and their
extractions cached against the hash: the same document is never paid for twice.
"""
import hashlib
import json
import os
import time


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class Record:
    def __init__(self, business_name, period, profile):
        self.data = {
            "business": business_name,
            "period": period,               # e.g. "2026-10"
            "profile": profile,             # assembled profile dict
            "status": "open",               # open | needs_input | paused | finalised
            "documents": {},                # sha256 -> {path, kind, extraction}
            "transactions": [],             # {id, date, details, amount_kes, direction, source, category, confidence}
            "matches": [],                  # {transaction_id, document_sha, basis}
            "questions": [],                # {id, transaction_id, question, answer, status}
            "decisions": [],                # {kind, detail, actor, content_sha256}
            "log": [],                      # {ts, actor, kind, detail}
        }

    # -- audit log ---------------------------------------------------------
    def log(self, actor, kind, detail):
        self.data["log"].append(
            {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "actor": actor, "kind": kind, "detail": detail})

    # -- documents ---------------------------------------------------------
    def register_document(self, path, kind):
        sha = sha256_file(path)
        if sha not in self.data["documents"]:
            self.data["documents"][sha] = {
                "path": path, "kind": kind, "extraction": None}
            self.log("system", "document_registered", f"{kind} sha={sha[:12]}")
        return sha

    def cached_extraction(self, sha):
        doc = self.data["documents"].get(sha) or {}
        return doc.get("extraction")

    def store_extraction(self, sha, extraction):
        self.data["documents"][sha]["extraction"] = extraction
        self.log("agent", "document_extracted", f"sha={sha[:12]}")

    # -- transactions ------------------------------------------------------
    def add_transaction(self, **txn):
        txn.setdefault("id", f"txn-{len(self.data['transactions']) + 1:04d}")
        self.data["transactions"].append(txn)
        return txn["id"]

    def transactions(self):
        return self.data["transactions"]

    # -- questions ---------------------------------------------------------
    def add_question(self, transaction_id, question):
        q = {"id": f"q-{len(self.data['questions']) + 1:03d}",
             "transaction_id": transaction_id, "question": question,
             "answer": None, "status": "open"}
        self.data["questions"].append(q)
        self.log("agent", "question_asked", f"{q['id']} on {transaction_id}")
        return q

    def answer_question(self, question_id, answer, actor="human"):
        for q in self.data["questions"]:
            if q["id"] == question_id:
                q["answer"] = answer
                q["status"] = "answered"
                self.log(actor, "question_answered", f"{question_id}: {answer}")
                return q
        raise KeyError(question_id)

    # -- persistence -------------------------------------------------------
    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            json.dump(self.data, fh, indent=2)

    @classmethod
    def load(cls, path):
        with open(path) as fh:
            data = json.load(fh)
        rec = cls(data["business"], data["period"], data["profile"])
        rec.data = data
        return rec
