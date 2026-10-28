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

    period_last_day = f"{args.period}-31"
    tot = rules.compute_tot(rec.transactions(), profile_cfg, period_last_day)
    rec.data["decisions"].append({
        "kind": "tot_computation",
        "detail": f"gross {tot['gross_sales_kes']} x {tot['rate']} = {tot['tot_payable_kes']}",
        "actor": "verification", "attestation_id": None})
    write_pack(args.out, rec.data, tot)
    rec.save(os.path.join(args.out, "record.json"))
    print(f"transactions: {len(txns)}")
    print(f"gross sales:  KSh {tot['gross_sales_kes']:,.2f}")
    print(f"TOT payable:  KSh {tot['tot_payable_kes']:,.2f} at {tot['rate'] * 100:.1f}%")
    print(f"open questions: {sum(1 for q in rec.data['questions'] if q['status'] == 'open')}")
    print(f"pack written to {args.out}/ (pack.md, tot_values.csv, record.json)")


if __name__ == "__main__":
    main()
