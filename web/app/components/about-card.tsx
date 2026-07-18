'use client'

import Link from 'next/link'
import { LogoMark } from './logo'

export function AboutCard() {
  return (
    <div className="rounded-sm border border-dashed border-edge">
      <div className="px-4 py-3 space-y-3">
        {/* Mark + title. size 28 suits text-xl; gap ~⅓ of the mark's width. */}
        <div className="flex items-center gap-2.5">
          <h2 className="font-marker text-xl text-content-primary">About Posters Up</h2>
          <LogoMark size={28}/>
        </div>
        <p className="text-sm leading-relaxed text-content-secondary">
          Hi. Thanks for visiting.
        </p>
        <p className="text-sm leading-relaxed text-content-secondary">
          This project was started in Olympia, Washington, to see if we can find
          out what&apos;s happening by taking photos of the bulletin boards downtown.
          It turns out, we can.
        </p>
        <p className="text-sm leading-relaxed text-content-secondary">
          Anybody can add photos, so even if you&apos;re not in Olympia,
          it can work for you if you have lots of posters in your neighborhood.
        </p>
        {/* Links styled like event-card tags */}
        <div className="flex flex-wrap gap-1">
          <Link
            href="/privacy"
            className="text-xs px-2 py-0.5 rounded-full bg-surface-raised text-content-muted transition-colors hover:text-content-secondary"
          >
            Privacy policy
          </Link>
          <Link
            href="/contact"
            className="text-xs px-2 py-0.5 rounded-full bg-surface-raised text-content-muted transition-colors hover:text-content-secondary"
          >
            Contact
          </Link>
        </div>

        {/* Footer — mirrors event-card's Tell-me-more row */}
        <div className="flex items-center justify-end mt-3 pt-2.5 border-t border-edge">
          <Link href="/upload" className="text-xs text-content-muted">
            Submit a photo →
          </Link>
        </div>
      </div>
    </div>
  )
}