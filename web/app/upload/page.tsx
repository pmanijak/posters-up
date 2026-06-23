'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'
import exifr from 'exifr'

async function resizeImage(file: File, maxDimension = 2400): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width * scale
  canvas.height = bitmap.height * scale
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise(resolve => canvas.toBlob(resolve as any, 'image/jpeg', 0.85))
}

// Advances linearly from 0 to 95 over 75 seconds.
// Jumps to 100 when the caller invokes the returned complete() function.
function useProgress(active: boolean) {
  const [progress, setProgress] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (active) {
      setProgress(0)
      const duration = 75_000
      const target   = 95
      const tick     = 250
      const step     = (target / duration) * tick

      intervalRef.current = setInterval(() => {
        setProgress(p => {
          const next = p + step
          return next >= target ? target : next
        })
      }, tick)
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [active])

  function complete() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setProgress(100)
  }

  function reset() {
    setProgress(0)
  }

  return { progress, complete, reset }
}

export default function UploadPage() {
  const supabase = createClient()

  // Auth
  const [user, setUser]         = useState<any>(null)
  const [loading, setLoading]   = useState(true)
  const [step, setStep]         = useState<'email' | 'code'>('email')
  const [email, setEmail]       = useState('')
  const [code, setCode]         = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Upload
  const [uploading, setUploading] = useState(false)
  const [results, setResults]     = useState<any>(null)
  const [showRaw, setShowRaw]     = useState(false)

  // Board details submission
  const [locationName, setLocationName]                                 = useState('')
  const [description, setDescription]                                   = useState('')
  const [requiresEntryToPhotograph, setRequiresEntryToPhotograph]       = useState<boolean | null>(null)
  const [requiresEntryToPost, setRequiresEntryToPost]                   = useState<boolean | null>(null)
  const [submittingBoard, setSubmittingBoard]                           = useState(false)
  const [boardSubmitted, setBoardSubmitted]                             = useState(false)
  const [boardError, setBoardError]                                     = useState<string | null>(null)

  const { progress, complete, reset } = useProgress(uploading)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When a board_id comes back, fetch its existing values to pre-populate.
  useEffect(() => {
    if (!results?.board_id) return
    setBoardSubmitted(false)
    setBoardError(null)
    setRequiresEntryToPhotograph(null)
    setRequiresEntryToPost(null)

    supabase
      .from('boards')
      .select('location_name, description')
      .eq('id', results.board_id)
      .maybeSingle()
      .then(({ data }) => {
        setLocationName(data?.location_name ?? '')
        setDescription(data?.description ?? '')
      })
  }, [results?.board_id])

  // Send a 8-digit OTP to their email.
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

  // Verify the OTP code, then immediately register a passkey for next time.
  async function verifyCode() {
    setSubmitting(true)
    setError(null)
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    })
    if (error) {
      setError(error.message)
      setSubmitting(false)
      return
    }
    if (data.user) {
      setUser(data.user)
    }
    setSubmitting(false)
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return

    setUploading(true)
    setError(null)
    setResults(null)
    reset()

    try {
      const [gps, exifData] = await Promise.all([
        exifr.gps(file).catch(() => null),
        exifr.parse(file, ['DateTimeOriginal']).catch(() => null),
      ])

      const lat          = gps?.latitude ?? null
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
            'Authorization': `Bearer ${session?.access_token}`
          },
          body: JSON.stringify({ photo_path: path, lat, lng, capture_date })
        }
      )

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
      complete()
      setResults(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function submitBoardDetails() {
    if (!results?.board_id) return

    const trimmedName = locationName.trim()
    const trimmedDesc = description.trim()
    if (!trimmedName && !trimmedDesc && requiresEntryToPhotograph === null && requiresEntryToPost === null) return

    setSubmittingBoard(true)
    setBoardError(null)

    const { error } = await supabase
      .from('board_submissions')
      .insert({
        board_id:                     results.board_id,
        location_name:                trimmedName || null,
        description:                  trimmedDesc || null,
        requires_entry_to_photograph: requiresEntryToPhotograph,
        requires_entry_to_post:       requiresEntryToPost,
      })

    setSubmittingBoard(false)

    if (error) {
      setBoardError(error.message)
    } else {
      setBoardSubmitted(true)
    }
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

          {/* Email OTP */}
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
                  if (val.length === 8) verifyCode()
                }}
                disabled={submitting}
                className="w-full bg-surface-card border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle tracking-widest disabled:opacity-50"
              />
              <button
                onClick={verifyCode}
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

      {/* Header — same grid layout as PageHeader: ← Events | Posters Up | email */}
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
            {uploading ? 'Extracting events…' : 'Choose a photo'}
            <input
              type="file"
              accept="image/*"
              onChange={upload}
              disabled={uploading}
              className="sr-only"
            />
          </label>

          {/* Progress bar */}
          {uploading && (
            <div className="space-y-1.5">
              <div className="h-1 w-full bg-surface-raised rounded-full overflow-hidden">
                <div
                  className="h-full bg-content-secondary rounded-full"
                  style={{
                    width: `${progress}%`,
                    transition: 'width 0.25s linear',
                  }}
                />
              </div>
              <p className="text-xs text-content-muted text-right">
                {Math.round(progress)}%
              </p>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {/* Results */}
        {results && (
          <div className="bg-surface-card rounded-sm border border-edge divide-y divide-edge">

            <div className="px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-content-primary font-medium">
                {results.events_extracted} event{results.events_extracted !== 1 ? 's' : ''} extracted
              </span>
              {results.board_id
                ? <span className="text-xs text-content-muted">board linked</span>
                : <span className="text-xs text-amber-400">no board — GPS missing</span>
              }
            </div>

            {results.warnings?.length > 0 && (
              <div className="px-4 py-3 space-y-1">
                {results.warnings.map((w: string, i: number) => (
                  <p key={i} className="text-xs text-amber-400">⚠ {w}</p>
                ))}
              </div>
            )}

            {results.events?.length > 0 && (
              <div className="px-4 py-3 space-y-1">
                {results.events.map((e: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-content-secondary truncate">{e.name}</span>
                    <span className="text-xs text-content-muted shrink-0">{e.match_type ?? 'new'}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Board details — only shown when a board was linked */}
            {results.board_id && (
              <div className="px-4 py-5 space-y-5">

                <div>
                  <p className="text-sm font-medium text-content-primary">Where is this board?</p>
                  <p className="text-xs text-content-muted mt-1">
                    Help future contributors and visitors find it in person.
                  </p>
                </div>

                {/* Business or place name */}
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

                {/* Navigation description */}
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

                {/* Requires entry to photograph */}
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

                {/* Requires entry to post */}
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

            <div className="px-4 py-3">
              <button
                onClick={() => setShowRaw(r => !r)}
                className="text-xs text-content-muted hover:text-content-secondary"
              >
                {showRaw ? 'Hide' : 'Show'} raw JSON
              </button>
              {showRaw && (
                <pre className="mt-3 text-xs text-content-muted overflow-auto leading-relaxed">
                  {JSON.stringify(results, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}