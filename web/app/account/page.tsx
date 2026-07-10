'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase'

// Stable across renders — no component-level deps. Same pattern as the
// upload page's client instance.
const supabase = createClient()

export default function AccountPage() {
  const [user, setUser]       = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Sign-in — same email → 8-digit-code flow as the upload page, kept
  // self-contained here since this page has to work for someone arriving
  // directly from the privacy policy, not just someone already signed in
  // from a prior upload session.
  const [step, setStep]             = useState<'email' | 'code'>('email')
  const [email, setEmail]           = useState('')
  const [code, setCode]             = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // Deletion
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deletingAccount, setDeletingAccount]   = useState(false)
  const [deleteError, setDeleteError]           = useState<string | null>(null)
  const [deleted, setDeleted]                   = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
      setLoading(false)
    })
  }, [])

  async function sendOtp() {
    setSubmitting(true)
    setError(null)
    // shouldCreateUser: false — someone landing here to manage or delete an
    // account shouldn't accidentally create a brand-new one. If there's no
    // existing account for this email, Supabase returns an error here,
    // which surfaces as a normal "no account found" style message below.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
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

  // Deletes the signed-in contributor's account via the delete-account Edge
  // Function, then signs out locally and shows a confirmation state.
  async function deleteAccount() {
    setDeletingAccount(true)
    setDeleteError(null)

    const { data: { session } } = await supabase.auth.getSession()

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/delete-account`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
      }
    )

    if (!res.ok) {
      const data = await res.json().catch(() => null)
      setDeleteError(data?.error ?? 'Deletion failed. Please try again.')
      setDeletingAccount(false)
      return
    }

    await supabase.auth.signOut()
    setUser(null)
    setDeleted(true)
  }

  if (loading) return (
    <div className="min-h-screen bg-surface-page" />
  )

  return (
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
          <p className="text-sm mt-1 text-content-muted text-center">Manage your account</p>
        </div>
      </header>

      <div className="flex justify-center px-4 pt-16">
        <div className="w-full max-w-sm space-y-4">

          {deleted ? (
            <div className="bg-surface-card rounded-sm border border-edge p-6 space-y-2 text-center">
              <p className="text-sm text-content-primary">Your account has been deleted.</p>
              <p className="text-xs text-content-muted">
                Your email and any submitted photos not already removed are now deleted from our systems.
              </p>
              <Link href="/" className="inline-block text-xs text-content-secondary underline hover:text-content-primary mt-2">
                Back to Posters Up
              </Link>
            </div>

          ) : !user ? (
            <>
              <p className="text-xs text-content-muted text-center">
                Sign in to view or delete your Posters Up account.
              </p>

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
            </>

          ) : (
            <div className="bg-surface-card rounded-sm border border-edge p-6 space-y-4">
              <div>
                <p className="text-xs text-content-muted">Signed in as</p>
                <p className="text-sm text-content-primary">{user.email}</p>
              </div>

              <div className="border-t border-edge pt-4 space-y-2">
                <p className="text-xs text-content-muted">
                  Deleting your account removes your email and any submitted photos that
                  haven't already been automatically deleted. This can't be undone.
                </p>

                {confirmingDelete ? (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={deleteAccount}
                      disabled={deletingAccount}
                      className="text-xs text-red-400 underline hover:text-red-300 disabled:opacity-50"
                    >
                      {deletingAccount ? 'Deleting…' : 'Yes, delete my account'}
                    </button>
                    <button
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deletingAccount}
                      className="text-xs text-content-muted underline hover:text-content-secondary disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingDelete(true)}
                    className="text-xs text-red-400 underline hover:text-red-300"
                  >
                    Delete account
                  </button>
                )}

                {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}