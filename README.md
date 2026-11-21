# Hazina — a tax agent for small and micro businesses

**Helping small and micro businesses keep up with the digitizing tax systems.**

KRA has gone digital: invoicing is electronic under eTIMS, and KRA now validates
returns against that digital record — an expense without an eTIMS invoice behind
it is disallowed. But a small business's records still live in M-Pesa messages,
till statements and paper receipts in a drawer. Hazina is the bridge: hand it the
pile you already have, and it returns books that can stand in the digital system.
The agent who does the work — who reads, matches, asks and computes — is **Hazi**.

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
6. **Record** — every match, classification and merchant answer is written
   into the run's audited record, hash-stamped and tied to the documents it
   rests on, so every figure can later answer "why is this number what it is?"
7. **Hand over** — a filing pack: the TOT figures, threshold status, flagged
   items, and the evidence index. **A human files on iTax. The agent never
   submits anything itself, and never invents a record for a gap.**

## Pre-existing vs built during the event (26 Oct – 4 Nov, 2026)

- **Pre-existing:** the Hazina product concept and the pilot relationship
  with Beautify by Angel. No pre-existing code is used anywhere in the build.
- **Built during the event:** everything in this repository — the agent, its
  tools, the rules engine, the merchant web app, and the evaluation harness —
  written from scratch during the event window.
- **Post-hackathon roadmap:** sealing each run's decisions to Attest, Ansai's
  attestation infrastructure, so a finished pack also carries a remotely
  verifiable, signed seal.

## Pilot

The use case is **Beautify by Angel**, a real Nairobi beauty business: its real
month of M-Pesa records, statements and receipts is the fixture set the agent is
graded against. Raw business records are never committed to this repo (see
`fixtures/README.md`); the public samples are synthetic.

## Setup

Copy `.env.example` to `.env` and add your Meta Model API key. Keys live in
`.env` only — never in code, never in git.

## Sign-in — the webapp's three doors

1. **Google (the front door).** "Continue with Google" on the gate. The first
   sign-in creates the person's account — sign-up and sign-in are one button.
   Every sign-in upserts a row in `as_identities`, the identity table shared
   with the Agent Store (one identity per person across the estate); the row's
   `ansaiPersonId` stays null until the Ansai ID service gains a provisioning
   API. The session is a signed cookie (`hz_google`, HMAC keyed by the OAuth
   client secret, 30 days); the ID token is verified against Google's JWKS.
2. **Workspace access code (the recovery door).** Unchanged: a code opens its
   workspace directly, whether or not Google is involved.
3. **Ansai ID.** Unchanged: members of a workspace via `hz_workspace_members`
   open it from their Ansai ID session.

**Linking model.** A Google session sees exactly the businesses whose
`hz_businesses.owner_email` equals its verified email. While signed in with
Google, entering a workspace's access code once links it (sets `owner_email`)
and opens it; from then on it opens from the Google door directly. A workspace
already linked to a different email refuses the link — a code can never move
someone else's books onto your account. Businesses with no `owner_email` keep
working by access code exactly as before.

**Env (Vercel project `hazina-app`).** `GOOGLE_CLIENT_ID` and
`GOOGLE_REDIRECT_URI` (= `https://hazina.ansaitechnologies.co.ke/api/auth?provider=google&step=callback`)
are set. `GOOGLE_CLIENT_SECRET` — the secret of the shared "Ansai Web" OAuth
client, the same value the Agent Store uses — is pasted by the founder in the
Vercel dashboard; until it is set, the Google button lands on a plain
"not switched on yet" page and the code door carries on. The matching
authorised origin + redirect URI for the Hazina domain must exist on the
"Ansai Web" client in Google Cloud Console.

**Function cap.** `webapp/api/` now carries 12 route files — the Vercel Hobby
cap. `api/auth.js` is the last route that fits; any future endpoint must fold
into an existing route file, the way `api/pay.js` folds the Daraja callback in.

## Try Hazina live — for hackathon judges

Hazina is gated by design: the front door is Google sign-in, and a workspace opens only once it is linked to the owner's Google account by its access code (the code itself, and Ansai ID, remain working doors). Signing in alone opens no books. For judging, a demo workspace is open:

- **Live app:** https://hazina.ansaitechnologies.co.ke
- **Access code:** `demo2026` — workspace *Kijiji Groceries (Demo)*, sample books for a small Nairobi grocery
- **October 2026 is closed:** 10 statement lines imported, 2 eTIMS receipts matched by the deterministic reconciler, and a Turnover Tax pack saved — **TOT KSh 6,180 on gross KSh 412,000**, with the pack's rules version and input hashes recorded.
- **November 2026 is in progress:** add lines, save a receipt, ask Hazi a question, and run *Close with Hazi* yourself to see a pack being prepared.
