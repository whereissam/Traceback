import { useState } from 'react'
import { CheckCircle2, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { KindBadge } from '@/components/traceback/kind-badge'
import { confirmFinding } from '@/lib/traceback/api'
import type { Evidence, Finding } from '@/lib/traceback/types'

/**
 * A single claim, with the evidence it rests on listed underneath. An
 * INFERENCE additionally carries the human sign-off control — the system never
 * marks its own hypotheses as confirmed.
 */
export function FindingCard({
  finding,
  evidenceById,
  onConfirmed,
}: {
  finding: Finding
  evidenceById: Map<string, Evidence>
  onConfirmed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await confirmFinding(finding.id, !finding.confirmed)
      onConfirmed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'border-border bg-card rounded-lg border p-3',
        finding.kind === 'INFERENCE' && 'border-inference/50 bg-inference/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={finding.kind} />
        <span className="font-medium">{finding.title}</span>
        {finding.confidence && (
          <span className="text-muted-foreground text-xs">
            confidence: {finding.confidence}
          </span>
        )}
        {finding.mitre_technique && (
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
            {finding.mitre_technique}
          </span>
        )}
      </div>

      {finding.description && (
        <p className="text-muted-foreground mt-2 text-sm">
          {finding.description}
        </p>
      )}

      {finding.evidence_ids.length > 0 && (
        <ul className="mt-3 space-y-1">
          {finding.evidence_ids.map((id) => {
            const item = evidenceById.get(id)
            if (!item) return null
            return (
              <li
                key={id}
                className="text-muted-foreground flex items-start gap-1.5 text-xs"
              >
                <Link2 className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  <code className="text-foreground">{id.slice(0, 8)}</code>{' '}
                  {item.statement}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {finding.kind === 'INFERENCE' && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-dashed pt-3">
          <span className="text-inference text-xs">
            ⚠︎ {finding.note ?? 'Requires human confirmation.'}
          </span>
          <Button
            size="sm"
            variant={finding.confirmed ? 'secondary' : 'outline'}
            onClick={onConfirm}
            disabled={busy}
            className="ml-auto"
          >
            {busy ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 h-3 w-3" />
            )}
            {finding.confirmed ? 'Confirmed by analyst' : 'Confirm finding'}
          </Button>
        </div>
      )}

      {error && <p className="text-danger mt-2 text-xs">{error}</p>}
    </div>
  )
}
