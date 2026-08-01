# Traceback — hands-on guide

Every command is copy-pasteable and every output below came from a real run.

---

## What it does, and what it doesn't

|                |                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Detects** | Give it an npm package name. It runs that package's install hooks in a sandbox, watches what they actually do, and returns a verdict with evidence. |
| ❌ **Blocks**  | **Not built.** It returns the string `"verdict": "block"` — nothing intercepts your `npm install`.                                                  |

Today it is **a detector that gives you an answer**, not **a gate that stops
anything**. Making it a real gate needs the CLI or MCP interception layer, which
is on the roadmap and labelled as not built.

---

## 0 · Start it

```bash
bun run dev:all
```

That starts two processes: the API server on `:8787` and the web UI on `:5173`.

Check both integrations are live:

```bash
curl -s localhost:8787/api/health
# {"ok":true,"llm":"gpt-5.6-luna","modal":true}
```

| Field                   | Meaning                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `"modal": true`         | The sandbox is real. If `false`, a local fixture is used and the UI says so.           |
| `"llm": "gpt-5.6-luna"` | The model writes the timeline prose. If `null`, a rule engine does — **same verdict**. |

---

## 1 · Inspect a real package

### The command

```bash
curl -s -X POST localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"package":"esbuild"}'
```

**What this actually does**, server-side, before it replies:

1. Starts a fresh container on Modal
2. Runs `npm install esbuild --ignore-scripts` — downloads the files, **executes nothing**
3. Opens `node_modules/esbuild/package.json` and reads its `scripts` field
4. Writes fake credentials into the container (`.env`, `.aws/credentials`, `.ssh/id_rsa`)
5. Runs esbuild's install hook under `strace`, recording every syscall
6. Turns those syscalls into normalised events and stores them

It replies with the full record it just created — note the
`investigation.id`, you need it for the next step:

```json
{
  "investigation": {
    "id": "d5eed23d-d8fa-40eb-8c71-a0599498e0af",
    "title": "esbuild@0.28.1 — install-hook inspection",
    "status": "open",
    "created_at": "2026-08-01T15:41:05.802534+00:00"
  },
  "package": "esbuild",
  "version": "0.28.1",
  "lifecycle_scripts": { "postinstall": "node install.js" },
  "has_lifecycle_scripts": true,
  "event_count": 3,
  "telemetry_source": "modal",
  "note": null
}
```

Reading that back: esbuild **does** declare an install hook
(`postinstall: node install.js`), running it produced **3 observable events**,
and the telemetry came from a real Modal sandbox rather than the local fallback.
Nothing has been judged yet.

### Then analyse it

Take the `id` from above and pass it to the analysis endpoint:

```bash
curl -s -X POST localhost:8787/api/investigate/d5eed23d-d8fa-40eb-8c71-a0599498e0af
```

**What this does**: reads those stored events, derives evidence, applies the
correlation rules, computes a verdict, and asks the model to write the prose.

```json
{
  "finding_counts": { "FACT": 3, "CORRELATION": 1, "INFERENCE": 0 },
  "verdict": "allow",
  "risk": "low"
}
```

### Both steps in one go

If you would rather not copy the id by hand:

```bash
ID=$(curl -s -X POST localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"package":"esbuild"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["investigation"]["id"])')

curl -s -X POST "localhost:8787/api/investigate/$ID" | python3 -m json.tool
```

---

## 1.5 · Where those numbers actually come from

This is the part worth understanding. Here is the **complete chain** for that
esbuild run — nothing omitted.

### The 3 raw events `strace` captured

```
process_start   pid 32   sh -c node install.js
process_start   pid 33   node install.js
process_start   pid 41   esbuild --version     ← spawned by pid 33
```

That is genuinely all esbuild's install hook did: start a shell, start node,
and run its own binary once to check the version.

### → 3 FACTs

One per observed process start. A FACT is a direct restatement of something in
the telemetry — no interpretation:

```
[FACT] Process started: sh -c node install.js
       sh -c node install.js (pid 32) started.

[FACT] Process started: node install.js
       node install.js (pid 33) started.

[FACT] Process started: esbuild --version
       esbuild --version (pid 41) started, spawned by pid 33.
```

### → 1 CORRELATION

A CORRELATION links two or more facts. Here, the parent/child relationship:

```
[CORRELATION] Payload executed as a child of the package install
              esbuild --version (pid 41) was spawned by node install.js
              (pid 33), placing it inside the dependency-installation
              process tree.
```

The rule that produced it (`server/pipeline.ts`): a `process_start` whose
`parent_process_id` matches another observed process.

### → 0 INFERENCE

An INFERENCE is a hypothesis about **intent**, and the rules only produce one
when there is something to explain. The candidate inferences are:

| Inference                        | Requires                                                            | Fired?                                                      |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Possible credential exfiltration | a credential read **and** an outbound connection, same process tree | No — esbuild read no credential file and made no connection |
| Possible persistence             | a write to `.github/workflows` / `Dockerfile` / `package.json`      | No — esbuild wrote nothing outside its own directory        |
| Possible supply-chain compromise | at least two risk behaviours                                        | No — zero risk behaviours                                   |

No correlation supports any of them, so none exists. **That is the structural
rule: an inference cannot exist without a correlation beneath it.**

### → verdict `allow`, 0 reasons

`server/verdict.ts` walks its rule list. Nothing matches, so:

```
ALLOW · low — No risky behaviour observed during sandboxed installation.
reasons: 0
```

**Note what this is not.** The verdict is not "the AI thought it looked fine".
It is "no rule fired". You can read the rules, and you get the same answer twice.

### Why this matters

esbuild has a **genuine `postinstall` hook** that spawns processes — exactly the
shape a naive detector would flag. It passes because it touched no credential,
made no outbound connection, and modified nothing outside its own directory.

A detector that flags every package with a `postinstall` hook is useless, because
a large part of the npm ecosystem uses them legitimately.

### Other packages, verified

| Package   | Version | Install hook                   | Events | F / C / I | Verdict         |
| --------- | ------- | ------------------------------ | ------ | --------- | --------------- |
| `esbuild` | 0.28.1  | `postinstall: node install.js` | 3      | 3 / 1 / 0 | **ALLOW** · low |
| `core-js` | 3.49.0  | `postinstall`                  | 3      | 2 / 0 / 0 | **ALLOW** · low |
| `bcrypt`  | 6.0.0   | `install`                      | 1      | 1 / 0 / 0 | **ALLOW** · low |
| `lodash`  | 4.18.1  | none                           | 0      | —         | nothing to run  |
| `sharp`   | 0.35.3  | none                           | 0      | —         | nothing to run  |

Any package on npm works. A cold run takes 40–90 seconds (download plus
container start).

---

## 2 · What a malicious package looks like

### Why a fixture, and what that means

A **fixture** here means: a package we wrote ourselves, whose malicious behaviour
we control and can re-run identically. We use one because genuinely malicious
packages are removed from npm within hours of discovery, so there is nothing
stable to point a demo at — and publishing a real one would be irresponsible.

The fixture's `postinstall` deliberately does four things:

1. reads the seeded credential file
2. sends its contents to a collector we operate
3. writes `deploy.yml`
4. modifies `.github/workflows/deploy.yml`

Everything it touches is synthetic. The "secret" is a canary string with no
power anywhere, and the exfil host in the generated workflow is `exfil.invalid`
— a reserved TLD that cannot resolve.

**The point of the comparison**: the _engine_ is unchanged. Only the observed
behaviour differs.

### Running it

```bash
curl -s -X POST localhost:8787/api/simulate -d '{}' -H 'content-type: application/json'
```

**What this does**: runs the fixture in the same Modal sandbox and stores its
telemetry as a new investigation. (This is the one path with a local fallback —
if Modal is unreachable it uses a local event fixture and labels it in the UI.)

```bash
curl -s -X POST localhost:8787/api/investigate/<id>
```

**What this does**: identical to §1 — same pipeline, same rules, same verdict
engine. Nothing is special-cased for the fixture.

```json
{
  "finding_counts": { "FACT": 7, "CORRELATION": 3, "INFERENCE": 2 },
  "verdict": "block",
  "risk": "high",
  "supply_chain_detected": true
}
```

### Where those numbers come from

| Count             | Made of                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **7 FACT**        | 2 process starts, 1 credential read, 1 outbound request, 1 file write, 1 workflow modification, **+1 canary fact** |
| **3 CORRELATION** | install→child process · credential read→outbound (same tree) · install process→workflow write                      |
| **2 INFERENCE**   | possible persistence via CI modification · possible supply-chain compromise                                        |

The **canary fact** is the interesting one:

```
[FACT] Synthetic credential was transmitted off-host
       The canary value TRACEBACK_CANARY_a91f4c27, seeded into the credential
       file before the install ran, was observed in the payload sent to the
       collector. Transmission is directly observed here, not inferred from timing.
```

Because transmission is now **proven**, the weaker "possible credential
exfiltration" inference is **withdrawn** — which is why there are 2 inferences
here and not 3.

---

## 3 · How it decides something is malicious

### First: the primary evidence is behaviour, not source

The verdict is driven by what the install hook **did**, not by what its code
looks like. Traceback runs the hook and records what the **operating system
kernel** observed.

|                  | Reading the source                                                                  | Watching it run (primary)                                  |
| ---------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Answers          | "what _could_ it do?"                                                               | "what _did_ it do?"                                        |
| Input            | Source code, file list                                                              | Syscalls the process actually made                         |
| Can be fooled by | Obfuscation, runtime string assembly, second-stage payloads fetched at install time | Sandbox-aware malware that stays dormant                   |
| Produces         | "there is an `fs.readFileSync` call here"                                           | "pid 33 opened `/work/.env` and read 31 bytes at 14:23:01" |

Seeing `fs.readFileSync` in source tells you nothing about whether it runs, or
which file it opens. So behaviour wins every time the two disagree, and no
verdict is ever escalated on source alone.

### But source is read too — for the one thing behaviour can't cover

Dynamic analysis has a structural blind spot: **a package that detects the
sandbox and does nothing produces nothing to observe.** It scores identically
to a harmless package.

So `server/static-analysis.ts` also scans each lifecycle script's source for
capabilities — credential access, network, process spawning, runtime code
construction, packing — citing the literal fragment that matched. The
interesting question is the cross-check:

|                              | ran it | didn't run it                      |
| ---------------------------- | ------ | ---------------------------------- |
| capability, source readable  | BLOCK  | ALLOW — reported, not escalated    |
| capability, source concealed | BLOCK  | **REVIEW** — dormant payload shape |

**The bottom-right cell is the point.** Code that can read credentials and
phone home, did neither while watched, and is written so you cannot tell why.

The top-right cell deliberately does _not_ escalate, and that was measured
rather than assumed. The first version of this rule escalated on any unused
capability — and it flagged esbuild, whose install hook legitimately carries
`process.env`, `require("https")` and `execSync` in order to fetch and run a
platform binary. Nearly every install hook that downloads something looks like
that. A rule that flags them all is the same cry-wolf failure this whole system
exists to avoid, so unused capability is reported and left at that. Escalation
requires it to coincide with concealment.

Static findings are recorded as **capabilities of the artefact, never as
behaviour** — a regex cannot know whether a code path is reachable.

### The bait: we plant the credentials ourselves

There is no real `.env` in the sandbox. **We create a fake one before the hook
runs**, along with fake AWS and SSH credentials:

```
/work/.env               API_KEY=TRACEBACK_CANARY_a91f4c27
/work/.aws/credentials   aws_secret_access_key = TRACEBACK_CANARY_a91f4c27
/work/.ssh/id_rsa        -----BEGIN OPENSSH PRIVATE KEY-----
                         TRACEBACK_CANARY_a91f4c27
```

Every value is the same synthetic canary string. It grants access to nothing,
anywhere. Its only two jobs are:

1. **Be somewhere a credential-stealing hook would look.** A package with no
   business reading `.env` has no reason to open it. If it does, that is a
   signal — and it's a signal we obtained without the package knowing it was
   being watched.
2. **Be recognisable if it leaves.** If the string `TRACEBACK_CANARY_a91f4c27`
   turns up in an outbound payload, we are not guessing that a secret was
   exfiltrated. We are reading it in the transmitted bytes.

This is baiting, not auditing. We are not checking whether your `.env` is
protected — we are putting a marked bill in the till and watching who takes it.

### What that looks like in practice

Same sandbox, same seeded files, two different packages:

```
esbuild                                    the malicious fixture
─────────────────────────────────          ─────────────────────────────────
execve("node", ["install.js"])             execve("node", ["postinstall.js"])
execve("esbuild", ["--version"])           openat("/work/.env", O_RDONLY) = 17
                                           read(17, "API_KEY=TRACEBACK_…")
(never opens /work/.env)                   connect(18, {AF_INET, …})
                                           openat("/work/deploy.yml", O_WRONLY)

→ ALLOW · low                              → BLOCK · high
```

esbuild had exactly the same bait available to it. It didn't take it.

### Step 1 — download without executing

```bash
npm install <pkg> --ignore-scripts
```

Fetches the files, runs no `preinstall` / `install` / `postinstall`.

### Step 2 — read the hooks the package declares

From `node_modules/<pkg>/package.json`:

```json
{ "scripts": { "postinstall": "node install.js" } }
```

No hooks → nothing executes at install time. That is a real answer, and it is
where `lodash` stops.

### Step 3 — seed canaries, then detonate

Fake credentials go into the container first:

```
/work/.env               API_KEY=TRACEBACK_CANARY_a91f4c27
/work/.aws/credentials   aws_secret_access_key = TRACEBACK_CANARY_…
/work/.ssh/id_rsa        -----BEGIN OPENSSH PRIVATE KEY-----
```

None grant access to anything. Their only job: be **recognisable if read**, and
**traceable if their contents leave the container**.

Then the hook runs under `strace`:

```bash
strace -f -tt -e trace=execve,openat,read,connect,clone -o trace.log \
  sh -c "node install.js"
```

### Step 4 — reconstruct behaviour from syscalls

`strace` records what the **kernel** saw, not what the package claims:

```
execve("/usr/bin/node", ["node", "install.js"])     → started a process
openat(AT_FDCWD, "/work/.env", O_RDONLY) = 17       → opened .env
read(17, …)                                          → actually read it
connect(18, {AF_INET, "104.21.x.x"})                 → called out
```

A package can lie in its source. It cannot lie to `openat`.

Parsing is deliberately conservative:

- a failed `openat` proves nothing and is ignored
- a `read` is only attributed to a path when that file descriptor was seen being opened
- loopback connections are not counted as egress

### Step 5 — rules produce the verdict

| Observed                                                               | Verdict                            |
| ---------------------------------------------------------------------- | ---------------------------------- |
| Reads `.env` / `.ssh` / `.aws` **and** connects out, same process tree | **BLOCK**                          |
| Modifies `.github/workflows` / `Dockerfile` / `package.json`           | **BLOCK**                          |
| The canary appears in what was transmitted                             | **BLOCK** — as a FACT, not a guess |
| Connects out but touches nothing sensitive                             | **REVIEW**                         |
| Writes only inside its own directory, no egress                        | **ALLOW**                          |

Rules live in `server/verdict.ts`. Deterministic — not model output.

### Why two signals are required

`npm install` triggering a `postinstall` hook is completely normal. So:

- install + lifecycle hook alone → **never** raises anything
- there must also be **risk behaviour**: credential access, egress, or a change
  to build/deploy configuration

That is exactly why esbuild passes.

---

## 4 · The canary: turning a guess into an observation

Normally "was the secret actually sent?" cannot be answered from timing. You see
a file read, then an outbound connection 320ms later — but never the payload. So
the honest statement is:

```
INFERENCE   Possible credential exfiltration   (medium)
```

If the canary string appears in **what left the container**, transmission is
observed:

```
FACT        Synthetic credential was transmitted off-host   (high)
```

And the system then **withdraws** the weaker inference rather than leaving a
guess beside the proof.

---

## 5 · Proof the AI isn't deciding anything

Same telemetry, analysed twice:

```bash
OPENAI_API_KEY= bun server/index.ts     # → {"llm":null}
```

|                        | Verdict        | FACT / CORR / INF | Timeline prose                                             |
| ---------------------- | -------------- | ----------------- | ---------------------------------------------------------- |
| `OPENAI_API_KEY` set   | `block` · high | 7 / 4 / 2         | full narrative                                             |
| `OPENAI_API_KEY` empty | `block` · high | **7 / 4 / 2**     | `3 findings in this phase (FACT, CORRELATION, INFERENCE).` |

Every number that matters is unchanged; only readability degrades. The model is
a writer — not a witness, and not a judge. See
[`docs/architecture.md`](../architecture.md).

---

## 6 · Demo sequence (UI)

Open <http://localhost:5173/traceback>

1. Type `esbuild` in the inspect box → **Inspect**
   → "A real package with a genuine postinstall hook. It passes."
2. **Run simulation** → point at the raw event table
   → "Six events, every line true, not one of them explains anything."
3. **Build timeline** (~9s)
   → "It's correlating now, and the model is writing the timeline — but the
   model never sees raw telemetry."
4. **BLOCKED card** → point at the **Not confirmed** column
   → "It states what it could not establish."
5. Scroll to an INFERENCE → point at **Confirm finding**
   → "The machine never clicks this."

---

## 7 · What it will not catch

| Situation                                               | Outcome                                                                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload is **encrypted** before being sent              | The canary never appears → falls back to **INFERENCE**, verdict becomes `review`. It under-claims rather than over-claims.                                                 |
| Package detects the sandbox and behaves                 | **Partly covered.** Nothing is observed, but if the source is concealed _and_ carries unused capability it becomes `review`. Cleanly-written dormant malware still passes. |
| Malicious behaviour happens at `require()`, not install | **Missed.** Only install-time behaviour is observed.                                                                                                                       |
| Malicious code is in a transitive dependency            | Only the named package's own hooks are detonated today.                                                                                                                    |

Only the first is inherent. The second is narrowed by static analysis but not
closed: a dormant payload written in plain, readable JavaScript is still
indistinguishable from a package that simply had nothing to do.

**And none of this blocks anything by itself.** Traceback is a gate you have to
put in front of the install, not a runtime shield. It detonates the hook in a
disposable sandbox so the verdict arrives _before_ the package touches your
machine — but if you run `npm install` directly, the hook has already run and
the answer comes too late. That is a deployment property, not a detection one.

---

## 8 · When things go wrong

| Symptom                          | What to do                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Amber banner: "local fallback"   | Say it out loud — Modal is unreachable, so it fell back and **labelled it**. A fallback is never presented as a real sandbox run. |
| `generated by rule-engine`       | No API key. The deterministic engine wrote it; correctness never depended on the model.                                           |
| Inspection takes over 90 seconds | Cold start: download plus container boot. The second run is faster.                                                               |
| `502` or a sandbox error         | Modal is down. Use **Run simulation** — that path has a local fallback.                                                           |
| Everything fails                 | Open a previous investigation; completed runs persist and re-render from `GET /api/investigation/:id`.                            |

Before presenting: run the flow once and leave that tab open as a safety net.

---

## 9 · In one sentence

> It doesn't read what the code says it will do. It runs the install hook in a
> sandbox, records what the kernel actually saw, and applies readable rules to
> produce a verdict — with every claim marked as observed fact or as inference.
>
> Today it **tells you**. It does not yet stop you.
