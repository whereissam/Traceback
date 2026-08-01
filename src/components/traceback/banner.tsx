import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const TONES = {
  ok: 'border-fact/40 bg-fact/10 text-fact',
  warn: 'border-inference/40 bg-inference/10 text-inference',
  error: 'border-danger/40 bg-danger/10 text-danger',
}

export function Banner({
  tone,
  icon,
  children,
}: {
  tone: keyof typeof TONES
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'mb-6 flex items-start gap-2 rounded-lg border p-3 text-sm',
        TONES[tone],
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  )
}
