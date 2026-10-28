# Design review by Muse Spark (Meta Model API, hackathon credits) — 2026-10-29

Prompt: review Hazina's design + data model; name the 3 most important gaps/risks for a one-salon pilot this week + the one feature that most builds judge/customer trust. (2,336 tokens.)

Spark's answer, verbatim:
"1. Cash + Till gap: salon income is ~40-60% cash + Till payouts net of fees/delay. M-Pesa CSV only ≠ gross. Without daily cash takings + Till settlement reconciliation, TOT 1.5% base is wrong.
2. Unscalable confirmation: receipts.sha256 stops dupes but not Spark-vision misreads (faded thermal slips). matched_txn_id 1:1 fails for split cash top-ups, rent/bundles, market purchases with no M-Pesa leg. questions only on outflows misses business vs personal inflows - the TOT risk - and will spam owner with 30+ asks.
3. No lockable truth: access_code_hash single secret, no roles/audit immutability. packs.results jsonb without config_version+input hashes means Hazi can change category/tax and you can't reproduce for KRA/accountant.
Trust builder: Verifiable pack: Approve & Lock screen showing gross→TOT maths, eTIMS-backed vs paper-only totals, each line drillable to txn/receipt image, with PDF+hash+config version for accountant to check in 60s."

Disposition (founder's build): points 1 and the inflow half of 2 accepted as designed (manual cash lines; "not a sale" inflow flag). Point 3 accepted: packs record rules version + input hashes; Approve & lock is the close action. The 1:1 matching limit is real and stays a stated boundary in v1 (unmatched receipts still count as paper-evidenced costs; the pack says so).
