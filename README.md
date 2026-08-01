<div align="center">

# Traceback

### An evidence-based security gate for npm packages installed by AI coding agents

**Your agent asks permission to run `npm install`. That permission does not cover
the code npm runs on the package's behalf.**

Traceback executes a package's install hook in an isolated sandbox, records what
it actually does, and returns **ALLOW / REVIEW / BLOCK** — where every claim is
labelled **FACT**, **CORRELATION**, or **INFERENCE** and cites the raw events it
came from.

_Do not trust what the package says. Observe what it does._

[![CI](https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/actions/workflows/ci.yml/badge.svg)](https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

</div>

---

## The problem

An AI coding agent asks before it runs a command:

```
Cursor wants to run:  npm install analytics-helper
```

You approve installing a package. But npm doesn't just download files — it runs
code the package author wrote, automatically, as part of installing:

```json
{ "scripts": { "postinstall": "node postinstall.js" } }
```

That script is ordinary code on your machine. It can spawn processes, read
`.env` or `~/.ssh`, make outbound requests, and rewrite `.github/workflows`.
None of that appeared in the prompt you approved. And it can arrive through a
dependency of a dependency, where nothing at the top level looks unusual.

So the approval answers _"may I run this command?"_ — when the question that
matters is **"what will the third-party code triggered by this command actually
do?"**

## What it does

Six unremarkable events from an install, captured in the sandbox:

```
process_start   npm install unknown-analytics-helper@1.4.2   pid 5
process_start   node postinstall.js                          pid 7  ← parent 5
file_read       /app/.env                                    pid 7
network_out     …traceback-sim-collector.modal.run           pid 7
file_write      /app/deploy.yml                              pid 7
git_modify      .github/workflows/deploy.yml                 pid 7
```

Each line is true. None of them, alone, says what happened. Traceback returns a
decision — this is verbatim output, only line-wrapped:

```
## Verdict

BLOCK — high risk. A synthetic credential was read and observed leaving the sandbox.

Why:
- [FACT] Synthetic credential was transmitted externally — The canary value
  TRACEBACK_CANARY_a91f4c27, seeded into the credential file before the install
  ran, was observed in the payload node postinstall.js (pid 7) sent to
  …traceback-sim-collector.modal.run. Transmission is directly observed here,
  not inferred from timing.
- [FACT] Deployment or build configuration modified by a lifecycle script —
  Modified /app/deploy.yml, .github/workflows/deploy.yml.

Confirmed:
- The seeded canary value appeared in the payload sent to an external host.
- Build/deploy files written: /app/deploy.yml, .github/workflows/deploy.yml.

Not confirmed:
- Whether those changes were committed, pushed, or executed by a later deployment.
```

Underneath sits the full timeline: **7 FACTs, 3 CORRELATIONs, 2 INFERENCEs**,
each citing the evidence beneath it, every inference carrying a note describing
what would settle it.

## The idea: rank claims by how much they assert

One label per level of certainty, so a reader never has to guess how much the
system is claiming.

| Label           | Means                                                   |
| --------------- | ------------------------------------------------------- |
| **FACT**        | Directly observed in telemetry.                         |
| **CORRELATION** | Observations linked by time, process tree, or user.     |
| **INFERENCE**   | A hypothesis about intent. Requires human confirmation. |

Then the escalation that makes it more than labelling. Normally _"was the secret
actually sent?"_ is unanswerable from timing alone, so exfiltration stays an
INFERENCE. But the sandbox seeds a **canary** — a recognisable synthetic token —
into the credential file before the install runs. If that exact token appears in
what leaves the container, transmission is _observed_:

```
INFERENCE  Possible credential exfiltration (medium)   ← without the canary
FACT       Synthetic credential was transmitted off-host (high)   ← with it
```

And when the FACT appears, **the system withdraws the inference** rather than
leaving a guess sitting next to the proof.

## Why this isn't "AI that summarises logs"

Five properties, each enforced in code rather than requested in a prompt:

**1 · Evidence outranks assertion.**
An INFERENCE cannot exist unless a CORRELATION supports it, and a CORRELATION
cannot exist without FACTs beneath it. Remove the evidence and the conclusion
disappears with it. That is a structural rule, and it has a test.

**2 · The model cannot invent events.**
The language model never sees raw telemetry. It receives findings already derived
by deterministic rules and may only reference them by id. Every id it returns is
checked against the set it was given; anything else is discarded before a single
row is written. It arranges the story — it cannot add to it.

**3 · The verdict is rule-based, not model-generated.**
A developer deciding whether to let third-party code run on their machine should
be able to read the rule that produced the answer, and get the same answer twice.
The model writes prose; it does not decide.

**4 · The machine never confirms its own hypothesis.**
Every INFERENCE ships unconfirmed with a note describing what would settle it.
Only a human click marks it confirmed.

**5 · It says what it could not establish.**
Every verdict carries a "Not confirmed" list — **including ALLOW**, which states
that only the behaviour exercised during this run was observed. A gate that hides
its uncertainty is more dangerous than one that has none.

## How this differs from what already exists

**vs. an agent permission prompt.** The prompt asks _"should this command run?"_
Traceback asks _"what does the third-party code triggered by that command do?"_
It protects against the indirect execution, not the command.

**vs. a static package scanner.** Static analysis reads the source: `fs.readFile`,
`fetch`, `eval`, obfuscation. But code can be obfuscated, can behave differently
by environment, can fetch a second-stage payload, and can hide the behaviour in a
dependency. Traceback observes what the package _did_ when it ran. The two signals
combine well; this is the dynamic half.

## How you'd actually use it

The obvious question — _do I install something? is it a CLI? does my agent call
it?_ Three delivery paths, tagged honestly:

### ✅ Built today — the inspection engine, behind an HTTP API

The sandbox, the correlation pipeline, the canary, and the verdict all work.
That's the hard part, and it's done. Anything can drive it:

```bash
curl -X POST localhost:8787/api/simulate            # detonate, collect telemetry
curl -X POST localhost:8787/api/investigate/:id     # correlate → verdict
# → {"verdict":"block","risk":"high","finding_counts":{"FACT":7,...}}
```

The engine is **package-agnostic** — the pipeline consumes normalised events, so
pointing it at a different package is an input change, not a rewrite. The demo
uses a controlled malicious package so the behaviour is reproducible on stage.

### ⏳ Next — a wrapper you type instead of `npm install`

```bash
npx traceback install analytics-helper
```

Downloads with `--ignore-scripts` so nothing executes locally, reads the
lifecycle scripts out of `package.json`, detonates them in the sandbox, and only
lets them run on your machine if the verdict allows it.

**Not built.** The sandbox half exists; the local interception doesn't.

### ⏳ Next — an MCP server your agent consults

```
agent → inspect_package("analytics-helper") → allow / review / block
```

Cursor or Claude Code asks Traceback _before_ proposing the install, so the gate
sits **inside** the agent loop rather than beside it. This is the shape that
matches the problem best — the agent is the thing installing packages, so it
should be the thing asking.

**Not built.** It's an adapter over the API above, not new analysis.

### So what runs right now?

A local web app plus an API. You click **Run simulation**, a real Modal sandbox
executes a real install hook, and you get a real verdict in about ten seconds.
What's missing is the plumbing that puts that gate in front of _your_ everyday
`npm install` — which is integration work, not research.

## What's real, and what's simulated

Worth being precise about, since "AI security demo" invites suspicion:

| Component                       | Status                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The attack                      | **Simulated** in a disposable Modal sandbox, using a synthetic canary. No real credential or system is touched.       |
| The telemetry                   | **Real** — actual processes, real parent/child pids, real file I/O, a real outbound request, timestamped when it ran. |
| The correlation                 | **Real**, deterministic, unit-tested including negative cases.                                                        |
| The canary proof                | **Real** — a collector we control confirms what it received, so the proof does not rest on a third party.             |
| The verdict                     | **Real**, rule-based and reproducible.                                                                                |
| The timeline prose              | **Written by an LLM**, constrained as above. Falls back to a rule engine with no API key.                             |
| Syscall capture                 | **Not built.** Telemetry is self-reported by the simulation, not captured from the kernel.                            |
| `--ignore-scripts` interception | **Not built.** The sandbox path is real; local interception is the next step.                                         |
| Authentication                  | **Not built.** Suitable for local evaluation, not deployment.                                                         |

## Where it's weak

Stated plainly, because a security tool that hides its limits has missed its own
point:

- **Transmission is proven only via a canary the sandbox controls.** Against a
  package that encrypts or encodes what it sends, the canary would not appear and
  exfiltration would fall back to an INFERENCE — the system under-claims rather
  than over-claims, which is the correct direction to fail.
- **Telemetry is self-reported by the simulation**, not captured from the kernel.
  `strace` syscall capture (`openat` / `read` / `connect`) is the next step and
  would make the evidence independent of the script's own account of itself.
- **MITRE ATT&CK mappings are approximate** — orientation for a reader, not
  suitable for formal reporting.
- **Correlation windows are tuned to this scenario** (2s exfiltration, 30s
  persistence). Real telemetry needs per-environment calibration.
- **One host, one session.** No cross-host or cross-session correlation.

## Try it

```bash
bun install
cp .env.example .env     # add your Supabase URL + secret key
bun run dev:all          # API on :8787, UI on :5173
```

Open **<http://localhost:5173/traceback>**, then:

1. **Run simulation** — shows the raw events, uninterpreted. The "before" state,
   on purpose.
2. **Build timeline** — the verdict, the supply-chain indicators, and the same
   events as a timeline. Expand a phase to see its findings and their evidence.
3. **Confirm** an inference. That click is the human step the design exists to
   protect.

Only Supabase is required. Without Modal it uses a local telemetry fixture;
without an OpenAI key a rule engine builds the timeline. Both fallbacks are
labelled in the interface — a fallback run is never presented as the real thing.

Full walkthrough and troubleshooting: **[docs/traceback/SETUP.md](docs/traceback/SETUP.md)**

## How it works

```
sandbox ──► raw events ──► evidence ──► findings ──► verdict
            (stored,       (plain       (FACT /      (rules)
             immutable)     facts)     CORRELATION /
                                        INFERENCE)      └──► timeline + report
                                                              (LLM, constrained)
```

Each stage may only cite the one before it. Raw events are never mutated —
re-running the analysis replaces the interpretation, never the ground truth.

The correlation stage is pure functions over plain data, so its rules are tested
directly: window boundaries, process-tree ancestry, the canary escalation, the
threshold that stops it firing on ordinary installs, and the invariant that an
inference never appears without a correlation beneath it.

```bash
bun run verify    # lint + typecheck + format + 48 tests + build
```

Architecture and safety model: **[docs/traceback/README.md](docs/traceback/README.md)**
Status and roadmap: **[docs/todo.md](docs/todo.md)**

## What's next

- **`npm install --ignore-scripts` interception** — detect lifecycle scripts from
  `package.json` and inspect them before anything executes locally.
- **`strace` syscall capture** so evidence comes from the kernel rather than from
  the script being observed.
- Authentication on `/api/*`, required before any deployment.
- Ingestion adapters for real EDR and SIEM sources — the pipeline consumes
  normalised events, so this is an adapter, not a rewrite.
- Persist analyst decisions as signal: which inferences were confirmed, which
  rejected, and why.

## Safety

All suspicious behaviour is simulated inside an isolated sandbox using synthetic
secrets. No real credentials or external systems are accessed. The "secret" is a
canary token with no power anywhere; the exfiltration destination is a collector
we operate; the generated workflow targets `exfil.invalid`, a reserved TLD that
cannot resolve.

Secrets stay server-side: the browser holds no keys and talks only to `/api/*`.
Row Level Security is enabled on every table with no permissive policies.

## Built with

React 19 · TypeScript · Vite · TanStack Router · TailwindCSS · Hono on Bun ·
Supabase · Modal · OpenAI

## License

MIT.
