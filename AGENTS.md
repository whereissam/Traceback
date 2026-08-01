# AGENTS.md — Project Conventions for AI Agents

This is the **canonical** instructions file for this repository. It is read by
AI coding tools that follow the [AGENTS.md](https://agents.md) standard
(Cursor, GitHub Copilot, Codex, and others). `CLAUDE.md` points here.

## Stack Overview

| Layer      | Tools                                                        |
| ---------- | ------------------------------------------------------------ |
| Framework  | React 19, TypeScript (strict)                                |
| Build      | Vite                                                         |
| Routing    | TanStack Router (file-based, codegen)                        |
| Data       | TanStack Query                                               |
| Styling    | TailwindCSS v4, `class-variance-authority`, `tailwind-merge` |
| Components | shadcn/ui on Base UI primitives, Lucide icons                |
| API server | Hono on Bun (`server/`)                                      |
| Database   | Supabase (Postgres), service-role key server-side only       |
| Sandbox    | Modal (Python) for telemetry simulation (`modal/`)           |
| LLM        | OpenAI, constrained to arranging derived findings            |
| Testing    | Vitest + Testing Library (jsdom)                             |
| Quality    | ESLint, Prettier, lefthook pre-commit, GitHub Actions CI     |

## Key Commands

Always use **`bun`** (never npm/yarn) and **`bunx`** (never npx).

| Command                | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `bun run dev`          | Start the dev server                                                      |
| `bun run dev:server`   | Start the Traceback API server on port 8787                               |
| `bun run dev:all`      | Start the API server and the dev server together                          |
| `bun run build`        | Type-check and build for production                                       |
| `bun run lint`         | Run ESLint                                                                |
| `bun run typecheck`    | Type-check only (`tsc --noEmit`)                                          |
| `bun run format`       | Format all files with Prettier                                            |
| `bun run format:check` | Check formatting without writing                                          |
| `bun run test`         | Run the Vitest suite once                                                 |
| `bun run check`        | Lint + typecheck + format check                                           |
| `bun run verify`       | **Full gate: check + test + build. Run this before declaring work done.** |

## Project Structure

```
src/
├── components/
│   ├── traceback/       # Traceback investigation UI
│   ├── ui/              # shadcn/ui components (Base UI primitives)
│   └── ...              # app-level components (nav, theme, etc.)
├── lib/
│   ├── traceback/       # Shared domain types + browser API client
│   └── utils.ts         # cn() and other helpers
├── routes/              # TanStack Router file-based routes (__root.tsx, index.tsx, ...)
├── test/setup.ts        # Vitest + Testing Library setup
├── main.tsx             # App entry
└── index.css            # Tailwind + design tokens

server/                  # Traceback API (Hono, run directly by Bun)
├── env.ts               # Env config; required vars fail fast at boot
├── supabase.ts          # All database access funnels through here
├── fixtures.ts          # Local telemetry (fallback + test fixture)
├── simulate.ts          # Calls Modal, falls back to fixtures.ts
├── pipeline.ts          # Evidence -> FACT / CORRELATION / INFERENCE
├── llm.ts               # Constrained OpenAI report generation
└── index.ts             # Routes

modal/modal_sim.py       # Sandboxed telemetry simulation
docs/traceback/          # Architecture notes + schema.sql
```

`src/routeTree.gen.ts` is **generated** — never edit it by hand.

There are three TypeScript projects, referenced from `tsconfig.json`:
`tsconfig.app.json` (`src/`, DOM libs), `tsconfig.node.json` (`vite.config.ts`),
and `tsconfig.server.json` (`server/`, Node types). A new top-level directory
needs its own project or it will not be type-checked by `bun run typecheck`.

## Traceback

Traceback is the forensics application in this repo. Full architecture is in
[`docs/traceback/README.md`](./docs/traceback/README.md); status and roadmap are
in [`docs/todo.md`](./docs/todo.md). Rules that matter when changing it:

- **Never let a claim outrun its evidence.** Findings are `FACT`,
  `CORRELATION`, or `INFERENCE`. An `INFERENCE` must cite the correlations it
  rests on, carry a note describing what would confirm it, and never be marked
  confirmed by the system — only by a human via `POST /api/findings/:id/confirm`.
- **The LLM must not be able to invent events.** It receives already-derived
  findings, never raw telemetry, and references them by id. Every id it returns
  is validated against the set we passed in; unknown ids are discarded before
  anything is written. Keep that validation gate in `server/llm.ts`.
- **Degrade, don't break.** Missing `OPENAI_API_KEY` falls back to the
  deterministic rule engine; an unreachable Modal endpoint falls back to
  `server/fixtures.ts`. A fallback must always be labelled as one in the
  response and the UI — never presented as sandbox telemetry.
- **Keep `server/pipeline.ts` pure.** No database or network calls. That is what
  makes the correlation rules unit-testable; add tests there for new rules.
- Analysis is idempotent: `POST /api/investigate/:id` clears derived rows first.
  Raw `events` are ground truth and are never deleted.

## Secrets and Environment

- Server-only config lives in `.env` (gitignored); `.env.example` documents it.
- **Never put a secret in a `VITE_`-prefixed variable** — those are inlined into
  the browser bundle. The Supabase service-role key bypasses RLS and must stay
  server-side.
- Every table has RLS enabled with no permissive policies, so the anon key
  cannot read them. Adding a table means adding its `enable row level security`.
- The browser talks only to `/api/*`; Vite proxies that to the API server in dev.

## Tooling Rules

- ALWAYS use `bun` instead of `npm` or `yarn` for TypeScript/JavaScript.
- ALWAYS use `bunx` instead of `npx`.
- ALWAYS use `uv` for Python package management and virtual environments.
  `modal/` is the only Python in this repo; it runs on Modal, not locally.
- For iOS, use `swift build` and `swift test`.

## File Conventions

- `AGENTS.md` and `CLAUDE.md` belong in the repo root, not in subdirectories.
- All new features must include tests in the appropriate test directory.
- Tests live next to the code they cover (e.g. `src/components/ui/button.test.tsx`,
  `server/pipeline.test.ts`).
- Test files must not import `server/env.ts`, directly or transitively — it
  throws on missing config at import time. Keep fixtures free of config imports.
- Route files in `src/routes/` should stay thin: export the route and delegate to
  a component in `src/components/`. Defining components alongside the `Route`
  export trips `react-refresh/only-export-components`.
- Colours belong in `src/index.css` as tokens, not as hardcoded Tailwind palette
  classes in components. See [`docs/design-system.md`](./docs/design-system.md).

## Post-Implementation Checklist (MANDATORY after every feature)

1. Run `bun run verify` and fix all failures.
2. Update `TODO.md` to mark completed items and add any new items discovered.
   For Traceback changes, also update `docs/todo.md` — it is public-facing, so
   keep it a product roadmap and record new limitations honestly.
3. Update `README.md` if new features affect the public API or setup, and
   `docs/traceback/README.md` if the architecture or safety model changed.
4. Update `.env.example` when adding config, and `llms.txt` when adding a
   top-level directory or entry point.
5. Provide a conventional commit message (`feat:`, `fix:`, `docs:`, etc.).
6. Never stage all files — only stage files related to the current task.

## Git Rules

- Only `git add` files that were modified in the current task.
- Never force push.
- Use separate commits for logically distinct changes when asked.

## MCP Servers

`.mcp.json` configures [Model Context Protocol](https://modelcontextprotocol.io)
servers for agents that support them (e.g. Claude Code). It ships with a
**Playwright** browser-automation server so agents can drive and verify the UI:

```jsonc
// runs on demand via bunx; no global install needed
"playwright": { "command": "bunx", "args": ["@playwright/mcp@latest"] }
```

`.mcp.json` must be strict JSON (no comments). To add a server, add another entry
under `mcpServers`. Tool-specific support varies; the file is additive and safe to
ignore for tools that don't read it.
