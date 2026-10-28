#!/usr/bin/env python3
"""Phase 0 vision-extraction spike for the Hazina tax agent (Hazi).

Sends each mock receipt image to muse-spark-1.3 through the Meta Model API
(stored connector credential, same surrogate pattern as the connector helper),
asks for strict-JSON extraction, and grades the result field by field against
fixtures/mock/ground_truth.json. Also runs the M-Pesa statement CSV through the
model as text for comparison.

Outputs: eval/spike-raw-results.json + a summary on stdout.
Pricing used for the spend estimate (Spark standard tier): $1.25 per 1M input
tokens, $4.25 per 1M output tokens.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.meta.ai/v1"
PROVIDER = "custom.meta-model-api"
HOSTS = ["api.meta.ai"]
MODEL = "muse-spark-1.3"
MAX_TOKENS = 3000
PRICE_IN_PER_M = 1.25
PRICE_OUT_PER_M = 4.25

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_DIR = os.path.join(ROOT, "fixtures", "mock")

IMAGE_PROMPT = (
    "Extract the data from this receipt image. Return strict JSON only, with no "
    "other text, in exactly this shape: "
    '{"date": "YYYY-MM-DD", "vendor": string, "amount_kes": number, '
    '"items": [{"name": string, "amount_kes": number}], "currency": "KES"}. '
    "amount_kes is the total amount paid on the receipt. items lists each "
    "itemised line with its amount; if the receipt has no itemised lines, use "
    "an empty list. If a field is genuinely unreadable, use null for it."
)

CSV_PROMPT = (
    "The text below is an M-Pesa till statement in CSV format. Return strict "
    "JSON only, with no other text, in exactly this shape: "
    '{"rows": number, "total_in_kes": number, "total_out_kes": number, '
    '"closing_balance_kes": number, "transactions": [{"date": "YYYY-MM-DD", '
    '"code": string, "amount_in_kes": number, "amount_out_kes": number}]}. '
    "rows is the number of transaction rows excluding the header. Use 0 for an "
    "empty Paid In or Paid Out cell.\n\n"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def call(payload):
    data = json.dumps(payload).encode()
    request = urllib.request.Request(BASE + "/chat/completions", data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    add_surrogate_to_request(request, PROVIDER, allowed_hosts=HOSTS)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            return response.status, read_json_response(response)
    except urllib.error.HTTPError as e:
        try:
            body = read_json_response(e)
        except Exception:
            body = {"error": "unreadable error body"}
        return e.code, body


def parse_json(text):
    """Best-effort strict-JSON extraction from a model reply."""
    if text is None:
        return None, "empty content"
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1:
        return None, "no JSON object found"
    try:
        return json.loads(t[start : end + 1]), None
    except json.JSONDecodeError as exc:
        return None, f"JSON decode failed: {exc}"


def cost(usage):
    pin = usage.get("prompt_tokens", 0)
    pout = usage.get("completion_tokens", 0)
    return pin / 1e6 * PRICE_IN_PER_M + pout / 1e6 * PRICE_OUT_PER_M


def num_eq(a, b):
    try:
        return a is not None and abs(float(a) - float(b)) < 0.005
    except (TypeError, ValueError):
        return False


def grade_receipt(gt, got):
    """Field-by-field grading. Amount is the critical field."""
    fields = {}
    fields["amount_kes"] = num_eq(got.get("amount_kes"), gt["amount_kes"])
    fields["date"] = got.get("date") == gt["date"]
    gv = (got.get("vendor") or "").strip().lower()
    tv = gt["vendor"].strip().lower()
    fields["vendor"] = bool(gv) and (gv in tv or tv in gv)
    fields["currency"] = (got.get("currency") or "").upper() == gt["currency"]
    gt_items = gt.get("items", [])
    got_items = got.get("items") or []
    item_hits = 0
    for gi in gt_items:
        for oi in got_items:
            oname = (oi.get("name") or "").lower()
            gname = gi["name"].lower()
            name_ok = gname.split("(")[0].strip() in oname or oname.split("(")[0].strip() in gname
            if num_eq(oi.get("amount_kes"), gi["amount_kes"]) and (name_ok or not oname):
                item_hits += 1
                break
    fields["items_matched"] = item_hits
    fields["items_total"] = len(gt_items)
    fields["items_extra"] = max(0, len(got_items) - len(gt_items))
    return fields


def main():
    with open(os.path.join(MOCK_DIR, "ground_truth.json")) as fh:
        gt = json.load(fh)

    results = {"model": MODEL, "calls": [], "receipts": [], "statement": None}
    total_cost = 0.0

    for rec in gt["receipts"]:
        path = os.path.join(MOCK_DIR, rec["file"])
        with open(path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        payload = {
            "model": MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": IMAGE_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }
            ],
            "max_tokens": MAX_TOKENS,
        }
        status, body = call(payload)
        usage = body.get("usage", {}) if isinstance(body, dict) else {}
        c = cost(usage)
        total_cost += c
        content = None
        if status == 200 and body.get("choices"):
            content = body["choices"][0]["message"].get("content")
        parsed, err = parse_json(content)
        entry = {
            "file": rec["file"],
            "status": status,
            "usage": usage,
            "cost_usd": round(c, 5),
            "raw_content": content,
            "parse_error": err,
            "extracted": parsed,
            "ground_truth": rec,
        }
        if parsed is not None:
            entry["grade"] = grade_receipt(rec, parsed)
        results["receipts"].append(entry)
        print(f"[{rec['file']}] status={status} cost=${c:.4f} parsed={parsed is not None}")

    # Statement CSV as text
    with open(os.path.join(MOCK_DIR, gt["statement"]["file"])) as fh:
        csv_text = fh.read()
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": CSV_PROMPT + csv_text}],
        "max_tokens": 4000,
    }
    status, body = call(payload)
    usage = body.get("usage", {}) if isinstance(body, dict) else {}
    c = cost(usage)
    total_cost += c
    content = None
    if status == 200 and body.get("choices"):
        content = body["choices"][0]["message"].get("content")
    parsed, err = parse_json(content)
    stmt = {
        "status": status,
        "usage": usage,
        "cost_usd": round(c, 5),
        "raw_content": content,
        "parse_error": err,
        "extracted_totals": None,
        "ground_truth": gt["statement"],
    }
    if parsed is not None:
        stmt["extracted_totals"] = {
            "rows": parsed.get("rows"),
            "total_in_kes": parsed.get("total_in_kes"),
            "total_out_kes": parsed.get("total_out_kes"),
            "closing_balance_kes": parsed.get("closing_balance_kes"),
        }
        stmt["totals_match"] = {
            "rows": parsed.get("rows") == gt["statement"]["rows"],
            "total_in_kes": num_eq(parsed.get("total_in_kes"), gt["statement"]["total_in_kes"]),
            "total_out_kes": num_eq(parsed.get("total_out_kes"), gt["statement"]["total_out_kes"]),
            "closing_balance_kes": num_eq(parsed.get("closing_balance_kes"), gt["statement"]["closing_balance_kes"]),
        }
    results["statement"] = stmt
    print(f"[statement csv] status={status} cost=${c:.4f} parsed={parsed is not None}")

    results["total_cost_usd"] = round(total_cost, 5)
    out_path = os.path.join(ROOT, "eval", "spike-raw-results.json")
    with open(out_path, "w") as fh:
        json.dump(results, fh, indent=2)
    print(f"total estimated spend: ${total_cost:.4f}")
    print(f"raw results written to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
