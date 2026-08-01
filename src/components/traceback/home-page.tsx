import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  GitBranch,
  Link2,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KindBadge } from '@/components/traceback/kind-badge'
import { KIND_MEANING } from '@/lib/traceback/types'

const PIPELINE = [
  {
    icon: GitBranch,
    title: 'Correlate, don’t summarise',
    body: 'Process-tree ancestry, time proximity, and user identity link fragmented events. A credential read followed within a second by an outbound request from the same tree is a correlation — not yet a conclusion.',
  },
  {
    icon: Link2,
    title: 'Every claim cites its evidence',
    body: 'Each finding links back to the raw event ids it was derived from. Nothing is asserted bare, so an investigator can audit the reasoning instead of trusting it.',
  },
  {
    icon: ShieldCheck,
    title: 'The model cannot invent events',
    body: 'The LLM never sees raw telemetry. It arranges already-derived findings and references them by id; unknown ids are discarded before anything is stored.',
  },
]

export function HomePage() {
  return (
    <div className="from-background to-muted min-h-screen bg-gradient-to-br">
      <div className="container mx-auto max-w-5xl px-4 py-16">
        <section className="mb-16 text-center">
          <div className="mb-6 flex justify-center">
            <img
              src="/traceback-mark.png"
              alt="Traceback"
              width="112"
              height="112"
              className="h-20 w-20 sm:h-28 sm:w-28"
            />
          </div>

          <h1 className="text-foreground mb-4 text-3xl font-bold sm:text-4xl md:text-5xl">
            Traceback
          </h1>

          <p className="text-muted-foreground mx-auto mb-4 max-w-2xl text-lg sm:text-xl">
            Security teams do not lack alerts; they lack a trustworthy
            explanation of what happened.
          </p>
          <p className="text-muted-foreground mx-auto mb-8 max-w-2xl">
            Traceback turns fragmented logs, code changes, and runtime events
            into an evidence-backed incident timeline — so a human confirms
            findings instead of reconstructing the story from scratch.
          </p>

          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Button size="lg" render={<Link to="/traceback" />}>
              <ScanSearch className="mr-2 h-4 w-4" />
              Open an investigation
            </Button>
            <Button
              size="lg"
              variant="outline"
              render={
                <a
                  href="https://github.com/whereissam/React-Vite-Tanstack-Starter-Template/blob/main/docs/traceback/README.md"
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <BookOpen className="mr-2 h-4 w-4" />
              How it works
            </Button>
          </div>
        </section>

        <section className="mb-16">
          <h2 className="text-foreground mb-2 text-center text-2xl font-bold">
            Three levels of certainty, never blurred
          </h2>
          <p className="text-muted-foreground mx-auto mb-8 max-w-2xl text-center">
            An inference can never exist without a correlation beneath it, and
            the system never marks its own hypotheses as confirmed.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            {(['FACT', 'CORRELATION', 'INFERENCE'] as const).map((kind) => (
              <div
                key={kind}
                className="bg-card border-border rounded-lg border p-6"
              >
                <KindBadge kind={kind} />
                <p className="text-muted-foreground mt-3 text-sm">
                  {KIND_MEANING[kind]}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-16 grid gap-6 md:grid-cols-3">
          {PIPELINE.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-card rounded-lg p-6 shadow-sm">
              <div className="bg-primary/10 mb-4 w-fit rounded-full p-3">
                <Icon className="text-primary h-6 w-6" />
              </div>
              <h3 className="text-foreground mb-2 text-lg font-semibold">
                {title}
              </h3>
              <p className="text-muted-foreground text-sm">{body}</p>
            </div>
          ))}
        </section>

        <section className="bg-card rounded-lg p-8 shadow-sm">
          <h2 className="text-foreground mb-2 text-center text-2xl font-bold">
            The scenario it reconstructs
          </h2>
          <p className="text-muted-foreground mx-auto mb-8 max-w-2xl text-center text-sm">
            A malicious dependency installed by an AI coding agent, simulated
            end to end inside a disposable sandbox.
          </p>

          <ol className="mx-auto max-w-2xl space-y-3">
            {[
              'An AI coding agent installs a dependency',
              'A malicious postinstall script executes',
              'It reads a synthetic secret from .env',
              'It makes an outbound request 320ms later',
              'It rewrites the deployment workflow',
            ].map((step, index) => (
              <li key={step} className="flex items-start gap-3">
                <span className="bg-primary/10 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs">
                  {index + 1}
                </span>
                <span className="text-muted-foreground">{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-8 text-center">
            <Button variant="secondary" render={<Link to="/traceback" />}>
              Run it
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
