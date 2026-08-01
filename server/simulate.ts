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
