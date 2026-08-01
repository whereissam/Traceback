import { cn } from '@/lib/utils'
import { KIND_MEANING, type FindingKind } from '@/lib/traceback/types'

const KIND_STYLES: Record<FindingKind, string> = {
  FACT: 'bg-fact/15 text-fact',
  CORRELATION: 'bg-correlation/15 text-correlation',
  INFERENCE: 'bg-inference/15 text-inference',
}

/**
 * The label that carries the product's core promise: how much is this system
 * actually asserting? Hovering shows the plain-English meaning.
 */
export function KindBadge({ kind }: { kind: FindingKind }) {
  return (
    <span
      title={KIND_MEANING[kind]}
      className={cn(
        'inline-block rounded px-1.5 py-0.5 font-mono text-xs font-semibold',
        KIND_STYLES[kind],
      )}
    >
      {kind}
    </span>
  )
}
