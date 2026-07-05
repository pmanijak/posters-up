// claimAndDispatch — the one place that advances the extraction queue.
//
// Called from three places:
//   1. The upload endpoint, right after inserting new photo rows.
//   2. The end of `extract`, right after it writes 'complete' or 'failed'
//      for the photo it was working on.
//   3. The extract-drain cron, as a backstop for anything the two push
//      call sites above miss (a request that errors before reaching this
//      call, an invocation that crashes before its own completion path).
//
// All three just call this — capacity enforcement (extract_max_concurrent)
// lives entirely in the claim_pending_photos() SQL function, so this file
// has no policy of its own to keep in sync.
//
// Takes its dependencies as parameters rather than reading env vars
// internally: callers already have a Supabase client for their own
// purposes (extract-drain needs one for its reap RPC; extract and the
// upload endpoint each have one for their own writes), so this avoids
// constructing a redundant second client and keeps env resolution where
// it naturally differs by runtime (Supabase secrets vs. Vercel env vars)
// instead of guessing at it here.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function claimAndDispatch(params: {
  supabase: SupabaseClient;
  extractUrl: string;       // e.g. `${SUPABASE_URL}/functions/v1/extract`
  serviceRoleKey: string;   // used as the Authorization bearer for the extract call
}): Promise<{ claimed: string[] }> {
  const { supabase, extractUrl, serviceRoleKey } = params;

  const { data, error } = await supabase.rpc("claim_pending_photos");
  if (error) {
    console.error("claim_pending_photos failed:", error);
    return { claimed: [] };
  }

  const claimedIds: string[] = (data ?? []).map((row: { id: string }) => row.id);
  if (claimedIds.length === 0) {
    return { claimed: [] };
  }

  // Promise.allSettled, not Promise.all — one bad photo must not stop the
  // rest of the claimed batch from being dispatched.
  const results = await Promise.allSettled(
    claimedIds.map((id) =>
      fetch(extractUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ photo_id: id }),
      })
    )
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      // Dispatch itself failed (network error reaching `extract`, not an
      // error *from* extract). The photo is left at 'processing' with a
      // fresh processing_started_at from the claim — reap_stale_processing
      // will recover it if extract never actually ran.
      console.error(`Failed to dispatch extract for photo ${claimedIds[i]}:`, result.reason);
    }
  });

  return { claimed: claimedIds };
}