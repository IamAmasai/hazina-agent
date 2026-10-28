# Hazina — the product (built from scratch, 29 Oct – 4 Nov 2026)

**Decision (founder, 2026-10-29):** Hazina did not exist as a product — only the
concept (an SME bookkeeping build sketched in September, never deployed, never
used). So the hackathon build is no longer "an agent plus a small UI". It is:

> **Hazina — M-Pesa-native bookkeeping for Kenyan small and micro businesses —
> with Hazi, an AI agent, living inside it.**

If it wins, it wins. If it doesn't, Hazina ships as a product Ansai markets.
Either way it is built properly: real data model, real persistence, real users.

## What Hazina is

A bookkeeping home for a small business:

- **Workspaces** — one per business: profile (legal form, income stream, KRA
  PIN), its tax posture derived from the four independent switches in the KRA
  research (income-tax regime × VAT overlay × eTIMS × agent obligations).
- **Months** — the unit of work. Each month has a lifecycle: *open → closing →
  closed*, and carries its ledger, receipts, questions, pack and audit log.
- **The ledger** — every shilling in and out: imported from M-Pesa statements
  (never typed by hand), plus manual entries for cash. Categories, personal
  carve-outs, eTIMS flags.
- **Receipts** — photographed paper, read by Muse Spark vision, confirmed by
  the merchant before they count. Metadata + SHA-256 hash in the record;
  photos themselves stay on the merchant's device in v1.
- **The pack** — per closed month: TOT figures + values CSV, regime
  comparison, VAT watch, eTIMS split, open-question flags, evidence index.
  Archived, downloadable, re-openable.

## Hazi, embedded

Hazi is not a separate tool bolted on. Inside Hazina, Hazi is the colleague who
does the month-end:

- **"Close the month with Hazi"** — the guided run (statement → receipts →
  reconcile → answer → pack) executed *inside* the workspace, persisted to the
  database at every step, resumable on any device.
- **Ask Hazi** — a question box on every closed (or closing) month: *"Why was
  the chama payment excluded?" "What would VAT registration change?"* Hazi
  answers from the month's own record — its ledger, receipts, answers and pack —
  grounded by the server, never from general knowledge of the business. If the
  record doesn't say, Hazi says so.
- **Hazi's activity log** — every match, classification, answer and computation
  is an event in the month's audit trail, written as it happens. The pack's
  evidence index is this log, rendered.

The rules Hazi computes by (TOT rate history, graduated bands, VAT threshold,
eTIMS consequences) live in versioned config — in the product exactly as in the
agent: the model reads paper and explains; it never supplies a rate and never
invents a record.

## Data model (Supabase, `hz_` tables, RLS on, service-role access only)

- `hz_businesses` — id, name, legal_form, income_stream, kra_pin, owner_name,
  access_code_hash (SHA-256; the code itself is never stored), created_at.
- `hz_months` — id, business_id, period (YYYY-MM), status, created_at,
  closed_at. Unique (business_id, period).
- `hz_txns` — id, month_id, ext_id, txn_date, details, receipt_code, amount,
  direction (in|out), is_business, category, source (statement|manual).
- `hz_receipts` — id, month_id, file_name, vendor, receipt_date, amount,
  items (jsonb), is_etims, status (new|draft|confirmed), sha256,
  matched_txn_id.
- `hz_questions` — id, month_id, txn_id, question, status (open|answered),
  category, answer, answered_at.
- `hz_packs` — id, month_id, results (jsonb), pack_text, tot_csv, created_at.
- `hz_events` — id, month_id, actor (hazi|merchant|system), kind, detail,
  created_at. The audit trail.

## Surfaces

- **hazina.ansaitechnologies.co.ke** — the product (this build).
- **hazi.ansaitechnologies.co.ke** — the standalone agent demo surface (built
  earlier in the window; same engine, local-only state) — kept as the light,
  no-signup way to feel Hazi in 60 seconds.
- **The Python pipeline** in this repo — the reference implementation the eval
  harness grades; the product's numbers must agree with it on the same month.

## Access model (v1)

A business workspace is opened by its **access code** (set at creation, stored
only as a hash; session = signed cookie, the Board pattern). Workspace creation
is gated by an admin passcode in the server environment. This is deliberately
simple for the pilot phase (owner-operated businesses, one user each);
per-user accounts and roles are the first post-hackathon upgrade, ahead of any
public self-signup.

## In scope this window / roadmap

**Now:** workspaces, months, statement import, receipts + Spark reading, the
embedded close-run, questions, packs + archive, Ask Hazi, activity log,
dashboard with cross-month TOT/VAT picture.
**Roadmap:** Attest sealing of closed packs; receipt photo storage; per-user
accounts + accountant role; bank statements; WhatsApp ask-loop; Daraja
till reconciliation; Swahili voice answers (only where language support is
verified).

## Design review — accepted corrections (Muse Spark review, 2026-10-29)

Spark reviewed this design on the credits; three points were right and are in:

1. **Cash is real.** A salon's gross is not only its M-Pesa statement. Manual
   entries (cash takings, cash costs) are first-class ledger lines, and the
   pack states plainly when a month's gross is statement-only.
2. **Inflows can be non-sales.** A loan or a personal transfer landing in the
   till account is not turnover. The merchant can mark any inflow "not a
   sale"; it leaves the TOT base, on their word, recorded as an event.
3. **A pack must be reproducible.** Every saved pack records the rules-config
   version and the SHA-256 hashes of its inputs (statement + receipts), so an
   accountant — or KRA — can re-derive the exact figures later.
   The merchant's **Approve & lock** action is what closes a month: figures
   shown, maths visible, then frozen with the pack.

## The pilot

Beautify by Angel — a real Nairobi salon — is workspace #1. Her October 2026
closes inside Hazina, with Hazi, on her real records.

## Integrations (only where the connection carries weight)
- **M-Pesa** — statement exports import into every month today. Roadmap: Daraja live feeds (till/bank movements as they happen).
- **KRA** — outputs in filing shapes: pack assembled in KRA order, TOT values file (CSV) for iTax, eTIMS evidence split on every cost. Hazina never files or signs on the merchant's behalf.
- **Meta Muse Spark** — receipt vision + Ask Hazi, on the hackathon credits during the event window.
- **WhatsApp** — roadmap: Hazi's questions/answers where the business already talks.
- **Ansai ecosystem** — Hazina runs on the same spine as the rest of Ansai (Supabase + Vercel, passcode-session pattern from the Board); Attest sealing of packs is a post-hackathon roadmap item, deliberately out of the event build.

## Libraries & shared code
- **Rules as config** — the KRA rules live once in `config/rules.ke.json` (generated from the researched YAML set); the Python pipeline and the product both read the same numbers. The model never supplies a rate.
- **Motion** (motion.dev) — spring-physics entrances, hardware-accelerated, loaded from CDN as progressive enhancement only.
- **NumberFlow** — digit-roll figure for the pack's tax hero; respects reduced-motion; falls back to plain text.
- **Ansai design system** — the Ansai palette v2 (azure/gold on blue-tinted neutrals), Fraunces + Inter, the product-mark family.
