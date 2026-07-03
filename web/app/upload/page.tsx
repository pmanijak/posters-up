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
  file:            File
  preview:         string        // object URL; revoked on reset/unmount
  status:          JobStatus
  progress:        number        // 0–100; drives the per-job progress bar
  submitResult:    SubmitResult | null
  sightings:       SightingRow[]
  extractionError: string | null
  uploadError:     string | null
  warnings:        string[]
}

// ── Supabase client ────────────────────────────────────────────────────────

// Stable across renders — no component-level deps.
const supabase = createClient()

// ── Helpers ────────────────────────────────────────────────────────────────

async function resizeImage(file: File, maxDimension = 2400): Promise<Blob> {
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
  const processingRef   = useRef(false)  // prevents double-starts; guards the queue useEffect
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

  // Merges a partial patch into one job by id.
  function updateJob(id: string, patch: Partial<JobState>) {
    if (!mountedRef.current) return
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j))
  }

  // Full pipeline for one photo: EXIF → resize → upload → extract Edge Function → poll.
  // Drives the job's status and progress directly via updateJob.
  // Sets processingRef.current = false on all exit paths so the queue useEffect
  // picks up the next queued job.
  async function processJob(job: JobState) {
    if (!mountedRef.current) { processingRef.current = false; return }

    // ── Phase 1: upload ──────────────────────────────────────────────────

    updateJob(job.id, { status: 'uploading', progress: 0 })

    let submitResult: SubmitResult | null = null

    try {
      const [gps, exifData] = await Promise.all([
        exifr.gps(job.file).catch(() => null),
        exifr.parse(job.file, ['DateTimeOriginal']).catch(() => null),
      ])

      const lat          = gps?.latitude  ?? null
      const lng          = gps?.longitude ?? null
      const capture_date = exifData?.DateTimeOriginal
        ? new Date(exifData.DateTimeOriginal).toISOString()
        : null

      const resized = await resizeImage(job.file)

      const { data: { user: authUser } } = await supabase.auth.getUser()
      const path = `${authUser!.id}/${Date.now()}-${job.file.name}`

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
      processingRef.current = false
      return
    }

    // ── Phase 2: poll for extraction ─────────────────────────────────────

    if (!submitResult?.photo_id) {
      // extract didn't return a photo_id — nothing to poll
      updateJob(job.id, { status: 'complete', progress: 100 })
      processingRef.current = false
      return
    }

    const photoId = submitResult.photo_id

    // Animate 0 → 95% over 75 s while we wait for the extraction worker.
    const startTime = Date.now()
    const progressInterval = setInterval(() => {
      if (!mountedRef.current) { clearInterval(progressInterval); return }
      const elapsed = Date.now() - startTime
      const frac    = Math.min(elapsed / PROGRESS_DURATION_MS, 1)
      updateJob(job.id, { progress: Math.round(frac * PROGRESS_TARGET) })
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

        if (data.sightings) updateJob(job.id, { sightings: data.sightings })

        if (data.extraction_status === 'complete') {
          clearInterval(progressInterval)
          updateJob(job.id, {
            status:    'complete',
            progress:  100,
            sightings: data.sightings ?? [],
          })
          break
        } else if (data.extraction_status === 'failed') {
          clearInterval(progressInterval)
          updateJob(job.id, {
            status:          'failed',
            extractionError: data.extraction_error ?? 'Extraction failed',
          })
          break
        }
      }
    } finally {
      // processingRef must be cleared before the final setJobs triggers the
      // queue useEffect. async/finally runs synchronously before React flushes
      // the queued render, so the guard is already false when the effect fires.
      clearInterval(progressInterval)
      processingRef.current = false
    }
  }

  // Auth check on mount.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Sequential queue processor. Fires whenever `jobs` changes; starts the next
  // queued job if nothing is currently running. `processingRef` prevents double-starts:
  // setJobs inside processJob triggers this effect while processJob is still awaiting,
  // and the guard bails out. When processJob finishes it sets processingRef.current = false
  // synchronously before the final setJobs triggers a re-render, so the next invocation
  // of this effect correctly sees it as free.
  useEffect(() => {
    if (processingRef.current) return
    const next = jobs.find(j => j.status === 'queued')
    if (!next) return
    processingRef.current = true
    // setTimeout defers processJob out of the synchronous effect body,
    // avoiding the "setState inside effect" linter warning. The guard above
    // is already set, so a re-render between here and the next tick is safe.
    setTimeout(() => void processJob(next), 0)
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
    }))

    setJobs(prev => [...prev, ...newJobs])
    e.target.value = '' // reset so the same file can be re-selected
  }

  // Resets all queue and board-form state so the contributor can start a new session.
  function handleReset() {
    jobs.forEach(j => URL.revokeObjectURL(j.preview))
    setJobs([])
    setLastBoardId(null)
    setBoardSubmitted(false)
    setBoardError(null)
    setLocationName('')
    setDescription('')
    setRequiresEntryToPhotograph(null)
    setRequiresEntryToPost(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
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

  const activeJob  = jobs.find(j => j.status === 'uploading' || j.status === 'extracting')
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

            {/* Thumbnail strip + queue status — only shown for multi-photo */}
            {jobs.length > 1 && (
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
                    {activeJob
                      ? `Processing photo ${doneCount + 1} of ${jobs.length}…`
                      : `${doneCount} of ${jobs.length} done`
                    }
                  </p>
                )}
              </div>
            )}

            {/* Progress bar — shown for the active job only.
                'uploading' uses animate-pulse (fast, indeterminate);
                'extracting' uses the 0→95 linear animation. */}
            {activeJob && (
              <div className="px-4 py-3 space-y-1.5">
                <div className="h-1 w-full bg-surface-raised rounded-full overflow-hidden">
                  {activeJob.status === 'uploading' ? (
                    <div className="h-full w-full bg-content-secondary rounded-full animate-pulse" />
                  ) : (
                    <div
                      className="h-full bg-content-secondary rounded-full"
                      style={{ width: `${activeJob.progress}%`, transition: 'width 0.25s linear' }}
                    />
                  )}
                </div>
                <p className="text-xs text-content-muted">
                  {activeJob.status === 'uploading'
                    ? 'Uploading…'
                    : progressMessage(activeJob.progress)
                  }
                </p>
              </div>
            )}

            {/* Per-job results — appear as each photo completes or fails */}
            {jobs
              .filter(j => j.status === 'complete' || j.status === 'failed')
              .map((job, idx) => (
                <JobResult
                  key={job.id}
                  job={job}
                  jobNumber={idx + 1}
                  totalJobs={jobs.length}
                />
              ))
            }

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
      title={job.file.name}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={job.preview} alt="" className="w-full h-full object-cover" />

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
function JobResult({ job, jobNumber, totalJobs }: {
  job:       JobState
  jobNumber: number
  totalJobs: number
}) {
  // Only show "Photo N" label when there are multiple photos.
  const label = totalJobs > 1 ? `Photo ${jobNumber}` : null

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