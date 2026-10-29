# Hazi eval — mock month (Zuri Beauty, synthetic fixtures)

- Wall time end-to-end: 20.4s
- Extraction core fields exact: 15/15
- Line items exact: 12/12
- Receipts matched to statement lines: 5/5
- TOT exact vs ground truth: True
- Decisions hash-stamped in the record: 3/3
- Model tokens (receipt extractions): 9815
- Open questions left hanging: 0

## Failure cases (must degrade to questions, never inventions)
- bad_sum_becomes_question: PASS
- truncated_statement_no_invention: PASS
- unanswered_escalates: PASS

Synthetic fixtures grade the plumbing and the discipline. The submission quotes the same harness run on the pilot's real records, not these numbers.
