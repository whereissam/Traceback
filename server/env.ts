/** Environment configuration for the Traceback API server. */

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

function required(name: string): string {
  const value = optional(name)
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    )
  }
  return value
}

/**
 * Returns the first of `names` that is set.
 *
 * Supabase renamed its API keys: the JWT-style `service_role` key became the
 * `sb_secret_...` secret key. Accepting both means a project on either scheme
 * works without editing code.
 */
function requiredAny(names: string[]): string {
  for (const name of names) {
    const value = optional(name)
    if (value) return value
  }
  throw new Error(
    `Missing required environment variable. Set one of: ${names.join(' or ')}. ` +
      `Copy .env.example to .env and fill it in.`,
  )
}

export const env = {
  port: Number(optional('PORT') ?? 8787),

  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: required('SUPABASE_URL'),
  /**
   * The key that bypasses RLS — `sb_secret_...` on current Supabase projects,
   * or the legacy JWT `service_role` key on older ones. Server-side only: it
   * must never be shipped to the browser.
   *
   * The publishable key (`sb_publishable_...`, formerly `anon`) is deliberately
   * unused. Traceback's tables have RLS enabled with no permissive policies, so
   * that key can read nothing, and the browser never talks to Supabase at all.
   */
  supabaseSecretKey: requiredAny([
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]),

  /** Deployed Modal web endpoint for `run_simulation`. */
  modalSimulateUrl: optional('MODAL_SIMULATE_URL'),
  /** Deployed Modal endpoint that inspects a real npm package. */
  modalInspectUrl: optional('MODAL_INSPECT_URL'),
  /** Shared secret matching the Modal secret `traceback-sim/SIM_TOKEN`. */
  modalSimulateToken: optional('MODAL_SIMULATE_TOKEN'),

  /** OpenAI credentials for report generation. Optional — see llm.ts. */
  openaiApiKey: optional('OPENAI_API_KEY'),
  /**
   * Any model served by the Responses API. Reasoning models are fine — the
   * task is arranging findings, not deep inference.
   */
  openaiModel: optional('OPENAI_MODEL') ?? 'gpt-5.6-luna',
  /**
   * Reasoning depth. Defaults to `low`: on this task it produced the same
   * timeline structure as `medium` in ~8s instead of ~48s, and the pipeline —
   * not the model — is what guarantees correctness.
   */
  openaiEffort: (optional('OPENAI_EFFORT') ?? 'low') as
    | 'low'
    | 'medium'
    | 'high',
}

export type Env = typeof env
