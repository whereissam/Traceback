# Traceback — demo guide

Everything needed to run the demo, plus what to say and what to do when
something misbehaves.

---

## Before you start

```bash
bun run dev:all        # API :8787 + UI :5173
```

Confirm both integrations are live — this is the one command worth running
before you present:

```bash
curl -s localhost:8787/api/health
# {"ok":true,"llm":"gpt-5.6-luna","modal":true}
```

- `"modal":true` → telemetry comes from a real sandbox. If `false`, you'll get
  the local fixture and an amber banner saying so.
- `"llm":"gpt-5.6-luna"` → the timeline is model-authored. If `null`, the rule
  engine writes it and the demo still works.

Open **<http://localhost:5173/traceback>** and leave it on the empty state.

**Timing:** "Run simulation" is ~2s. "Build timeline" is **~9s** — the model is
writing the timeline. Plan a sentence to say over it (see below).

---

## The 90-second script

### 0:00–0:15 — the problem

> Your AI coding agent asks permission before running `npm install`. But that
> permission only covers the command. npm then runs code the _package author_
> wrote — a postinstall hook — and that code can read your `.env`, call out to
> the network, and rewrite your deploy workflow. None of that was in the prompt
> you approved.

### 0:15–0:30 — show the raw state

Click **Run simulation**.

> That just executed a suspicious package's install hook inside an isolated
> sandbox. Here's the telemetry — six events. Real processes, real parent-child
> pids, real timestamps.

Point at the table.

> Every line is true. None of them tells you what happened. This is what an
> investigator actually starts with.

### 0:30–0:45 — run the analysis

Click **Build timeline**. Talk over the ~9 seconds:

> It's correlating those events now, and the model is writing the timeline —
> but the model never sees the raw telemetry. It only arranges findings the
> rules already derived.

### 0:45–1:05 — the verdict

The BLOCKED card appears.

> BLOCK, high risk. And notice the two reasons are both labelled **FACT** —
> not guesses.
>
> The first one matters most: we seeded a canary into the credential file
> before the install ran. That exact token showed up in what left the container.
> So transmission isn't inferred from timing — it was **observed**.

Point at the two columns.

> And it tells you what it _couldn't_ establish: whether those workflow changes
> were ever committed or executed. It doesn't round that up.

### 1:05–1:20 — the evidence chain

Scroll to the timeline, expand **Exfiltration**.

> Every claim is FACT, CORRELATION, or INFERENCE, and each one lists the
> evidence underneath it. This correlation says the outbound request came 320ms
> after the `.env` read from the same process tree — and that 320ms is measured
> from two real timestamps, not written by a model.

### 1:20–1:30 — the human step

Scroll to a **Confirm finding** button on an INFERENCE.

> Inferences ship unconfirmed. The machine never marks its own hypothesis as
> confirmed — a human does. And when the canary _proved_ transmission, the
> system withdrew its weaker guess instead of leaving it next to the proof.
>
> Telemetry proves. Rules correlate. AI explains. The developer decides.

---

## Three questions you will get

**"How is this different from the agent's own permission prompt?"**

> That prompt asks "should this command run?". We ask "what does the third-party
> code triggered by that command actually do?" It's the indirect execution that
> isn't covered — and it can arrive through a dependency of a dependency.

**"Isn't this just a static scanner?"**

> Static analysis reads the source. Source can be obfuscated, can behave
> differently by environment, or can fetch a second-stage payload at runtime.
> We observe what it did when it ran. The two combine well — this is the
> dynamic half.

**"How do you know the AI isn't making it up?"**

> It structurally can't. It never receives raw telemetry — only findings the
> rules derived — and it references them by id. Every id it returns is checked
> against the set we gave it; anything else is discarded before a row is
> written. The verdict isn't model-generated at all; it's a rule you can read.

---

## If something goes wrong

| Symptom                                                | What to say / do                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amber banner: "telemetry came from the local fallback" | Say it out loud — _"Modal's unreachable, so it fell back to a local fixture and labelled it. A fallback is never presented as a real run."_ That honesty **is** the product. Continue as normal. |
| Timeline says "generated by rule-engine"               | The LLM was unavailable. _"No API key, so the deterministic engine wrote it — the system doesn't depend on the model for correctness."_                                                          |
| "Build timeline" takes >20s                            | The model is slow. Keep talking, or drop `OPENAI_EFFORT=low` (already the default).                                                                                                              |
| Any red error banner                                   | Re-click **Run simulation** — analysis is idempotent and re-running replaces the previous result.                                                                                                |
| Total failure                                          | Have a prior investigation open in a second tab. Any completed run stays in Supabase and re-renders from `GET /api/investigation/:id`.                                                           |

**Safety net worth setting up:** before presenting, run the flow once, keep that
browser tab open in the background, and record a 30-second screen capture of a
successful run.

---

## Deeper cuts, if you get more time

- **Show the report.** Expand _Investigation report_ — the markdown includes a
  Supply-chain indicators block naming the package, install hook, secrets
  touched, and containment steps.
- **Show the API.** `curl -s -X POST localhost:8787/api/simulate` then
  `/api/investigate/:id` returns the verdict as JSON — makes the point that the
  UI is a client, not the product.
- **Show the tests.** `bun run verify` — 48 tests, including the negative cases:
  that an inference disappears when its correlation does, and that the
  supply-chain detector does _not_ fire on an ordinary `npm install`.

---

## What to admit before you're asked

Volunteering these reads as rigour, not weakness — and every one is already in
the README:

- Telemetry is **self-reported by the simulation**, not captured from the
  kernel. `strace` syscall capture is next and would make the evidence
  independent of the script's own account of itself.
- The canary proves transmission **only because we control it**. A package that
  encrypts its payload would defeat it — and exfiltration would correctly fall
  back to an INFERENCE. It under-claims rather than over-claims.
- Local `--ignore-scripts` interception isn't built. The sandbox path is real;
  intercepting the agent's install on the developer's machine is the next step.
- No auth on `/api/*`. Local evaluation only.
