// extract-drain — cron backstop for the extraction queue.
//
// This is NOT the primary way photos get processed. `claimAndDispatch()`
// is called directly at upload time and at the end of `extract` itself,
// so most photos are picked up immediately without waiting for this cron
// to tick at all. This function exists purely to catch what those two
// push call sites can miss:
//
//   - A photo left 'pending' because a push call errored before it could
//     fire (e.g. the upload request failed after inserting rows but
//     before calling claimAndDispatch).
//   - A photo left 'processing' because its extract invocation died
//     mid-flight (OOM, wall-clock timeout, boot failure racing a deploy)
//     and therefore never reached its own completion-triggered dispatch
//     call. See reap_stale_processing_photos() for what "died" covers.
//
// Runs every 1-2 minutes — slow, because it's a safety net, not the
// thing advancing the queue. See migrations/xxxx_extract_queue*.sql for
// the underlying SQL functions and config keys.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { claimAndDispatch } from "../_shared/claimAndDispatch.ts";

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: reapedCount, error: reapError } = await supabase.rpc(
    "reap_stale_processing_photos"
  );
  if (reapError) {
    console.error("reap_stale_processing_photos failed:", reapError);
  } else if (reapedCount > 0) {
    console.log(`extract-drain: reaped ${reapedCount} stuck photo(s) back to pending`);
  }

  const { claimed } = await claimAndDispatch({
    supabase,
    extractUrl: `${supabaseUrl}/functions/v1/extract`,
    serviceRoleKey,
  });
  if (claimed.length > 0) {
    console.log(`extract-drain: dispatched ${claimed.length} photo(s)`, claimed);
  }

  return new Response(
    JSON.stringify({ reaped: reapedCount ?? 0, dispatched: claimed.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});