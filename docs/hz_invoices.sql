-- Hazina — eTIMS sales invoices + workspace meta (2026-11-22)
-- Run in the Looply Supabase project (SQL editor), same pattern as the
-- other hz_ tables: RLS on, no public policies — only the serverless
-- functions holding the service key can touch these rows.

-- Sales invoices raised inside a month. An invoice is rendered in eTIMS
-- format by Hazina; cu_invoice_no / qr_payload are filled ONLY from a
-- real KRA eTIMS response — never by the app.
create table if not exists hz_invoices (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references hz_businesses(id),
  month_id       uuid not null references hz_months(id),
  number         text not null,               -- per-workspace sequence: INV-0001, INV-0002, …
  buyer_name     text not null,
  buyer_pin      text,                        -- buyer's KRA PIN, when they give one
  items          jsonb not null default '[]'::jsonb,  -- [{description, qty, amount, lineTotal}]
  total          numeric not null default 0,  -- always computed server-side from items
  status         text not null default 'draft',       -- draft | rendered | transmitted
  cu_invoice_no  text,                        -- KRA control-unit invoice number, once transmitted
  qr_payload     text,                        -- KRA QR payload, once transmitted
  transmitted_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (business_id, number)
);

alter table hz_invoices enable row level security;

create index if not exists hz_invoices_month_idx on hz_invoices (month_id);
create index if not exists hz_invoices_business_idx on hz_invoices (business_id);

-- Workspace meta: holds wizardSeen (the welcome guide has been seen) and,
-- once KRA issues them, the workspace's eTIMS connection under
-- meta.etims ({ connected, endpoint, clientId, clientSecret }).
alter table hz_businesses
  add column if not exists meta jsonb not null default '{}'::jsonb;
