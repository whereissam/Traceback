import { describe, expect, it } from 'vitest'
import {
  buildDeterministicTimeline,
  EXFIL_WINDOW_MS,
  extractEvidence,
  renderMarkdownReport,
  runPipeline,
  sameProcessTree,
} from './pipeline'
import { buildLocalTelemetry } from './fixtures'
import type {
  Evidence,
  Finding,
  RawTelemetryEvent,
  TelemetryEvent,
} from '../src/lib/traceback/types'

/** Gives raw simulator events the database ids the pipeline expects. */
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

function scenario(): TelemetryEvent[] {
  return withIds(buildLocalTelemetry(BASE))
}

describe('extractEvidence', () => {
  it('produces one evidence statement per event', () => {
    const events = scenario()
    expect(extractEvidence(events)).toHaveLength(events.length)
  })

  it('categorises a .env read as credential, not plain file access', () => {
    const evidence = extractEvidence(scenario())
    const envRead = evidence.find((item) =>
      item.statement.includes('/app/.env'),
    )
    expect(envRead?.category).toBe('credential')
  })

  it('categorises a workflow modification as code', () => {
    const evidence = extractEvidence(scenario())
    const workflow = evidence.find((item) =>
      item.statement.includes('.github/workflows/deploy.yml'),
    )
    expect(workflow?.category).toBe('code')
  })

  it('names the acting process, not the telemetry channel', () => {
    const evidence = extractEvidence(scenario())
    const envRead = evidence.find((item) =>
      item.statement.includes('/app/.env'),
    )
    // A file_read event only carries a pid; the name is resolved from the
    // matching process_start. "file (pid 1002)" would be useless to a reader.
    expect(envRead?.statement).toContain('node postinstall.js (pid 1002)')
    expect(envRead?.statement.startsWith('file ')).toBe(false)
  })

  it('links every evidence statement back to a source event', () => {
    const events = scenario()
    const eventIds = new Set(events.map((event) => event.id))
    for (const item of extractEvidence(events)) {
      expect(item.event_ids.length).toBeGreaterThan(0)
      for (const id of item.event_ids) expect(eventIds.has(id)).toBe(true)
    }
  })
})

describe('sameProcessTree', () => {
  it('links a child process to its parent', () => {
    const events = scenario()
    const npm = events.find((e) => e.process_id === '1001')!
    const netOut = events.find((e) => e.event_type === 'network_out')!
    expect(sameProcessTree(npm, netOut, events)).toBe(true)
  })

  it('does not link unrelated process ids', () => {
    const events = scenario()
    const stranger: TelemetryEvent = {
      ...events[0],
      id: 'evt-stranger',
      process_id: '9999',
      parent_process_id: null,
    }
    const netOut = events.find((e) => e.event_type === 'network_out')!
    expect(sameProcessTree(stranger, netOut, [...events, stranger])).toBe(false)
  })
})

describe('runPipeline', () => {
  it('emits all three finding kinds for the demo scenario', () => {
    const { findings } = runPipeline(scenario())
    const kinds = new Set(findings.map((f) => f.kind))
    expect(kinds).toEqual(new Set(['FACT', 'CORRELATION', 'INFERENCE']))
  })

  it('correlates the credential read with the outbound request', () => {
    const { findings } = runPipeline(scenario())
    const correlation = findings.find((f) => f.key.startsWith('corr-exfil-'))
    expect(correlation).toBeDefined()
    expect(correlation?.kind).toBe('CORRELATION')
    // Cites both sides of the link, never just one.
    expect(correlation?.evidence_keys.length).toBe(2)
  })

  it('drops the exfiltration correlation when the gap exceeds the window', () => {
    const events = scenario()
    const netOut = events.find((e) => e.event_type === 'network_out')!
    netOut.timestamp = new Date(
      new Date(netOut.timestamp).getTime() + EXFIL_WINDOW_MS + 1_000,
    ).toISOString()

    const { findings } = runPipeline(events)
    expect(findings.some((f) => f.key.startsWith('corr-exfil-'))).toBe(false)
    // With no correlation to rest on, the inference must not appear either.
    expect(findings.some((f) => f.key === 'inf-exfil')).toBe(false)
  })

  it('does not correlate a credential read with an unrelated process tree', () => {
    const events = scenario()
    const netOut = events.find((e) => e.event_type === 'network_out')!
    netOut.process_id = '7777'
    netOut.parent_process_id = null

    const { findings } = runPipeline(events)
    expect(findings.some((f) => f.key.startsWith('corr-exfil-'))).toBe(false)
  })

  it('marks every inference as requiring human confirmation', () => {
    const { findings } = runPipeline(scenario())
    const inferences = findings.filter((f) => f.kind === 'INFERENCE')
    expect(inferences.length).toBeGreaterThan(0)
    for (const inference of inferences) {
      // Confidence may reach 'high' when many independent indicators
      // corroborate, but an inference about intent is never self-confirming:
      // it must always name what a human would check to settle it.
      expect(inference.note).toMatch(/human confirmation/i)
      expect(inference.note).toMatch(/confirm by/i)
    }
  })

  it('keeps a single-correlation inference below high confidence', () => {
    const { findings } = runPipeline(scenario())
    // Exfiltration rests on one correlation; only the multi-indicator
    // supply-chain finding earns 'high'.
    const exfil = findings.find((f) => f.key === 'inf-exfil')
    expect(exfil?.confidence).toBe('medium')
  })

  it('grounds every finding in at least one extracted evidence key', () => {
    const { evidence, findings } = runPipeline(scenario())
    const keys = new Set(evidence.map((item) => item.key))
    for (const finding of findings) {
      expect(finding.evidence_keys.length).toBeGreaterThan(0)
      for (const key of finding.evidence_keys) expect(keys.has(key)).toBe(true)
    }
  })

  it('is order-independent — shuffled input yields the same findings', () => {
    const ordered = runPipeline(scenario())
    const shuffled = runPipeline([...scenario()].reverse())
    expect(shuffled.findings.map((f) => f.key).sort()).toEqual(
      ordered.findings.map((f) => f.key).sort(),
    )
  })
})

describe('canary escalation', () => {
  /** Marks the outbound event as having carried the seeded canary. */
  function withCanary(transmitted: boolean): TelemetryEvent[] {
    const events = scenario()
    const net = events.find((e) => e.event_type === 'network_out')!
    net.raw = {
      ...net.raw,
      canary_transmitted: transmitted,
      canary_token: transmitted ? 'TRACEBACK_CANARY_test' : null,
    }
    return events
  }

  it('states transmission as FACT when the canary was observed leaving', () => {
    const { findings } = runPipeline(withCanary(true))
    const fact = findings.find((f) => f.key.startsWith('fact-canary'))
    expect(fact?.kind).toBe('FACT')
    expect(fact?.confidence).toBe('high')
    expect(fact?.description).toContain('TRACEBACK_CANARY_test')
    // A FACT is observed, so it carries no "needs confirmation" caveat.
    expect(fact?.note).toBeNull()
  })

  it('stands the weaker inference down once transmission is proven', () => {
    const { findings } = runPipeline(withCanary(true))
    expect(findings.some((f) => f.key === 'inf-exfil')).toBe(false)
  })

  it('keeps exfiltration an INFERENCE when the canary did not leave', () => {
    const { findings } = runPipeline(withCanary(false))
    expect(findings.some((f) => f.key.startsWith('fact-canary'))).toBe(false)
    const inference = findings.find((f) => f.key === 'inf-exfil')
    expect(inference?.kind).toBe('INFERENCE')
    expect(inference?.confidence).toBe('medium')
  })

  it('never claims transmission when the request failed', () => {
    const events = scenario()
    const net = events.find((e) => e.event_type === 'network_out')!
    // A failed request transmits nothing, however incriminating the payload.
    net.raw = { ...net.raw, status: 'failed', canary_transmitted: false }
    const { findings } = runPipeline(events)
    expect(findings.some((f) => f.key.startsWith('fact-canary'))).toBe(false)
  })
})

describe('buildDeterministicTimeline', () => {
  it('orders phases along the kill chain', () => {
    const { findings } = runPipeline(scenario())
    const timeline = buildDeterministicTimeline(findings)
    expect(timeline.map((entry) => entry.phase)).toEqual([
      'initial_access',
      'execution',
      'credential_access',
      'exfiltration',
      'persistence',
    ])
    expect(timeline.map((entry) => entry.order_index)).toEqual([0, 1, 2, 3, 4])
  })

  it('references only findings that exist', () => {
    const { findings } = runPipeline(scenario())
    const keys = new Set(findings.map((f) => f.key))
    for (const entry of buildDeterministicTimeline(findings)) {
      expect(entry.finding_keys.length).toBeGreaterThan(0)
      for (const key of entry.finding_keys) expect(keys.has(key)).toBe(true)
    }
  })
})

describe('renderMarkdownReport', () => {
  it('labels each claim with its kind and cites its evidence', () => {
    const evidence: Evidence[] = [
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000000',
        investigation_id: 'inv-1',
        event_ids: ['evt-2'],
        statement: 'node (pid 1002) read /app/.env.',
        timestamp: new Date(BASE).toISOString(),
        category: 'credential',
        created_at: new Date(BASE).toISOString(),
      },
    ]
    const findings: Finding[] = [
      {
        id: 'bbbbbbbb-0000-0000-0000-000000000000',
        investigation_id: 'inv-1',
        kind: 'INFERENCE',
        title: 'Possible credential exfiltration',
        description: 'Consistent with the credential leaving the host.',
        confidence: 'medium',
        mitre_technique: 'T1041',
        evidence_ids: [evidence[0].id],
        note: 'Requires human confirmation.',
        confirmed: false,
        created_at: new Date(BASE).toISOString(),
      },
    ]

    const markdown = renderMarkdownReport({
      title: 'Test investigation',
      evidence,
      findings,
      timeline: [
        {
          phase: 'exfiltration',
          title: 'Outbound request',
          description: 'One finding.',
          finding_ids: [findings[0].id],
        },
      ],
      openQuestions: ['Was the body captured?'],
      containmentSteps: ['Rotate the key.'],
    })

    expect(markdown).toContain(
      '**[INFERENCE]** Possible credential exfiltration',
    )
    expect(markdown).toContain('node (pid 1002) read /app/.env.')
    expect(markdown).toContain('Was the body captured?')
    expect(markdown).toContain('Rotate the key.')
  })
})
