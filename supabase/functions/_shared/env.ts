// requireEnv — read a required secret, or fail loudly at boot.
//
// Replaces the `Deno.env.get("X")!` pattern. The non-null assertion is a
// compile-time claim with no runtime backing: a missing secret yields
// `undefined`, the function boots fine, and the failure surfaces much later
// as something unrelated — a 401 from Anthropic, or `Bearer undefined` on a
// Supabase call. Throwing here turns that into one obvious message naming
// the missing variable.
//
// Note this moves the failure to module load, so a function with a missing
// secret now fails to start rather than starting and erroring per-request.
// That is the intent: an unset secret is never a recoverable per-request
// condition, and a boot failure is far easier to diagnose.

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it with: supabase secrets set ${name}=...`,
    );
  }
  return value;
}