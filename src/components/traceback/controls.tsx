import { Loader2, Play, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Where the investigation currently is, which drives both buttons and copy. */
export type Stage = 'idle' | 'simulating' | 'raw' | 'analysing' | 'done'

const STATUS_COPY: Record<Stage, string> = {
  idle: 'Start by generating sandbox telemetry.',
  simulating: 'Executing payload in the sandbox…',
  raw: 'Raw events only. Nothing has been interpreted yet.',
  analysing: 'Correlating events and drafting the report…',
  done: 'Analysis complete. Confirm the inferences below.',
}

export function Controls({
  stage,
  hasEvents,
  onSimulate,
  onInvestigate,
}: {
  stage: Stage
  hasEvents: boolean
  onSimulate: () => void
  onInvestigate: () => void
}) {
  const busy = stage === 'simulating' || stage === 'analysing'

  return (
    <div className="border-border bg-card mb-6 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center">
      <Button onClick={onSimulate} disabled={busy} size="lg">
        {stage === 'simulating' ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-2 h-4 w-4" />
        )}
        1. Run simulation
      </Button>

      <Button
        onClick={onInvestigate}
        disabled={busy || !hasEvents}
        size="lg"
        variant="secondary"
      >
        {stage === 'analysing' ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ScanSearch className="mr-2 h-4 w-4" />
        )}
        2. Build timeline
      </Button>

      <p className="text-muted-foreground text-sm sm:ml-auto">
        {STATUS_COPY[stage]}
      </p>
    </div>
  )
}
