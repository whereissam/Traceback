import { describe, expect, it } from 'vitest'
import { computeVerdict, renderVerdictSection } from './verdict'
import { detectSupplyChain } from './supply-chain'
import { runPipeline } from './pipeline'
import { buildLocalTelemetry } from './fixtures'
import type {
  Finding,
  RawTelemetryEvent,
  TelemetryEvent,
} from '../src/lib/traceback/types'

function withIds(events: RawTelemetryEvent[]): TelemetryEvent[] {
  return events.map((event, index) => ({
    id: `evt-${index}`,
    investigation_id: 'inv-1',
    timestamp: event.timestamp,
    source: event.source,
    event_type: event.event_type,
    raw: event.raw,
    process_id: event.process_id ?? null,
    parent_process_id: event.parent_process_id ?? null,
    user_id: event.user_id ?? null,
    created_at: event.timestamp,
  }))
}
const scenario = () =>
  withIds(buildLocalTelemetry(Date.UTC(2026, 0, 1, 12, 0, 0)))

/** Promotes pipeline drafts to the row shape computeVerdict consumes. */
function asFindings(events: TelemetryEvent[]): Finding[] {
  return runPipeline(events).findings.map((d, i) => ({
    id: `f-${i}`,
    investigation_id: 'inv-1',
    kind: d.kind,
    title: d.title,
    description: d.description,
    confidence: d.confidence,
    mitre_technique: d.mitre_technique,
    evidence_ids: [],
    note: d.note,
    confirmed: false,
    created_at: new Date(0).toISOString(),
  }))
}

describe('computeVerdict', () => {
  it('blocks the malicious-install scenario', () => {
    const events = scenario()
    const result = computeVerdict(asFindings(events), detectSupplyChain(events))
    expect(result.verdict).toBe('block')
    expect(result.risk).toBe('high')
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('allows an install with no risky behaviour', () => {
    const events = scenario().filter((e) => e.event_type === 'process_start')
    const result = computeVerdict(asFindings(events), detectSupplyChain(events))
    expect(result.verdict).toBe('allow')
    expect(result.risk).toBe('low')
  })

  it('labels each reason with how strongly it is established', () => {
    const events = scenario()
    const result = computeVerdict(asFindings(events), detectSupplyChain(events))
    for (const reason of result.reasons) {
      expect(['FACT', 'CORRELATION', 'INFERENCE']).toContain(reason.basis)
    }
  })

  it('always states what it could not confirm', () => {
    const events = scenario()
    const result = computeVerdict(asFindings(events), detectSupplyChain(events))
    // A verdict that hides its gaps is the failure mode this product exists
    // to avoid — even ALLOW carries the caveat that only this run was observed.
    expect(result.unconfirmed.length).toBeGreaterThan(0)
  })

  it('does not claim transmission when only timing links the events', () => {
    const events = scenario()
    const result = computeVerdict(asFindings(events), detectSupplyChain(events))
    expect(result.unconfirmed.join(' ')).toMatch(
      /request body was not captured/i,
    )
  })

  it('renders a report section separating confirmed from unconfirmed', () => {
    const events = scenario()
    const md = renderVerdictSection(
      computeVerdict(asFindings(events), detectSupplyChain(events)),
    )
    expect(md).toContain('## Verdict')
    expect(md).toContain('**BLOCK**')
    expect(md).toContain('**Confirmed:**')
    expect(md).toContain('**Not confirmed:**')
  })
})
