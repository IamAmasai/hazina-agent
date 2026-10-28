# Hazi — Build Map (Oct 28 → Nov 4, 2026)

The plan of record for the hackathon build. One page per concern; build order is
slices, each ending in something runnable and graded.

## 1. What we are building

**Hazi**, the tax agent inside **Hazina** (Ansai Technologies). A small or micro
business hands Hazi its month — M-Pesa statement, bank statement, photos of
paper receipts — and Hazi returns reconciled, Attest-sealed books plus a filing
pack in KRA's own shapes. Story: *helping small and micro businesses keep up
with the digitizing tax systems.*

Pilot: **Beautify by Angel** (real records, evening of Oct 28). Development runs
on a mock salon month until then.

Entry rules (Discord #rules): fresh public repo, event-window work only;
pre-existing Hazina scaffold + Attest declared and called externally; 3-minute
demo opening with the layering line; submission by Wed Nov 4, 9 PM ET
(= Nov 5 05:00 EAT; our real deadline is the evening of Nov 4 EAT).

## 2. Architecture

One audited **run record** is the centre. Every stage reads and writes it;
nothing lives only in a model conversation.

```
documents ──► ingest ──► extract ──► record ◄──► match ──► ask ──► rules ──► seal ──► pack
 (hash-     (registry)  (Spark       (one      (determin-  (merchant (config) (Attest) (KRA
  cached)                vision)     JSON)      istic)     answers)                     shapes)
```

- **Loop**: serial, one tool per turn (workshop pattern). A tool failure returns
  an error to the model as data; a failed run saves as `paused`, resumable.
- **Tools**: one file per tool in `agent/tools/`, each `run(ctx, args)`.
- **Record**: `agent/record.py` — documents (sha256 → extraction cache),
  transactions, matches, questions, decisions; every entry actor-stamped
  (agent / verification / human).
- **Rules**: `agent/rules.py` reads ONLY `config/` (master + per-profile YAML).
  The model never supplies a rate. Profiles assemble from dimensions
  (income-tax profile + overlays), per `config/rules.ke.yaml`.
- **Verification lives in the committing tool**: the pack cannot finalise while
  unexplained gaps exist — gaps are either answered by the merchant or carried
  into the pack as explicit flags.
- **Seal**: decisions are written to Attest (`POST /attestations`) — external,
  pre-existing, declared.
- **Console**: `ui/` renders the record (runs, questions, pack) and never
  imports the agent. Borrowed from the workshop console pattern.

## 3. Build slices (in order; each has a gate)

- **S0 Fixtures + spikes** (Oct 28): mock salon month with ground truth; Spark
  vision extraction graded field-by-field. *Gate: amounts accuracy high enough
  to trust the reading layer; failure modes named.* Real Beautify records swap
  in when they land (evening Oct 28).
- **S1 Text path end-to-end** (Oct 28–29): M-Pesa statement CSV → transactions →
  classify → TOT computation from config → filing pack (tot_values.csv in
  Section A–E order + pack.md). *Gate: the fictional-month numbers reconcile to
  the shilling against hand computation.*
- **S2 Vision path** (Oct 29–30): receipt photos → extraction (S0 prompt) →
  transactions in the same record; receipt↔statement matching (amount + date
  window). *Gate: ≥90% of statement lines matched or correctly listed unmatched
  on the fixture month.*
- **S3 Ask loop** (Oct 31): unmatched/unexplained items become merchant
  questions, one at a time, bounded (3 tries → escalate with the problem list);
  answers write back as human-stamped records. *Gate: a full mock month runs
  gather→pack with questions answered in the console.*
- **S4 Profiles + watches** (Oct 31–Nov 1): onboarding profile assembly
  (dimensions from config), VAT-threshold watch, eTIMS expense split
  (eTIMS-backed vs paper-only), regime comparison (TOT vs standard) as a draft
  only. *Gate: profile unit checks — salon (TOT+VAT watch) and consultancy
  (standard, TOT-excluded) assemble correctly.*
- **S5 Seal** (Nov 1): Attest writes for matches, classifications, answers;
  pack carries the evidence index. *Gate: every figure in the pack traces to a
  record + attestation id.*
- **S6 Console UI** (Nov 1–2): run view (documents, matches, questions, pack),
  phone-first. *Gate: the whole month is followable on a phone screen.*
- **S7 Eval + hardening** (Nov 2–3): harness reruns the month from scratch
  (accuracy, seconds, cost from token accounting); failure cases — blurry
  receipt, missing statement page, unexplained cash — degrade to questions,
  never inventions. Angel reviews her own pack. *Gate: harness numbers printed;
  zero invented records.*
- **S8 Demo + submission** (Nov 3–4): 3-minute phone-recorded demo (layering
  line → messy month → Hazi asks → sealed pack → "why was this flagged?"
  answered with receipt + rule + attestation); write-up; repo public; submit
  by evening Nov 4 EAT.

## 4. Out of scope (named, on purpose)

- Filing on iTax or signing/transmitting eTIMS invoices (KRA certification
  track — post-hackathon). Hazi produces everything up to KRA's door.
- Voice notes as a load-bearing input (Swahili is not among Voice Transcribe's
  verified languages; spike only if time remains after S3).
- VAT computation beyond the threshold watch and annex CSVs.
- WhatsApp surface (the console is the demo surface).

## 5. Risks that can still bite

- Vision accuracy on real photographed receipts (S0 grades the mock; real paper
  is messier) → extraction confidence per field; low confidence becomes a
  merchant question, never a guess.
- Free-credits content note (provider may use content for product improvement
  while on free credits) → pilot data minimised; standard Spark tier only,
  never contributor variants.
- Scope creep → this map is the fence; new ideas queue for after Nov 4.
