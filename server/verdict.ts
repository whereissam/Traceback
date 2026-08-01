/**
 * Risk policy — turns findings into a decision a developer can act on.
 *
 * The verdict is deliberately rule-based, not model-generated. A developer
 * deciding whether to let third-party code run on their machine should be able
 * to read the rule that produced the answer, and get the same answer twice.
 *
 * It also never collapses the epistemic distinction the rest of the pipeline
 * maintains: the result separates what was *observed* from what is *suspected*,
 * so "BLOCK" never implies more certainty than the evidence supports.
 */

import type { Finding } from '../src/lib/traceback/types'
import type { SupplyChainIndicators } from './supply-chain'
import type { Capability } from './static-analysis'

export type Verdict = 'allow' | 'review' | 'block'

export interface VerdictReason {
  /** The policy rule that fired, in plain language. */
  rule: string
  /** What in the telemetry triggered it. */
  detail: string
  /** How strongly it is established — mirrors the finding it came from. */
  basis: 'FACT' | 'CORRELATION' | 'INFERENCE'
}

export interface VerdictResult {
  verdict: Verdict
  risk: 'high' | 'medium' | 'low'
  reasons: VerdictReason[]
  /** Directly observed in telemetry. */
  confirmed: string[]
  /** Suspected but not established — the honest gaps. */
  unconfirmed: string[]
  /** One-line summary suitable for a UI card. */
  summary: string
}

const SENSITIVE_CREDENTIAL =
  /(\.ssh|id_rsa|\.aws\/|credentials|\.npmrc|gcloud)/i

export function computeVerdict(
  findings: Finding[],
  supplyChain: SupplyChainIndicators | null,
  /**
   * Capabilities the source clearly has but the sandbox never saw used. Absent
   * when no static analysis ran (the fixture path), which is why it defaults
   * to empty rather than being required.
   */
  dormantCapabilities: Capability[] = [],
): VerdictResult {
  const reasons: VerdictReason[] = []
  const confirmed: string[] = []
  const unconfirmed: string[] = []

  const has = (predicate: (f: Finding) => boolean) => findings.some(predicate)

  // --- BLOCK conditions ----------------------------------------------------

  // Strongest signal: the seeded canary was observed leaving the sandbox.
  const transmission = findings.find(
    (f) => f.kind === 'FACT' && /transmitted off-host/i.test(f.title ?? ''),
  )
  if (transmission) {
    reasons.push({
      rule: 'Synthetic credential was transmitted externally',
      detail: transmission.description ?? '',
      basis: 'FACT',
    })
    confirmed.push(
      'The seeded canary value appeared in the payload sent to an external host.',
    )
  }

  // High-value credentials are a different class from a project-local .env.
  const sensitiveRead = (supplyChain?.secretsAccessed ?? []).filter((path) =>
    SENSITIVE_CREDENTIAL.test(path),
  )
  if (sensitiveRead.length > 0) {
    reasons.push({
      rule: 'SSH or cloud credentials accessed',
      detail: `Read ${sensitiveRead.join(', ')} during installation.`,
      basis: 'FACT',
    })
    confirmed.push(`Credential files read: ${sensitiveRead.join(', ')}.`)
  }

  // Credential read followed by outbound traffic in the same process tree.
  const exfilCorrelation = findings.find(
    (f) =>
      f.kind === 'CORRELATION' && /credential-file read/i.test(f.title ?? ''),
  )
  if (exfilCorrelation) {
    reasons.push({
      rule: 'Credential read followed by an outbound connection',
      detail: exfilCorrelation.description ?? '',
      basis: 'CORRELATION',
    })
    confirmed.push(
      'A credential file was read and an outbound request followed from the same process tree.',
    )
    if (!transmission) {
      unconfirmed.push(
        'Whether the credential was actually included in the outbound payload — the request body was not captured.',
      )
    }
  }

  // Persistence: changes that outlive removal of the package.
  const persistence = (supplyChain?.persistencePaths ?? []).length > 0
  if (persistence) {
    reasons.push({
      rule: 'Deployment or build configuration modified by a lifecycle script',
      detail: `Modified ${supplyChain!.persistencePaths.join(', ')}.`,
      basis: 'FACT',
    })
    confirmed.push(
      `Build/deploy files written: ${supplyChain!.persistencePaths.join(', ')}.`,
    )
    unconfirmed.push(
      'Whether those changes were committed, pushed, or executed by a later deployment.',
    )
  }

  if (reasons.length > 0) {
    // Any of the above is enough to keep the script off a real machine.
    const summary = transmission
      ? 'A synthetic credential was read and observed leaving the sandbox.'
      : 'The install hook accessed sensitive files or altered deployment configuration.'
    return {
      verdict: 'block',
      risk: 'high',
      reasons,
      confirmed,
      unconfirmed,
      summary,
    }
  }

  // --- REVIEW conditions ---------------------------------------------------

  const outbound = (supplyChain?.outboundHosts ?? []).length > 0
  const anyCredentialRead = (supplyChain?.secretsAccessed ?? []).length > 0

  if (outbound) {
    reasons.push({
      rule: 'Outbound connection from an install script',
      detail: `Contacted ${supplyChain!.outboundHosts.join(', ')} during installation.`,
      basis: 'FACT',
    })
    confirmed.push(
      `Outbound hosts contacted: ${supplyChain!.outboundHosts.join(', ')}.`,
    )
    unconfirmed.push('Whether that destination is legitimate for this package.')
  }
  if (anyCredentialRead) {
    reasons.push({
      rule: 'Sensitive file read during installation',
      detail: `Read ${supplyChain!.secretsAccessed.join(', ')}.`,
      basis: 'FACT',
    })
    confirmed.push(`Files read: ${supplyChain!.secretsAccessed.join(', ')}.`)
  }
  // Dynamic analysis alone cannot distinguish "harmless" from "waited us out".
  // Reading the source can: if the code carries a capability it never used
  // while observed, that is worth a human look even though nothing happened.
  if (dormantCapabilities.length > 0) {
    for (const capability of dormantCapabilities) {
      reasons.push({
        rule: `Capability present in source but not exercised: ${capability.label.toLowerCase()}`,
        detail: `${capability.file} contains ${capability.matches.slice(0, 3).join(', ')} — none of it ran during the sandbox execution.`,
        // A regex over source proves the code exists, not that it would run.
        basis: 'INFERENCE',
      })
    }
    unconfirmed.push(
      'Whether the unused capabilities are dead code, conditional on an environment we did not reproduce, or deliberately dormant while observed.',
    )
  }

  if (has((f) => f.kind === 'INFERENCE')) {
    const inference = findings.find((f) => f.kind === 'INFERENCE')!
    reasons.push({
      rule: 'Unresolved hypothesis about install behaviour',
      detail: inference.title ?? '',
      basis: 'INFERENCE',
    })
    unconfirmed.push(inference.title ?? 'An inference remains unconfirmed.')
  }

  if (reasons.length > 0) {
    return {
      verdict: 'review',
      risk: 'medium',
      reasons,
      confirmed,
      unconfirmed,
      summary:
        dormantCapabilities.length > 0
          ? 'The install script carries capabilities it did not use while observed. Nothing malicious happened, and that is not the same as nothing being there.'
          : 'The install script did something worth a human look, but nothing that clearly warrants blocking.',
    }
  }

  // --- ALLOW ---------------------------------------------------------------

  return {
    verdict: 'allow',
    risk: 'low',
    reasons: [],
    confirmed: [
      'No sensitive file access observed.',
      'No outbound network connection observed.',
      'No build or deployment configuration modified.',
      'The install-hook source declares no unused credential or network capability.',
    ],
    unconfirmed: [
      'Only the behaviour exercised during this sandbox run was observed. A script can behave differently under other conditions.',
      'Static analysis reads the shipped source. Code fetched at runtime cannot be assessed this way.',
    ],
    summary: 'No risky behaviour observed during sandboxed installation.',
  }
}

/** The verdict block appended to the markdown report. */
export function renderVerdictSection(result: VerdictResult): string {
  const lines: string[] = ['## Verdict', '']
  lines.push(
    `**${result.verdict.toUpperCase()}** — ${result.risk} risk. ${result.summary}`,
    '',
  )

  if (result.reasons.length > 0) {
    lines.push('**Why:**', '')
    for (const reason of result.reasons) {
      lines.push(`- [${reason.basis}] ${reason.rule} — ${reason.detail}`)
    }
    lines.push('')
  }

  lines.push('**Confirmed:**', '')
  for (const item of result.confirmed) lines.push(`- ${item}`)
  lines.push('')

  lines.push('**Not confirmed:**', '')
  if (result.unconfirmed.length === 0) lines.push('- Nothing outstanding.')
  for (const item of result.unconfirmed) lines.push(`- ${item}`)
  lines.push('')

  return lines.join('\n')
}
