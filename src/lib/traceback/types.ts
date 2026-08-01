/**
 * Shared Traceback domain types.
 *
 * Imported by both the API server (`server/`) and the browser app (`src/`), so
 * this module must stay free of Node- and DOM-specific imports.
 */

export const PHASES = [
  'initial_access',
  'execution',
  'credential_access',
  'exfiltration',
  'persistence',
] as const

export type Phase = (typeof PHASES)[number]

/** The epistemic status of a finding. This distinction is the whole product. */
export type FindingKind = 'FACT' | 'CORRELATION' | 'INFERENCE'

export type Confidence = 'high' | 'medium' | 'low'

export type EvidenceCategory =
  | 'process'
  | 'file'
  | 'network'
  | 'code'
  | 'credential'

export interface Investigation {
  id: string
  title: string | null
  status: 'open' | 'investigating' | 'closed'
  created_at: string
}

export interface TelemetryEvent {
  id: string
  investigation_id: string
  timestamp: string
  source: string | null
  event_type: string | null
  raw: Record<string, unknown>
  process_id: string | null
  parent_process_id: string | null
  user_id: string | null
  created_at: string
}

/** A raw event as it arrives from the simulator, before it has a database id. */
export interface RawTelemetryEvent {
  timestamp: string
  source: string
  event_type: string
  raw: Record<string, unknown>
  process_id?: string | null
  parent_process_id?: string | null
  user_id?: string | null
}

export interface Evidence {
  id: string
  investigation_id: string
  event_ids: string[]
  statement: string
  timestamp: string | null
  category: EvidenceCategory | null
  created_at: string
}

export interface Finding {
  id: string
  investigation_id: string
  kind: FindingKind
  title: string | null
  description: string | null
  confidence: Confidence | null
  mitre_technique: string | null
  evidence_ids: string[]
  note: string | null
  confirmed: boolean
  created_at: string
}

export interface TimelineEntry {
  id: string
  investigation_id: string
  phase: Phase | null
  title: string | null
  description: string | null
  finding_ids: string[]
  order_index: number
  created_at: string
}

export interface Report {
  id: string
  investigation_id: string
  markdown: string | null
  open_questions: string[]
  containment_steps: string[]
  generated_by: string | null
  created_at: string
}

/** The full payload returned by `GET /api/investigation/:id`. */
export type Verdict = 'allow' | 'review' | 'block'

export interface VerdictReason {
  rule: string
  detail: string
  basis: FindingKind
}

/** The risk-policy decision, computed by rules rather than by a model. */
export interface VerdictResult {
  verdict: Verdict
  risk: 'high' | 'medium' | 'low'
  reasons: VerdictReason[]
  confirmed: string[]
  unconfirmed: string[]
  summary: string
}

export interface InvestigationReport {
  investigation: Investigation
  events: TelemetryEvent[]
  evidence: Evidence[]
  findings: Finding[]
  timeline: TimelineEntry[]
  report: Report | null
  /** Null until the pipeline has run for this investigation. */
  verdict: VerdictResult | null
}

export const PHASE_LABELS: Record<Phase, string> = {
  initial_access: 'Initial Access',
  execution: 'Execution',
  credential_access: 'Credential Access',
  exfiltration: 'Exfiltration',
  persistence: 'Persistence',
}

/**
 * Human-readable gloss for each finding kind. Shown in the UI next to every
 * finding so a reviewer never has to guess how much the system is asserting.
 */
export const KIND_MEANING: Record<FindingKind, string> = {
  FACT: 'Directly observed in the telemetry.',
  CORRELATION:
    'Two or more observations linked by time, process tree, or user.',
  INFERENCE: 'A hypothesis about intent. Requires human confirmation.',
}
