// supabase/functions/delete-account/index.ts
//
// Lets a contributor delete their own account on request, ahead of the normal
// 90-day photo / 180-day inactive-account retention windows.
//
// Auth model: the caller must present their own valid session JWT (the
// standard Supabase client sends this automatically). We use that JWT only
// to identify *whose* account to delete — all actual deletion is performed
// with the service role key, since RLS does not grant authenticated users
// DELETE on their own row (deletion is a privileged, one-way action, not a
// self-service table write).
//
// Steps:
//   1. Identify the caller from their JWT.
//   2. Remove the storage objects for any of their photos not already deleted.
//   3. Mark those photo rows deleted (same fields the 90-day expiry job sets —
//      image_deleted_at + image_url = NULL), so this reuses existing read-path
//      logic rather than introducing a second "deleted" concept.
//   4. Delete the public.users row. photos.submitted_by is
//      ON DELETE SET NULL, so this does not touch event_sightings/events —
//      it just detaches the (already-scrubbed) photo rows from the account.
//   5. Delete the underlying Supabase Auth user, which revokes all sessions
//      and removes their ability to sign back in with the same email.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PHOTOS_BUCKET = "photos-raw";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Client used only to validate the caller's JWT and read their identity.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: authError,
  } = await callerClient.auth.getUser();

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
    });
  }

  const userId = user.id;

  // Service-role client for the actual privileged deletion work.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // 1. Find this user's photos that still have an image on disk.
    const { data: photos, error: photosError } = await admin
      .from("photos")
      .select("id, image_url")
      .eq("submitted_by", userId)
      .is("image_deleted_at", null);

    if (photosError) throw photosError;

    // 2. Remove the storage objects.
    if (photos && photos.length > 0) {
      const paths = photos
        .map((p) => extractStoragePath(p.image_url))
        .filter((p): p is string => Boolean(p));

      if (paths.length > 0) {
        const { error: storageError } = await admin.storage
          .from(PHOTOS_BUCKET)
          .remove(paths);
        // Don't hard-fail the whole deletion over a storage hiccup — log and
        // continue so the account/DB deletion still completes. Orphaned
        // storage objects are cheap to sweep up in a follow-up job if needed.
        if (storageError) {
          console.error("Storage removal error:", storageError.message);
        }
      }

      // 3. Mark rows deleted the same way the normal expiry job does.
      const { error: markError } = await admin
        .from("photos")
        .update({ image_deleted_at: new Date().toISOString(), image_url: null })
        .eq("submitted_by", userId)
        .is("image_deleted_at", null);

      if (markError) throw markError;
    }

    // 4. Delete the public.users row.
    // photos.submitted_by is ON DELETE SET NULL — this detaches the
    // (already-scrubbed) photo rows rather than deleting them outright,
    // so extracted event data and confidence history are unaffected.
    const { error: userDeleteError } = await admin
      .from("users")
      .delete()
      .eq("id", userId);

    if (userDeleteError) throw userDeleteError;

    // 5. Delete the underlying Auth user — revokes sessions, frees the email
    // for future re-signup, completes the deletion.
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(
      userId,
    );

    if (authDeleteError) throw authDeleteError;

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error("delete-account error:", err);
    return new Response(
      JSON.stringify({ error: "Deletion failed. Please try again or contact support." }),
      { status: 500 },
    );
  }
});

// image_url is a public Supabase Storage URL; storage.remove() needs the
// object path relative to the bucket, not the full URL.
function extractStoragePath(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const marker = `/${PHOTOS_BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return null;
  return imageUrl.slice(idx + marker.length);
}