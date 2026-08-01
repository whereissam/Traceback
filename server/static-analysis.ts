/**
 * Static capability analysis of install-hook source.
 *
 * Dynamic analysis answers "what did it do?" — which is the stronger question,
 * and why the rest of this system is built around it. But it has a specific
 * blind spot: a package that detects the sandbox and stays dormant does
 * nothing, so there is nothing to observe.
 *
 * Reading the source answers a different question: "what *could* it do?"
 *
 * Neither is sufficient. The combination is what matters, and specifically one
 * cell of it:
 *
 *                              | ran it   | didn't run it
 *   ---------------------------+----------+--------------------------------
 *   capability, readable source| BLOCK    | ALLOW — reported, not escalated
 *   capability, concealed code | BLOCK    | REVIEW — dormant payload shape
 *
 * The bottom-right cell is the one dynamic analysis cannot reach: code that
 * can read credentials and phone home, did neither while watched, and is
 * written so you cannot tell why. See `capabilitiesNotExercised` for why the
 * top-right cell does *not* escalate — that was measured, not assumed.
 *
 * Static findings are deliberately weaker evidence than syscalls. A regex over
 * source cannot know whether a code path is reachable, so these are recorded as
 * *capabilities present in the artefact*, never as behaviour.
 */

export interface Capability {
  /** Stable id, used to correlate against runtime observations. */
  id:
    | 'credential_access'
    | 'network'
    | 'process_spawn'
    | 'dynamic_code'
    | 'obfuscation'
  label: string
  /** The literal source fragment that matched — evidence, not a summary. */
  matches: string[]
  /** Which file it was found in. */
  file: string
}

export interface StaticAnalysis {
  capabilities: Capability[]
  /** Files scanned, so "found nothing" is distinguishable from "read nothing". */
  filesScanned: string[]
  /** Total bytes read, for the same reason. */
  bytesScanned: number
}

interface Rule {
  id: Capability['id']
  label: string
  patterns: RegExp[]
}

const RULES: Rule[] = [
  {
    id: 'credential_access',
    label: 'Can read credentials or environment secrets',
    patterns: [
      /process\.env\b/g,
      /["'`][^"'`]*\.env(?:\.[a-z]+)?["'`]/gi,
      /["'`][^"'`]*(?:\.ssh|id_rsa|\.npmrc|\.aws\/credentials|\.git-credentials)[^"'`]*["'`]/gi,
      /\bhomedir\s*\(/g,
    ],
  },
  {
    id: 'network',
    label: 'Can make outbound network requests',
    patterns: [
      /require\(\s*["'`](?:https?|net|dgram|tls)["'`]\s*\)/g,
      /\bfetch\s*\(/g,
      /\baxios\b/g,
      /\bXMLHttpRequest\b/g,
      /https?:\/\/[^\s"'`]+/g,
    ],
  },
  {
    id: 'process_spawn',
    label: 'Can execute other programs',
    patterns: [
      /require\(\s*["'`]child_process["'`]\s*\)/g,
      /\b(?:execSync|exec|spawnSync|spawn|fork)\s*\(/g,
    ],
  },
  {
    id: 'dynamic_code',
    label: 'Can construct and run code at runtime',
    patterns: [
      /\beval\s*\(/g,
      /new\s+Function\s*\(/g,
      /Buffer\.from\s*\([^)]*["'`]base64["'`]\s*\)/g,
      /\batob\s*\(/g,
    ],
  },
]

/** A line this long is almost certainly minified or packed, not authored. */
const LONG_LINE = 2_000

function detectObfuscation(source: string, file: string): Capability | null {
  const lines = source.split('\n')
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0)
  // Long base64-ish runs are the usual carrier for a second-stage payload.
  const blobs = source.match(/["'`][A-Za-z0-9+/=]{200,}["'`]/g) ?? []

  const reasons: string[] = []
  if (longest > LONG_LINE) {
    reasons.push(`single line of ${longest} characters (minified or packed)`)
  }
  if (blobs.length > 0) {
    reasons.push(`${blobs.length} long base64-like literal(s)`)
  }
  if (lines.length <= 3 && source.length > 5_000) {
    reasons.push(`${source.length} characters across ${lines.length} line(s)`)
  }

  if (reasons.length === 0) return null
  return {
    id: 'obfuscation',
    label: 'Source is obfuscated or packed, limiting what reading it can prove',
    matches: reasons,
    file,
  }
}

/** Trims a match so evidence stays readable in a report. */
function excerpt(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat
}

export function analyseSource(sources: Record<string, string>): StaticAnalysis {
  const byCapability = new Map<Capability['id'], Capability>()
  const filesScanned: string[] = []
  let bytesScanned = 0

  for (const [file, source] of Object.entries(sources)) {
    if (!source) continue
    filesScanned.push(file)
    bytesScanned += source.length

    for (const rule of RULES) {
      const matches: string[] = []
      for (const pattern of rule.patterns) {
        for (const m of source.match(pattern) ?? []) {
          const e = excerpt(m)
          if (!matches.includes(e)) matches.push(e)
          if (matches.length >= 5) break
        }
      }
      if (matches.length === 0) continue

      const existing = byCapability.get(rule.id)
      if (existing) {
        existing.matches = [
          ...new Set([...existing.matches, ...matches]),
        ].slice(0, 5)
      } else {
        byCapability.set(rule.id, {
          id: rule.id,
          label: rule.label,
          matches,
          file,
        })
      }
    }

    const obf = detectObfuscation(source, file)
    if (obf && !byCapability.has('obfuscation'))
      byCapability.set('obfuscation', obf)
  }

  return {
    capabilities: [...byCapability.values()],
    filesScanned,
    bytesScanned,
  }
}

/**
 * The cross-check that neither analysis can do alone.
 *
 * Returns capabilities the source has but the sandbox never saw exercised —
 * but only when that gap is genuinely suspicious.
 *
 * The naive version of this rule (any unused capability escalates) was tried
 * and measured: it fires on esbuild, whose install hook legitimately carries
 * `process.env`, `require("https")` and `execSync` in order to fetch and run a
 * platform binary. Most install hooks that download anything look like that. A
 * rule that flags them all reproduces exactly the cry-wolf failure this system
 * is built to avoid, so unused capability alone is now *informational* — it is
 * reported, and it does not move the verdict.
 *
 * What does move it is unused capability **combined with a reason the source
 * could not be read honestly**: obfuscated or packed code, or code that builds
 * and runs strings at runtime. Legitimate build tooling is rarely either. That
 * combination is the recognisable shape of a payload waiting for a real host.
 */
export function capabilitiesNotExercised(
  statik: StaticAnalysis,
  observed: {
    readCredentials: boolean
    madeNetworkRequest: boolean
    spawnedProcess: boolean
  },
): Capability[] {
  const exercised: Record<Capability['id'], boolean> = {
    credential_access: observed.readCredentials,
    network: observed.madeNetworkRequest,
    process_spawn: observed.spawnedProcess,
    // These describe the artefact, not an action, so they are never "exercised".
    dynamic_code: false,
    obfuscation: false,
  }

  const concealment = statik.capabilities.some(
    (c) => c.id === 'obfuscation' || c.id === 'dynamic_code',
  )
  if (!concealment) return []

  return statik.capabilities.filter((c) => {
    // Spawning is normal for build tooling; on its own it is not interesting.
    if (c.id === 'process_spawn') return false
    if (c.id === 'obfuscation' || c.id === 'dynamic_code') return true
    return !exercised[c.id]
  })
}
