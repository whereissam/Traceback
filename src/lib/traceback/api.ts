/** Browser-side client for the Traceback API. */

import type {
  Finding,
  Investigation,
  InvestigationReport,
  Verdict,
} from './types'

/** Vite proxies /api to the Hono server in dev; same-origin in production. */
const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null)
    throw new Error(
      detail ?? `${init?.method ?? 'GET'} ${path} failed (${response.status})`,
    )
  }

  return (await response.json()) as T
}

export interface SimulateResponse {
  investigation: Investigation
  event_count: number
  telemetry_source: 'modal' | 'local-fallback'
  fallback_reason: string | null
}

export interface InvestigateResponse {
  investigation_id: string
  evidence_count: number
  finding_counts: { FACT: number; CORRELATION: number; INFERENCE: number }
  timeline_phases: number
  supply_chain_detected: boolean
  verdict: Verdict
  risk: 'high' | 'medium' | 'low'
  generated_by: string
}

export function runSimulation(title?: string) {
  return request<SimulateResponse>('/simulate', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export interface InspectResponse {
  investigation: Investigation
  package: string
  version: string | null
  lifecycle_scripts: Record<string, string>
  has_lifecycle_scripts: boolean
  event_count: number
  note: string | null
}

/** Inspect a real package pulled from the npm registry. */
export function inspectPackage(name: string) {
  return request<InspectResponse>('/inspect', {
    method: 'POST',
    body: JSON.stringify({ package: name }),
  })
}

export function runInvestigation(investigationId: string) {
  return request<InvestigateResponse>(`/investigate/${investigationId}`, {
    method: 'POST',
  })
}

export function fetchInvestigation(investigationId: string) {
  return request<InvestigationReport>(`/investigation/${investigationId}`)
}

export function listInvestigations() {
  return request<{ investigations: Investigation[] }>('/investigations')
}

export function confirmFinding(findingId: string, confirmed: boolean) {
  return request<{ finding: Finding }>(`/findings/${findingId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ confirmed }),
  })
}
