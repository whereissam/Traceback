# Traceback

AI-assisted digital forensics that turns fragmented logs into an
evidence-backed incident timeline.

## Why

Security teams do not lack alerts; they lack a trustworthy explanation of what
happened. Traceback correlates logs, code changes, and runtime events into a
single timeline where **every claim is labelled FACT, CORRELATION, or
INFERENCE** and links back to the raw event ids it came from. A human confirms
findings instead of reconstructing the story from scratch.

## Demo story

```
Developer uses an AI coding agent to install a dependency
        ↓
A malicious postinstall script runs
        ↓
It reads a synthetic secret from .env
        ↓
It makes an outbound request 320ms later
        ↓
It rewrites the GitHub deployment workflow
```

Traceback turns that into:

| Phase             | What the system says                             |
| ----------------- | ------------------------------------------------ |
| Initial Access    | Malicious dependency installed                   |
| Execution         | `node postinstall.js` spawned by `npm install`   |
| Credential Access | Payload read `/app/.env`                         |
| Exfiltration      | Outbound request, same process tree, 320ms later |
| Persistence       | `.github/workflows/deploy.yml` modified          |

## How it works

```
Modal sandbox ──► raw events ──► evidence ──► findings ──► timeline ──► report
  (real            (Supabase)     (pure          (FACT /      (OpenAI,     (markdown
   telemetry)                      facts)      CORRELATION /  constrained)   + JSON)
                                                INFERENCE)
```

1. **Ingest.** `modal/modal_sim.py` runs the payload in a disposable container
   and emits telemetry from real processes, file I/O, and network calls. Each
   event is timestamped when it actually happened, so inter-event gaps are real.
2. **Normalise → evidence.** Every event becomes a plain statement of fact that
   cites the event ids behind it. No interpretation at this stage.
3. **Correlate.** Process-tree ancestry, time proximity, and user identity link
   evidence together. A credential read followed within 2s by an outbound
   request from the same tree is a CORRELATION — not yet a conclusion.
4. **Infer.** Only where correlations support it. Every INFERENCE carries a
   confidence, a note on what would confirm it, and cannot be marked confirmed
   by the system.
5. **Report.** The LLM arranges _already-derived findings_ into the timeline and
   drafts open questions and containment steps.

### Why the LLM cannot invent events

The model never sees raw telemetry. It receives the evidence and findings we
derived, and must reference findings by id. Every id it returns is checked
against the set we passed in — unknown ids are dropped before anything is
written. If the model returns nothing usable, a deterministic rule engine builds
the timeline instead. **The demo works with no `OPENAI_API_KEY` at all.**

## Setup

```bash
bun install
cp .env.example .env          # fill in SUPABASE_URL + SUPABASE_SECRET_KEY
```

Run `docs/traceback/schema.sql` in the Supabase SQL editor.

Optional — real sandbox telemetry:

```bash
modal secret create traceback-sim SIM_TOKEN=$(openssl rand -hex 16)
modal deploy modal/modal_sim.py     # prints the URL for MODAL_SIMULATE_URL
```

Optional — LLM-authored timeline: set `OPENAI_API_KEY`.

## Run

```bash
bun run dev:all     # API on :8787, UI on :5173
```

Then open <http://localhost:5173/traceback>.

Or run the two processes separately:

```bash
bun run dev:server
bun run dev
```

## API

| Method | Path                        | Purpose                           |
| ------ | --------------------------- | --------------------------------- |
| `POST` | `/api/simulate`             | Run the sandbox, store raw events |
| `POST` | `/api/investigate/:id`      | Run the pipeline (idempotent)     |
| `GET`  | `/api/investigation/:id`    | Full investigation payload        |
| `GET`  | `/api/investigations`       | Recent investigations             |
| `POST` | `/api/findings/:id/confirm` | Record analyst sign-off           |
| `GET`  | `/api/health`               | Which integrations are live       |

## Stack

Vite · React 19 · TanStack Router · Hono · Supabase · Modal · OpenAI

## Safety

All malicious behaviour is **simulated inside a disposable Modal sandbox**. The
"secret" is a synthetic string (`sk-synthetic-DO-NOT-USE-0000`), the outbound
request goes to `httpbin.org`, the "exfil" host in the generated workflow is
`exfil.invalid` (a reserved TLD that cannot resolve), and the workflow file is
written to `/tmp` inside the container. No real credential, registry, repository,
or external system is touched.

The Supabase **service-role key is server-side only** — it never appears in a
`VITE_`-prefixed variable and is never bundled into the browser. RLS is enabled
on every table with no permissive policies, so the anon key cannot read them.

## Tests

```bash
bun run verify    # lint + typecheck + format + tests + build
```

The pipeline is pure functions over plain data, so the correlation rules are
unit-tested directly: window boundaries, process-tree ancestry, and the
invariant that an INFERENCE never appears without a CORRELATION under it.
