// app/privacy/page.tsx
//
// Server component. Reads privacy/policy.md, injects the {{TOKEN}}
// placeholders (contact email, account URL, policy dates) from lib/site.ts,
// and renders it with react-markdown, styled by Tailwind Typography's
// `prose` class. The prose color variables are remapped to this app's
// dark-theme tokens in globals.css (see .prose override there) so headings,
// links, and lists match the rest of the app instead of Typography's
// light-mode defaults.

import fs from 'node:fs'
import path from 'node:path'
import type { Metadata } from 'next'
import ReactMarkdown from 'react-markdown'
import { CONTACT_EMAIL, SITE_TITLE, SITE_URL } from '@/lib/site'

// Bump POLICY_LAST_UPDATED whenever the policy text changes;
// POLICY_EFFECTIVE_DATE is the date it first took effect.
const POLICY_EFFECTIVE_DATE = 'DRAFT'
const POLICY_LAST_UPDATED = 'July 9, 2026'

export const metadata: Metadata = {
  title: `Privacy Policy — ${SITE_TITLE}`,
  description:
    'How Posters Up collects, uses, and protects information -- an observational, no-profiles bulletin-board event app.',
}

// Token substitution. Keep this list in sync with the {{PLACEHOLDERS}}
// used in privacy/policy.md.
function renderPolicyMarkdown(): string {
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'app', 'privacy', 'policy.md'),
    'utf8'
  )

  const tokens: Record<string, string> = {
    CONTACT_EMAIL,
    ACCOUNT_URL: `${SITE_URL}/account`,
    POLICY_EFFECTIVE_DATE,
    POLICY_LAST_UPDATED,
  }

  return Object.entries(tokens).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value),
    raw
  )
}

export default function PrivacyPolicyPage() {
  const markdown = renderPolicyMarkdown()

  return (
    <main className="mx-auto max-w-2xl px-5 py-12">
      <article className="prose max-w-none">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </article>
    </main>
  )
}