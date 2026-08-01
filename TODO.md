# TODO

## Done

- [x] Migrate UI primitives from Radix to **Base UI** (`@base-ui/react`)
  - [x] Rewrite `button.tsx` using `useRender` (`render` prop replaces `asChild`)
  - [x] Remove `@radix-ui/react-slot` and unused `@radix-ui/react-select`
  - [x] Add Vitest + Testing Library setup and `button.test.tsx`
  - [x] Update README, design-system docs, and add component instructions
- [x] Add baseline shadcn components: `card` and `input` (with tests)
- [x] Reconcile README — removed the "React Router DOM" mention (not a dependency; routing is TanStack Router)
- [x] Add CI workflow (`.github/workflows/ci.yml`) running `lint`, `test`, and `build`
- [x] AI-agent-ready upgrade ([spec](docs/superpowers/specs/2026-06-26-ai-agent-ready-starter-design.md))
  - [x] Add `AGENTS.md` (canonical) + reduce `CLAUDE.md` to a pointer
  - [x] Add `llms.txt`, `.cursor/rules/project.mdc`, and `.mcp.json` (Playwright)
  - [x] Add Prettier (+ Tailwind class sorting) and `eslint-config-prettier`
  - [x] Add `typecheck`, `format`, `check`, and `verify` scripts
  - [x] Add lefthook + lint-staged pre-commit hook
  - [x] Extend CI with `typecheck` + `format:check`; add `.github/dependabot.yml`

- [x] Major dependency upgrades (vite 6→8, eslint 9→10, TS 5.8→6, lucide 0→1) — `bun audit` now clean
  - [x] Drop deprecated `baseUrl` from tsconfigs (TS 6)
  - [x] Add `overrides.vite` to dedupe vite (vitest/@tailwindcss/vite pulled vite 6)
  - [x] Replace removed `Github` lucide icon with `Rocket`

- [x] Add **Traceback** — evidence-based security gate for AI-installed npm packages ([docs](docs/traceback/README.md), [setup](docs/traceback/SETUP.md), [roadmap](docs/todo.md))
  - [x] Supabase schema with RLS; secret key kept server-side only
  - [x] Sandboxed telemetry simulation on Modal, with a labelled local fallback
  - [x] Correlation pipeline producing FACT / CORRELATION / INFERENCE findings, each citing its evidence
  - [x] Hono API server (`server/`) + `dev:server` / `dev:all` scripts and a Vite `/api` proxy
  - [x] Constrained OpenAI report generation with id validation and a deterministic fallback
  - [x] `/traceback` route with analyst confirmation on every INFERENCE
  - [x] Evidence-tier design tokens in `src/index.css` (`--fact`, `--correlation`, `--inference`, `--danger`)
  - [x] Supply-chain detection with named indicators (package, install hook, secrets, persistence paths)
  - [x] Canary escalation: a synthetic token observed leaving the sandbox turns exfiltration from INFERENCE into FACT, and stands the weaker hypothesis down
  - [x] Rule-based ALLOW / REVIEW / BLOCK verdict that separates confirmed from unconfirmed
  - [x] Migrate report generation to the OpenAI Responses API (`gpt-5.6-luna`); `OPENAI_EFFORT` defaults to `low` (~8s vs ~48s)
  - [x] Deploy Modal sandbox and verify live: token auth rejects, real pids/timestamps, canary transmission observed
  - [x] Repo docs rewritten for readers rather than a tech listing (README as product overview, SETUP.md as the walkthrough)

- [x] Fix `bun run typecheck` — `tsc --noEmit` against a project-references root
      silently checked nothing, hiding real errors in `server/`. Now `tsc -b --force`.

## Backlog

### Traceback

- [ ] `npm install --ignore-scripts` prevention flow: intercept the agent's install,
      detect lifecycle scripts from `package.json`, and inspect before anything runs locally
- [ ] Replace self-reported telemetry with `strace` syscall capture in the sandbox
      (`openat`/`read`/`connect`), so evidence comes from the kernel rather than the script
- [ ] Ingestion adapters for real EDR/SIEM sources — the pipeline takes normalised events,
      so this is an adapter rather than a rewrite
- [ ] Authentication on `/api/*` before any deployment (currently local-evaluation only)
- [ ] Multi-host and multi-session correlation
- [ ] Persist analyst decisions as signal: which inferences were confirmed, which rejected, and why

### Template

- [ ] Add further shadcn/Base UI components on demand (`bunx shadcn@latest add <name> --base base`)
- [ ] AI-app on-ramp: streaming Claude example, typed env validation, server function for key safety
