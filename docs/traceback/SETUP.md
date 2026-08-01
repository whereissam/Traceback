# Traceback — setup guide

Full walkthrough. For the project overview see the [README](../../README.md);
for architecture and the safety model see [README.md](./README.md) in this
folder.

## How the pieces fit

Read this first — it explains why the configuration looks the way it does.

There are **three separate programs**, and only the first runs in your browser:

```
  ┌──────────────────────┐
  │  BROWSER   (src/)    │   The UI. Holds no keys of any kind.
  │  localhost:5173      │   Its only outbound call is fetch('/api/...').
  └──────────┬───────────┘
             │  HTTP
             ▼
  ┌──────────────────────┐   Runs the correlation pipeline and holds every
  │  API SERVER (server/)│   secret. The only thing that talks to Supabase,
  │  localhost:8787      │   OpenAI, or Modal.
  └──────────┬───────────┘
             │
      ┌──────┴──────┬──────────────┐
      ▼             ▼              ▼
  Supabase       OpenAI          Modal
  (Postgres)   (report text)    (sandbox)
```

**The browser never connects to Supabase.** Supabase is used as a plain Postgres
database that the backend queries — not as a client-side service. That is why
`src/` imports neither `@supabase/supabase-js` nor `openai`.

Two consequences that surprise people:

- **No `VITE_` variables.** Vite only exposes variables prefixed with `VITE_` to
  browser code, and it does so by _pasting the value into the JavaScript bundle_,
  where anyone can read it with view-source. That prefix is an allowlist for
  public values, not a naming convention. Every key here is read by the server
  through `process.env`, so it must **not** be prefixed.
- **You need 2 Supabase values, not 4.** The dashboard's Server panel offers four
  because it assumes you are verifying end-user logins. Traceback has no sign-in
  yet. See Step 2.

## Step 1 — Install

```bash
bun install
```

Installs both the UI and server dependencies; they share one `package.json`.

**Prerequisites:** [Bun](https://bun.sh) 1.0+ (Node.js 20.19+ / 22.12+ also works
for the toolchain).

## Step 2 — Get your Supabase keys

**What you are doing:** giving the API server permission to read and write your
database.

In the Supabase dashboard: **Connect → Server** (not "Framework" — that panel is
for apps whose browser talks to Supabase directly, which is not this
architecture). It lists four variables; you need two:

| Variable                   | Copy it? | What it is                                                                                         |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`             | ✅ Yes   | Your project's address. Not a secret.                                                              |
| `SUPABASE_SECRET_KEY`      | ✅ Yes   | `sb_secret_…` — **bypasses Row Level Security**. The real secret. Server-side only.                |
| `SUPABASE_PUBLISHABLE_KEY` | ❌ No    | `sb_publishable_…` (formerly `anon`). Public by design, for browser clients. Nothing here uses it. |
| `SUPABASE_JWKS_URL`        | ❌ No    | A URL, not a key. Verifies end-user logins. Relevant once you add sign-in.                         |

Also **skip step 1 of that panel** (`npm install @supabase/server`). This repo
already uses `@supabase/supabase-js`, which is what the secret key works with.

> Older Supabase projects issue a JWT `service_role` key instead of `sb_secret_…`.
> Either works — set `SUPABASE_SERVICE_ROLE_KEY` in that case.

## Step 3 — Configure

```bash
cp .env.example .env
```

Fill in the two values from Step 2. `.env.example` documents every variable
inline. `.env` is gitignored, so your keys never reach the repo.

| Variable                                     | Required | Without it                                                 |
| -------------------------------------------- | -------- | ---------------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`        | **Yes**  | The API server refuses to start, with a named error        |
| `MODAL_SIMULATE_URL`, `MODAL_SIMULATE_TOKEN` | No       | Uses a local telemetry fixture, labelled as such in the UI |
| `OPENAI_API_KEY`                             | No       | A deterministic rule engine builds the timeline instead    |

The system runs end to end with only Supabase configured. Missing integrations
degrade visibly rather than failing silently.

Optional — real sandbox telemetry:

```bash
modal secret create traceback-sim SIM_TOKEN=$(openssl rand -hex 16)
modal deploy modal/modal_sim.py     # prints the URL for MODAL_SIMULATE_URL
```

## Step 4 — Create the tables

**What you are doing:** creating the six tables the pipeline writes to.

Open the Supabase **SQL Editor**, paste [`schema.sql`](./schema.sql), and run it.
Safe to re-run.

It also enables Row Level Security on every table with **no permissive
policies** — so even if the publishable key leaked, it could read nothing.

**Verify:** the Table Editor lists `investigations`, `events`, `evidence`,
`findings`, `attack_timeline`, and `reports`.

## Step 5 — Run it

```bash
bun run dev:all      # API server (:8787) + UI (:5173)
```

**Verify:** the terminal prints

```
[traceback] API listening on http://localhost:8787
[traceback] telemetry: local fallback | report model: rule-engine (no OPENAI_API_KEY)
```

That second line reports which integrations are live. Then open
**<http://localhost:5173/traceback>**.

## Troubleshooting

| Symptom                                                     | Cause and fix                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing required environment variable SUPABASE_SECRET_KEY` | `.env` is missing or the value is blank. A deliberate fail-fast, not a bug.                                                                 |
| The UI loads on a port other than 5173                      | Something else already holds 5173; Vite silently moves to 5174. Check the terminal for the actual URL.                                      |
| "Run simulation" fails with a table error                   | Step 4 has not run yet. Execute `schema.sql`.                                                                                               |
| Timeline says "generated by rule-engine"                    | Working as designed — no `OPENAI_API_KEY` is set.                                                                                           |
| An amber banner says telemetry came from the local fallback | Working as designed — Modal is not configured or was unreachable. The banner exists so a fallback is never mistaken for a real sandbox run. |
| A different app appears at localhost:5173                   | Another project's dev server is running. `tmux ls` to find it.                                                                              |

## Commands

| Command                | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `bun run dev`          | Start the UI dev server                             |
| `bun run dev:server`   | Start the API server (port 8787)                    |
| `bun run dev:all`      | Start both together                                 |
| `bun run build`        | Type-check and build for production                 |
| `bun run preview`      | Preview the production build                        |
| `bun run lint`         | Run ESLint                                          |
| `bun run typecheck`    | Type-check only (`tsc --noEmit`)                    |
| `bun run format`       | Format all files with Prettier                      |
| `bun run format:check` | Check formatting without writing                    |
| `bun run check`        | Lint + typecheck + format check                     |
| `bun run verify`       | Full gate: check + test + build (run before "done") |
| `bun run test`         | Run the test suite once                             |
| `bun run test:watch`   | Run tests in watch mode                             |

## Project structure

```
src/
├── components/
│   ├── traceback/       # Investigation UI (timeline, findings, report)
│   ├── ui/              # shadcn/ui components (Base UI primitives)
│   └── ...              # app-level components (nav, theme, etc.)
├── lib/
│   ├── traceback/       # Shared domain types + browser API client
│   └── utils.ts         # cn() and other helpers
├── routes/              # TanStack Router file-based routes
├── test/setup.ts        # Vitest + Testing Library setup
├── main.tsx             # App entry
└── index.css            # Tailwind + design tokens

server/                  # API server (Hono, run directly by Bun)
├── env.ts               # Config; required vars fail fast at boot
├── supabase.ts          # All database access
├── fixtures.ts          # Local telemetry (fallback + test fixture)
├── simulate.ts          # Calls Modal, falls back to fixtures
├── pipeline.ts          # Evidence -> FACT / CORRELATION / INFERENCE
├── llm.ts               # Constrained OpenAI report generation
└── index.ts             # Routes

modal/modal_sim.py       # Sandboxed telemetry simulation
docs/traceback/          # Architecture, schema.sql, this guide
```

## API

| Method | Path                        | Purpose                                 |
| ------ | --------------------------- | --------------------------------------- |
| `POST` | `/api/simulate`             | Run the sandbox, store raw events       |
| `POST` | `/api/investigate/:id`      | Run the pipeline (idempotent)           |
| `GET`  | `/api/investigation/:id`    | Full investigation payload              |
| `GET`  | `/api/investigations`       | Recent investigations                   |
| `POST` | `/api/findings/:id/confirm` | Record analyst sign-off on an INFERENCE |
| `GET`  | `/api/health`               | Which integrations are live             |

## Tech stack

| Layer          | Tools                                                        |
| -------------- | ------------------------------------------------------------ |
| **Framework**  | React 19, TypeScript (strict)                                |
| **Build**      | Vite 8                                                       |
| **Routing**    | TanStack Router (file-based)                                 |
| **Data**       | TanStack Query                                               |
| **Styling**    | TailwindCSS v4, `class-variance-authority`, `tailwind-merge` |
| **Components** | shadcn/ui on Base UI, Lucide icons                           |
| **API server** | Hono on Bun                                                  |
| **Database**   | Supabase (Postgres) with RLS                                 |
| **Sandbox**    | Modal (Python)                                               |
| **LLM**        | OpenAI, constrained to arranging derived findings            |
| **Testing**    | Vitest, Testing Library                                      |
| **Quality**    | ESLint, Prettier, lefthook, GitHub Actions CI, Dependabot    |

## Styling

TailwindCSS v4 via the Vite plugin, with a semantic design-token system in
`src/index.css` (see [`docs/design-system.md`](../design-system.md)). Evidence
tiers are tokens too — `--fact`, `--correlation`, `--inference`, `--danger` — so
a finding's epistemic level is readable at a glance in both themes without
hardcoded palette classes.

Components come from **shadcn/ui** on **Base UI** primitives. Add more with:

```bash
bunx shadcn@latest add dialog --base base
```

> Base UI replaces Radix's `asChild` with a `render` prop:
> `<Button render={<a href="/" />}>Home</Button>`

## Working with AI coding tools

| File             | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `AGENTS.md`      | Canonical conventions read by Cursor, Copilot, Codex, and others  |
| `CLAUDE.md`      | Pointer to `AGENTS.md` for Claude Code                            |
| `llms.txt`       | Concise project map in the [llms.txt](https://llmstxt.org) format |
| `.cursor/rules/` | Cursor rule that defers to `AGENTS.md`                            |
| `.mcp.json`      | MCP servers (ships with Playwright for UI verification)           |

Guardrails: ESLint + Prettier, a lefthook pre-commit hook, a `bun run verify`
gate (lint + typecheck + format + test + build), and Dependabot.

## Starter template

The frontend foundation is a reusable React starter — Vite 8, React 19, TanStack
Router & Query, TailwindCSS v4, shadcn/ui on Base UI. To start a new project from
it, click
**["Use this template"](https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/generate)**
on GitHub and delete `server/`, `modal/`, `docs/traceback/`,
`src/components/traceback/`, `src/lib/traceback/`, and `src/routes/traceback.tsx`.
