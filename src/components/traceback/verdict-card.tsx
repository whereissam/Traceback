import { CheckCircle2, HelpCircle, ShieldBan } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Verdict, VerdictResult } from '@/lib/traceback/types'

const STYLES: Record<
  Verdict,
  { border: string; text: string; icon: typeof ShieldBan; label: string }
> = {
  block: {
    border: 'border-danger/50 bg-danger/10',
    text: 'text-danger',
    icon: ShieldBan,
    label: 'BLOCKED',
  },
  review: {
    border: 'border-inference/50 bg-inference/10',
    text: 'text-inference',
    icon: HelpCircle,
    label: 'NEEDS REVIEW',
  },
  allow: {
    border: 'border-fact/50 bg-fact/10',
    text: 'text-fact',
    icon: CheckCircle2,
    label: 'ALLOWED',
  },
}

/**
 * The decision, with its own evidence attached.
 *
 * "Confirmed" and "Not confirmed" are shown side by side deliberately — a
 * verdict that hides what it could not establish is the failure mode this
 * whole product exists to avoid.
 */
export function VerdictCard({ result }: { result: VerdictResult }) {
  const style = STYLES[result.verdict]
  const Icon = style.icon

  return (
    <section className={cn('mb-6 rounded-xl border p-4', style.border)}>
      <div className="flex flex-wrap items-center gap-3">
        <Icon className={cn('h-6 w-6 shrink-0', style.text)} />
        <span className={cn('text-xl font-bold tracking-tight', style.text)}>
          {style.label}
        </span>
        <span className="text-muted-foreground text-sm">
          {result.risk} risk
        </span>
      </div>

      <p className="text-foreground mt-2 text-sm">{result.summary}</p>

      {result.reasons.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {result.reasons.map((reason) => (
            <li key={reason.rule} className="text-muted-foreground text-sm">
              <span
                className={cn(
                  'mr-2 rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
                  reason.basis === 'FACT' && 'bg-fact/15 text-fact',
                  reason.basis === 'CORRELATION' &&
                    'bg-correlation/15 text-correlation',
                  reason.basis === 'INFERENCE' &&
                    'bg-inference/15 text-inference',
                )}
              >
                {reason.basis}
              </span>
              {reason.rule}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-fact mb-1 text-xs font-semibold tracking-wide uppercase">
            Confirmed
          </h3>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
            {result.confirmed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-inference mb-1 text-xs font-semibold tracking-wide uppercase">
            Not confirmed
          </h3>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
            {result.unconfirmed.length === 0 && <li>Nothing outstanding.</li>}
            {result.unconfirmed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
