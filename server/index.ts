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
import { runSimulation } from './simulate'
import { computeVerdict, renderVerdictSection } from './verdict'
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
  const verdict = computeVerdict(findingRows, supplyChain)

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
