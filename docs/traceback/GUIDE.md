# Traceback — hands-on guide

Every command below is copy-pasteable, and every output is from a real run.

---

## What it does, and what it doesn't

|                |                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Detects** | Give it an npm package name. It runs that package's install hooks in a sandbox, watches what they actually do, and returns a verdict with evidence. |
| ❌ **Blocks**  | **Not built.** It returns the string `"verdict": "block"` — nothing intercepts your `npm install`.                                                  |

Today it is **a detector that gives you an answer**, not **a gate that stops
anything**. Turning it into a real gate needs the CLI or MCP interception layer,
which is on the roadmap and honestly labelled as such.

---

## 0 · Start it

```bash
bun run dev:all        # API :8787 + UI :5173
curl -s localhost:8787/api/health
```

Both integrations are live when you see:

```json
{ "ok": true, "llm": "gpt-5.6-luna", "modal": true }
```

- `"modal": true` — the sandbox is real. If `false`, a local fixture is used and
  the UI shows an amber banner saying so.
- `"llm": "gpt-5.6-luna"` — the model writes the timeline prose. If `null`, a
  rule engine writes it and **the verdict is identical** (see §5).

---

## 1 · Inspect a real package

```bash
curl -s -X POST localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"package":"esbuild"}' | python3 -m json.tool
```

Actual output:

```json
{
  "package": "esbuild",
  "version": "0.28.1",
  "lifecycle_scripts": { "postinstall": "node install.js" },
  "has_lifecycle_scripts": true,
  "event_count": 3,
  "telemetry_source": "modal"
}
```

Take the `investigation.id` and analyse it:

```bash
curl -s -X POST localhost:8787/api/investigate/<id> | python3 -m json.tool
```

```json
{
  "verdict": "allow",
  "risk": "low",
  "finding_counts": { "FACT": 3, "CORRELATION": 1, "INFERENCE": 0 },
  "supply_chain_detected": false
}
```

**This is the result that matters.** esbuild has a genuine `postinstall` hook,
and it **passes**. A detector that flags everything proves nothing.

### Verified against real packages

| Package   | Version | Install hook                   | Verdict         |
| --------- | ------- | ------------------------------ | --------------- |
| `esbuild` | 0.28.1  | `postinstall: node install.js` | **ALLOW** · low |
| `core-js` | 3.49.0  | `postinstall`                  | **ALLOW** · low |
| `bcrypt`  | 6.0.0   | `install`                      | **ALLOW** · low |
| `lodash`  | 4.18.1  | none                           | nothing to run  |
| `sharp`   | 0.35.3  | none                           | nothing to run  |

Any package on npm works. Expect 40–90 seconds on a cold run (download plus
container start); subsequent runs are faster.

---

## 2 · What a malicious package looks like

Genuinely malicious packages get pulled from npm quickly, so the comparison uses
a controlled fixture:

```bash
curl -s -X POST localhost:8787/api/simulate -d '{}' -H 'content-type: application/json'
curl -s -X POST localhost:8787/api/investigate/<id> | python3 -m json.tool
```

```json
{
  "verdict": "block",
  "risk": "high",
  "finding_counts": { "FACT": 7, "CORRELATION": 3, "INFERENCE": 2 },
  "supply_chain_detected": true
}
```

**Same engine, same rules.** Only the observed behaviour differs.

---

## 3 · How it decides something is malicious

The short answer: **it watches behaviour, it does not read code.**

### Step 1 — download without executing

```bash
npm install <pkg> --ignore-scripts
```

Fetches the files but runs no `preinstall` / `install` / `postinstall`.

### Step 2 — read the hooks the package declares

From `node_modules/<pkg>/package.json`:

```json
{ "scripts": { "postinstall": "node install.js" } }
```

No hooks means nothing executes at install time — that's a real answer, and it's
where `lodash` stops.

### Step 3 — seed canaries, then detonate in the sandbox

Synthetic credentials are placed in the workspace first:

```
/work/.env               API_KEY=TRACEBACK_CANARY_a91f4c27
/work/.aws/credentials   aws_secret_access_key = TRACEBACK_CANARY_...
/work/.ssh/id_rsa        -----BEGIN OPENSSH PRIVATE KEY-----
```

None of these grant access to anything. Their only job is to be **recognisable
if read**, and **traceable if their contents leave the container**.

Then the hook runs under `strace`:

```bash
strace -f -tt -e trace=execve,openat,read,connect,clone -o trace.log \
  sh -c "node install.js"
```

### Step 4 — reconstruct behaviour from syscalls

`strace` records what the **kernel** saw, not what the package claims:

```
execve("/usr/bin/node", ["node", "install.js"])     → it started a process
openat(AT_FDCWD, "/work/.env", O_RDONLY) = 17       → it opened .env
read(17, ...)                                        → it actually read it
connect(18, {AF_INET, "104.21.x.x"})                 → it called out
```

This is what "observe what it does" means in practice. A package can lie in its
source. It cannot lie to `openat`.

### Step 5 — rules produce the verdict

| Observed                                                               | Verdict                                |
| ---------------------------------------------------------------------- | -------------------------------------- |
| Reads `.env` / `.ssh` / `.aws` **and** connects out, same process tree | **BLOCK**                              |
| Modifies `.github/workflows` / `Dockerfile` / `package.json`           | **BLOCK**                              |
| The canary appears in what was transmitted                             | **BLOCK** — and as a FACT, not a guess |
| Connects out but touches nothing sensitive                             | **REVIEW**                             |
| Writes only inside its own directory, no egress                        | **ALLOW**                              |

The rules live in `server/verdict.ts` and are deterministic — not model output.
Run it twice, get the same answer.

### Why two signals are required

`npm install` triggering a `postinstall` hook is completely normal — a large part
of the ecosystem depends on it. So:

- install + lifecycle hook alone → **never** raises anything
- there must also be **risk behaviour**: credential access, egress, or a change
  to build/deploy configuration

That's exactly why esbuild passes. It has a hook and spawns a process, but it
touches nothing sensitive.

---

## 4 · The canary: turning a guess into an observation

Normally "was the secret actually sent?" cannot be answered from timing. You see
a file read, then an outbound connection 320ms later — but you never saw the
payload. So the honest statement is:

```
INFERENCE   Possible credential exfiltration   (medium)
```

But if the canary string `TRACEBACK_CANARY_a91f4c27` appears in **what left the
container**, transmission is observed:

```
FACT        Synthetic credential was transmitted off-host   (high)
```

And when that FACT appears, the system **withdraws the weaker inference** rather
than leaving a guess sitting beside the proof.

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

Worth stating up front:

| Situation                                               | Outcome                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Payload is **encrypted** before being sent              | Canary never appears → falls back to **INFERENCE**, verdict becomes `review`. It under-claims rather than over-claims. |
| Package detects the sandbox and behaves                 | **Missed.** The standard weakness of dynamic analysis.                                                                 |
| Malicious behaviour happens at `require()`, not install | **Missed.** Only install-time behaviour is observed.                                                                   |
| The malicious code is in a transitive dependency        | Only the named package's hooks are detonated today.                                                                    |

The first two are inherent to this approach, not tuning problems.

---

## 8 · When things go wrong

| Symptom                          | What to do                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Amber banner: "local fallback"   | Say it out loud — Modal is unreachable, so it fell back and **labelled it**. A fallback is never presented as a real sandbox run. |
| `generated by rule-engine`       | No API key. The deterministic engine wrote it; correctness never depended on the model.                                           |
| Inspection takes over 90 seconds | Cold start: download plus container boot. The second run is faster.                                                               |
| `502` or a sandbox error         | Modal is down. Use **Run simulation** — that path has a local fallback.                                                           |
| Everything fails                 | Open a previous investigation. Completed runs persist in Supabase and re-render from `GET /api/investigation/:id`.                |

Before presenting: run the flow once and leave that tab open as a safety net.

---

## 9 · In one sentence

> It doesn't read what the code says it will do. It runs the install hook in a
> sandbox, records what the kernel actually saw, and applies readable rules to
> produce a verdict — with every claim marked as observed fact or as inference.
>
> Today it **tells you**. It does not yet stop you.
