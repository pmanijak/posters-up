'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase'

async function resizeImage(file: File, maxDimension = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width * scale
  canvas.height = bitmap.height * scale
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise(resolve => canvas.toBlob(resolve as any, 'image/jpeg', 0.85))
}

export default function Home() {
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  // Check for existing session on load
  useState(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
    })
  })

  async function signIn() {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: 'http://localhost:3000/auth/callback' }
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return

    const resized = await resizeImage(file)

    setUploading(true)
    setError(null)
    setResults(null)

    try {
      // Upload to storage
      const path = `${user.id}/${Date.now()}-${file.name}`
      const { error: uploadError } = await supabase.storage
        .from('photos-raw')
        .upload(path, resized)

      if (uploadError) throw uploadError

      // Get session token
      const { data: { session } } = await supabase.auth.getSession()

      // Call extract function
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/extract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`
          },
          body: JSON.stringify({ photo_path: path })
        }
      )

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
      setResults(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  if (!user) return (
    <main className="max-w-md mx-auto mt-20 p-6 space-y-4">
      <h1 className="text-2xl font-bold">Posters Up</h1>
      {sent ? (
        <p className="text-green-600">Check your email for a sign-in link.</p>
      ) : (
        <>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full border rounded px-3 py-2"
          />
          <button
            onClick={signIn}
            className="w-full bg-black text-white rounded px-3 py-2"
          >
            Send sign-in link
          </button>
        </>
      )}
      {error && <p className="text-red-500">{error}</p>}
    </main>
  )

  return (
    <main className="max-w-2xl mx-auto mt-20 p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Posters Up</h1>
        <span className="text-sm text-gray-500">{user.email}</span>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">
          Upload a bulletin board photo
        </label>
        <input
          type="file"
          accept="image/*"
          onChange={upload}
          disabled={uploading}
          className="block"
        />
        {uploading && <p className="text-gray-500 mt-2">Extracting events...</p>}
      </div>

      {error && <p className="text-red-500">{error}</p>}

      {results && (
        <div className="space-y-2">
          <p className="font-medium">{results.events_extracted} events extracted</p>
          <pre className="bg-gray-100 rounded p-4 text-xs overflow-auto">
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )}
    </main>
  )
}