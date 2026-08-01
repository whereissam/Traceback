# Traceback — status and roadmap

An evidence-based security gate for npm packages installed by AI coding agents.
Traceback runs a package's install hook in an isolated sandbox, records what it
actually does, and returns an ALLOW / REVIEW / BLOCK verdict where every claim is
labelled FACT, CORRELATION, or INFERENCE.

**Do not trust what the package says. Observe what it does.**

Legend: `[x]` shipped · `[ ]` planned · `[~]` needs deployment credentials

---

## Shipped

### Data model

- [x] Postgres schema — investigations, events, evidence, findings,
      attack_timeline, reports (`docs/traceback/schema.sql`)
- [x] Row Level Security enabled on every table with no permissive policies;
      the service-role key is server-side only and never reaches the browser
- [x] Shared domain types across server and client (`src/lib/traceback/types.ts`)

### Telemetry ingestion

- [x] Sandboxed simulation of a malicious dependency (`modal/modal_sim.py`) —
      real subprocesses, real file I/O, a real outbound request, each event
      timestamped when it actually occurred so inter-event gaps are genuine
- [x] Token-protected HTTP endpoint so the API server can trigger a run
- [x] Local fallback with an identical event shape; the UI states which source
      produced the data, so a fallback run is never shown as sandbox telemetry

### Correlation pipeline

- [x] Normalisation and time alignment of raw events
- [x] Evidence extraction — plain statements of fact, each citing its event ids
- [x] Correlation by process-tree ancestry, time proximity, and user identity
- [x] FACT / CORRELATION / INFERENCE classification with confidence and an
      approximate MITRE ATT&CK technique
- [x] Structural invariant: an INFERENCE cannot exist without a CORRELATION
      beneath it, and no finding is stored without cited evidence
- [x] Process-name resolution, so evidence reads "node postinstall.js (pid
      1002)" rather than naming the telemetry channel
- [x] Pipeline implemented as pure functions over plain data, covered by 27
      unit tests including window boundaries and negative cases

### Supply-chain detection

- [x] Named indicators extracted from telemetry: package, install command,
      install hook, secrets accessed, outbound hosts, persistence paths
- [x] Threshold tuned against false positives — an install plus a lifecycle
      hook never fires on its own, since that is ordinary npm behaviour
- [x] Activity attributed to the install process tree, so unrelated host
      activity is not swept into the finding
- [x] Dedicated "Supply chain indicators" report section with named
      containment actions
- [x] Prominent banner above the timeline; still labelled INFERENCE and still
      unconfirmed until a human confirms it

### Verdict and canary

- [x] Canary escalation: a synthetic token is seeded into the credential file
      before the install runs. If it is observed in the transmitted payload,
      exfiltration becomes a FACT instead of an INFERENCE — and the weaker
      hypothesis is withdrawn rather than left standing next to the proof
- [x] Both ends of the exfiltration path are ours: the sandbox posts to a Modal
      collector that reports what it received, so the proof does not depend on a
      third-party echo service being reachable
- [x] Transmission is never claimed when the request failed, however
      incriminating the payload
- [x] Rule-based ALLOW / REVIEW / BLOCK verdict — deterministic, not
      model-generated, so it is readable and reproducible
- [x] Every verdict separates _confirmed_ from _not confirmed_, including ALLOW

### API

- [x] `POST /api/simulate` — run the sandbox, store raw events
- [x] `POST /api/investigate/:id` — run the pipeline (idempotent; re-running
      replaces the analysis rather than duplicating it)
- [x] `GET /api/investigation/:id` — full investigation payload
- [x] `POST /api/findings/:id/confirm` — record analyst sign-off
- [x] `GET /api/health` — reports which integrations are live

### Report generation

- [x] LLM arranges already-derived findings into a timeline and drafts open
      questions and containment steps
- [x] The model never sees raw telemetry and must reference findings by id;
      every id is validated against the set supplied, and unknown ids are
      discarded before anything is written
- [x] Deterministic rule engine produces the timeline when no LLM is
      configured, so the system runs end to end without an API key

### Interface

- [x] Raw events shown before analysis, so the "before" state is visible
- [x] Vertical timeline with expandable phases and per-finding evidence links
- [x] Analyst confirmation required on every INFERENCE — the system never marks
      its own hypotheses as confirmed
- [x] Evidence tiers defined as design tokens (`--fact`, `--correlation`,
      `--inference`, `--danger`) rather than hardcoded colours

---

## Verified end to end

Every integration has been exercised against live services, not mocked:

- [x] **Supabase** — schema applied; investigations, events, evidence, findings,
      timeline, and report rows all written and read back
- [x] **Modal** — sandbox deployed; token auth rejects bad callers; runs return
      real pids, real parent links, and real timestamps
- [x] **Canary** — collector confirmed receipt of the seeded token, producing
      `FACT: 7 / CORRELATION: 3 / INFERENCE: 2` with the exfiltration hypothesis
      correctly withdrawn
- [x] **OpenAI** — timeline authored by `gpt-5.6-luna` via the Responses API,
      with zero hallucinated finding ids across runs
- [x] **Full flow** — `POST /api/simulate` → `POST /api/investigate/:id` →
      verdict `block` / high risk in roughly 10 seconds

---

## Known limitations

Stated explicitly because a forensics tool that hides its uncertainty is worse
than one that has none:

- The outbound request body is not captured, so credential _transmission_ is
  inferred rather than observed. The generated report says so under Open
  Questions rather than presenting it as established.
- MITRE technique mappings are approximate — useful for orientation, not
  suitable for formal reporting.
- Correlation windows (2s for exfiltration, 30s for persistence) are tuned to
  this scenario and need per-environment calibration against real telemetry.
- The LLM only arranges findings. It cannot promote an INFERENCE to a FACT, but
  it is also not yet contributing hypothesis generation.
- Single-host only. There is no cross-host or cross-session correlation.

---

## Roadmap

### Next

- [ ] Ingestion adapters for real EDR and SIEM sources. The pipeline consumes
      normalised events, so this is a new adapter rather than a rewrite.
- [ ] Multi-host and multi-session correlation
- [ ] Persist analyst decisions as training signal — which inferences were
      confirmed, which were rejected, and why
- [ ] `npm install --ignore-scripts` interception: detect lifecycle scripts from
      `package.json` and inspect them before anything executes locally
- [ ] `strace` syscall capture (`openat` / `read` / `connect`) so evidence comes
      from the kernel rather than from the script being observed
- [ ] Authentication on `/api/*` — required before any deployment

### Later

- [ ] Package reputation signals as an additional correlation input
- [ ] Automated diff review of modified CI/CD workflow files
- [ ] Report export (PDF and STIX) for handoff to downstream systems
- [ ] Investigation history view and cross-investigation search
