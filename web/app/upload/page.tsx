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
      const duration = 75_000   // ms
      const target   = 95       // %
      const tick     = 250      // ms between updates
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
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  const { progress, complete, reset } = useProgress(uploading)

  useState(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  })

  async function signIn() {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    })
    if (error) setError(error.message)
    else setSent(true)
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

      const lat = gps?.latitude ?? null
      const lng = gps?.longitude ?? null
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
            'Content-Type': 'application/json',
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

  if (loading) return (
    <div className="min-h-screen bg-surface-page" />
  )

  if (!user) return (
    <div className="min-h-screen bg-surface-page flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="font-marker text-3xl text-content-primary">Posters Up</h1>
          <p className="text-sm mt-1 text-content-muted">Sign in to submit photos</p>
        </div>

        {sent ? (
          <p className="text-sm text-content-secondary">
            Check your email for a sign-in link.
          </p>
        ) : (
          <div className="space-y-3">
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && signIn()}
              className="w-full bg-surface-card border border-edge rounded px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:border-edge-subtle"
            />
            <button
              onClick={signIn}
              className="w-full bg-content-secondary text-surface-page rounded px-3 py-2 text-sm font-medium"
            >
              Send sign-in link
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <Link href="/" className="block text-xs text-content-muted hover:text-content-secondary">
          ← Back to events
        </Link>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-surface-page">

      {/* Header */}
      <header className="border-b border-edge">
        <div className="max-w-2xl mx-auto px-4 py-6 flex items-baseline justify-between">
          <div>
            <h1 className="font-marker text-3xl text-content-primary">Posters Up</h1>
            <p className="text-sm mt-0.5 text-content-muted">Submit a bulletin board photo</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-content-muted">{user.email}</span>
            <Link href="/" className="text-xs text-content-muted hover:text-content-secondary">
              ← Events
            </Link>
          </div>
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