# Architecture

How Traceback is put together, and — the question this document mostly exists to
answer — **where the AI is, and where it deliberately isn't**.

---

## The short version

```
  ┌──────────────┐   fetch('/api/…')   ┌──────────────────┐
  │  BROWSER     │ ──────────────────► │  API SERVER      │
  │  src/        │                     │  server/         │
  │  holds no    │                     │  holds every     │
  │  credentials │                     │  credential      │
  └──────────────┘                     └────────┬─────────┘
                                                │
                    ┌───────────────────────────┼───────────────────┐
                    ▼                           ▼                   ▼
             ┌─────────────┐            ┌──────────────┐    ┌──────────────┐
             │  MODAL      │            │  SUPABASE    │    │  OPENAI      │
             │  sandbox    │            │  Postgres    │    │  prose only  │
             │  + strace   │            │  + RLS       │    │              │
             └─────────────┘            └──────────────┘    └──────────────┘
```

Three programs; only the first runs in a browser. The browser's entire outbound
surface is `fetch('/api/…')` — it imports neither `@supabase/supabase-js` nor
`openai`, so it holds no keys at all.

---

## The pipeline

Each stage may only cite the stage before it. That constraint is the product.

```
  npm registry
       │  fetch with --ignore-scripts (nothing executes yet)
       ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 1. SANDBOX          modal/inspect_package.py            │
  │    seed canary credentials, run the install hook under  │
  │    strace, capture execve / openat / read / connect     │
  └───────────────────────────┬─────────────────────────────┘
                              ▼   raw events (immutable, stored)
  ┌─────────────────────────────────────────────────────────┐
  │ 2. EVIDENCE         server/pipeline.ts                  │
  │    one plain statement of fact per event, each citing   │
  │    the event ids it came from. No interpretation.       │
  └───────────────────────────┬─────────────────────────────┘
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 3. FINDINGS         server/pipeline.ts                  │
  │    FACT · CORRELATION · INFERENCE                       │
  │    deterministic rules: process-tree ancestry, time      │
  │    windows, canary escalation                            │
  └───────────────────────────┬─────────────────────────────┘
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 4. VERDICT          server/verdict.ts                   │
  │    ALLOW / REVIEW / BLOCK — rules, not a model          │
  └───────────────────────────┬─────────────────────────────┘
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 5. NARRATIVE        server/llm.ts        ← the only AI  │
  │    arrange existing findings into a timeline;           │
  │    draft open questions and containment steps           │
  └─────────────────────────────────────────────────────────┘
```

Raw events are never mutated. Re-running the analysis replaces the
interpretation, never the ground truth (`clearDerived` in `server/supabase.ts`
deletes derived rows only).

---

## Where the AI is

**One call site in the entire codebase.** You can verify it:

```bash
grep -rn "responses.create" server/ src/
# server/llm.ts:118
```

### What it receives

Not raw telemetry. Only findings the rules already derived
(`server/llm.ts`, the `input` object):

```ts
const input = {
  evidence: evidence.map((item) => ({ id, statement, category, timestamp })),
  findings: findings.map((finding) => ({
    id, kind, title, description, confidence, mitre_technique,
    cited_evidence: /* the statements this finding rests on */,
  })),
}
```

### What it produces

A timeline that references findings **by id**, plus open questions and
containment steps. Nothing else.

### What stops it inventing things

Every id it returns is checked against the set it was given, and unknown ids are
dropped **before anything is written**:

```ts
const validFindingIds = new Set(findings.map((f) => f.id))
// …
const findingIds = (entry.finding_ids ?? []).filter((id) => {
  if (!validFindingIds.has(id) || seen.has(id)) return false
  seen.add(id)
  return true
})
```

It can rearrange the story. It cannot add to it.

---

## Where the AI deliberately isn't

| Decision                          | Made by              | Lives in                         |
| --------------------------------- | -------------------- | -------------------------------- |
| What happened (raw events)        | `strace`, the kernel | `modal/inspect_package.py`       |
| What each event means             | Rules                | `server/pipeline.ts`             |
| FACT vs CORRELATION vs INFERENCE  | Rules                | `server/pipeline.ts`             |
| Whether transmission is proven    | Canary match         | `server/pipeline.ts`             |
| Supply-chain indicators           | Rules                | `server/supply-chain.ts`         |
| **ALLOW / REVIEW / BLOCK**        | **Rules**            | `server/verdict.ts`              |
| Whether an inference is confirmed | **A human clicking** | `POST /api/findings/:id/confirm` |
| Readable prose                    | LLM                  | `server/llm.ts`                  |

### Proof: turn the AI off and the security answer is identical

Same telemetry, analysed twice:

|                        | Verdict        | FACT / CORR / INF | Timeline text                                              |
| ---------------------- | -------------- | ----------------- | ---------------------------------------------------------- |
| `OPENAI_API_KEY` set   | `block` · high | 7 / 4 / 2         | full prose                                                 |
| `OPENAI_API_KEY` empty | `block` · high | **7 / 4 / 2**     | `3 findings in this phase (FACT, CORRELATION, INFERENCE).` |

Reproduce it:

```bash
OPENAI_API_KEY= bun server/index.ts     # → {"llm":null}
```

Every number that matters is unchanged. Only readability degrades. That is the
whole design: **the model is a writer, not a witness and not a judge.**

---

## Why this shape

A language model pointed at logs produces a summary, and a summary cannot tell
you how much of itself to believe — it states a guess and an observation in the
same confident voice. In a security context that is worse than no answer,
because a wrong conclusion sends the response in the wrong direction.

So the model was given the one job it is genuinely good at (turning structured
findings into readable prose) and denied every job where being wrong is
expensive (deciding what happened, and deciding what to do about it).

---

## Data model

Six tables, all scoped to an investigation (`docs/traceback/schema.sql`):

| Table             | Holds                                   | Mutable?                     |
| ----------------- | --------------------------------------- | ---------------------------- |
| `investigations`  | one inspection run                      | status only                  |
| `events`          | raw telemetry, exactly as captured      | **never** — ground truth     |
| `evidence`        | plain statements, each citing event ids | replaced on re-analysis      |
| `findings`        | FACT / CORRELATION / INFERENCE          | replaced, except `confirmed` |
| `attack_timeline` | ordered phases                          | replaced                     |
| `reports`         | markdown, open questions, verdict JSON  | replaced                     |

Row Level Security is enabled on every table with **no permissive policies**, so
the publishable key can read nothing. The server uses the secret key, which
bypasses RLS — which is exactly why it never leaves the server.

---

## Trust boundaries

| Boundary           | What crosses it                       | Control                                                  |
| ------------------ | ------------------------------------- | -------------------------------------------------------- |
| Browser → API      | Investigation data only               | No credentials in the browser; `/api/*` is the only path |
| API → Modal        | A package name and a shared token     | Token-protected endpoint; the sandbox is disposable      |
| Sandbox → internet | The install hook's own traffic        | Canary is synthetic; the collector is ours               |
| API → OpenAI       | Derived findings, never raw telemetry | `store: false`; ids validated on return                  |
| API → Supabase     | Everything                            | Secret key, server-side only                             |

**Not built:** authentication on `/api/*`. Local evaluation only.

---

## Degradation

Every integration fails to a labelled fallback rather than an error:

| Missing  | Behaviour                                                                           |
| -------- | ----------------------------------------------------------------------------------- |
| Modal    | Local telemetry fixture; the UI shows an amber banner saying so                     |
| OpenAI   | Deterministic rule engine writes the timeline; report says `rule-engine`            |
| Supabase | **Server refuses to start** — a silent fallback to a broken database would be worse |

A fallback is never presented as the real thing. That rule is why the banner
exists.

---

## Testing

The correlation stage is pure functions over plain data, so its rules are tested
directly rather than through the database — 48 tests, including the negative
cases that matter most:

- an inference disappears when the correlation beneath it does
- the supply-chain detector does **not** fire on an ordinary `npm install`
- transmission is never claimed when the request failed
- evidence names the acting process, not the telemetry channel

```bash
bun run verify    # lint + typecheck + format + 48 tests + build
```

---

## File map

```
server/
├── env.ts           config; required vars fail fast at boot
├── supabase.ts      all database access
├── simulate.ts      calls Modal (fixture run + real package inspection)
├── fixtures.ts      local telemetry — fallback and test fixture
├── pipeline.ts      evidence → FACT / CORRELATION / INFERENCE
├── supply-chain.ts  named indicators, tuned against false positives
├── verdict.ts       ALLOW / REVIEW / BLOCK — rules only
├── llm.ts           the single AI call, and its validation gate
└── index.ts         routes

modal/
├── modal_sim.py        controlled malicious fixture + canary collector
└── inspect_package.py  real npm package inspection under strace

src/
├── lib/traceback/      shared domain types + browser API client
├── components/traceback/
└── routes/traceback.tsx
```

See also: [`docs/traceback/README.md`](traceback/README.md) for the safety model,
[`docs/traceback/SETUP.md`](traceback/SETUP.md) for configuration.
