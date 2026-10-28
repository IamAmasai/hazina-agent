#!/usr/bin/env python3
"""Hazi eval harness. Two halves:

1. End-to-end: run the real pipeline on the mock month and grade the record
   against ground_truth.json — extraction accuracy, matching, TOT exactness,
   wall time, token usage.
2. Failure cases (in-process, deterministic): a receipt whose items don't
   sum to its total must become a question, not a book entry; a truncated
   statement must produce exactly the transactions it contains (nothing
   invented); an unanswered question must escalate into the pack as a flag.

  python3 eval/run_eval.py
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)
MOCK = os.path.join(ROOT, "fixtures", "mock")
OUT = os.path.join(ROOT, "runs", "eval-latest")


def grade_end_to_end():
    t0 = time.time()
    subprocess.run(
        [sys.executable, os.path.join(ROOT, "run_month.py"),
         "--statement", os.path.join(MOCK, "statement_mpesa_oct2026.csv"),
         "--receipts", MOCK,
         "--answers", os.path.join(MOCK, "merchant_answers.json"),
         "--business", "Zuri Beauty", "--period", "2026-10", "--out", OUT],
        check=True, capture_output=True, text=True)
    seconds = round(time.time() - t0, 1)
    with open(os.path.join(OUT, "record.json")) as fh:
        rec = json.load(fh)
    with open(os.path.join(MOCK, "ground_truth.json")) as fh:
        truth = json.load(fh)

    docs = {os.path.basename(d["path"]): d for d in rec["documents"].values()}
    fields_ok = fields_total = 0
    items_ok = items_total = 0
    tokens = 0
    for r in truth["receipts"]:
        ext = (docs.get(r["file"]) or {}).get("extraction") or {}
        for key, want in (("date", r["date"]), ("vendor", r["vendor"]),
                          ("amount_kes", r["amount_kes"])):
            fields_total += 1
            if ext.get(key) == want:
                fields_ok += 1
        got_items = {(i["name"], i["amount_kes"]) for i in ext.get("items") or []}
        for item in r["items"]:
            items_total += 1
            if (item["name"], item["amount_kes"]) in got_items:
                items_ok += 1
        usage = ext.get("usage") or {}
        tokens += usage.get("total_tokens") or 0

    expected_tot = round(truth["statement"]["total_in_kes"] * 0.015, 2)
    tot_decision = next(d for d in rec["decisions"] if d["kind"] == "tot_computation")
    return {
        "seconds": seconds,
        "extraction_fields": f"{fields_ok}/{fields_total}",
        "line_items": f"{items_ok}/{items_total}",
        "matches": f"{len(rec['matches'])}/{len(truth['receipts'])}",
        "tot_exact": expected_tot == 865.50 and "865.5" in tot_decision["detail"],
        "stamped": sum(1 for d in rec["decisions"] if d.get("content_sha256")),
        "decisions": len(rec["decisions"]),
        "tokens_total": tokens,
        "open_questions": sum(1 for q in rec["questions"] if q["status"] == "open"),
    }


def failure_cases():
    from agent import ask
    from agent.record import Record
    from agent.tools import extract_receipt

    results = {}

    # 1. Items that don't sum to the total -> question + half confidence.
    rec = Record("Test Biz", "2026-10", {"income_tax_profile": "tot_band"})
    path = os.path.join(MOCK, "receipt_supplies.png")
    real = extract_receipt.client.vision_extract
    extract_receipt.client.vision_extract = lambda p, prompt: (
        json.dumps({"date": "2026-10-17", "vendor": "Savanna General Stores",
                    "amount_kes": 9999, "currency": "KES",
                    "items": [{"name": "Towels", "amount_kes": 1200}]}),
        {"total_tokens": 10})
    try:
        out = extract_receipt.run({"record": rec}, {"path": path})
    finally:
        extract_receipt.client.vision_extract = real
    txn = rec.transactions()[-1]
    results["bad_sum_becomes_question"] = (
        txn["confidence"] == 0.5 and len(rec.data["questions"]) == 1
        and "error" not in out)

    # 2. Truncated statement -> exactly the rows it contains, nothing invented.
    from agent.ingest_csv import parse_mpesa_statement
    with open(os.path.join(MOCK, "statement_mpesa_oct2026.csv")) as fh:
        lines = fh.read().splitlines()
    truncated = "\n".join(lines[:12])  # header + 11 rows
    txns = parse_mpesa_statement(truncated)
    results["truncated_statement_no_invention"] = len(txns) == 11

    # 3. Unanswered question -> escalated flag, gate reports it.
    rec2 = Record("Test Biz", "2026-10", {"income_tax_profile": "tot_band"})
    tid = rec2.add_transaction(date="2026-10-05", details="Mystery payment",
                               amount_kes=4200, direction="out",
                               source="mpesa_statement")
    ask.generate_questions(rec2, [tid])
    ask.escalate_unanswered(rec2)
    gate = ask.finalise_gate(rec2)
    results["unanswered_escalates"] = (
        gate["ok"] and gate["escalated"] == ["q-001"]
        and rec2.data["questions"][0]["status"] == "escalated")
    return results


def main():
    e2e = grade_end_to_end()
    failures = failure_cases()
    lines = ["# Hazi eval — mock month (Zuri Beauty, synthetic fixtures)", "",
             f"- Wall time end-to-end: {e2e['seconds']}s",
             f"- Extraction core fields exact: {e2e['extraction_fields']}",
             f"- Line items exact: {e2e['line_items']}",
             f"- Receipts matched to statement lines: {e2e['matches']}",
             f"- TOT exact vs ground truth: {e2e['tot_exact']}",
             f"- Decisions hash-stamped in the record: {e2e['stamped']}/{e2e['decisions']}",
             f"- Model tokens (receipt extractions): {e2e['tokens_total']}",
             f"- Open questions left hanging: {e2e['open_questions']}",
             "", "## Failure cases (must degrade to questions, never inventions)"]
    for name, ok in failures.items():
        lines.append(f"- {name}: {'PASS' if ok else 'FAIL'}")
    lines += ["", "Synthetic fixtures grade the plumbing and the discipline. "
              "The submission quotes the same harness run on the pilot's real "
              "records, not these numbers."]
    report = "\n".join(lines) + "\n"
    out_path = os.path.join(ROOT, "eval", "results-latest.md")
    with open(out_path, "w") as fh:
        fh.write(report)
    print(report)
    if not all(failures.values()) or not e2e["tot_exact"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
