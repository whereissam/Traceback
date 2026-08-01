/**
 * Supply-chain compromise detection.
 *
 * This is not a second detection engine bolted onto the side — it reads the
 * same normalised events as the rest of the pipeline and emits an ordinary
 * INFERENCE finding. What it adds is *named indicators*: which package, which
 * install hook, which secret, which persistence path. A reviewer should be able
 * to act on the finding without opening the raw telemetry.
 *
 * Confidence scales with how many independent indicators corroborate, because
 * one signal in isolation is ordinary developer activity. A `postinstall` hook
 * is normal. A `postinstall` hook that reads a credential and then rewrites a
 * deployment workflow is not.
 */

import type { TelemetryEvent } from '../src/lib/traceback/types'
import type { Confidence } from '../src/lib/traceback/types'

/** Package managers whose install step runs arbitrary lifecycle scripts. */
const INSTALL_COMMAND =
  /\b(npm|yarn|pnpm|bun)\b.*\b(install|add|ci)\b|\bpip install\b|\bgem install\b/i

/** Lifecycle hooks that execute during installation, without user action. */
const INSTALL_HOOK = /\b(pre|post)?install(\.js|\.sh|\.py)?\b|prepare\.js/i

const CREDENTIAL_PATH =
  /(^|\/)(\.env(\.|$)|\.npmrc|\.aws\/|credentials|id_rsa|\.pem$|config\.json$)/i

/** Files that, once changed, keep executing after the package is removed. */
const PERSISTENCE_PATH =
  /(\.github\/workflows\/|\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/|deploy\.ya?ml$|Dockerfile|package\.json$)/i

export interface SupplyChainIndicators {
  /** e.g. "unknown-analytics-helper@1.4.2" — null when not recoverable. */
  packageName: string | null
  /** e.g. "npm install unknown-analytics-helper@1.4.2" */
  installCommand: string | null
  /** e.g. "node postinstall.js" */
  installHook: string | null
  secretsAccessed: string[]
  outboundHosts: string[]
  persistencePaths: string[]
  /** Human-readable list of which indicators fired. */
  signals: string[]
  /** Event ids backing the whole picture. */
  eventIds: string[]
  confidence: Confidence
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

/**
 * Returns indicators when the install's follow-on behaviour is genuinely
 * suspicious, otherwise null. See the threshold comment below for the rule.
 */
export function detectSupplyChain(
  events: TelemetryEvent[],
): SupplyChainIndicators | null {
  /**
   * Context signals establish *that a dependency was installed*. On their own
   * they are meaningless — `npm install` running a `postinstall` hook is how
   * half the ecosystem works. They never trigger a finding; they only tell us
   * where to attribute the risk signals below.
   */
  const contextSignals: string[] = []
  /** Risk signals are the behaviours that make an install worth investigating. */
  const riskSignals: string[] = []
  const eventIds: string[] = []

  // --- 1. An install command ran ------------------------------------------
  const install = events.find(
    (event) =>
      event.event_type === 'process_start' &&
      INSTALL_COMMAND.test(
        `${str(event.raw.process) ?? ''} ${str(event.raw.args) ?? ''}`,
      ),
  )

  let installCommand: string | null = null
  let packageName: string | null = null

  if (install) {
    const process = str(install.raw.process) ?? ''
    const args = str(install.raw.args) ?? ''
    installCommand = `${process} ${args}`.trim()
    // Last token of the install args is conventionally the package spec.
    packageName =
      args
        .split(/\s+/)
        .filter((token) => token && !token.startsWith('-'))
        .filter((token) => !/^(install|add|ci)$/i.test(token))
        .pop() ?? null
    contextSignals.push('Dependency installation observed')
    eventIds.push(install.id)
  }

  // --- 2. An install lifecycle hook executed ------------------------------
  // Only counts as a supply-chain signal if it descends from the install.
  const hook = events.find(
    (event) =>
      event.event_type === 'process_start' &&
      INSTALL_HOOK.test(str(event.raw.args) ?? '') &&
      (!install || event.parent_process_id === install.process_id),
  )

  let installHook: string | null = null
  if (hook) {
    installHook =
      `${str(hook.raw.process) ?? ''} ${str(hook.raw.args) ?? ''}`.trim()
    contextSignals.push('Install lifecycle hook executed a payload process')
    eventIds.push(hook.id)
  }

  // Everything below is attributed to the hook's process when we found one, so
  // unrelated activity elsewhere on the host is not swept in.
  const attributed = (event: TelemetryEvent) =>
    !hook || event.process_id === hook.process_id

  // --- 3. Credentials read by that process --------------------------------
  const credentialReads = events.filter(
    (event) =>
      event.event_type === 'file_read' &&
      CREDENTIAL_PATH.test(str(event.raw.path) ?? '') &&
      attributed(event),
  )
  const secretsAccessed = uniq(
    credentialReads.map((event) => str(event.raw.path) ?? ''),
  )
  if (secretsAccessed.length > 0) {
    riskSignals.push('Credential file read during installation')
    eventIds.push(...credentialReads.map((event) => event.id))
  }

  // --- 4. Outbound network from that process ------------------------------
  const outbound = events.filter(
    (event) => event.event_type === 'network_out' && attributed(event),
  )
  const outboundHosts = uniq(
    outbound.map(
      (event) => str(event.raw.dest_host) ?? str(event.raw.dest) ?? '',
    ),
  )
  if (outboundHosts.length > 0) {
    riskSignals.push('Outbound network request from the install process')
    eventIds.push(...outbound.map((event) => event.id))
  }

  // --- 5. Build / CI / deployment files modified --------------------------
  const persistence = events.filter(
    (event) =>
      (event.event_type === 'file_write' ||
        event.event_type === 'git_modify') &&
      PERSISTENCE_PATH.test(str(event.raw.path) ?? '') &&
      attributed(event),
  )
  const persistencePaths = uniq(
    persistence.map((event) => str(event.raw.path) ?? ''),
  )
  if (persistencePaths.length > 0) {
    riskSignals.push('Build or deployment configuration modified')
    eventIds.push(...persistence.map((event) => event.id))
  }

  // Threshold. An install plus a lifecycle hook is ordinary — it must not
  // fire on every benign `npm install`. Require either two independent risk
  // behaviours, or one risk behaviour attributable to an install hook.
  const fires =
    riskSignals.length >= 2 || (Boolean(hook) && riskSignals.length >= 1)
  if (!fires) return null

  const signals = [...contextSignals, ...riskSignals]

  return {
    packageName,
    installCommand,
    installHook,
    secretsAccessed,
    outboundHosts,
    persistencePaths,
    signals,
    eventIds: uniq(eventIds),
    // Corroboration raises confidence; it never removes the need for a human
    // to confirm. Two risk behaviours could still be an unusual build tool.
    confidence:
      hook && riskSignals.length >= 3
        ? 'high'
        : riskSignals.length >= 2
          ? 'medium'
          : 'low',
  }
}

/** The "Supply chain indicators" block appended to the markdown report. */
export function renderSupplyChainSection(
  indicators: SupplyChainIndicators,
): string {
  const lines: string[] = ['## Supply chain indicators', '']

  lines.push(`- **Package:** ${indicators.packageName ?? 'not recoverable'}`)
  lines.push(
    `- **Install command:** ${indicators.installCommand ?? 'not observed'}`,
  )
  lines.push(`- **Install hook:** ${indicators.installHook ?? 'not observed'}`)
  lines.push(
    `- **Secrets accessed:** ${
      indicators.secretsAccessed.join(', ') || 'none observed'
    }`,
  )
  lines.push(
    `- **Outbound hosts:** ${
      indicators.outboundHosts.join(', ') || 'none observed'
    }`,
  )
  lines.push(
    `- **Persistence:** ${
      indicators.persistencePaths.join(', ') || 'none observed'
    }`,
  )
  lines.push(
    `- **Confidence:** ${indicators.confidence} (${indicators.signals.length} independent indicators)`,
  )
  lines.push('')

  lines.push('**Indicators that fired:**', '')
  for (const signal of indicators.signals) lines.push(`- ${signal}`)
  lines.push('')

  lines.push('**Recommended action:**', '')
  lines.push(
    `1. Quarantine ${indicators.packageName ?? 'the suspect package'} and pin the last known-good version.`,
  )
  if (indicators.secretsAccessed.length > 0) {
    lines.push(
      `2. Rotate every credential in ${indicators.secretsAccessed.join(', ')}.`,
    )
  } else {
    lines.push('2. Rotate credentials reachable from the build environment.')
  }
  if (indicators.persistencePaths.length > 0) {
    lines.push(
      `3. Diff ${indicators.persistencePaths.join(', ')} against the last reviewed commit and revert if unexpected.`,
    )
  } else {
    lines.push(
      '3. Audit recent deployments for unreviewed configuration changes.',
    )
  }
  lines.push('4. Search other lockfiles for the same package and version.')
  lines.push(
    '5. Review deployments that ran after the modification for signs of execution.',
  )
  lines.push('')

  return lines.join('\n')
}
