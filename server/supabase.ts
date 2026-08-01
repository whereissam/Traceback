/** Supabase access layer. All queries funnel through here. */

import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import type {
  Evidence,
  Finding,
  Investigation,
  RawTelemetryEvent,
  Report,
  TelemetryEvent,
  TimelineEntry,
} from '../src/lib/traceback/types'

export const supabase = createClient(env.supabaseUrl, env.supabaseSecretKey, {
  auth: { persistSession: false },
})

/** Throws with the Postgres message intact so failures are diagnosable. */
function unwrap<T>(
  result: { data: T | null; error: { message: string } | null },
  context: string,
): T {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`)
  }
  if (result.data === null) {
    throw new Error(`${context}: no data returned`)
  }
  return result.data
}

export async function createInvestigation(
  title: string,
): Promise<Investigation> {
  return unwrap(
    await supabase
      .from('investigations')
      .insert({ title, status: 'open' })
      .select()
      .single(),
    'createInvestigation',
  ) as Investigation
}

export async function getInvestigation(
  id: string,
): Promise<Investigation | null> {
  const { data, error } = await supabase
    .from('investigations')
    .select()
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`getInvestigation: ${error.message}`)
  return (data as Investigation) ?? null
}

export async function listInvestigations(): Promise<Investigation[]> {
  return unwrap(
    await supabase
      .from('investigations')
      .select()
      .order('created_at', { ascending: false })
      .limit(50),
    'listInvestigations',
  ) as Investigation[]
}

export async function setInvestigationStatus(
  id: string,
  status: Investigation['status'],
): Promise<void> {
  const { error } = await supabase
    .from('investigations')
    .update({ status })
    .eq('id', id)
  if (error) throw new Error(`setInvestigationStatus: ${error.message}`)
}

export async function insertEvents(
  investigationId: string,
  events: RawTelemetryEvent[],
): Promise<TelemetryEvent[]> {
  const rows = events.map((event) => ({
    investigation_id: investigationId,
    timestamp: event.timestamp,
    source: event.source,
    event_type: event.event_type,
    raw: event.raw,
    process_id: event.process_id ?? null,
    parent_process_id: event.parent_process_id ?? null,
    user_id: event.user_id ?? null,
  }))

  return unwrap(
    await supabase.from('events').insert(rows).select(),
    'insertEvents',
  ) as TelemetryEvent[]
}

export async function getEvents(
  investigationId: string,
): Promise<TelemetryEvent[]> {
  return unwrap(
    await supabase
      .from('events')
      .select()
      .eq('investigation_id', investigationId)
      .order('timestamp', { ascending: true }),
    'getEvents',
  ) as TelemetryEvent[]
}

export async function getEvidence(
  investigationId: string,
): Promise<Evidence[]> {
  return unwrap(
    await supabase
      .from('evidence')
      .select()
      .eq('investigation_id', investigationId)
      .order('timestamp', { ascending: true }),
    'getEvidence',
  ) as Evidence[]
}

export async function getFindings(investigationId: string): Promise<Finding[]> {
  return unwrap(
    await supabase
      .from('findings')
      .select()
      .eq('investigation_id', investigationId)
      .order('created_at', { ascending: true }),
    'getFindings',
  ) as Finding[]
}

export async function getTimeline(
  investigationId: string,
): Promise<TimelineEntry[]> {
  return unwrap(
    await supabase
      .from('attack_timeline')
      .select()
      .eq('investigation_id', investigationId)
      .order('order_index', { ascending: true }),
    'getTimeline',
  ) as TimelineEntry[]
}

export async function getLatestReport(
  investigationId: string,
): Promise<Report | null> {
  const { data, error } = await supabase
    .from('reports')
    .select()
    .eq('investigation_id', investigationId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`getLatestReport: ${error.message}`)
  return ((data as Report[] | null) ?? [])[0] ?? null
}

/**
 * Clears derived data for an investigation so `/api/investigate/:id` is
 * idempotent — re-running it replaces the analysis rather than duplicating it.
 * Raw `events` are never touched: they are the ground truth.
 */
export async function clearDerived(investigationId: string): Promise<void> {
  for (const table of ['attack_timeline', 'reports', 'findings', 'evidence']) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('investigation_id', investigationId)
    if (error) throw new Error(`clearDerived(${table}): ${error.message}`)
  }
}

export async function insertEvidence(
  investigationId: string,
  rows: Array<{
    statement: string
    category: string
    timestamp: string
    event_ids: string[]
  }>,
): Promise<Evidence[]> {
  if (rows.length === 0) return []
  return unwrap(
    await supabase
      .from('evidence')
      .insert(
        rows.map((row) => ({ ...row, investigation_id: investigationId })),
      )
      .select(),
    'insertEvidence',
  ) as Evidence[]
}

export async function insertFindings(
  investigationId: string,
  rows: Array<{
    kind: string
    title: string
    description: string
    confidence: string
    mitre_technique: string | null
    evidence_ids: string[]
    note: string | null
  }>,
): Promise<Finding[]> {
  if (rows.length === 0) return []
  return unwrap(
    await supabase
      .from('findings')
      .insert(
        rows.map((row) => ({ ...row, investigation_id: investigationId })),
      )
      .select(),
    'insertFindings',
  ) as Finding[]
}

export async function insertTimeline(
  investigationId: string,
  rows: Array<{
    phase: string
    title: string
    description: string
    finding_ids: string[]
    order_index: number
  }>,
): Promise<TimelineEntry[]> {
  if (rows.length === 0) return []
  return unwrap(
    await supabase
      .from('attack_timeline')
      .insert(
        rows.map((row) => ({ ...row, investigation_id: investigationId })),
      )
      .select(),
    'insertTimeline',
  ) as TimelineEntry[]
}

export async function insertReport(
  investigationId: string,
  row: {
    markdown: string
    open_questions: string[]
    containment_steps: string[]
    generated_by: string
    verdict: unknown
  },
): Promise<Report> {
  return unwrap(
    await supabase
      .from('reports')
      .insert({ ...row, investigation_id: investigationId })
      .select()
      .single(),
    'insertReport',
  ) as Report
}

export async function setFindingConfirmed(
  findingId: string,
  confirmed: boolean,
): Promise<Finding> {
  return unwrap(
    await supabase
      .from('findings')
      .update({ confirmed })
      .eq('id', findingId)
      .select()
      .single(),
    'setFindingConfirmed',
  ) as Finding
}
