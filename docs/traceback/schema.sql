-- Traceback — Supabase schema
-- Run this once in the Supabase SQL editor (or `supabase db execute -f`).
-- Safe to re-run: every statement is idempotent.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- investigations
-- ---------------------------------------------------------------------------
create table if not exists investigations (
  id uuid primary key default gen_random_uuid(),
  title text,
  status text not null default 'open', -- open | investigating | closed
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events — raw telemetry, exactly as it arrived from Modal / logs
-- ---------------------------------------------------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  timestamp timestamptz not null,
  source text, -- terminal | npm | process | network | git | file
  event_type text, -- process_start | file_read | network_out | git_modify ...
  raw jsonb not null,
  process_id text,
  parent_process_id text,
  user_id text,
  created_at timestamptz not null default now()
);

create index if not exists events_investigation_ts_idx
  on events (investigation_id, timestamp);

-- ---------------------------------------------------------------------------
-- evidence — normalised, citable statements of fact. Never interpretation.
-- ---------------------------------------------------------------------------
create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  event_ids uuid[] not null, -- links back to raw events
  statement text not null,
  timestamp timestamptz,
  category text, -- process | file | network | code | credential
  created_at timestamptz not null default now()
);

create index if not exists evidence_investigation_idx
  on evidence (investigation_id);

-- ---------------------------------------------------------------------------
-- findings — FACT / CORRELATION / INFERENCE, each backed by evidence
-- ---------------------------------------------------------------------------
create table if not exists findings (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  kind text not null, -- FACT | CORRELATION | INFERENCE
  title text,
  description text,
  confidence text, -- high | medium | low
  mitre_technique text,
  evidence_ids uuid[] not null default '{}',
  note text,
  confirmed boolean not null default false, -- human sign-off on an INFERENCE
  created_at timestamptz not null default now()
);

create index if not exists findings_investigation_idx
  on findings (investigation_id);

-- ---------------------------------------------------------------------------
-- attack_timeline — the final narrative, ordered
-- ---------------------------------------------------------------------------
create table if not exists attack_timeline (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  phase text, -- initial_access | execution | credential_access | exfiltration | persistence
  title text,
  description text,
  finding_ids uuid[] not null default '{}',
  order_index int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists attack_timeline_investigation_order_idx
  on attack_timeline (investigation_id, order_index);

-- ---------------------------------------------------------------------------
-- reports — the generated investigation report (markdown + structured JSON)
-- ---------------------------------------------------------------------------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  markdown text,
  open_questions text[] not null default '{}',
  containment_steps text[] not null default '{}',
  generated_by text, -- model id, or 'rule-engine' when the LLM was unavailable
  verdict jsonb, -- rule-based allow/review/block decision + its basis
  created_at timestamptz not null default now()
);

create index if not exists reports_investigation_idx
  on reports (investigation_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The API server talks to Supabase with the SERVICE ROLE key, which bypasses
-- RLS. RLS is enabled with no permissive policies so that the anon/public key
-- cannot read or write these tables directly from a browser.
-- ---------------------------------------------------------------------------
alter table investigations enable row level security;
alter table events enable row level security;
alter table evidence enable row level security;
alter table findings enable row level security;
alter table attack_timeline enable row level security;
alter table reports enable row level security;
