/**
 * Traceback API server.
 *
 *   POST /api/simulate           run the sandbox, store raw events
 *   POST /api/investigate/:id    run the pipeline, store evidence/findings/timeline/report
 *   GET  /api/investigation/:id  full investigation payload
 *   GET  /api/investigations     recent investigations
 *   POST /api/findings/:id/confirm   record human sign-off on an INFERENCE
 *
 * Run with:  bun run dev:server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env'
import { inspectPackage, runSimulation } from './simulate'
import { computeVerdict, renderVerdictSection } from './verdict'
import { analyseSource, capabilitiesNotExercised } from './static-analysis'
import { generateReport, isLlmConfigured } from './llm'
import {
  buildDeterministicTimeline,
  DEFAULT_CONTAINMENT_STEPS,
  DEFAULT_OPEN_QUESTIONS,
  renderMarkdownReport,
  runPipeline,
} from './pipeline'
import {
  clearDerived,
  createInvestigation,
  getEvents,
  getEvidence,
  getFindings,
  getInvestigation,
  getLatestReport,
  getTimeline,
  insertEvents,
  insertEvidence,
  insertFindings,
  insertReport,
  insertTimeline,
  listInvestigations,
  setFindingConfirmed,
  setInvestigationStatus,
} from './supabase'
import type {
  InvestigationReport,
  VerdictResult,
} from '../src/lib/traceback/types'

/**
 * The controlled malicious package, addressable by name so a reviewer can type
 * it into the same box as a real package and watch the identical pipeline reach
 * the opposite verdict.
 */
const FIXTURE_LABEL = 'unknown-analytics-helper@1.4.2'
const FIXTURE_NAMES = new Set([
  'unknown-analytics-helper',
  'unknown-analytics-helper@1.4.2',
])

/**
 * Static analysis is computed at inspection time (that is when the source is in
 * hand) but consumed at analysis time. Held in memory rather than persisted:
 * it is derived from the package, so a re-inspection regenerates it, and a
 * server restart losing it degrades the verdict to dynamic-only rather than
 * corrupting anything.
 */
const staticByInvestigation = new Map<
  string,
  ReturnType<typeof analyseSource>
>()

const app = new Hono()

app.use('/api/*', cors())

app.onError((error, c) => {
  console.error('[traceback] request failed:', error)
  return c.json({ error: error.message }, 500)
})

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    llm: isLlmConfigured() ? env.openaiModel : null,
    modal: Boolean(env.modalSimulateUrl && env.modalSimulateToken),
  }),
)

app.get('/api/investigations', async (c) => {
  return c.json({ investigations: await listInvestigations() })
})

/**
 * Runs the sandbox simulation and stores the resulting telemetry against a new
 * investigation. Analysis is a separate call so the demo can show raw,
 * unexplained events before anything interprets them.
 */
app.post('/api/simulate', async (c) => {
  const body = await c.req
    .json<{ title?: string }>()
    .catch((): { title?: string } => ({}))
  const result = await runSimulation()

  const investigation = await createInvestigation(
    body.title?.trim() ||
      `Malicious dependency during agent-driven install — ${new Date().toISOString()}`,
  )
  const events = await insertEvents(investigation.id, result.events)

  return c.json({
    investigation,
    event_count: events.length,
    telemetry_source: result.source,
    fallback_reason: result.fallbackReason ?? null,
  })
})

/**
 * Inspects a REAL npm package: downloads it with scripts disabled, detonates
 * its lifecycle hooks in the sandbox under strace, and stores the resulting
 * telemetry as a new investigation.
 *
 * There is deliberately no fallback here. Inventing telemetry for a named
 * third-party package would be a fabrication about software someone else
 * published, so an unreachable sandbox is an error, not a degraded result.
 */
app.post('/api/inspect', async (c) => {
  const body = await c.req
    .json<{ package?: string }>()
    .catch((): { package?: string } => ({}))
  const name = body.package?.trim()
  if (!name || !/^[@a-z0-9._/-]{1,120}$/.test(name)) {
    return c.json({ error: 'provide a valid npm package name' }, 400)
  }

  // The malicious fixture is reachable by name from the same input as a real
  // package, so one box can demonstrate both outcomes. It is not fetched from
  // npm — the response says so, and the UI labels it.
  if (FIXTURE_NAMES.has(name)) {
    const result = await runSimulation()
    const investigation = await createInvestigation(
      `${FIXTURE_LABEL} — install-hook inspection (fixture)`,
    )
    const events = await insertEvents(investigation.id, result.events)
    return c.json({
      investigation,
      package: FIXTURE_LABEL,
      version: '1.4.2',
      lifecycle_scripts: { postinstall: 'node postinstall.js' },
      has_lifecycle_scripts: true,
      event_count: events.length,
      telemetry_source: result.source,
      is_fixture: true,
      note: 'Controlled fixture — written by us, not fetched from npm. Its behaviour is deliberately malicious so the same pipeline can be shown producing a BLOCK.',
    })
  }

  const result = await inspectPackage(name)
  if (result.error) return c.json({ error: result.error }, 502)

  const scriptCount = Object.keys(result.lifecycleScripts).length
  const investigation = await createInvestigation(
    `${result.package}${result.version ? `@${result.version}` : ''} — install-hook inspection`,
  )

  // A package with no lifecycle scripts has nothing to detonate. That is a
  // real, useful answer, not a failure.
  const events =
    result.events.length > 0
      ? await insertEvents(investigation.id, result.events)
      : []

  // Static capability scan of the hook source. Cheap, and it covers the one
  // case dynamic analysis structurally cannot: a package that stays dormant.
  const statik = analyseSource(result.hookSources)
  staticByInvestigation.set(investigation.id, statik)

  return c.json({
    investigation,
    package: result.package,
    static_analysis: {
      files_scanned: statik.filesScanned,
      bytes_scanned: statik.bytesScanned,
      capabilities: statik.capabilities.map((cap) => ({
        id: cap.id,
        label: cap.label,
        matches: cap.matches,
      })),
    },
    version: result.version,
    lifecycle_scripts: result.lifecycleScripts,
    has_lifecycle_scripts: scriptCount > 0,
    event_count: events.length,
    telemetry_source: 'modal',
    note:
      result.note ??
      (scriptCount === 0
        ? 'No install lifecycle scripts declared — nothing executes at install time.'
        : null),
  })
})

/**
 * Runs the full pipeline for an investigation. Idempotent: derived rows are
 * cleared first, so re-running replaces the analysis rather than duplicating it.
 */
app.post('/api/investigate/:id', async (c) => {
  const id = c.req.param('id')
  const investigation = await getInvestigation(id)
  if (!investigation) return c.json({ error: 'investigation not found' }, 404)

  const events = await getEvents(id)
  if (events.length === 0) {
    return c.json({ error: 'investigation has no events to analyse' }, 400)
  }

  await setInvestigationStatus(id, 'investigating')
  await clearDerived(id)

  // --- evidence ------------------------------------------------------------
  const {
    evidence: evidenceDrafts,
    findings: findingDrafts,
    supplyChain,
  } = runPipeline(events)

  const evidenceRows = await insertEvidence(
    id,
    evidenceDrafts.map((draft) => ({
      statement: draft.statement,
      category: draft.category,
      timestamp: draft.timestamp,
      event_ids: draft.event_ids,
    })),
  )
  const evidenceIdByKey = new Map(
    evidenceDrafts.map((draft, index) => [draft.key, evidenceRows[index]?.id]),
  )

  // --- findings ------------------------------------------------------------
  const findingRows = await insertFindings(
    id,
    findingDrafts.map((draft) => ({
      kind: draft.kind,
      title: draft.title,
      description: draft.description,
      confidence: draft.confidence,
      mitre_technique: draft.mitre_technique,
      evidence_ids: [
        ...new Set(
          draft.evidence_keys
            .map((key) => evidenceIdByKey.get(key))
            .filter((value): value is string => Boolean(value)),
        ),
      ],
      note: draft.note,
    })),
  )
  const findingIdByKey = new Map(
    findingDrafts.map((draft, index) => [draft.key, findingRows[index]?.id]),
  )

  // --- timeline: LLM first, deterministic fallback -------------------------
  const llm = await generateReport(evidenceRows, findingRows)

  const timelineRows = await insertTimeline(
    id,
    llm
      ? llm.timeline.map((entry) => ({
          phase: entry.phase,
          title: entry.title,
          description: entry.description,
          finding_ids: entry.finding_ids,
          order_index: entry.order_index,
        }))
      : buildDeterministicTimeline(findingDrafts).map((entry) => ({
          phase: entry.phase,
          title: entry.title,
          description: entry.description,
          finding_ids: entry.finding_keys
            .map((key) => findingIdByKey.get(key))
            .filter((value): value is string => Boolean(value)),
          order_index: entry.order_index,
        })),
  )

  // --- report --------------------------------------------------------------
  const openQuestions = llm?.open_questions ?? DEFAULT_OPEN_QUESTIONS
  const containmentSteps = llm?.containment_steps ?? DEFAULT_CONTAINMENT_STEPS

  // Rule-based decision, computed from findings — never model-generated.
  const statik = staticByInvestigation.get(id)
  const dormant = statik
    ? capabilitiesNotExercised(statik, {
        readCredentials: (supplyChain?.secretsAccessed ?? []).length > 0,
        madeNetworkRequest: (supplyChain?.outboundHosts ?? []).length > 0,
        spawnedProcess: events.some((e) => e.event_type === 'process_start'),
      })
    : []
  const verdict = computeVerdict(findingRows, supplyChain, dormant)

  const markdown = renderMarkdownReport({
    title: investigation.title ?? 'Untitled investigation',
    supplyChain,
    evidence: evidenceRows,
    findings: findingRows,
    timeline: timelineRows,
    openQuestions,
    containmentSteps,
    verdictSection: renderVerdictSection(verdict),
  })

  const report = await insertReport(id, {
    markdown,
    open_questions: openQuestions,
    containment_steps: containmentSteps,
    generated_by: llm?.generated_by ?? 'rule-engine',
    verdict,
  })

  return c.json({
    investigation_id: id,
    evidence_count: evidenceRows.length,
    finding_counts: {
      FACT: findingRows.filter((f) => f.kind === 'FACT').length,
      CORRELATION: findingRows.filter((f) => f.kind === 'CORRELATION').length,
      INFERENCE: findingRows.filter((f) => f.kind === 'INFERENCE').length,
    },
    timeline_phases: timelineRows.length,
    supply_chain_detected: Boolean(supplyChain),
    verdict: verdict.verdict,
    risk: verdict.risk,
    dormant_capabilities: dormant.map((c) => c.id),
    generated_by: report.generated_by,
  })
})

app.get('/api/investigation/:id', async (c) => {
  const id = c.req.param('id')
  const investigation = await getInvestigation(id)
  if (!investigation) return c.json({ error: 'investigation not found' }, 404)

  const [events, evidence, findings, timeline, report] = await Promise.all([
    getEvents(id),
    getEvidence(id),
    getFindings(id),
    getTimeline(id),
    getLatestReport(id),
  ])

  const payload: InvestigationReport = {
    investigation,
    events,
    evidence,
    findings,
    timeline,
    report,
    verdict:
      (report as { verdict?: VerdictResult | null } | null)?.verdict ?? null,
  }
  return c.json(payload)
})

/** Human sign-off. An INFERENCE is only ever "confirmed" by a person. */
app.post('/api/findings/:id/confirm', async (c) => {
  const body = await c.req
    .json<{ confirmed?: boolean }>()
    .catch(() => ({ confirmed: true }))
  const finding = await setFindingConfirmed(
    c.req.param('id'),
    body.confirmed !== false,
  )
  return c.json({ finding })
})

console.log(`[traceback] API listening on http://localhost:${env.port}`)
console.log(
  `[traceback] telemetry: ${
    env.modalSimulateUrl && env.modalSimulateToken
      ? 'Modal sandbox'
      : 'local fallback'
  } | report model: ${isLlmConfigured() ? env.openaiModel : 'rule-engine (no OPENAI_API_KEY)'}`,
)

export default {
  port: env.port,
  fetch: app.fetch,
}
