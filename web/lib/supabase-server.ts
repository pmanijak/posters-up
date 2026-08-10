import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.generated'

// Server-side counterpart to lib/supabase.ts.
//
// lib/supabase.ts returns a createBrowserClient — it carries auth-session
// cookie storage backed by `document`, which is right for client components
// and wrong for server components and route handlers. This module is the
// plain, stateless client for those.
//
// Not covered here: app/auth/callback/route.ts. That one needs
// createServerClient with real cookie get/set wiring so it can persist the
// session after a magic-link exchange, which is a genuinely different client
// and stays inline.

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const SUPABASE_URL = requireEnv(
  'NEXT_PUBLIC_SUPABASE_URL',
  process.env.NEXT_PUBLIC_SUPABASE_URL,
)

/**
 * Public read client — publishable key, subject to RLS as an unauthenticated
 * caller. Use for server-rendered pages reading public views.
 */
export function createPublicClient() {
  return createClient<Database>(
    SUPABASE_URL,
    requireEnv(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY',
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    ),
  )
}

/**
 * Scoped-key client for API routes that read past what the publishable key
 * exposes — enrichment data, photo rows, the search candidate pool.
 *
 * The key scope is a boundary, not the access control. Routes using this are
 * responsible for sanitizing what they return (see the tell-me-more route,
 * which strips personal contact details before responding).
 *
 * Named for the key rather than the original route: SUPABASE_TELL_ME_MORE_KEY
 * now backs four routes, so "tell me more" no longer describes the usage.
 */
export function createScopedClient() {
  return createClient<Database>(
    SUPABASE_URL,
    requireEnv('SUPABASE_TELL_ME_MORE_KEY', process.env.SUPABASE_TELL_ME_MORE_KEY),
  )
}