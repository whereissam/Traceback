/**
 * Telemetry acquisition.
 *
 * Primary path: POST to the deployed Modal endpoint, which runs the payload in
 * a sandbox and returns telemetry from real process/file/network activity.
 *
 * Fallback path: a locally generated event set with the same shape. It exists
 * so a flaky network or an undeployed Modal function does not take the demo
 * down. The source is recorded on the response and surfaced in the UI — a
 * fallback run is never presented as though it came from the sandbox.
 */

import { env } from './env'
import { buildLocalTelemetry } from './fixtures'
import type { RawTelemetryEvent } from '../src/lib/traceback/types'

export type TelemetrySource = 'modal' | 'local-fallback'

export interface SimulationResult {
  events: RawTelemetryEvent[]
  source: TelemetrySource
  /** Populated when the Modal call was attempted and failed. */
  fallbackReason?: string
}

function isRawEvent(value: unknown): value is RawTelemetryEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.timestamp === 'string' &&
    typeof candidate.event_type === 'string' &&
    typeof candidate.raw === 'object' &&
    candidate.raw !== null
  )
}

export async function runSimulation(): Promise<SimulationResult> {
  if (!env.modalSimulateUrl || !env.modalSimulateToken) {
    return {
      events: buildLocalTelemetry(),
      source: 'local-fallback',
      fallbackReason:
        'MODAL_SIMULATE_URL or MODAL_SIMULATE_TOKEN is not set. Deploy modal/modal_sim.py and set both to capture real sandbox telemetry.',
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)

    const response = await fetch(env.modalSimulateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: env.modalSimulateToken }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`Modal returned HTTP ${response.status}`)
    }

    const payload = (await response.json()) as {
      events?: unknown
      error?: string
    }
    if (payload.error) throw new Error(`Modal returned error: ${payload.error}`)

    const events = Array.isArray(payload.events)
      ? payload.events.filter(isRawEvent)
      : []
    if (events.length === 0) {
      throw new Error('Modal returned no usable events')
    }

    return { events, source: 'modal' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(
      '[traceback] Modal simulation failed, using local fallback:',
      reason,
    )
    return {
      events: buildLocalTelemetry(),
      source: 'local-fallback',
      fallbackReason: reason,
    }
  }
}

/** Result of inspecting a real package pulled from the npm registry. */
export interface InspectionResult {
  package: string
  version: string | null
  lifecycleScripts: Record<string, string>
  /** Source of each lifecycle script, for static capability analysis. */
  hookSources: Record<string, string>
  events: RawTelemetryEvent[]
  note: string | null
  error: string | null
}

/**
 * Inspects a real npm package: downloads it with scripts disabled, reads its
 * declared lifecycle hooks, then detonates them under `strace` in the sandbox.
 *
 * Unlike `runSimulation`, there is no local fallback — a fabricated result for
 * a named third-party package would be a lie, so an unreachable sandbox is
 * reported as an error instead.
 */
export async function inspectPackage(name: string): Promise<InspectionResult> {
  const url = env.modalInspectUrl
  if (!url || !env.modalSimulateToken) {
    return {
      package: name,
      version: null,
      lifecycleScripts: {},
      hookSources: {},
      events: [],
      note: null,
      error:
        'MODAL_INSPECT_URL is not set. Deploy modal/inspect_package.py to inspect real packages.',
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: env.modalSimulateToken, package: name }),
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(`sandbox returned HTTP ${response.status}`)

    const payload = (await response.json()) as {
      package?: string
      version?: string | null
      lifecycle_scripts?: Record<string, string>
      hook_sources?: Record<string, string>
      events?: unknown
      note?: string
      error?: string
    }

    return {
      package: payload.package ?? name,
      version: payload.version ?? null,
      lifecycleScripts: payload.lifecycle_scripts ?? {},
      hookSources: payload.hook_sources ?? {},
      events: Array.isArray(payload.events)
        ? payload.events.filter(isRawEvent)
        : [],
      note: payload.note ?? null,
      error: payload.error ?? null,
    }
  } catch (error) {
    return {
      package: name,
      version: null,
      lifecycleScripts: {},
      hookSources: {},
      events: [],
      note: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}
