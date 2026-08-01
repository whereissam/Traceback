import { useCallback, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ScanSearch,
  ShieldAlert,
} from 'lucide-react'
import { Banner } from '@/components/traceback/banner'
import { Controls, type Stage } from '@/components/traceback/controls'
import { KindBadge } from '@/components/traceback/kind-badge'
import { RawEvents } from '@/components/traceback/raw-events'
import { SupplyChainBanner } from '@/components/traceback/supply-chain-banner'
import { VerdictCard } from '@/components/traceback/verdict-card'
import { ReportBlock } from '@/components/traceback/report-block'
import { Timeline } from '@/components/traceback/timeline'
import {
  fetchInvestigation,
  runInvestigation,
  runSimulation,
} from '@/lib/traceback/api'
import type { InvestigationReport } from '@/lib/traceback/types'

export function TracebackPage() {
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [telemetrySource, setTelemetrySource] = useState<string | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const [generatedBy, setGeneratedBy] = useState<string | null>(null)
  const [data, setData] = useState<InvestigationReport | null>(null)

  const load = useCallback(async (id: string) => {
    setData(await fetchInvestigation(id))
  }, [])

  const onSimulate = useCallback(async () => {
    setError(null)
    setStage('simulating')
    setData(null)
    setGeneratedBy(null)
    try {
      const result = await runSimulation()
      setTelemetrySource(result.telemetry_source)
      setFallbackReason(result.fallback_reason)
      await load(result.investigation.id)
      setStage('raw')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStage('idle')
    }
  }, [load])

  const onInvestigate = useCallback(async () => {
    if (!data) return
    setError(null)
    setStage('analysing')
    try {
      const result = await runInvestigation(data.investigation.id)
      setGeneratedBy(result.generated_by)
      await load(data.investigation.id)
      setStage('done')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStage('raw')
    }
  }, [data, load])

  return (
    <main className="bg-background min-h-screen">
      <div className="container mx-auto max-w-5xl px-4 py-10">
        <header className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <div className="bg-primary/10 rounded-lg p-2">
              <ScanSearch className="text-primary h-6 w-6" />
            </div>
            <h1 className="text-foreground text-3xl font-bold tracking-tight">
              Traceback
            </h1>
          </div>
          <p className="text-muted-foreground max-w-2xl text-lg">
            Security teams do not lack alerts; they lack a trustworthy
            explanation of what happened. Traceback correlates fragmented
            telemetry into an evidence-backed incident timeline — and labels
            every claim <KindBadge kind="FACT" />,{' '}
            <KindBadge kind="CORRELATION" />
            , or <KindBadge kind="INFERENCE" /> so a human confirms findings
            instead of reconstructing the story from scratch.
          </p>
        </header>

        <Controls
          stage={stage}
          hasEvents={(data?.events.length ?? 0) > 0}
          onSimulate={onSimulate}
          onInvestigate={onInvestigate}
        />

        {error && (
          <Banner tone="error" icon={<ShieldAlert className="h-4 w-4" />}>
            {error}
          </Banner>
        )}

        {telemetrySource === 'local-fallback' && fallbackReason && (
          <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
            <span className="font-medium">
              Telemetry came from the local fallback, not the Modal sandbox.
            </span>{' '}
            {fallbackReason}
          </Banner>
        )}

        {telemetrySource === 'modal' && (
          <Banner tone="ok" icon={<CheckCircle2 className="h-4 w-4" />}>
            Telemetry captured from a live Modal sandbox run.
          </Banner>
        )}

        {data && (
          <>
            <RawEvents events={data.events} />
            {data.verdict && <VerdictCard result={data.verdict} />}
            {data.timeline.length > 0 && (
              <SupplyChainBanner findings={data.findings} />
            )}
            {data.timeline.length > 0 && (
              <Timeline
                data={data}
                generatedBy={generatedBy ?? data.report?.generated_by ?? null}
                onConfirmed={() => load(data.investigation.id)}
              />
            )}
            {data.report && <ReportBlock report={data.report} />}
          </>
        )}
      </div>
    </main>
  )
}
