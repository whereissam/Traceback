/**
 * Traceback correlation pipeline.
 *
 * Raw events -> evidence (fact only) -> findings (FACT / CORRELATION /
 * INFERENCE) -> timeline. Everything in this module is a pure function over
 * plain data so it can be unit-tested without a database or a network.
 *
 * The rule that governs this file: a statement may only escalate from FACT to
 * CORRELATION to INFERENCE by citing what it was derived from. Nothing is
 * asserted without an evidence trail.
 */

import { detectSupplyChain, renderSupplyChainSection } from './supply-chain'
import type { SupplyChainIndicators } from './supply-chain'
import type {
  Confidence,
  Evidence,
  EvidenceCategory,
  Finding,
  FindingKind,
  Phase,
  TelemetryEvent,
} from '../src/lib/traceback/types'

/** Max gap between a credential read and an outbound request to correlate them. */
export const EXFIL_WINDOW_MS = 2_000

/** Max gap between a payload executing and it modifying build/CI files. */
export const PERSISTENCE_WINDOW_MS = 30_000

const CREDENTIAL_PATH_PATTERN =
  /(^|\/)(\.env(\.|$)|\.npmrc|\.aws\/|credentials|id_rsa|\.pem$)/i

const CI_PATH_PATTERN =
  /(\.github\/workflows\/|\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/|deploy\.ya?ml$)/i

export interface EvidenceDraft {
  key: string
  statement: string
  category: EvidenceCategory
  timestamp: string
  event_ids: string[]
}

export interface FindingDraft {
  key: string
  kind: FindingKind
  title: string
  description: string
  confidence: Confidence
  mitre_technique: string | null
  evidence_keys: string[]
  note: string | null
}

export interface TimelineDraft {
  phase: Phase
  title: string
  description: string
  finding_keys: string[]
  order_index: number
}

export interface PipelineResult {
  evidence: EvidenceDraft[]
  findings: FindingDraft[]
  /** Present only when at least two supply-chain indicators corroborate. */
  supplyChain: SupplyChainIndicators | null
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ms(timestamp: string): number {
  return new Date(timestamp).getTime()
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Maps pid -> a human label, learned from `process_start` events.
 *
 * A `file_read` event carries the pid that read the file but not the name of
 * the process behind it. Without this lookup, evidence reads "file (pid 1002)
 * read /app/.env" — which names the telemetry channel, not the actor. An
 * investigator needs "node postinstall.js (pid 1002)".
 */
export function buildProcessNames(
  events: TelemetryEvent[],
): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.event_type !== 'process_start' || !event.process_id) continue
    const process = str(event.raw.process)
    const args = str(event.raw.args)
    if (!process) continue
    names.set(event.process_id, args ? `${process} ${args}` : process)
  }
  return names
}

/** A short human label for the process behind an event, e.g. `node (pid 12)`. */
function actor(event: TelemetryEvent, names: Map<string, string>): string {
  const pid = event.process_id
  const name =
    (pid ? names.get(pid) : null) ??
    str(event.raw.process) ??
    str(event.raw.args) ??
    event.source

  if (name && pid) return `${name} (pid ${pid})`
  if (name) return String(name)
  if (pid) return `pid ${pid}`
  return 'unknown process'
}

/**
 * Walks parent links to decide whether two events belong to the same process
 * tree. Events only carry a direct parent, so this reconstructs ancestry from
 * the full event set.
 */
export function sameProcessTree(
  a: TelemetryEvent,
  b: TelemetryEvent,
  events: TelemetryEvent[],
): boolean {
  if (!a.process_id || !b.process_id) return false
  if (a.process_id === b.process_id) return true
  return (
    ancestry(a.process_id, events).includes(b.process_id) ||
    ancestry(b.process_id, events).includes(a.process_id)
  )
}

function ancestry(pid: string, events: TelemetryEvent[]): string[] {
  const parentOf = new Map<string, string>()
  for (const event of events) {
    if (event.process_id && event.parent_process_id) {
      parentOf.set(event.process_id, event.parent_process_id)
    }
  }

  const chain: string[] = [pid]
  let current = pid
  // Bounded by the map size, so a malformed cycle cannot hang the pipeline.
  for (let i = 0; i < parentOf.size; i += 1) {
    const parent = parentOf.get(current)
    if (!parent || chain.includes(parent)) break
    chain.push(parent)
    current = parent
  }
  return chain
}

function isCredentialPath(path: string | null): boolean {
  return path !== null && CREDENTIAL_PATH_PATTERN.test(path)
}

function isCiPath(path: string | null): boolean {
  return path !== null && CI_PATH_PATTERN.test(path)
}

// ---------------------------------------------------------------------------
// 1. Evidence extraction — pure restatement of what the telemetry shows
// ---------------------------------------------------------------------------

export function extractEvidence(events: TelemetryEvent[]): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = []
  const names = buildProcessNames(events)

  events.forEach((event, index) => {
    const key = `ev-${index}`
    const base = { key, timestamp: event.timestamp, event_ids: [event.id] }
    const path = str(event.raw.path)

    switch (event.event_type) {
      case 'process_start': {
        // `actor` already carries the command line, so don't repeat the args.
        const parent = event.parent_process_id
        drafts.push({
          ...base,
          category: 'process',
          statement: parent
            ? `${actor(event, names)} started, spawned by pid ${parent}.`
            : `${actor(event, names)} started.`,
        })
        break
      }

      case 'file_read': {
        const preview = str(event.raw.content_preview)
        drafts.push({
          ...base,
          category: isCredentialPath(path) ? 'credential' : 'file',
          statement: `${actor(event, names)} read ${path ?? 'an unnamed file'}${
            preview ? ` (content preview: ${preview})` : ''
          }.`,
        })
        break
      }

      case 'file_write': {
        drafts.push({
          ...base,
          category: isCiPath(path) ? 'code' : 'file',
          statement: `${actor(event, names)} wrote ${path ?? 'an unnamed file'}.`,
        })
        break
      }

      case 'network_out': {
        const host =
          str(event.raw.dest_host) ?? str(event.raw.dest) ?? 'unknown host'
        const status = str(event.raw.status) ?? 'unknown status'
        const method = str(event.raw.method)
        const canary = str(event.raw.canary_token)
        drafts.push({
          ...base,
          category: canary ? 'credential' : 'network',
          statement:
            `${actor(event, names)} made an outbound ${method ? `${method} ` : ''}` +
            `request to ${host} (${status}).` +
            (canary
              ? ` The synthetic canary ${canary} was present in the transmitted payload.`
              : ''),
        })
        break
      }

      case 'git_modify': {
        const change = str(event.raw.change)
        drafts.push({
          ...base,
          category: 'code',
          statement: `${actor(event, names)} modified ${path ?? 'a tracked file'}${
            change ? `: ${change}` : ''
          }.`,
        })
        break
      }

      default: {
        drafts.push({
          ...base,
          category: 'process',
          statement: `${actor(event, names)} emitted a ${
            event.event_type ?? 'unclassified'
          } event.`,
        })
      }
    }
  })

  return drafts
}

// ---------------------------------------------------------------------------
// 2. Findings — FACT, then CORRELATION, then INFERENCE
// ---------------------------------------------------------------------------

/**
 * One FACT per piece of evidence that a reviewer would care about. Routine
 * noise stays as evidence without being promoted to a finding.
 */
function buildFacts(
  events: TelemetryEvent[],
  evidence: EvidenceDraft[],
  names: Map<string, string>,
): FindingDraft[] {
  const findings: FindingDraft[] = []

  events.forEach((event, index) => {
    const evidenceKey = evidence[index]?.key
    if (!evidenceKey) return
    const path = str(event.raw.path)

    const notable =
      event.event_type === 'process_start' ||
      event.event_type === 'network_out' ||
      event.event_type === 'git_modify' ||
      (event.event_type === 'file_read' && isCredentialPath(path)) ||
      (event.event_type === 'file_write' && isCiPath(path))

    if (!notable) return

    findings.push({
      key: `fact-${index}`,
      kind: 'FACT',
      title: factTitle(event, names),
      description: evidence[index].statement,
      confidence: 'high',
      mitre_technique: factTechnique(event),
      evidence_keys: [evidenceKey],
      note: null,
    })
  })

  return findings
}

function factTitle(event: TelemetryEvent, names: Map<string, string>): string {
  const path = str(event.raw.path)
  switch (event.event_type) {
    case 'process_start':
      return `Process started: ${names.get(event.process_id ?? '') ?? str(event.raw.process) ?? 'unknown'}`
    case 'file_read':
      return `Credential file read: ${path ?? 'unknown path'}`
    case 'file_write':
      return `Build file written: ${path ?? 'unknown path'}`
    case 'network_out':
      return `Outbound request to ${str(event.raw.dest_host) ?? 'unknown host'}`
    case 'git_modify':
      return `Workflow file modified: ${path ?? 'unknown path'}`
    default:
      return `Observed ${event.event_type ?? 'event'}`
  }
}

function factTechnique(event: TelemetryEvent): string | null {
  const path = str(event.raw.path)
  if (event.event_type === 'file_read' && isCredentialPath(path)) {
    return 'T1552.001'
  }
  if (event.event_type === 'process_start' && event.parent_process_id) {
    return 'T1059'
  }
  return null
}

/** Links facts to each other by process tree, time proximity, and user. */
function buildCorrelations(
  events: TelemetryEvent[],
  evidence: EvidenceDraft[],
  names: Map<string, string>,
): FindingDraft[] {
  const findings: FindingDraft[] = []
  const evidenceKeyFor = (index: number) => evidence[index]?.key

  const credentialReads = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event_type === 'file_read' &&
        isCredentialPath(str(event.raw.path)),
    )

  const outbound = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.event_type === 'network_out')

  const ciWrites = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        (event.event_type === 'file_write' ||
          event.event_type === 'git_modify') &&
        isCiPath(str(event.raw.path)),
    )

  // (a) Parent/child process relationships within the install.
  events.forEach((child, childIndex) => {
    if (child.event_type !== 'process_start' || !child.parent_process_id) return
    const parentIndex = events.findIndex(
      (candidate) =>
        candidate.event_type === 'process_start' &&
        candidate.process_id === child.parent_process_id,
    )
    if (parentIndex === -1) return

    const childKey = evidenceKeyFor(childIndex)
    const parentKey = evidenceKeyFor(parentIndex)
    if (!childKey || !parentKey) return

    findings.push({
      key: `corr-tree-${childIndex}`,
      kind: 'CORRELATION',
      title: 'Payload executed as a child of the package install',
      description:
        `${actor(child, names)} was spawned by ${actor(events[parentIndex], names)}, ` +
        `placing it inside the dependency-installation process tree rather than ` +
        `in a separate, developer-initiated process.`,
      confidence: 'high',
      mitre_technique: 'T1195.002',
      evidence_keys: [parentKey, childKey],
      note: null,
    })
  })

  // (b) Credential read closely followed by an outbound request, same tree.
  for (const read of credentialReads) {
    for (const net of outbound) {
      const gap = ms(net.event.timestamp) - ms(read.event.timestamp)
      if (gap < 0 || gap > EXFIL_WINDOW_MS) continue
      if (!sameProcessTree(read.event, net.event, events)) continue

      const readKey = evidenceKeyFor(read.index)
      const netKey = evidenceKeyFor(net.index)
      if (!readKey || !netKey) continue

      findings.push({
        key: `corr-exfil-${read.index}-${net.index}`,
        kind: 'CORRELATION',
        title: 'Outbound request immediately followed a credential-file read',
        description:
          `An outbound request to ${
            str(net.event.raw.dest_host) ?? 'an external host'
          } occurred ${gap}ms after ${actor(read.event, names)} read ${
            str(read.event.raw.path) ?? 'a credential file'
          }. Both events originate from the same process tree` +
          `${
            read.event.user_id && read.event.user_id === net.event.user_id
              ? ` and the same user (${read.event.user_id})`
              : ''
          }.`,
        confidence: gap <= 1_000 ? 'high' : 'medium',
        mitre_technique: null,
        evidence_keys: [readKey, netKey],
        note: null,
      })
    }
  }

  // (c) The same payload process also rewrote build/CI configuration.
  for (const write of ciWrites) {
    const origin = events
      .map((event, index) => ({ event, index }))
      .find(
        ({ event }) =>
          event.event_type === 'process_start' &&
          event.process_id === write.event.process_id,
      )
    if (!origin) continue

    const gap = ms(write.event.timestamp) - ms(origin.event.timestamp)
    if (gap < 0 || gap > PERSISTENCE_WINDOW_MS) continue

    const writeKey = evidenceKeyFor(write.index)
    const originKey = evidenceKeyFor(origin.index)
    if (!writeKey || !originKey) continue

    findings.push({
      key: `corr-persist-${write.index}`,
      kind: 'CORRELATION',
      title: 'Install-time process modified deployment configuration',
      description:
        `${actor(write.event, names)} modified ${
          str(write.event.raw.path) ?? 'a CI/CD file'
        } ${gap}ms after that same process started during dependency installation. ` +
        `Dependency installation does not normally write to deployment configuration.`,
      confidence: 'high',
      mitre_technique: null,
      evidence_keys: [originKey, writeKey],
      note: null,
    })
  }

  return findings
}

/**
 * Hypotheses. Each one names the correlations it rests on and is explicitly
 * marked as requiring human confirmation.
 */
function buildInferences(
  correlations: FindingDraft[],
  canaryFacts: FindingDraft[],
): FindingDraft[] {
  const findings: FindingDraft[] = []

  const exfilCorrelations = correlations.filter((f) =>
    f.key.startsWith('corr-exfil-'),
  )
  // If the canary was observed leaving, transmission is already a FACT. Keeping
  // a weaker "possible exfiltration" hypothesis next to the proof would only
  // muddy what the system is actually claiming.
  const transmissionProven = canaryFacts.length > 0

  if (exfilCorrelations.length > 0 && !transmissionProven) {
    findings.push({
      key: 'inf-exfil',
      kind: 'INFERENCE',
      title: 'Possible credential exfiltration',
      description:
        'A process read a credential file and then contacted an external host ' +
        'within the same second, from the same process tree. That sequence is ' +
        'consistent with the credential being transmitted off-host. The request ' +
        'body was not captured, so transmission of the secret is not directly observed.',
      confidence: 'medium',
      mitre_technique: 'T1041',
      evidence_keys: exfilCorrelations.flatMap((f) => f.evidence_keys),
      note: 'Requires human confirmation. Confirm by inspecting the outbound request body or egress proxy logs.',
    })
  }

  const persistenceCorrelations = correlations.filter((f) =>
    f.key.startsWith('corr-persist-'),
  )
  if (persistenceCorrelations.length > 0) {
    findings.push({
      key: 'inf-persistence',
      kind: 'INFERENCE',
      title: 'Possible persistence via CI/CD workflow modification',
      description:
        'The install-time process rewrote deployment configuration to add an ' +
        'outbound command. If committed and pushed, that change would execute on ' +
        'every subsequent deployment, surviving removal of the package itself.',
      confidence: 'medium',
      mitre_technique: 'T1546',
      evidence_keys: persistenceCorrelations.flatMap((f) => f.evidence_keys),
      note: 'Requires human confirmation. Confirm by diffing the workflow file against the last known-good commit.',
    })
  }

  return findings
}

/**
 * Canary escalation.
 *
 * Normally "was the secret actually sent?" is unanswerable from timing alone,
 * so exfiltration stays an INFERENCE. But the sandbox seeds a recognisable
 * synthetic token, and if that exact token appears in the transmitted payload,
 * transmission is *observed* — which makes it a FACT.
 *
 * This is the one path by which exfiltration is ever stated as fact, and it
 * requires the token to have been seen leaving, not merely read.
 */
function buildCanaryFacts(
  events: TelemetryEvent[],
  evidence: EvidenceDraft[],
  names: Map<string, string>,
): FindingDraft[] {
  const findings: FindingDraft[] = []

  events.forEach((event, index) => {
    if (event.event_type !== 'network_out') return
    if (event.raw.canary_transmitted !== true) return
    const canary = str(event.raw.canary_token)
    const evidenceKey = evidence[index]?.key
    if (!canary || !evidenceKey) return

    findings.push({
      key: `fact-canary-${index}`,
      kind: 'FACT',
      title: 'Synthetic credential was transmitted off-host',
      description:
        `The canary value ${canary}, seeded into the credential file before the ` +
        `install ran, was observed in the payload ${actor(event, names)} sent to ` +
        `${str(event.raw.dest_host) ?? 'an external host'}. Transmission is ` +
        `directly observed here, not inferred from timing.`,
      confidence: 'high',
      mitre_technique: 'T1041',
      evidence_keys: [evidenceKey],
      note: null,
    })
  })

  return findings
}

function buildSupplyChainInference(
  supplyChain: SupplyChainIndicators | null,
  evidence: EvidenceDraft[],
): FindingDraft[] {
  const findings: FindingDraft[] = []

  // Supply-chain compromise — named indicators rather than a vague hunch.
  if (supplyChain) {
    const detail = [
      supplyChain.packageName ? `Package: ${supplyChain.packageName}.` : null,
      supplyChain.installHook
        ? `Install hook: ${supplyChain.installHook}.`
        : null,
      supplyChain.secretsAccessed.length > 0
        ? `Secrets accessed: ${supplyChain.secretsAccessed.join(', ')}.`
        : null,
      supplyChain.persistencePaths.length > 0
        ? `Persistence: ${supplyChain.persistencePaths.join(', ')}.`
        : null,
    ]
      .filter(Boolean)
      .join(' ')

    findings.push({
      key: 'inf-supply-chain',
      kind: 'INFERENCE',
      title: 'Possible supply-chain compromise via malicious dependency',
      description:
        `${supplyChain.signals.length} independent indicators fired during a single ` +
        `dependency installation: ${supplyChain.signals.join('; ').toLowerCase()}. ` +
        `Individually each is ordinary developer activity; together they match the ` +
        `shape of a package whose install hook is intentionally malicious. ${detail}`,
      confidence: supplyChain.confidence,
      mitre_technique: 'T1195.002',
      // Cite every piece of evidence drawn from the events that triggered it.
      evidence_keys: evidence
        .filter((item) =>
          item.event_ids.some((id) => supplyChain.eventIds.includes(id)),
        )
        .map((item) => item.key),
      note: 'Requires human confirmation. Confirm by auditing the package tarball and its registry publication history.',
    })
  }

  return findings
}

/** Runs the full pipeline over a set of raw events. */
export function runPipeline(events: TelemetryEvent[]): PipelineResult {
  const ordered = [...events].sort((a, b) => ms(a.timestamp) - ms(b.timestamp))

  const names = buildProcessNames(ordered)
  const evidence = extractEvidence(ordered)
  const facts = buildFacts(ordered, evidence, names)
  const correlations = buildCorrelations(ordered, evidence, names)
  const supplyChain = detectSupplyChain(ordered)
  const canaryFacts = buildCanaryFacts(ordered, evidence, names)
  const inferences = buildInferences(correlations, canaryFacts)
  const supplyChainInference = buildSupplyChainInference(supplyChain, evidence)

  return {
    evidence,
    findings: [
      ...facts,
      ...canaryFacts,
      ...correlations,
      ...inferences,
      ...supplyChainInference,
    ],
    supplyChain,
  }
}

// ---------------------------------------------------------------------------
// 3. Deterministic timeline — the fallback when no LLM is configured, and the
//    baseline the LLM output is validated against.
// ---------------------------------------------------------------------------

const PHASE_ORDER: Phase[] = [
  'initial_access',
  'execution',
  'credential_access',
  'exfiltration',
  'persistence',
]

const PHASE_TITLES: Record<Phase, string> = {
  initial_access: 'Malicious dependency installed',
  execution: 'Install hook executed a payload process',
  credential_access: 'Credential file read by the payload',
  exfiltration: 'Outbound request following credential access',
  persistence: 'Deployment workflow modified',
}

/** Assigns each finding to the phase its underlying behaviour belongs to. */
function phaseForFinding(finding: FindingDraft): Phase | null {
  if (
    finding.key.startsWith('corr-tree-') ||
    finding.key === 'inf-supply-chain'
  ) {
    return 'initial_access'
  }
  if (finding.key.startsWith('corr-exfil-') || finding.key === 'inf-exfil') {
    return 'exfiltration'
  }
  if (
    finding.key.startsWith('corr-persist-') ||
    finding.key === 'inf-persistence'
  ) {
    return 'persistence'
  }
  if (finding.mitre_technique === 'T1552.001') return 'credential_access'
  if (finding.mitre_technique === 'T1059') return 'execution'
  if (finding.title.startsWith('Outbound request to')) return 'exfiltration'
  if (finding.title.startsWith('Workflow file modified')) return 'persistence'
  if (finding.title.startsWith('Build file written')) return 'persistence'
  if (finding.title.startsWith('Process started')) return 'initial_access'
  return null
}

export function buildDeterministicTimeline(
  findings: FindingDraft[],
): TimelineDraft[] {
  const byPhase = new Map<Phase, string[]>()
  for (const finding of findings) {
    const phase = phaseForFinding(finding)
    if (!phase) continue
    const bucket = byPhase.get(phase) ?? []
    bucket.push(finding.key)
    byPhase.set(phase, bucket)
  }

  return PHASE_ORDER.filter(
    (phase) => (byPhase.get(phase) ?? []).length > 0,
  ).map((phase, order_index) => {
    const keys = byPhase.get(phase) ?? []
    const kinds = new Set(
      keys
        .map((key) => findings.find((f) => f.key === key)?.kind)
        .filter(Boolean),
    )
    return {
      phase,
      title: PHASE_TITLES[phase],
      description: `${keys.length} finding${keys.length === 1 ? '' : 's'} in this phase (${[
        ...kinds,
      ].join(', ')}).`,
      finding_keys: keys,
      order_index,
    }
  })
}

// ---------------------------------------------------------------------------
// 4. Markdown report — deterministic rendering of whatever survived the pipeline
// ---------------------------------------------------------------------------

export function renderMarkdownReport(input: {
  title: string
  supplyChain?: SupplyChainIndicators | null
  verdictSection?: string
  evidence: Evidence[]
  findings: Finding[]
  timeline: Array<{
    phase: string | null
    title: string | null
    description: string | null
    finding_ids: string[]
  }>
  openQuestions: string[]
  containmentSteps: string[]
}): string {
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]))
  const findingById = new Map(input.findings.map((f) => [f.id, f]))
  const lines: string[] = []

  lines.push(`# Investigation report — ${input.title}`, '')
  lines.push(
    '> Every claim below is labelled **FACT**, **CORRELATION**, or **INFERENCE**.',
    '> INFERENCE items are hypotheses and must be confirmed by a human investigator.',
    '',
  )

  if (input.verdictSection) lines.push(input.verdictSection)

  if (input.supplyChain) {
    lines.push(renderSupplyChainSection(input.supplyChain))
  }

  lines.push('## Attack timeline', '')
  for (const entry of input.timeline) {
    lines.push(`### ${entry.phase ?? 'unphased'} — ${entry.title ?? ''}`)
    if (entry.description) lines.push('', entry.description)
    lines.push('')
    for (const findingId of entry.finding_ids) {
      const finding = findingById.get(findingId)
      if (!finding) continue
      lines.push(
        `- **[${finding.kind}]** ${finding.title} _(confidence: ${finding.confidence ?? 'n/a'}${
          finding.mitre_technique ? `, ${finding.mitre_technique}` : ''
        })_`,
      )
      if (finding.description) lines.push(`  - ${finding.description}`)
      for (const evidenceId of finding.evidence_ids) {
        const item = evidenceById.get(evidenceId)
        if (!item) continue
        lines.push(`  - evidence \`${item.id.slice(0, 8)}\`: ${item.statement}`)
      }
      if (finding.note) lines.push(`  - ⚠︎ ${finding.note}`)
    }
    lines.push('')
  }

  lines.push('## Open questions', '')
  if (input.openQuestions.length === 0) lines.push('- None recorded.')
  for (const question of input.openQuestions) lines.push(`- ${question}`)
  lines.push('')

  lines.push('## Recommended containment', '')
  if (input.containmentSteps.length === 0) lines.push('- None recorded.')
  for (const step of input.containmentSteps) lines.push(`- ${step}`)
  lines.push('')

  lines.push('## Evidence index', '')
  for (const item of input.evidence) {
    lines.push(
      `- \`${item.id.slice(0, 8)}\` (${item.category ?? 'uncategorised'}, ${
        item.timestamp ?? 'no timestamp'
      }) — ${item.statement}`,
    )
  }
  lines.push('')

  return lines.join('\n')
}

export const DEFAULT_OPEN_QUESTIONS = [
  'Was the credential value actually present in the outbound request body? The body was not captured.',
  'Was the modified workflow file committed and pushed, or only written to the working tree?',
  'Did the same package version reach any other host or CI runner?',
  'Is the synthetic API key the only credential the process could reach?',
]

export const DEFAULT_CONTAINMENT_STEPS = [
  'Rotate every credential reachable from the affected working directory.',
  'Pin or remove the suspect dependency and audit the lockfile for the same version elsewhere.',
  'Revert the deployment workflow to the last reviewed commit and require review on workflow changes.',
  'Block egress to the destination host at the network boundary pending review.',
  'Preserve the raw event log and container image for follow-up analysis.',
]
