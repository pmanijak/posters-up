'use client'

import Link from 'next/link'

export function AboutCard() {
  return (
    <div className="rounded-sm overflow-hidden bg-surface-card border border-dashed border-edge">
      <div className="px-4 py-3 space-y-3">

        <h2 className="font-marker text-xl text-content-primary">About Posters Up</h2>

        <p className="text-sm leading-relaxed text-content-secondary">
          Hi. Thanks for visiting.
        </p>
        <p className="text-sm leading-relaxed text-content-secondary">
          This project was started in Olympia, Washington, to see if we can find
          out what's happening by taking photos of the bulletin boards downtown.
          It turns out, we can.
        </p>
        <p className="text-sm leading-relaxed text-content-secondary">
          Anybody can add photos, so even if you're not in Olympia,
          it can work for you if you have lots of posters in your neighborhood.
        </p>

        <div className="pt-0.5">
          <Link href="/upload" className="text-xs text-content-secondary">
            Submit a photo →
          </Link>
        </div>

      </div>
    </div>
  )
}