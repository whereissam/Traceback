import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FindingCard } from '@/components/traceback/finding-card'
import {
  PHASE_LABELS,
  type Evidence,
  type Finding,
  type InvestigationReport,
  type Phase,
} from '@/lib/traceback/types'

/** The "after" half of the demo: the same events, arranged into a story. */
export function Timeline({
  data,
  generatedBy,
  onConfirmed,
}: {
  data: InvestigationReport
  generatedBy: string | null
  onConfirmed: () => void
}) {
  const findingById = new Map(data.findings.map((f) => [f.id, f]))
  const evidenceById = new Map(data.evidence.map((e) => [e.id, e]))

  return (
    <section className="mb-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">Attack timeline</h2>
        <span className="text-muted-foreground text-sm">
          {data.findings.length} findings from {data.evidence.length} pieces of
          evidence
          {generatedBy ? ` · timeline by ${generatedBy}` : ''}
        </span>
      </div>

      <ol className="border-border relative ml-3 border-l pl-6">
        {data.timeline.map((entry) => (
          <PhaseBlock
            key={entry.id}
            phase={entry.phase}
            title={entry.title}
            description={entry.description}
            findings={entry.finding_ids
              .map((id) => findingById.get(id))
              .filter((finding): finding is Finding => Boolean(finding))}
            evidenceById={evidenceById}
            onConfirmed={onConfirmed}
          />
        ))}
      </ol>
    </section>
  )
}

function PhaseBlock({
  phase,
  title,
  description,
  findings,
  evidenceById,
  onConfirmed,
}: {
  phase: Phase | null
  title: string | null
  description: string | null
  findings: Finding[]
  evidenceById: Map<string, Evidence>
  onConfirmed: () => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <li className="mb-6">
      <span className="bg-primary absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full" />

      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        <span className="text-primary font-mono text-xs tracking-wide uppercase">
          {phase ? PHASE_LABELS[phase] : 'unphased'}
        </span>
        <span className="font-semibold">{title}</span>
      </button>

      {description && (
        <p className="text-muted-foreground mt-1 ml-6 text-sm">{description}</p>
      )}

      {open && (
        <div className="mt-3 ml-6 space-y-3">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              evidenceById={evidenceById}
              onConfirmed={onConfirmed}
            />
          ))}
        </div>
      )}
    </li>
  )
}
