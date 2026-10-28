# Phase 0 Vision-Extraction Spike — Results (2026-10-28)

**Model:** muse-spark-1.3 via Meta Model API (standard tier, stored connector credential)
**Fixtures:** fictional "Zuri Beauty" salon, October 2026 — 5 rendered receipt images + 1 M-Pesa statement CSV, graded against `fixtures/mock/ground_truth.json`
**Script:** `eval/spike_vision.py` · raw output: `eval/spike-raw-results.json`

## Headline

- **Critical field (receipt total, `amount_kes`): 5/5 exact — 100%**
- **All core fields (date, vendor, amount, currency): 20/20 exact — 100%**
- **Line items: 12/12 extracted with exact amounts, zero hallucinated items**
- **Statement CSV (as text): rows 22/22; total in 57,700 / total out 76,620 / closing balance 21,080 — all exact**
- **Total spend: $0.0421** for 6 calls (cap was $0.50)

## Per-image verdicts

| Receipt | Amount | Date | Vendor | Items | Verdict |
|---|---|---|---|---|---|
| Supplier invoice (GlowLine) | 13,000 ✓ | 2026-10-06 ✓ | ✓ | 5/5 ✓ | Perfect |
| KPLC token voucher | 3,000 ✓ | 2026-10-11 ✓ | ✓ | n/a (none printed) | Perfect |
| Rent receipt (Kamau Properties) | 25,000 ✓ | 2026-10-03 ✓ | ✓ | n/a | Perfect |
| Supplies till receipt (Savanna) | 4,080 ✓ | 2026-10-17 ✓ | ✓ | 5/5 ✓ | Perfect |
| **Degraded receipt (QuickMart, ~8° rotation + Gaussian blur)** | 1,540 ✓ | 2026-10-21 ✓ | ✓ | 2/2 ✓ | **Perfect — the designed failure case did not fail** |

Every call returned strict JSON in the requested shape on the first attempt; no retries, no fence-stripping needed beyond the parser's safety net.

## Token usage and cost per call

| Call | Prompt tokens | Completion tokens (of which reasoning) | Est. cost |
|---|---|---|---|
| Supplier invoice | 1,586 | 1,323 (1,196) | $0.0076 |
| KPLC voucher | 1,209 | 1,125 (1,074) | $0.0063 |
| Rent receipt | 1,180 | 1,053 (1,015) | $0.0060 |
| Supplies receipt | 1,069 | 922 (777) | $0.0053 |
| Degraded receipt | 1,372 | 950 (867) | $0.0058 |
| Statement CSV (text) | 783 | 2,417 (1,645) | $0.0113 |
| **Total** | | | **$0.0421** |

Costing at $1.25 / $4.25 per 1M input / output tokens. A receipt costs roughly **0.6 US cents** to extract; a full month of ~30 receipts plus a statement would run ≈ **$0.20 per business per month** at this rate.

## Failure modes observed

**None in extraction.** No misread digits, no swapped totals, no invented line items, no JSON breakage — including on the rotated, blurred receipt.

## Honest caveats (what this spike does NOT prove)

1. **The fixtures are clean synthetic renders.** Perfectly printed DejaVu text on flat backgrounds. Real merchant receipts are faded thermal paper, crumpled, photographed at angles in poor light, sometimes handwritten. The "degraded" fixture (uniform blur + rotation of crisp text) is materially easier than a real phone photo — it did not stress the model. Real-photo robustness stays unproven until Beautify's actual records are run (expected this evening).
2. **Reasoning tokens dominate cost.** 75–96% of completion tokens were reasoning, not output. Costs are still tiny, but per-call cost is driven by thinking time, so it will vary with document complexity more than with output size.
3. **Single pass, n=5 images.** No variance measured; one wrong digit in a total would be a 20-point swing at this sample size. Treat the 100% as "no failures observed", not "error rate is zero".
4. **The model was asked to normalise dates to ISO** and did so across four different printed formats (06 Oct 2026, 11/10/2026 14:32, 3rd October 2026, 21/10/2026) without error — good sign, same synthetic-data caveat.

## Verdict

**Vision extraction is trustworthy enough to build Phase 1 on.** The plumbing (connector credential, image payload shape, strict-JSON discipline) and clean-document accuracy are proven, at negligible cost. Phase 1 should proceed — with two safeguards carried forward:

1. **Deterministic cross-checks in code, not trust in the model:** line items must sum to the receipt total; receipt totals must reconcile against statement lines. Any mismatch routes the item to the merchant-question flow (the "ask" step) instead of into the books. This is already the architecture (verification inside the committing tool).
2. **A real-photo grading run before any accuracy claim is made publicly:** re-run this same harness against Beautify's real October records when they arrive and publish *that* number in the submission, not this synthetic 100%.
