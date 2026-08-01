/**
 * Report generation via the OpenAI API.
 *
 * The model's job is narrow on purpose: it arranges *already-derived* findings
 * into an ordered timeline and drafts open questions and containment steps. It
 * never sees raw events and cannot introduce new claims — every finding id it
 * returns is validated against the set we passed in, and unknown ids are
 * dropped before anything is written to the database.
 *
 * When OPENAI_API_KEY is absent, callers fall back to the deterministic
 * timeline in pipeline.ts. The demo works offline.
 */

import OpenAI from 'openai'
import { env } from './env'
import { PHASES } from '../src/lib/traceback/types'
import type { Evidence, Finding, Phase } from '../src/lib/traceback/types'
import { DEFAULT_CONTAINMENT_STEPS, DEFAULT_OPEN_QUESTIONS } from './pipeline'

export interface LlmTimelineEntry {
  phase: Phase
  title: string
  description: string
  finding_ids: string[]
  order_index: number
}

export interface LlmReport {
  timeline: LlmTimelineEntry[]
  open_questions: string[]
  containment_steps: string[]
  generated_by: string
}

const SYSTEM_PROMPT = `You are a digital forensics assistant.

You are given a list of EVIDENCE (plain statements of fact extracted from telemetry) and a list of FINDINGS already classified as FACT, CORRELATION, or INFERENCE.

Your job:
1. Arrange the findings into an attack timeline using only these phases: initial_access, execution, credential_access, exfiltration, persistence. Omit a phase entirely if no finding supports it.
2. For each phase, write a title and a description that summarises what the findings in that phase show.
3. List open questions — things the evidence does NOT answer.
4. List recommended containment steps.
5. If any finding indicates a supply-chain compromise (a dependency install whose hook accessed credentials, contacted the network, or modified build/deploy configuration), say so explicitly in that phase's description — name the package and what it touched.

Hard rules:
- NEVER invent an event, a finding, a host, a file path, a process, or a timestamp that does not appear in the input.
- Every finding_ids value MUST be an id copied exactly from the FINDINGS input. Do not fabricate ids.
- Assign each finding to at most one phase.
- Do not restate an INFERENCE as though it were established fact. Describe it as a hypothesis.
- Descriptions must be plain prose a tired incident responder can read at 3am. No marketing language.`

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['timeline', 'open_questions', 'containment_steps'],
  properties: {
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'title', 'description', 'finding_ids'],
        properties: {
          phase: { type: 'string', enum: [...PHASES] },
          title: { type: 'string' },
          description: { type: 'string' },
          finding_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    containment_steps: { type: 'array', items: { type: 'string' } },
  },
} as const

export function isLlmConfigured(): boolean {
  return Boolean(env.openaiApiKey)
}

/**
 * Asks the model for a timeline. Returns null when the LLM is unconfigured or
 * the call fails — callers then use the deterministic timeline, so a missing
 * key or a flaky network degrades the report instead of breaking the demo.
 */
export async function generateReport(
  evidence: Evidence[],
  findings: Finding[],
): Promise<LlmReport | null> {
  if (!env.openaiApiKey) return null

  const client = new OpenAI({ apiKey: env.openaiApiKey })

  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const validFindingIds = new Set(findings.map((f) => f.id))

  const input = {
    evidence: evidence.map((item) => ({
      id: item.id,
      statement: item.statement,
      category: item.category,
      timestamp: item.timestamp,
    })),
    findings: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      title: finding.title,
      description: finding.description,
      confidence: finding.confidence,
      mitre_technique: finding.mitre_technique,
      cited_evidence: finding.evidence_ids
        .map((id) => evidenceById.get(id)?.statement)
        .filter(Boolean),
    })),
  }

  try {
    const response = await client.responses.create({
      model: env.openaiModel,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
      text: {
        format: {
          type: 'json_schema',
          name: 'investigation_report',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
      reasoning: { effort: env.openaiEffort },
      // Investigation data is incident evidence. Don't leave a copy on the
      // provider's side by default; opt in deliberately if you want it.
      store: false,
    })

    const content = response.output_text
    if (!content) return null

    const parsed = JSON.parse(content) as {
      timeline?: Array<{
        phase?: string
        title?: string
        description?: string
        finding_ids?: string[]
      }>
      open_questions?: string[]
      containment_steps?: string[]
    }

    // Validation gate: anything the model invented is discarded here.
    const seen = new Set<string>()
    const timeline: LlmTimelineEntry[] = []

    for (const entry of parsed.timeline ?? []) {
      const phase = entry.phase as Phase | undefined
      if (!phase || !(PHASES as readonly string[]).includes(phase)) continue

      const findingIds = (entry.finding_ids ?? []).filter((id) => {
        if (!validFindingIds.has(id) || seen.has(id)) return false
        seen.add(id)
        return true
      })
      if (findingIds.length === 0) continue

      timeline.push({
        phase,
        title: entry.title?.trim() || phase,
        description: entry.description?.trim() || '',
        finding_ids: findingIds,
        order_index: 0,
      })
    }

    if (timeline.length === 0) return null

    // Re-order by the canonical kill-chain sequence, not the model's ordering.
    timeline.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase))
    timeline.forEach((entry, index) => {
      entry.order_index = index
    })

    const openQuestions = (parsed.open_questions ?? [])
      .map((q) => q.trim())
      .filter(Boolean)
    const containmentSteps = (parsed.containment_steps ?? [])
      .map((s) => s.trim())
      .filter(Boolean)

    return {
      timeline,
      open_questions:
        openQuestions.length > 0 ? openQuestions : DEFAULT_OPEN_QUESTIONS,
      containment_steps:
        containmentSteps.length > 0
          ? containmentSteps
          : DEFAULT_CONTAINMENT_STEPS,
      generated_by: env.openaiModel,
    }
  } catch (error) {
    console.error('[traceback] LLM report generation failed:', error)
    return null
  }
}
