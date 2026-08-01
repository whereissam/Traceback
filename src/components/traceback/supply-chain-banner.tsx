import { PackageX } from 'lucide-react'
import { KindBadge } from '@/components/traceback/kind-badge'
import type { Finding } from '@/lib/traceback/types'

/** MITRE technique for "Compromise Software Supply Chain". */
const SUPPLY_CHAIN_TECHNIQUE = 'T1195.002'

/**
 * Surfaces a supply-chain compromise above the timeline, because it is the
 * finding that changes what a responder does first — quarantine the package,
 * rotate the secrets, audit the deploys.
 *
 * It stays honest about its own status: still an INFERENCE, still unconfirmed
 * until a human says otherwise. The banner draws attention; it does not
 * upgrade the claim.
 */
export function SupplyChainBanner({ findings }: { findings: Finding[] }) {
  const finding = findings.find(
    (f) =>
      f.kind === 'INFERENCE' && f.mitre_technique === SUPPLY_CHAIN_TECHNIQUE,
  )
  if (!finding) return null

  return (
    <section className="border-inference/50 bg-inference/10 mb-6 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PackageX className="text-inference h-5 w-5 shrink-0" />
        <h2 className="text-foreground font-semibold">
          Supply-chain attack pattern detected
        </h2>
        <KindBadge kind={finding.kind} />
        {finding.confidence && (
          <span className="text-muted-foreground text-xs">
            confidence: {finding.confidence}
          </span>
        )}
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
          {finding.mitre_technique}
        </span>
        {finding.confirmed && (
          <span className="bg-fact/15 text-fact rounded px-1.5 py-0.5 text-xs font-medium">
            confirmed by analyst
          </span>
        )}
      </div>

      <p className="text-muted-foreground mt-2 font-mono text-sm">
        dependency install → credential access → outbound request → persistence
      </p>

      {finding.description && (
        <p className="text-muted-foreground mt-2 text-sm">
          {finding.description}
        </p>
      )}

      <p className="text-inference mt-3 text-xs">
        ⚠︎ {finding.note ?? 'Requires human confirmation.'} Confirm it on the
        finding below.
      </p>
    </section>
  )
}
