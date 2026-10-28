"""Tool: extract_receipt — one file per tool (workshop pattern).

Registers the document by hash, returns the cached extraction if this record
has seen the document before, otherwise calls Muse Spark vision. The
extraction is cross-checked in code before it counts: line items must sum to
the receipt total. A mismatch lowers confidence and becomes a merchant
question — the figure never enters the books silently.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from agent import client  # noqa: E402

DEFINITION = {
    "name": "extract_receipt",
    "description": "Extract structured data from a receipt or invoice image.",
    "parameters": {"path": "image file path"},
}

PROMPT = (
    "Extract the data from this receipt or invoice image. Return strict JSON "
    "only, no prose: {\"date\": \"YYYY-MM-DD\", \"vendor\": string, "
    "\"amount_kes\": number (the total), \"currency\": \"KES\", "
    "\"items\": [{\"name\": string, \"amount_kes\": number}]}. "
    "If there are no itemised lines, items is an empty list."
)


def run(ctx, args):
    record = ctx["record"]
    path = args["path"]
    sha = record.register_document(path, "receipt")
    cached = record.cached_extraction(sha)
    if cached is not None:
        return {"sha": sha, "cached": True, "extraction": cached}

    text, usage = client.vision_extract(path, PROMPT)
    try:
        extraction = json.loads(text)
    except json.JSONDecodeError:
        return {"error": f"model returned non-JSON for {os.path.basename(path)}"}

    extraction["usage"] = usage
    items = extraction.get("items") or []
    total = extraction.get("amount_kes")
    items_sum = sum(i.get("amount_kes") or 0 for i in items)
    cross_check = "ok"
    if items and total is not None and abs(items_sum - total) > 0.5:
        cross_check = "items_do_not_sum_to_total"
    extraction["cross_check"] = cross_check
    record.store_extraction(sha, extraction)

    txn_id = record.add_transaction(
        date=extraction.get("date") or "",
        details=f"Receipt — {extraction.get('vendor') or 'unknown vendor'}",
        amount_kes=float(total or 0),
        direction="out",
        source=f"receipt:{sha[:12]}",
        stream=None,
        category=None,
        confidence=1.0 if cross_check == "ok" else 0.5,
        document_sha=sha,
        items=items,
        vendor=extraction.get("vendor"),
    )
    if cross_check != "ok":
        record.add_question(
            txn_id,
            f"The receipt from {extraction.get('vendor')} lists items adding "
            f"to KSh {items_sum:,.0f} but a total of KSh {total:,.0f}. "
            "Which figure is right?")
    return {"sha": sha, "cached": False, "transaction_id": txn_id,
            "extraction": extraction}
