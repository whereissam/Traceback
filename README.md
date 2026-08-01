<div align="center">

# Traceback

### AI-assisted digital forensics

**Security teams do not lack alerts. They lack a trustworthy explanation of what happened.**

An evidence-based security gate for npm packages installed by AI coding agents.
Traceback runs a package's install hook in an isolated sandbox, records what it
actually does, and returns **ALLOW / REVIEW / BLOCK** — where every claim is
labelled **FACT**, **CORRELATION**, or **INFERENCE** and links back to the raw
events it came from.

_Do not trust what the package says. Observe what it does._

[![CI](https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/actions/workflows/ci.yml/badge.svg)](https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

</div>

---

## The problem

When something breaks at 3am, an investigator is handed a pile of disconnected
records: a process started here, a file was read there, a request went out, a
config file changed. Each line is true. None of them say what happened.

Reconstructing the story is slow, manual, and the part that actually requires
judgement. So the obvious move is to point a language model at the logs — and
that fails, for a specific reason: **a summary cannot tell you how much of itself
to believe.** It states a guess and an observation in the same confident voice.
In forensics, that is worse than no answer, because a wrong conclusion sends the
response in the wrong direction.

Traceback's premise is that the useful unit of work is not a summary. It is a
**claim you can audit**.

## What it does

Feed it six unremarkable events from a developer machine:

```
process_start   npm install unknown-analytics-helper@1.4.2       pid 1001
process_start   node postinstall.js                              pid 1002 ← parent 1001
file_read       /app/.env                                        pid 1002
network_out     httpbin.org  POST                                pid 1002
file_write      /app/deploy.yml                                  pid 1002
git_modify      .github/workflows/deploy.yml                     pid 1002
```

It returns a timeline across five attack phases. Here is one phase, taken from
real output (line-wrapped to fit, otherwise unedited):

```
### exfiltration — Outbound request following credential access

3 findings in this phase (FACT, CORRELATION, INFERENCE).

- [FACT] Outbound request to httpbin.org  (confidence: high)
    node postinstall.js (pid 1002) made an outbound POST request to
    httpbin.org (completed).
    └ evidence 4a7f21c8

- [CORRELATION] Outbound request immediately followed a credential-file read
    (confidence: high)
    An outbound request to httpbin.org occurred 320ms after node postinstall.js
    (pid 1002) read /app/.env. Both events originate from the same process tree
    and the same user (dev-agent).
    └ evidence 9c1b04de · 4a7f21c8

- [INFERENCE] Possible credential exfiltration  (confidence: medium, T1041)
    A process read a credential file and then contacted an external host within
    the same second, from the same process tree. That sequence is consistent
    with the credential being transmitted off-host. The request body was not
    captured, so transmission of the secret is not directly observed.
    └ evidence 9c1b04de · 4a7f21c8
    ⚠ Requires human confirmation. Confirm by inspecting the outbound request
      body or egress proxy logs.
```

Read what those three labels are doing. The fact is what the machine saw. The
correlation is the link it drew, with the reasoning stated. The inference is a
hypothesis — and it says out loud what it could _not_ observe, then tells the
investigator exactly how to settle it.

**The 320ms is measured**, not written by a model. It falls out of comparing two
real timestamps.

And it ends with a decision a developer can act on:

```
BLOCK — high risk. A synthetic credential was read and observed leaving the sandbox.

  [FACT] Synthetic credential was transmitted externally
  [FACT] Deployment configuration modified by a lifecycle script

  Confirmed      The seeded canary appeared in the payload sent to an external host.
                 Build/deploy files written: .github/workflows/deploy.yml
  Not confirmed  Whether those changes were committed, pushed, or later executed.
```

The verdict is **rule-based, not model-generated** — a developer deciding whether
to let third-party code run on their machine should be able to read the rule that
produced the answer and get the same answer twice.

## Why this isn't "AI that summarises logs"

Four properties, each enforced in code rather than requested in a prompt:

**1 · Claims are ranked by how much they're asserting.**
An INFERENCE cannot exist unless a CORRELATION supports it, and a CORRELATION
cannot exist without the FACTs beneath it. Remove the evidence and the conclusion
disappears with it — that is a structural rule in the pipeline, and it has a test.

**2 · The model cannot invent events.**
The language model never sees raw telemetry. It receives findings that were
already derived by deterministic rules, and may only reference them by id. Every
id it returns is checked against the set it was given; anything else is discarded
before a single row is written. It arranges the story — it cannot add to it.

**3 · The machine never confirms its own hypothesis.**
Every INFERENCE ships unconfirmed, with a note describing the evidence that would
settle it. Only a human click marks it confirmed. The system is built to be
_checked_, not trusted.

**4 · Supply-chain patterns are named, not just described.**
When a dependency install is followed by credential access, an outbound request,
and a change to deployment config, the system says so explicitly — naming the
package, the install hook, the secret touched, and the file that would keep
executing after the package is removed. It deliberately does **not** fire on an
install plus a lifecycle hook alone: that is how half of npm works, and a
detector that cries wolf on it is useless.

**5 · It says when it doesn't know.**
Every report ends with open questions — the things the evidence does not answer.
The first one is usually that the request body was never captured, so
exfiltration remains inferred. A tool that hides its uncertainty is more
dangerous than one that has none.

## What's real, and what's simulated

Worth being precise about, since "AI security demo" invites suspicion:

| Component                | Status                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| The attack               | **Simulated**, in a disposable cloud sandbox. Synthetic secret, harmless endpoint, unresolvable exfil host. Nothing real is touched.  |
| The telemetry            | **Real.** Actual processes, file reads, and an outbound request — timestamped when they occurred, which is why the 320ms is measured. |
| The correlation pipeline | **Real**, deterministic, and unit-tested — including the negative cases.                                                              |
| The timeline text        | **Written by an LLM**, constrained as described above. Falls back to a rule engine with no API key.                                   |
| Multi-host correlation   | **Not built.** Single host only.                                                                                                      |
| Authentication           | **Not built.** Suitable for local evaluation, not deployment.                                                                         |

## Where it's weak

Stated plainly, because a forensics tool that hides its limits has missed its own
point:

- **Transmission is proven only via a canary the sandbox controls.** Against a
  package that encrypts or encodes what it sends, the canary would not appear
  and exfiltration would fall back to an INFERENCE — the system under-claims
  rather than over-claims, which is the correct direction to fail.
- **Telemetry is self-reported by the simulation**, not captured from the
  kernel. `strace` syscall capture is the next step and would make the evidence
  independent of the script's own account of itself.
- **MITRE ATT&CK mappings are approximate** — orientation for a reader, not
  suitable for formal reporting.
- **Correlation windows are tuned to this scenario** (2s exfiltration, 30s
  persistence). Real telemetry needs per-environment calibration.
- **The LLM only arranges findings.** It cannot promote an inference to a fact,
  but it also contributes no hypotheses of its own yet.
- **One host, one session.** No cross-host or cross-session correlation.

## Try it

```bash
bun install
cp .env.example .env     # add your Supabase URL + secret key
bun run dev:all          # API on :8787, UI on :5173
```

Open **<http://localhost:5173/traceback>**, then:

1. **Run simulation** — shows the six raw events, uninterpreted. This is the
   "before" state on purpose.
2. **Build timeline** — the same events, now a timeline. Expand a phase to see
   its findings and the evidence under each.
3. **Confirm** an inference. That click is the human step the whole design exists
   to protect.

Only Supabase is required. Without Modal it uses a local telemetry fixture;
without an OpenAI key a rule engine builds the timeline. Both fallbacks are
labelled in the interface — a fallback run is never presented as the real thing.

Full walkthrough, troubleshooting, and configuration:
**[docs/traceback/SETUP.md](docs/traceback/SETUP.md)**

## How it works

```
sandbox ──► raw events ──► evidence ──► findings ──► timeline ──► report
            (stored,       (plain       (FACT /       (LLM,        (markdown
             immutable)     facts)     CORRELATION /  constrained)  + JSON)
                                        INFERENCE)
```

Each stage may only cite the one before it. Raw events are never mutated —
re-running the analysis replaces the interpretation, never the ground truth.

The correlation stage is pure functions over plain data, so its rules are tested
directly: window boundaries, process-tree ancestry, and the invariant that an
inference never appears without a correlation beneath it.

```bash
bun run verify    # lint + typecheck + format + 27 tests + build
```

Architecture and safety model: **[docs/traceback/README.md](docs/traceback/README.md)**
Status and roadmap: **[docs/todo.md](docs/todo.md)**

## What's next

- Ingestion adapters for real EDR and SIEM sources. The pipeline consumes
  normalised events, so this is an adapter, not a rewrite.
- Capture request bodies at the egress boundary — turning the exfiltration
  inference into a fact.
- Multi-host and multi-session correlation.
- Persist analyst decisions as signal: which inferences were confirmed, which
  were rejected, and why.

## Built with

React 19 · TypeScript · Vite · TanStack Router · TailwindCSS · Hono on Bun ·
Supabase · Modal · OpenAI

## License

MIT.
