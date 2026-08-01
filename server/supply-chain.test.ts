import { describe, expect, it } from 'vitest'
import { detectSupplyChain, renderSupplyChainSection } from './supply-chain'
import { buildLocalTelemetry } from './fixtures'
import { runPipeline } from './pipeline'
import type {
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

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0)
const scenario = () => withIds(buildLocalTelemetry(BASE))

describe('detectSupplyChain', () => {
  it('names the package, hook, secret, and persistence path', () => {
    const result = detectSupplyChain(scenario())
    expect(result).not.toBeNull()
    expect(result!.packageName).toBe('unknown-analytics-helper@1.4.2')
    expect(result!.installHook).toBe('node postinstall.js')
    expect(result!.secretsAccessed).toEqual(['/app/.env'])
    expect(result!.outboundHosts).toEqual(['httpbin.org'])
    expect(result!.persistencePaths).toContain('.github/workflows/deploy.yml')
  })

  it('raises confidence only when several indicators corroborate', () => {
    const result = detectSupplyChain(scenario())
    expect(result!.signals.length).toBeGreaterThanOrEqual(4)
    expect(result!.confidence).toBe('high')
  })

  it('returns null for an install with no suspicious follow-on activity', () => {
    // A plain dependency install is ordinary developer activity, not an incident.
    const events = scenario().filter(
      (event) =>
        event.event_type === 'process_start' && !event.parent_process_id,
    )
    expect(detectSupplyChain(events)).toBeNull()
  })

  it('does not fire on a single indicator', () => {
    const events = scenario().filter(
      (event) => event.event_type === 'file_read',
    )
    expect(detectSupplyChain(events)).toBeNull()
  })

  it('ignores activity from processes outside the install tree', () => {
    const events = scenario()
    // Re-attribute the credential read and network call to an unrelated process.
    for (const event of events) {
      if (
        event.event_type === 'file_read' ||
        event.event_type === 'network_out'
      ) {
        event.process_id = '9999'
        event.parent_process_id = null
      }
    }
    const result = detectSupplyChain(events)
    expect(result?.secretsAccessed ?? []).toEqual([])
    expect(result?.outboundHosts ?? []).toEqual([])
  })

  it('cites only real event ids', () => {
    const events = scenario()
    const known = new Set(events.map((event) => event.id))
    for (const id of detectSupplyChain(events)!.eventIds) {
      expect(known.has(id)).toBe(true)
    }
  })
})

describe('supply-chain finding in the pipeline', () => {
  it('is an INFERENCE that still requires human confirmation', () => {
    const { findings } = runPipeline(scenario())
    const finding = findings.find((f) => f.key === 'inf-supply-chain')
    expect(finding).toBeDefined()
    expect(finding!.kind).toBe('INFERENCE')
    expect(finding!.mitre_technique).toBe('T1195.002')
    // High confidence is allowed once corroborated, but never self-confirmed.
    expect(finding!.note).toMatch(/human confirmation/i)
  })

  it('names the package in the finding a reviewer reads', () => {
    const { findings } = runPipeline(scenario())
    const finding = findings.find((f) => f.key === 'inf-supply-chain')!
    expect(finding.description).toContain('unknown-analytics-helper@1.4.2')
  })

  it('disappears entirely when the indicators do', () => {
    const events = scenario().filter((e) => e.event_type === 'process_start')
    const { findings, supplyChain } = runPipeline(events)
    expect(supplyChain).toBeNull()
    expect(findings.some((f) => f.key === 'inf-supply-chain')).toBe(false)
  })
})

describe('renderSupplyChainSection', () => {
  it('lists indicators and actionable containment steps', () => {
    const markdown = renderSupplyChainSection(detectSupplyChain(scenario())!)
    expect(markdown).toContain('## Supply chain indicators')
    expect(markdown).toContain('unknown-analytics-helper@1.4.2')
    expect(markdown).toContain('/app/.env')
    expect(markdown).toMatch(/Rotate every credential/i)
    expect(markdown).toMatch(/Quarantine/i)
  })
})
