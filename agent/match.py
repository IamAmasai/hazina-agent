"""Deterministic receipt↔statement matching. No model involved: an expense is
matched when a receipt transaction and a statement line agree on amount
(exactly) and fall within a date window. One-to-one, greediest first (exact
date before near date). Everything unmatched stays visible — a receipt with
no statement line is a cash expense to confirm; a statement line with no
receipt is a paper-only record.
"""
from datetime import datetime

DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y")


def _parse_date(text):
    text = (text or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text[:19], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def match_receipts(record, window_days=3):
    txns = record.transactions()
    receipts = [t for t in txns if (t.get("source") or "").startswith("receipt:")]
    statement = [t for t in txns
                 if t.get("source") == "mpesa_statement" and t.get("direction") == "out"]
    used = set()
    results = {"matched": [], "unmatched_receipts": [], "unmatched_statement": []}

    def day_gap(a, b):
        da, db = _parse_date(a), _parse_date(b)
        if da is None or db is None:
            return None
        return abs((da - db).days)

    for receipt in sorted(receipts, key=lambda t: t["amount_kes"]):
        candidates = []
        for line in statement:
            if line["id"] in used:
                continue
            if abs(line["amount_kes"] - receipt["amount_kes"]) > 0.5:
                continue
            gap = day_gap(receipt.get("date"), line.get("date"))
            if gap is not None and gap <= window_days:
                candidates.append((gap, line))
        if candidates:
            candidates.sort(key=lambda c: c[0])
            _, line = candidates[0]
            used.add(line["id"])
            record.data["matches"].append({
                "transaction_id": line["id"],
                "document_sha": receipt.get("document_sha"),
                "basis": f"amount_exact+date_within_{candidates[0][0]}d",
            })
            record.log("verification", "receipt_matched",
                       f"{receipt['id']} -> {line['id']}")
            results["matched"].append((receipt["id"], line["id"]))
        else:
            results["unmatched_receipts"].append(receipt["id"])

    results["unmatched_statement"] = [t["id"] for t in statement if t["id"] not in used]
    return results
