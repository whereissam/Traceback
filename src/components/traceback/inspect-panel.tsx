import { useState } from 'react'
import { Loader2, PackageSearch, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Inspect a package that actually exists on npm.
 *
 * This is the difference between a demo and a tool: the same pipeline that
 * flags the malicious fixture also runs against `esbuild`, and has to *not*
 * flag it. Suggestions below cover the three outcomes a reviewer should see.
 */

interface Suggestion {
  name: string
  why: string
  /** Marks the controlled fixture so it is never mistaken for a real package. */
  danger?: boolean
}

const SUGGESTIONS: Suggestion[] = [
  { name: 'esbuild', why: 'real package, genuine postinstall hook → ALLOW' },
  { name: 'lodash', why: 'real package, no install scripts → nothing to run' },
  {
    name: 'unknown-analytics-helper',
    why: 'controlled fixture, deliberately malicious → BLOCK',
    danger: true,
  },
]

export function InspectPanel({
  onInspect,
  busy,
  status,
}: {
  onInspect: (name: string) => void
  busy: boolean
  status: string | null
}) {
  const [name, setName] = useState('')

  const submit = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && !busy) onInspect(trimmed)
  }

  return (
    <section className="border-border bg-card mb-6 rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <PackageSearch className="text-primary h-4 w-4 shrink-0" />
        <h2 className="font-semibold">Inspect a real npm package</h2>
        <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">
          downloaded with <code>--ignore-scripts</code>, then detonated in the
          sandbox
        </span>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit(name)
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="package name, e.g. esbuild"
          disabled={busy}
          aria-label="npm package name"
          className="font-mono"
        />
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ShieldQuestion className="mr-2 h-4 w-4" />
          )}
          Inspect
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">Try:</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.name}
            type="button"
            disabled={busy}
            onClick={() => {
              setName(s.name)
              submit(s.name)
            }}
            title={s.why}
            className={cn(
              'rounded-full border px-2.5 py-1 font-mono text-xs transition-colors',
              s.danger
                ? 'border-danger/50 text-danger hover:border-danger'
                : 'border-border hover:border-primary hover:text-primary',
              busy && 'pointer-events-none opacity-50',
            )}
          >
            {s.name}
            {s.danger && <span className="ml-1 not-italic">⚠</span>}
          </button>
        ))}
      </div>

      {status && <p className="text-muted-foreground mt-3 text-sm">{status}</p>}

      <p className="text-muted-foreground mt-3 text-xs">
        Pulls the real package from the npm registry, reads the lifecycle hooks
        out of its own <code>package.json</code>, then runs them under{' '}
        <code>strace</code>. Evidence comes from the kernel, not from the
        script's account of itself.
      </p>
    </section>
  )
}
