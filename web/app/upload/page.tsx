'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase'
import { CATEGORY_MAP, categoryColor } from '@/lib/categories'
import type { EventCategory } from '@/lib/categories'
import exifr from 'exifr'

// ── Types ──────────────────────────────────────────────────────────────────

// Immediate response from the extract Edge Function.
interface SubmitResult {
  success:   boolean
  photo_id:  string | null
  board_id:  string | null
  warnings?: string[]
}

// One row from event_sightings, joined to its canonical event.
interface SightingRow {
  id:                    string
  match_type:            string | null
  extraction_confidence: number
  flyer_style:           string | null
  raw_extraction:        Record<string, unknown>
  events: {
    id:               string
    name:             string
    date_start:       string | null
    confidence_score: number
    // Requires event_category in the /api/photos/[id]/sightings select query.
    event_category:   string | null
  } | null
}

type JobStatus = 'queued' | 'uploading' | 'extracting' | 'complete' | 'failed'

interface JobState {
  id:              string
  file:            File | null   // null for jobs resumed from the DB after a refresh
  preview:         string        // object URL for locally-selected files, revoked on reset/unmount;
                                  // a signed storage URL for jobs resumed after a refresh (not revoked)
  status:          JobStatus
  progress:        number        // 0–100; drives the per-job progress bar
  submitResult:    SubmitResult | null
  sightings:       SightingRow[]
  extractionError: string | null
  uploadError:     string | null
  warnings:        string[]
  resumed:         boolean       // true for jobs hydrated from the DB, not selected this page-load —
                                  // only used to decide whether a settled result renders inline or
                                  // inside the collapsed "completed earlier" section
}

// ── Supabase client ────────────────────────────────────────────────────────

// Stable across renders — no component-level deps.
const supabase = createClient()

// ── Helpers ────────────────────────────────────────────────────────────────

// maxDimension matches Claude's high-resolution vision tier (2576px long
// edge) — see extract/index.ts's model comment for why this pairing
// matters. 2400 was originally tuned against the older 1568px ceiling
// and was already generous for that tier; now that extract runs on
// Sonnet 5, capping below 2576 here would throw away resolution the
// model can actually use. Raising this alone (without the model change)
// would do nothing — the model downsizes internally to its own tier
// ceiling regardless of what's uploaded above it.
async function resizeImage(file: File, maxDimension = 2576): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale  = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width  = Math.round(bitmap.width  * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
      'image/jpeg',
      0.85
    )
  )
}

// A contributor doesn't care which dedup tier matched. Two things matter to
// them: did they add something new, or confirm something still posted? Both are
// valuable — a match is a fresh sighting that bumps last_seen_at and confidence.
// Collapses null / 'none' / 'new' → New; every other tier → Still posted.
function contributionBadge(matchType: string | null) {
  const isNew = !matchType || matchType === 'new' || matchType === 'none'
  return isNew ? (
    <span className="text-xs shrink-0 text-content-accent">✨ New</span>
  ) : (
    <span className="text-xs shrink-0 text-content-secondary">✓ Confirmed</span>
  )
}

// Groups sightings by event_category for the results list.
// Uncategorized sightings collect under null and render last.
interface CategoryGroup {
  category: string | null
  label:    string
  items:    SightingRow[]
}

function groupByCategory(sightings: SightingRow[]): CategoryGroup[] {
  const map = new Map<string, SightingRow[]>()

  for (const s of sightings) {
    const key = s.events?.event_category ?? '__uncategorized__'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }

  const groups: CategoryGroup[] = []
  for (const [key, items] of map.entries()) {
    if (key === '__uncategorized__') continue
    groups.push({
      category: key,
      label:    CATEGORY_MAP[key as EventCategory] ?? key,
      items,
    })
  }

  // Uncategorized last
  const uncategorized = map.get('__uncategorized__')
  if (uncategorized?.length) {
    groups.push({ category: null, label: 'Uncategorized', items: uncategorized })
  }

  return groups
}

// Sequenced messages shown during extraction, advancing with the progress bar.
// 12 messages over ~75 seconds = ~6 seconds each. Each one teaches the contributor
// something about what the app is doing or can do.
const PROGRESS_MESSAGES = [
  'Scanning photo…',
  'Summarizing posters…',
  'Checking GPS…',
  'Reading venues…',
  'Finding headliners…',
  'Weighing confidence…',
  'Throwing out personal info…',
  'Labeling shows…',
  'Categorizing events…',
  'Comparing sightings…',
  'Almost done…',
] as const

function progressMessage(progress: number): string {
  const idx = Math.min(
    Math.floor((progress / 95) * PROGRESS_MESSAGES.length),
    PROGRESS_MESSAGES.length - 1
  )
  return PROGRESS_MESSAGES[idx]
}

// Progress bar: animate to 95% over 75 s while extracting, jump to 100 on complete.
const PROGRESS_DURATION_MS = 75_000
const PROGRESS_TARGET      = 95

// Browser-side politeness cap on how many jobs run their EXIF/resize/upload
// phase at once. Independent of the server's extract_max_concurrent — the
// server already gates true extraction concurrency via its own queue, so
// this is only about not decoding and resizing a huge batch of full-size
// photos in the tab at the same instant.
const MAX_CONCURRENT_CLIENT_JOBS = 3

// sessionStorage key marking when the contributor last hit "Submit another
// photo" in this tab. Purely a client-side UI boundary — has no server-side
// meaning and isn't a cache of anything that needs to stay correct, so
// sessionStorage is the right tool here (unlike photo status itself, which
// stays entirely DB-driven). Scoped to sessionStorage rather than
// localStorage on purpose: a reset should mean "not for the rest of this tab
// session," not "never again on this device."
const RESET_BOUNDARY_KEY = 'postersup:upload-reset-at'

// The resume-on-refresh window is enforced server-side, not here — see
// RESUME_WINDOW_HOURS in app/api/photos/recent/route.ts.

// ── Component ──────────────────────────────────────────────────────────────

export default function UploadPage() {
  // Auth
  const [user, setUser]             = useState<User | null>(null)
  const [loading, setLoading]       = useState(true)
  const [step, setStep]             = useState<'email' | 'code'>('email')
  const [email, setEmail]           = useState('')
  const [code, setCode]             = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // Photo queue
  const [jobs, setJobs] = useState<JobState[]>([])
  const dispatchedRef   = useRef<Set<string>>(new Set())  // job ids ever passed to processJob; prevents double-dispatch before status flips off 'queued'
  const hydratedForRef  = useRef<string | null>(null)      // user id the resume-on-load effect has already run for
  const mountedRef      = useRef(true)   // guards setJobs calls after unmount
  const fileInputRef    = useRef<HTMLInputElement>(null)

  // Board details — only shown for single-photo uploads (see note below jobs.length check).
  // When a board_id comes back the form pre-populates from whatever the DB already has.
  const [lastBoardId, setLastBoardId]                             = useState<string | null>(null)
  const [locationName, setLocationName]                           = useState('')
  const [description, setDescription]                             = useState('')
  const [requiresEntryToPhotograph, setRequiresEntryToPhotograph] = useState<boolean | null>(null)
  const [requiresEntryToPost, setRequiresEntryToPost]             = useState<boolean | null>(null)
  const [submittingBoard, setSubmittingBoard]                     = useState(false)
  const [boardSubmitted, setBoardSubmitted]                       = useState(false)
  const [boardError, setBoardError]                               = useState<string | null>(null)

  // Collapses settled results from resumed jobs (see the resume effect below)
  // until the contributor asks to see them — a session resumed with several
  // already-finished photos would otherwise dump all their full result
  // blocks at the top before showing anything about what's happening now.
  // Also re-collapses automatically the moment a new upload starts (see
  // handleFileChange) — once there's something new happening, the old
  // results shouldn't stay competing for attention.
  const [showResumedResults, setShowResumedResults] = useState(false)

  // Merges a partial patch into one job by id.
  function updateJob(id: string, patch: Partial<JobState>) {
    if (!mountedRef.current) return
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j))
  }

  // Full pipeline for one photo: EXIF → resize → upload → extract Edge Function → poll.
  // Drives the job's status and progress directly via updateJob. Multiple jobs run
  // this concurrently (up to MAX_CONCURRENT_CLIENT_JOBS) — dispatchedRef is what
  // prevents the same job from being started twice, not anything in here.
  async function processJob(job: JobState) {
    if (!mountedRef.current) return

    const file = job.file
    if (!file) {
      // Should never happen — processJob is only ever called for freshly
      // selected files (see the queue effect below), never for jobs resumed
      // from the DB, which go straight to pollForExtraction instead.
      console.error(`processJob called with no file for job ${job.id}`)
      return
    }

    // ── Phase 1: upload ──────────────────────────────────────────────────

    updateJob(job.id, { status: 'uploading', progress: 0 })

    let submitResult: SubmitResult | null = null

    try {
      const [gps, exifData] = await Promise.all([
        exifr.gps(file).catch(() => null),
        exifr.parse(file, ['DateTimeOriginal']).catch(() => null),
      ])

      const lat          = gps?.latitude  ?? null
      const lng          = gps?.longitude ?? null
      const capture_date = exifData?.DateTimeOriginal
        ? new Date(exifData.DateTimeOriginal).toISOString()
        : null

      const resized = await resizeImage(file)

      const { data: { user: authUser } } = await supabase.auth.getUser()
      const path = `${authUser!.id}/${Date.now()}-${file.name}`

      const { error: uploadError } = await supabase.storage
        .from('photos-raw')
        .upload(path, resized)
      if (uploadError) throw uploadError

      const { data: { session } } = await supabase.auth.getSession()

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/extract`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ photo_path: path, lat, lng, capture_date }),
        }
      )

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')

      submitResult = data as SubmitResult

      updateJob(job.id, {
        status:       'extracting',
        progress:     0,
        submitResult,
        warnings:     submitResult.warnings ?? [],
      })

      if (submitResult.board_id) setLastBoardId(submitResult.board_id)

    } catch (err: unknown) {
      if (!mountedRef.current) return
      updateJob(job.id, {
        status:      'failed',
        uploadError: err instanceof Error ? err.message : 'Upload failed',
      })
      return
    }

    if (!submitResult?.photo_id) {
      // extract didn't return a photo_id — nothing to poll
      updateJob(job.id, { status: 'complete', progress: 100 })
      return
    }

    await pollForExtraction(job.id, submitResult.photo_id)
  }

  // Polls /api/photos/[id]/sightings until extraction finishes, animating
  // the progress bar in the meantime. Shared by processJob (right after a
  // live upload's extract call returns) and by the resume-on-refresh effect
  // below (for jobs that were already 'pending'/'processing' in the DB when
  // the page loaded) — extraction itself is entirely server-driven at this
  // point, so both cases just need to watch the same status field.
  async function pollForExtraction(jobId: string, photoId: string, startedAt?: string) {
    // Animate 0 → 95% over 75 s while we wait for the extraction worker.
    // startedAt, when given, anchors this to when extraction actually began
    // (processing_started_at, or submitted_at if still queued) rather than
    // to whenever this function happens to be called — without it, a
    // resumed job's bar would reset to 0% and re-climb the full 75s on
    // every refresh, regardless of how far along it actually was.
    const startTime = startedAt ? new Date(startedAt).getTime() : Date.now()
    const progressInterval = setInterval(() => {
      if (!mountedRef.current) { clearInterval(progressInterval); return }
      const elapsed = Date.now() - startTime
      const frac    = Math.min(elapsed / PROGRESS_DURATION_MS, 1)
      updateJob(jobId, { progress: Math.round(frac * PROGRESS_TARGET) })
    }, 250)

    try {
      const { data: { session } } = await supabase.auth.getSession()

      while (mountedRef.current) {
        await new Promise(r => setTimeout(r, 3000))
        if (!mountedRef.current) break

        let res: Response
        try {
          res = await fetch(`/api/photos/${photoId}/sightings`, {
            headers: { Authorization: `Bearer ${session?.access_token}` },
          })
        } catch {
          // Network hiccup — keep polling
          continue
        }

        if (!res.ok) break

        const data = await res.json()

        if (data.sightings) updateJob(jobId, { sightings: data.sightings })

        if (data.extraction_status === 'complete') {
          clearInterval(progressInterval)
          updateJob(jobId, {
            status:    'complete',
            progress:  100,
            sightings: data.sightings ?? [],
          })
          break
        } else if (data.extraction_status === 'failed') {
          clearInterval(progressInterval)
          updateJob(jobId, {
            status:          'failed',
            extractionError: data.extraction_error ?? 'Extraction failed',
          })
          break
        }
      }
    } finally {
      clearInterval(progressInterval)
    }
  }

  // One-shot fetch for a photo that's already 'complete' when resumed after
  // a refresh — its results just need filling in, there's nothing to poll
  // for since extraction already finished. Same endpoint pollForExtraction
  // uses, just called once instead of in a loop.
  async function fetchSightingsOnce(jobId: string, photoId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`/api/photos/${photoId}/sightings`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      if (!res.ok || !mountedRef.current) return
      const data = await res.json()
      updateJob(jobId, { sightings: data.sightings ?? [] })
    } catch {
      // Best-effort — the job still shows as complete either way, just
      // without its results filled in if this fails.
    }
  }

  // Auth check on mount.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  }, [])

  // Resumes this user's recent session from the DB on load — not just what's
  // still running, but what finished (or failed) while the tab was closed too.
  // extraction_status is the real source of truth for progress; the jobs
  // array is just a local view of it. The window this looks back is enforced
  // server-side (see app/api/photos/recent/route.ts) rather than pulling
  // someone's entire upload history on every load. Resumed jobs skip
  // processJob's upload phase entirely — there's no local File to re-upload,
  // and there doesn't need to be, since the photo is already in storage and
  // already at whatever stage the DB says it's at.
  //
  // hydratedForRef, not jobs.length, is what makes this run once: jobs
  // legitimately goes back to [] every time handleReset runs ("Submit
  // another photo"), so a jobs.length-based guard would fire again right
  // after every reset and immediately pull the photos you just finished
  // back in as "resumed" — which looked like the reset not working at all.
  // Keying on the user id (rather than a plain boolean) also means a
  // mid-session user switch gets its own hydration instead of being
  // silently skipped.
  //
  // Goes through /api/photos/recent rather than querying `photos` directly —
  // `authenticated` only has INSERT on `photos` per ARCHITECTURE.md's access
  // control table, not SELECT, so a direct client query 403s.
  //
  // Also sends RESET_BOUNDARY_KEY from sessionStorage as ?after, if set —
  // otherwise refreshing right after "Submit another photo" would pull the
  // just-put-away batch straight back in, since the DB has no record that a
  // reset happened at all.
  useEffect(() => {
    if (!user || hydratedForRef.current === user.id) return
    hydratedForRef.current = user.id

    const resetAt = sessionStorage.getItem(RESET_BOUNDARY_KEY)
    const url = resetAt
      ? `/api/photos/recent?after=${encodeURIComponent(resetAt)}`
      : '/api/photos/recent'

    supabase.auth.getSession().then(({ data: { session } }) =>
      fetch(url, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
    )
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        const data = json?.photos as
          {
            id: string
            image_url: string
            board_id: string | null
            extraction_status: string
            extraction_error: string | null
            submitted_at: string
            processing_started_at: string | null
          }[]
          | undefined
        if (!data?.length || !mountedRef.current) return

        const hydrated: JobState[] = data.map(p => {
          // Real start time for the progress bar: when extraction actually
          // began (processing_started_at), or submitted_at if it's still
          // queued and hasn't been claimed yet. Used both for the initial
          // progress value here and passed into pollForExtraction below —
          // without this, the bar would flash to 0% and re-climb the full
          // 75s arc on every refresh instead of showing real elapsed time.
          const startedAt = p.processing_started_at ?? p.submitted_at
          const elapsedFrac = Math.min((Date.now() - new Date(startedAt).getTime()) / PROGRESS_DURATION_MS, 1)

          return {
            id:              p.id,   // reuse the photo id directly — no local file to give it a separate client id
            file:            null,
            preview:         '',     // filled in below once the signed URL resolves; JobThumbnail shows a placeholder until then
            status:          p.extraction_status === 'complete' ? 'complete'
                            : p.extraction_status === 'failed'   ? 'failed'
                            : 'extracting',                       // 'pending' or 'processing'
            progress:        p.extraction_status === 'complete' ? 100 : Math.round(elapsedFrac * PROGRESS_TARGET),
            submitResult:    { success: true, photo_id: p.id, board_id: p.board_id },
            sightings:       [],
            extractionError: p.extraction_error,
            uploadError:     null,
            warnings:        [],
            resumed:         true,
          }
        })

        setJobs(prev => [...hydrated, ...prev])

        // Best-effort thumbnail: a signed URL for the already-uploaded photo.
        // Failure just leaves the placeholder — doesn't block anything else.
        for (const p of data) {
          supabase.storage
            .from('photos-raw')
            .createSignedUrl(p.image_url, 3600)
            .then(({ data: signed }) => {
              if (signed?.signedUrl && mountedRef.current) {
                updateJob(p.id, { preview: signed.signedUrl })
              }
            })
        }

        // Per-status follow-up. None of these go through the queue effect
        // below (status is never 'queued' for a resumed job) or processJob.
        for (const p of data) {
          if (p.extraction_status === 'pending' || p.extraction_status === 'processing') {
            void pollForExtraction(p.id, p.id, p.processing_started_at ?? p.submitted_at)
          } else if (p.extraction_status === 'complete') {
            // Already finished — just needs its results filled in once,
            // not a polling loop. 'failed' needs nothing further; its
            // extraction_error already came back with the initial query.
            void fetchSightingsOnce(p.id, p.id)
          }
        }
      })
    // pollForExtraction/fetchSightingsOnce/updateJob don't close over anything
    // that should re-run this effect — safe to omit, same as the queue effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Bounded-concurrency queue processor. Fires whenever `jobs` changes; starts
  // as many queued jobs as fit under MAX_CONCURRENT_CLIENT_JOBS. dispatchedRef
  // prevents double-starts: it's checked and updated synchronously here, so a
  // job is marked dispatched the instant it's chosen — before processJob's own
  // updateJob call (which flips status off 'queued') actually lands. Without
  // that, a re-render firing this effect again in that window could pick the
  // same still-'queued' job a second time. dispatchedRef entries are never
  // removed — job ids are freshly generated per file (see handleFileChange),
  // so a finished job's id sitting in the set forever is harmless.
  useEffect(() => {
    const inFlight = jobs.filter(j => dispatchedRef.current.has(j.id) && j.status !== 'complete' && j.status !== 'failed').length
    const slots = MAX_CONCURRENT_CLIENT_JOBS - inFlight
    if (slots <= 0) return

    const toStart = jobs.filter(j => j.status === 'queued' && !dispatchedRef.current.has(j.id)).slice(0, slots)
    if (toStart.length === 0) return

    toStart.forEach(j => dispatchedRef.current.add(j.id))
    // setTimeout defers processJob out of the synchronous effect body,
    // avoiding the "setState inside effect" linter warning. dispatchedRef is
    // already updated above, so a re-render between here and the next tick
    // won't cause any of these jobs to be picked again.
    setTimeout(() => { toStart.forEach(j => void processJob(j)) }, 0)
    // processJob doesn't close over `jobs` — safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs])

  // When a board_id comes back, fetch its existing values to pre-populate
  // the board details form and reset submission state.
  // All setState calls are in .then() to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!lastBoardId) return
    supabase
      .from('boards')
      .select('location_name, description')
      .eq('id', lastBoardId)
      .maybeSingle()
      .then(({ data }) => {
        setBoardSubmitted(false)
        setBoardError(null)
        setRequiresEntryToPhotograph(null)
        setRequiresEntryToPost(null)
        setLocationName(data?.location_name ?? '')
        setDescription(data?.description ?? '')
      })
  }, [lastBoardId])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return

    const newJobs: JobState[] = files.map(file => ({
      id:              crypto.randomUUID(),
      file,
      preview:         URL.createObjectURL(file),
      status:          'queued',
      progress:        0,
      submitResult:    null,
      sightings:       [],
      extractionError: null,
      uploadError:     null,
      warnings:        [],
      resumed:         false,
    }))

    setJobs(prev => [...prev, ...newJobs])
    setShowResumedResults(false) // starting something new — tuck the old results back away
    e.target.value = '' // reset so the same file can be re-selected
  }

  // Resets all queue and board-form state so the contributor can start a new session.
  function handleReset() {
    jobs.forEach(j => { if (j.preview.startsWith('blob:')) URL.revokeObjectURL(j.preview) })
    setJobs([])
    setShowResumedResults(false)
    setLastBoardId(null)
    setBoardSubmitted(false)
    setBoardError(null)
    setLocationName('')
    setDescription('')
    setRequiresEntryToPhotograph(null)
    setRequiresEntryToPost(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    // Marks "don't resume anything from before this point" — otherwise a
    // refresh right after resetting would pull the just-put-away batch
    // straight back in, since the DB has no idea a reset happened at all.
    sessionStorage.setItem(RESET_BOUNDARY_KEY, new Date().toISOString())
  }

  async function sendOtp() {
    setSubmitting(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    if (error) setError(error.message)
    else setStep('code')
    setSubmitting(false)
  }

  async function verifyCode(tokenOverride?: string) {
    const token = tokenOverride ?? code
    setSubmitting(true)
    setError(null)
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    })
    if (error) {
      setError(error.message)
      setSubmitting(false)
      return
    }
    if (data.user) setUser(data.user)
    setSubmitting(false)
  }

  async function submitBoardDetails() {
    if (!lastBoardId) return

    const trimmedName = locationName.trim()
    const trimmedDesc = description.trim()
    if (!trimmedName && !trimmedDesc && requiresEntryToPhotograph === null && requiresEntryToPost === null) return

    setSubmittingBoard(true)
    setBoardError(null)

    const { error } = await supabase
      .from('board_submissions')
      .insert({
        board_id:                     lastBoardId,
        location_name:                trimmedName || null,
        description:                  trimmedDesc || null,
        requires_entry_to_photograph: requiresEntryToPhotograph,
        requires_entry_to_post:       requiresEntryToPost,
      })

    setSubmittingBoard(false)
    if (error) setBoardError(error.message)
    else setBoardSubmitted(true)
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const activeJobs = jobs.filter(j => j.status === 'uploading' || j.status === 'extracting')
  const anySuccess = jobs.some(j => j.status === 'complete')
  const allSettled = jobs.length > 0 && jobs.every(j => j.status === 'complete' || j.status === 'failed')
  const doneCount  = jobs.filter(j => j.status === 'complete' || j.status === 'failed').length

  // Board form is only meaningful for a single-photo upload: the contributor is
  // presumably at or near that one board. Multi-photo sessions are typically a
  // downtown walkabout covering many different boards, so a single form at the
  // end would be ambiguous and not worth filling in.
  const showBoardForm = jobs.length === 1 && anySuccess && lastBoardId

  const boardDetailsReady =
    locationName.trim().length > 0 ||
    description.trim().length > 0 ||
    requiresEntryToPhotograph !== null ||
    requiresEntryToPost !== null

  // ── Loading + auth states ─────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen bg-surface-page" />
  )

  if (!user) return (
    <div className="min-h-screen bg-surface-page">
      <header className="border-b border-edge">
        <div className="max-w-2xl mx-auto px-4 pt-3 pb-2">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center">
            <div>
              <Link href="/" className="text-xs text-content-muted hover:text-content-secondary transition-colors">
                ← Events
              </Link>
            </div>
            <h1 className="font-marker text-3xl text-content-primary text-center px-2">
              <Link href="/">Posters Up</Link>
            </h1>
            <div />
          </div>
          <p className="text-sm mt-1 text-content-muted text-center">Sign in to submit photos</p>
        </div>
      </header>

      <div className="flex justify-center px-4 pt-16">
        <div className="w-full max-w-sm space-y-4">

          {step === 'email' ? (
            <div className="space-y-3">
              <input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendOtp()}
                disabled={submitting}
                className="w-full bg-surface-card border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle disabled:opacity-50"
              />
              <button
                onClick={sendOtp}
                disabled={submitting || !email.trim()}
                className="w-full bg-content-secondary text-surface-page rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {submitting ? 'Sending…' : 'Send code'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-content-muted">
                Code sent to {email}.{' '}
                <button
                  onClick={() => { setStep('email'); setCode(''); setError(null) }}
                  className="underline hover:text-content-secondary"
                >
                  Change
                </button>
              </p>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                placeholder="8-digit code"
                value={code}
                onChange={e => {
                  const val = e.target.value.replace(/\D/g, '')
                  setCode(val)
                  if (val.length === 8) verifyCode(val)
                }}
                disabled={submitting}
                className="w-full bg-surface-card border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle tracking-widest disabled:opacity-50"
              />
              <button
                onClick={() => verifyCode()}
                disabled={submitting || code.length < 8}
                className="w-full bg-content-secondary text-surface-page rounded px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {submitting ? 'Verifying…' : 'Continue'}
              </button>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )

  // ── Authenticated ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface-page">

      <header className="border-b border-edge">
        <div className="max-w-2xl mx-auto px-4 pt-3 pb-2">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center">
            <div>
              <Link href="/" className="text-xs text-content-muted hover:text-content-secondary transition-colors whitespace-nowrap">
                ← Events
              </Link>
            </div>
            <h1 className="font-marker text-3xl text-content-primary text-center px-2">
              <Link href="/">Posters Up</Link>
            </h1>
            <div className="flex justify-end">
              <span className="text-xs text-content-muted truncate max-w-[100px] sm:max-w-none">{user.email}</span>
            </div>
          </div>
          <p className="text-sm mt-1 text-content-muted text-center">Submit a bulletin board photo</p>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* ── File picker — shown before any photos are queued ── */}
        {jobs.length === 0 && (
          <div className="bg-surface-card rounded-sm border border-edge p-6 space-y-4">
            <p className="text-sm text-content-secondary">
              Photograph a bulletin board and submit it. We'll read the GPS from your
              photo to place the board on the map — make sure your camera has location enabled.
              You can select multiple photos at once.
            </p>

            <label className="flex items-center justify-center w-full h-24 rounded border border-dashed border-edge-subtle text-sm cursor-pointer transition-colors text-content-muted hover:border-content-muted hover:text-content-secondary">
              Choose photos
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>
          </div>
        )}

        {/* ── Queue panel — shown once photos are added ── */}
        {jobs.length > 0 && (
          <div className="bg-surface-card rounded-sm border border-edge divide-y divide-edge">

            {/* Thumbnail strip + queue status — same for one photo or many;
                only the board-details form below stays single-photo-only,
                since that one's a content decision, not a UI one. */}
            <div className="px-4 py-3 space-y-3">
              <div className="flex gap-2 flex-wrap items-center">
                {jobs.map(job => (
                  <JobThumbnail key={job.id} job={job} />
                ))}

                {/* Add more photos while the queue is running or after it finishes */}
                <label
                  className="w-12 h-12 flex items-center justify-center rounded border-2 border-dashed border-edge-subtle text-content-muted text-xl cursor-pointer transition-colors hover:border-content-muted hover:text-content-secondary"
                  title="Add more photos"
                >
                  +
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>
              </div>

              {!allSettled && (
                <p className="text-xs text-content-muted">
                  {activeJobs.length > 0
                    ? `Processing ${activeJobs.length} of ${jobs.length}…`
                    : `${doneCount} of ${jobs.length} done`
                  }
                </p>
              )}
            </div>

            {/* Progress bars — one per concurrently active job.
                'uploading' uses animate-pulse (fast, indeterminate);
                'extracting' uses the 0→95 linear animation. */}
            {activeJobs.map(job => (
              <div key={job.id} className="px-4 py-3 space-y-1.5">
                <p className="text-xs text-content-secondary truncate">{job.file?.name ?? 'Resumed photo'}</p>
                <div className="h-1 w-full bg-surface-raised rounded-full overflow-hidden">
                  {job.status === 'uploading' ? (
                    <div className="h-full w-full bg-content-secondary rounded-full animate-pulse" />
                  ) : (
                    <div
                      className="h-full bg-content-secondary rounded-full"
                      style={{ width: `${job.progress}%`, transition: 'width 0.25s linear' }}
                    />
                  )}
                </div>
                <p className="text-xs text-content-muted">
                  {job.status === 'uploading'
                    ? 'Uploading…'
                    : progressMessage(job.progress)
                  }
                </p>
              </div>
            ))}

            {/* Per-job results — appear as each freshly-selected photo completes or fails.
                Resumed jobs (from before a refresh) are collapsed below instead —
                see showResumedResults. */}
            {jobs
              .filter(j => (j.status === 'complete' || j.status === 'failed') && !j.resumed)
              .map((job, idx) => (
                <JobResult
                  key={job.id}
                  job={job}
                  jobNumber={idx + 1}
                />
              ))
            }

            {/* Collapsed results for jobs resumed from before a refresh — a
                session resumed with several already-finished photos would
                otherwise dump all of them, fully expanded, ahead of anything
                happening right now. */}
            {(() => {
              const resumedSettled = jobs.filter(j => j.resumed && (j.status === 'complete' || j.status === 'failed'))
              if (resumedSettled.length === 0) return null
              return (
                <div>
                  <button
                    onClick={() => setShowResumedResults(v => !v)}
                    className="w-full px-4 py-3 flex items-center justify-between text-xs text-content-muted hover:text-content-secondary transition-colors"
                  >
                    <span>
                      {showResumedResults ? 'Hide' : 'Show'} {resumedSettled.length} completed upload{resumedSettled.length !== 1 ? 's' : ''} from earlier
                    </span>
                    <span>{showResumedResults ? '▲' : '▼'}</span>
                  </button>
                  {showResumedResults && resumedSettled.map((job, idx) => (
                    <JobResult
                      key={job.id}
                      job={job}
                      jobNumber={idx + 1}
                    />
                  ))}
                </div>
              )
            })()}

            {/* Board details — single-photo only. Multi-photo sessions are typically
                a walkabout covering many different boards, so the form would be
                ambiguous. The board_id is stored in job.submitResult for future use. */}
            {showBoardForm && (
              <div className="px-4 py-5 space-y-5">

                <div>
                  <p className="text-sm font-medium text-content-primary">Where is this board?</p>
                  <p className="text-xs text-content-muted mt-1">
                    Help future contributors and visitors find it in person.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-content-secondary">Business or place name</label>
                  <input
                    type="text"
                    value={locationName}
                    onChange={e => setLocationName(e.target.value)}
                    disabled={boardSubmitted}
                    placeholder="e.g. Rainy Day Records, Olympia Timberland Library"
                    className="w-full bg-surface-page border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle disabled:opacity-50"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-content-secondary">Where exactly</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    disabled={boardSubmitted}
                    placeholder="e.g. outside the front door on 4th Ave, next to the window"
                    rows={2}
                    className="w-full bg-surface-page border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle resize-none disabled:opacity-50"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-content-secondary">
                    Did you need to go inside to photograph it?
                  </label>
                  <div className="flex items-center gap-2">
                    {([true, false, null] as const).map((val) => {
                      const label  = val === true ? 'Yes' : val === false ? 'No' : 'Not sure'
                      const active = requiresEntryToPhotograph === val
                      return (
                        <button
                          key={label}
                          onClick={() => !boardSubmitted && setRequiresEntryToPhotograph(val)}
                          disabled={boardSubmitted}
                          className={[
                            'px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-50',
                            active
                              ? 'bg-content-secondary text-surface-page'
                              : 'bg-surface-page border border-edge text-content-muted hover:border-edge-subtle',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-content-secondary">
                    Would someone need to go inside to post here?
                  </label>
                  <div className="flex items-center gap-2">
                    {([true, false, null] as const).map((val) => {
                      const label  = val === true ? 'Yes' : val === false ? 'No' : 'Not sure'
                      const active = requiresEntryToPost === val
                      return (
                        <button
                          key={label}
                          onClick={() => !boardSubmitted && setRequiresEntryToPost(val)}
                          disabled={boardSubmitted}
                          className={[
                            'px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-50',
                            active
                              ? 'bg-content-secondary text-surface-page'
                              : 'bg-surface-page border border-edge text-content-muted hover:border-edge-subtle',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {boardSubmitted ? (
                  <p className="text-sm text-content-secondary">Thanks — details submitted.</p>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={submitBoardDetails}
                      disabled={!boardDetailsReady || submittingBoard}
                      className="px-3 py-1.5 bg-content-secondary text-surface-page rounded text-xs font-medium disabled:opacity-40"
                    >
                      {submittingBoard ? 'Submitting…' : 'Submit board details'}
                    </button>
                    {!boardDetailsReady && (
                      <span className="text-xs text-content-muted">
                        Add a location or access info to submit.
                      </span>
                    )}
                  </div>
                )}

                {boardError && (
                  <p className="text-xs text-red-400">{boardError}</p>
                )}
              </div>
            )}

            {/* Submit another session */}
            {allSettled && (
              <div className="px-4 py-4 flex justify-center">
                <button
                  onClick={handleReset}
                  className="text-sm text-content-muted underline hover:text-content-secondary transition-colors"
                >
                  Submit another photo
                </button>
              </div>
            )}

          </div>
        )}

      </main>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

// Small thumbnail in the strip with a status indicator overlay.
// Only rendered in the multi-photo thumbnail strip.
function JobThumbnail({ job }: { job: JobState }) {
  const ringColor =
    job.status === 'uploading' || job.status === 'extracting' ? 'ring-content-secondary' :
    job.status === 'complete'                                  ? 'ring-green-600/70' :
    job.status === 'failed'                                    ? 'ring-red-500/70' :
    'ring-transparent'

  return (
    <div
      className={`relative w-12 h-12 rounded overflow-hidden shrink-0 ring-2 ${ringColor}`}
      title={job.file?.name ?? 'Resumed photo'}
    >
      {job.preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={job.preview} alt="" className="w-full h-full object-cover" />
      ) : (
        // Resumed job whose signed preview URL hasn't resolved yet (or failed)
        <div className="w-full h-full bg-surface-raised" />
      )}

      <div className={`absolute inset-0 flex items-center justify-center ${job.status === 'queued' ? 'bg-black/40' : ''}`}>
        {job.status === 'queued' && (
          <span className="w-1.5 h-1.5 rounded-full bg-white/80" />
        )}
        {job.status === 'failed' && (
          <span className="text-red-300 text-base leading-none drop-shadow font-bold">✗</span>
        )}
      </div>
    </div>
  )
}

// Results section for one completed or failed job.
function JobResult({ job, jobNumber }: {
  job:       JobState
  jobNumber: number
}) {
  // Shown regardless of count now, same as the thumbnail strip/status line —
  // only the board-details form stays single-photo-only, since that one's a
  // content decision (which board this is), not a UI one.
  const label = `Photo ${jobNumber}`

  if (job.status === 'failed') {
    return (
      <div className="px-4 py-3 space-y-1">
        {label && <p className="text-xs font-medium text-content-secondary">{label}</p>}
        <p className="text-xs text-red-400">
          {job.uploadError ?? job.extractionError ?? 'Failed'}
        </p>
      </div>
    )
  }

  const groups = groupByCategory(job.sightings)

  return (
    <div className="px-4 py-3 space-y-4">

      <div className="flex items-baseline gap-2">
        {label && <p className="text-xs font-medium text-content-secondary">{label}</p>}
        <span className="text-xs text-content-muted">
          Found {job.sightings.length} poster{job.sightings.length !== 1 ? 's' : ''} on this board
        </span>
      </div>

      {/* Fast-path warnings from the extract function */}
      {job.warnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-400">⚠ {w}</p>
      ))}

      {job.sightings.length === 0 && (
        <p className="text-xs text-content-muted">No events extracted from this photo.</p>
      )}

      {groups.map(({ category, label: catLabel, items }) => (
        <div key={category ?? '__uncategorized__'} className="space-y-1.5">

          {/* Category header — colored dot + label */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: category ? categoryColor(category) : 'var(--color-content-muted)' }}
            />
            <span className="text-xs font-medium text-content-secondary uppercase tracking-wide">
              {catLabel}
            </span>
          </div>

          <div className="space-y-2">
            {items.map((s) => {
              const hardToRead = s.extraction_confidence < 0.5
              return (
                <div key={s.id} className="space-y-0.5 pl-3">
                  <div className="flex items-center justify-between gap-4">
                    <Link
                      href={`/events/${s.events?.id}`}
                      className="text-sm text-content-secondary hover:text-content-primary truncate"
                    >
                      {s.events?.name ?? '(unnamed)'}
                    </Link>
                    {contributionBadge(s.match_type)}
                  </div>
                  {hardToRead && (
                    <p className="text-xs text-content-muted">Hard to read — a sharper photo would help.</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}