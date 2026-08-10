// Shared HTTP helpers for edge functions.
//
// CORS_HEADERS was duplicated verbatim in extract and resolve-talent-name.
// Keeping one copy means a future change (tightening the origin from `*` to
// the real site origin, say) happens once instead of being applied to one
// function and silently missed in the other.

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/** JSON response with CORS headers applied. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Standard preflight reply. Call from the top of a request handler. */
export function corsPreflightResponse(): Response {
  return new Response("ok", { headers: CORS_HEADERS });
}

/**
 * Message from an unknown caught value.
 *
 * `catch (err: any)` then `err.message` is a lie in the cases that matter:
 * a thrown string or object has no `.message`, so the error report becomes
 * `undefined` exactly when something unexpected went wrong. This is the
 * idiom check-urls already uses — hoisted so the rest can share it.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}