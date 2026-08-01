import { useState } from 'react'
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react'
import type { TelemetryEvent } from '@/lib/traceback/types'

/**
 * The "before" half of the demo: fragmented events with no story attached.
 * Deliberately raw — this is what an investigator starts with today.
 */
export function RawEvents({ events }: { events: TelemetryEvent[] }) {
  const [open, setOpen] = useState(true)

  return (
    <section className="border-border bg-card mb-6 rounded-xl border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 p-4 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <Terminal className="h-4 w-4" />
        <span className="font-semibold">
          Raw telemetry — {events.length} fragmented events
        </span>
        <span className="text-muted-foreground ml-auto text-sm">
          no interpretation applied
        </span>
      </button>

      {open && (
        <div className="border-border overflow-x-auto border-t">
          <table className="w-full min-w-[720px] text-left font-mono text-xs">
            <thead className="text-muted-foreground bg-muted/40">
              <tr>
                <th className="p-2 font-medium">timestamp</th>
                <th className="p-2 font-medium">source</th>
                <th className="p-2 font-medium">event_type</th>
                <th className="p-2 font-medium">pid</th>
                <th className="p-2 font-medium">ppid</th>
                <th className="p-2 font-medium">raw</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-border border-t">
                  <td className="text-muted-foreground p-2 whitespace-nowrap">
                    {new Date(event.timestamp).toISOString().slice(11, 23)}
                  </td>
                  <td className="p-2">{event.source}</td>
                  <td className="p-2">{event.event_type}</td>
                  <td className="p-2">{event.process_id ?? '—'}</td>
                  <td className="p-2">{event.parent_process_id ?? '—'}</td>
                  <td className="text-muted-foreground max-w-md truncate p-2">
                    {JSON.stringify(event.raw)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
