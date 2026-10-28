#!/usr/bin/env python3
"""Run one month end to end on the text path (Slice 1).

Usage:
  python3 run_month.py --statement path/to/statement.csv \
      --business "Zuri Beauty" --period 2026-10 --profile tot_band \
      --out runs/2026-10

Statement in → transactions in the record → TOT from config → filing pack out.
Withdrawals with thin details become merchant questions (the ask loop, S3,
collects the answers); nothing is invented for them.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent import rules                      # noqa: E402
from agent.ingest_csv import parse_mpesa_statement  # noqa: E402
from agent.pack import write_pack            # noqa: E402
from agent.record import Record              # noqa: E402

QUESTION_THRESHOLD_KES = 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--statement", required=True)
    ap.add_argument("--business", required=True)
    ap.add_argument("--period", required=True, help="YYYY-MM")
    ap.add_argument("--profile", default="tot_band")
    ap.add_argument("--receipts", default=None,
                    help="directory of receipt images to extract and match")
    ap.add_argument("--answers", default=None,
                    help="JSON of merchant answers keyed by statement receipt code")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    profile_cfg = rules.load_profile(args.profile)
    rec = Record(args.business, args.period,
                 {"income_tax_profile": args.profile, "overlays": []})
    sha = rec.register_document(args.statement, "mpesa_statement")
    with open(args.statement) as fh:
        txns = parse_mpesa_statement(fh.read())
    for txn in txns:
        txn_id = rec.add_transaction(**txn)
        if (txn["direction"] == "out"
                and txn["amount_kes"] >= QUESTION_THRESHOLD_KES
                and len(txn["details"]) < 12):
            rec.add_question(
                txn_id,
                f"A payment of KSh {txn['amount_kes']:,.0f} on {txn['date']} "
                f"has no clear description ('{txn['details']}'). What was it for?")
    rec.log("agent", "statement_ingested", f"{len(txns)} transactions from sha={sha[:12]}")

    match_stats = None
    if args.receipts:
        from agent.match import match_receipts
        from agent.tools import extract_receipt
        images = sorted(
            os.path.join(args.receipts, f) for f in os.listdir(args.receipts)
            if f.lower().endswith((".png", ".jpg", ".jpeg")))
        for image in images:
            result = extract_receipt.run({"record": rec}, {"path": image})
            if "error" in result:
                print(f"extract FAILED {os.path.basename(image)}: {result['error']}")
        match_stats = match_receipts(rec)
        rec.log("verification", "matching_done",
                f"{len(match_stats['matched'])} matched, "
                f"{len(match_stats['unmatched_receipts'])} receipts unmatched, "
                f"{len(match_stats['unmatched_statement'])} statement lines unmatched")

    # Ask loop: unexplained statement lines become merchant questions.
    gate = None
    if match_stats:
        from agent import ask
        ask.generate_questions(rec, match_stats["unmatched_statement"])
        if args.answers:
            import json as _json
            with open(args.answers) as fh:
                answers = _json.load(fh)
            by_id = {t["id"]: t for t in rec.transactions()}
            for q in list(rec.data["questions"]):
                if q["status"] != "open":
                    continue
                code = (by_id.get(q["transaction_id"]) or {}).get("receipt")
                if code and code in answers:
                    a = answers[code]
                    ask.apply_answer(rec, q["id"], a["answer"],
                                     category=a.get("category"),
                                     business=a.get("business", True))
        ask.escalate_unanswered(rec)
        gate = ask.finalise_gate(rec)

    period_last_day = f"{args.period}-31"
    tot = rules.compute_tot(rec.transactions(), profile_cfg, period_last_day)
    rec.data["decisions"].append({
        "kind": "tot_computation",
        "detail": f"gross {tot['gross_sales_kes']} x {tot['rate']} = {tot['tot_payable_kes']}",
        "actor": "verification", "attestation_id": None})
    if match_stats:
        rec.data["decisions"].append({
            "kind": "reconciliation",
            "detail": f"{len(match_stats['matched'])} receipts matched to statement "
                      f"lines; {len(match_stats['unmatched_statement'])} lines "
                      f"unmatched and put to the merchant",
            "actor": "verification", "attestation_id": None})
        answered = [q for q in rec.data["questions"] if q["status"] == "answered"]
        if answered:
            rec.data["decisions"].append({
                "kind": "merchant_classifications",
                "detail": f"{len(answered)} items classified by merchant answer: "
                          + "; ".join(
                              f"{q['transaction_id']} -> "
                              f"{(next((t for t in rec.transactions() if t['id'] == q['transaction_id']), {}) or {}).get('category')}"
                              for q in answered),
                "actor": "human", "attestation_id": None})

    statement_outs = [t for t in rec.transactions()
                      if t.get("source") == "mpesa_statement"
                      and t.get("direction") == "out"
                      and t.get("business", True)]
    for t in statement_outs:
        t.setdefault("has_etims_invoice", False)  # paper trail only, unless evidenced
    etims = rules.etims_split(statement_outs)
    roll = rules.rolling_turnover([(args.period, tot["gross_sales_kes"])])
    vat = rules.vat_watch(roll["annualised_projection_kes"])
    regime = rules.compare_regimes(rec.transactions())
    from agent.seal import seal_run
    sealed = seal_run(rec)
    print(f"sealed decisions: {len(sealed)} "
          f"({sum(1 for d in sealed if d['seal_status'] == 'attested')} attested, "
          f"{sum(1 for d in sealed if d['seal_status'] != 'attested')} deferred)")
    write_pack(args.out, rec.data, tot, vat=vat, etims=etims, regime=regime)
    rec.save(os.path.join(args.out, "record.json"))
    print(f"transactions: {len(rec.transactions())}")
    if match_stats:
        print(f"receipts matched to statement lines: {len(match_stats['matched'])}")
        print(f"receipts unmatched: {len(match_stats['unmatched_receipts'])}; "
              f"statement lines unmatched: {len(match_stats['unmatched_statement'])}")
    print(f"gross sales:  KSh {tot['gross_sales_kes']:,.2f}")
    print(f"TOT payable:  KSh {tot['tot_payable_kes']:,.2f} at {tot['rate'] * 100:.1f}%")
    print(f"open questions: {sum(1 for q in rec.data['questions'] if q['status'] == 'open')}")
    if gate:
        print(f"finalise gate: ok={gate['ok']} escalated={gate['escalated']}")
    print(f"regime check: TOT {regime['tot_payable_kes']:,.2f} vs standard "
          f"{regime['standard_estimate_kes']:,.2f} (profit {regime['profit_kes']:,.2f})")
    print(f"VAT watch: annualised {roll['annualised_projection_kes']:,.0f} vs "
          f"threshold {vat['threshold_kes']:,.0f} — must register: {vat['must_register']}")
    print(f"pack written to {args.out}/ (pack.md, tot_values.csv, record.json)")


if __name__ == "__main__":
    main()
