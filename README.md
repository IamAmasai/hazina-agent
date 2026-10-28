# Hazina — a tax agent for small and micro businesses

**Helping small and micro businesses keep up with the digitizing tax systems.**

KRA has gone digital: invoicing is electronic under eTIMS, and KRA now validates
returns against that digital record — an expense without an eTIMS invoice behind
it is disallowed. But a small business's records still live in M-Pesa messages,
till statements and paper receipts in a drawer. Hazina is the bridge: hand it the
pile you already have, and it returns books that can stand in the digital system.
The agent who does the work — who reads, matches, asks and seals — is **Hazi**.

## What the agent does

One month-end run:

1. **Gather** — M-Pesa statement, bank statement, photos of paper receipts,
   voice notes for cash spent.
2. **Read** — Muse Spark vision turns documents into structured records.
3. **Match** — deterministic code matches every shilling in the statements to a
   record, or lists it as unmatched. Nothing is silently filled in.
4. **Ask** — the agent takes the unmatched list back to the merchant, one
   question at a time. The answers become records.
5. **Compute** — tax rules live in versioned config (`config/rules.ke.yaml`),
   never in the model: Turnover Tax on gross sales, a rolling VAT-registration
   threshold watch, and the eTIMS-backed vs paper-only expense split.
6. **Seal** — every match, classification and merchant answer is written to
   Attest, so every figure can later answer "why is this number what it is?"
7. **Hand over** — a filing pack: the TOT figures, threshold status, flagged
   items, and the evidence index. **A human files on iTax. The agent never
   submits anything itself, and never invents a record for a gap.**

## Pre-existing vs built during the event (Oct 28 – Nov 4, 2026)

- **Pre-existing (not in this repo):** the Hazina bookkeeping scaffold and the
  Attest attestation API — both Ansai Technologies products, called here as
  external services.
- **Built during the event:** everything in this repository — the reconciliation
  agent, its tools, the rules engine, and the evaluation harness.

## Pilot

The use case is **Beautify by Angel**, a real Nairobi beauty business: its real
month of M-Pesa records, statements and receipts is the fixture set the agent is
graded against. Raw business records are never committed to this repo (see
`fixtures/README.md`); the public samples are synthetic.

## Setup

Copy `.env.example` to `.env` and add your Meta Model API key. Keys live in
`.env` only — never in code, never in git.
