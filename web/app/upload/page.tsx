'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase'
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
  } | null
}

type ExtractionStatus = 'pending' | 'complete' | 'failed'

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

function matchTypeBadge(matchType: string | null) {
  const label = matchType ?? 'new'
  const colors: Record<string, string> = {
    new:             'text-emerald-400',
    url:             'text-sky-400',
    talent_anchor:   'text-violet-400',
    location_anchor: 'text-amber-400',
    fuzzy:           'text-content-muted',
  }
  return (
    <span className={`text-xs shrink-0 ${colors[label] ?? 'text-content-muted'}`}>
      {label}
    </span>
  )
}

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

  // Upload
  const [uploading, setUploading]       = useState(false)
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null)

  // Extraction polling
  const [extractionStatus, setExtractionStatus] = useState<ExtractionStatus | null>(null)
  const [sightings, setSightings]               = useState<SightingRow[]>([])
  const [extractionError, setExtractionError]   = useState<string | null>(null)
  const [showRaw, setShowRaw]                   = useState(false)

  // Board details submission
  const [locationName, setLocationName]                               = useState('')
  const [description, setDescription]                                 = useState('')
  const [requiresEntryToPhotograph, setRequiresEntryToPhotograph]     = useState<boolean | null>(null)
  const [requiresEntryToPost, setRequiresEntryToPost]                 = useState<boolean | null>(null)
  const [submittingBoard, setSubmittingBoard]                         = useState(false)
  const [boardSubmitted, setBoardSubmitted]                           = useState(false)
  const [boardError, setBoardError]                                   = useState<string | null>(null)

  // Auth check on mount.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  }, [])

  // When a board_id comes back, fetch its existing values to pre-populate
  // the board details form and reset submission state.
  // All setState calls are in .then() to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!submitResult?.board_id) return
    supabase
      .from('boards')
      .select('location_name, description')
      .eq('id', submitResult.board_id)
      .maybeSingle()
      .then(({ data }) => {
        setBoardSubmitted(false)
        setBoardError(null)
        setRequiresEntryToPhotograph(null)
        setRequiresEntryToPost(null)
        setLocationName(data?.location_name ?? '')
        setDescription(data?.description ?? '')
      })
  }, [submitResult?.board_id])

  // Poll /api/photos/[id]/sightings every 3 seconds until complete or failed.
  // Starts as soon as we have a photo_id from the submit response.
  // State resets are inside poll() before the first await, not in the effect
  // body — satisfies react-hooks/set-state-in-effect.
  useEffect(() => {
    const photoId = submitResult?.photo_id
    if (!photoId) return

    let cancelled = false

    async function poll() {
      // Resets go here, before the first await, so they run synchronously
      // on poll() invocation but are inside a function, not the effect body.
      setExtractionStatus('pending')
      setSightings([])
      setExtractionError(null)

      const { data: { session } } = await supabase.auth.getSession()

      while (!cancelled) {
        await new Promise(r => setTimeout(r, 3000))
        if (cancelled) break

        let res: Response
        try {
          res = await fetch(`/api/photos/${photoId}/sightings`, {
            headers: { Authorization: `Bearer ${session?.access_token}` },
          })
        } catch {
          // Network error — keep trying
          continue
        }

        if (!res.ok) break

        const data = await res.json()

        if (data.extraction_status === 'complete') {
          setSightings(data.sightings ?? [])
          setExtractionStatus('complete')
          break
        } else if (data.extraction_status === 'failed') {
          setExtractionError(data.extraction_error ?? 'Extraction failed')
          setExtractionStatus('failed')
          break
        }
        // still 'pending' — loop continues
      }
    }

    poll()
    return () => { cancelled = true }
  }, [submitResult?.photo_id])

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

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return

    setUploading(true)
    setError(null)
    setSubmitResult(null)
    setExtractionStatus(null)
    setSightings([])
    setExtractionError(null)

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

      const path = `${user.id}/${Date.now()}-${file.name}`
      const { error: uploadError } = await supabase.storage
        .from('photos-raw')
        .upload(path, resized)

      if (uploadError) throw uploadError

      const { data: { session } } = await supabase.auth.getSession()

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/extract`,
        {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ photo_path: path, lat, lng, capture_date }),
        }
      )

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setSubmitResult(data as SubmitResult)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function submitBoardDetails() {
    if (!submitResult?.board_id) return

    const trimmedName = locationName.trim()
    const trimmedDesc = description.trim()
    if (!trimmedName && !trimmedDesc && requiresEntryToPhotograph === null && requiresEntryToPost === null) return

    setSubmittingBoard(true)
    setBoardError(null)

    const { error } = await supabase
      .from('board_submissions')
      .insert({
        board_id:                     submitResult.board_id,
        location_name:                trimmedName || null,
        description:                  trimmedDesc || null,
        requires_entry_to_photograph: requiresEntryToPhotograph,
        requires_entry_to_post:       requiresEntryToPost,
      })

    setSubmittingBoard(false)
    if (error) setBoardError(error.message)
    else setBoardSubmitted(true)
  }

  const boardDetailsReady =
    locationName.trim().length > 0 ||
    description.trim().length > 0 ||
    requiresEntryToPhotograph !== null ||
    requiresEntryToPost !== null

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

        {/* Upload */}
        <div className="bg-surface-card rounded-sm border border-edge p-6 space-y-4">
          <p className="text-sm text-content-secondary">
            Photograph a bulletin board and submit it. GPS and capture date are read
            automatically from the photo.
          </p>

          <label className={[
            'flex items-center justify-center w-full h-24 rounded border border-dashed border-edge-subtle text-sm cursor-pointer transition-colors',
            uploading
              ? 'text-content-muted cursor-not-allowed'
              : 'text-content-muted hover:border-content-muted hover:text-content-secondary',
          ].join(' ')}>
            {uploading ? 'Uploading…' : 'Choose a photo'}
            <input
              type="file"
              accept="image/*"
              onChange={upload}
              disabled={uploading}
              className="sr-only"
            />
          </label>

          {uploading && (
            <div className="h-1 w-full bg-surface-raised rounded-full overflow-hidden">
              <div className="h-full w-full bg-content-secondary rounded-full animate-pulse" />
            </div>
          )}
        </div>

        {/* Upload error */}
        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {/* Post-submit panel */}
        {submitResult && (
          <div className="bg-surface-card rounded-sm border border-edge divide-y divide-edge">

            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-content-primary font-medium">Photo submitted</span>
              {submitResult.board_id
                ? <span className="text-xs text-content-muted">board linked</span>
                : <span className="text-xs text-amber-400">no board — GPS missing</span>
              }
            </div>

            {/* Fast-path warnings (GPS missing, rate limit config, etc.) */}
            {submitResult.warnings && submitResult.warnings.length > 0 && (
              <div className="px-4 py-3 space-y-1">
                {submitResult.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-400">⚠ {w}</p>
                ))}
              </div>
            )}

            {/* Extraction status */}
            {extractionStatus === 'pending' && (
              <div className="px-4 py-3 space-y-2">
                <p className="text-xs text-content-muted">Extracting events…</p>
                <div className="h-0.5 w-full bg-surface-raised rounded-full overflow-hidden">
                  <div className="h-full w-full bg-content-secondary rounded-full animate-pulse" />
                </div>
              </div>
            )}

            {extractionStatus === 'failed' && (
              <div className="px-4 py-3">
                <p className="text-xs text-red-400">Extraction failed: {extractionError}</p>
              </div>
            )}

            {extractionStatus === 'complete' && (
              <div className="px-4 py-3 space-y-1">
                <p className="text-xs text-content-muted mb-2">
                  {sightings.length} item{sightings.length !== 1 ? 's' : ''} extracted
                </p>
                {sightings.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-4">
                    <Link
                      href={`/events/${s.events?.id}`}
                      className="text-sm text-content-secondary hover:text-content-primary truncate"
                    >
                      {s.events?.name ?? '(unnamed)'}
                    </Link>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.flyer_style === 'minimal' && (
                        <span className="text-xs text-content-muted">minimal</span>
                      )}
                      <span className="text-xs text-content-muted">
                        {Math.round(s.extraction_confidence * 100)}%
                      </span>
                      {matchTypeBadge(s.match_type)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Board details — shown as soon as board_id is available, before extraction finishes */}
            {submitResult.board_id && (
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

            {/* Raw JSON — shows sightings when available, submit result otherwise */}
            <div className="px-4 py-3">
              <button
                onClick={() => setShowRaw(r => !r)}
                className="text-xs text-content-muted hover:text-content-secondary"
              >
                {showRaw ? 'Hide' : 'Show'} raw JSON
              </button>
              {showRaw && (
                <pre className="mt-3 text-xs text-content-muted overflow-auto leading-relaxed">
                  {JSON.stringify(sightings.length > 0 ? sightings : submitResult, null, 2)}
                </pre>
              )}
            </div>

          </div>
        )}
      </main>
    </div>
  )
}