// web/app/manifest.ts
import { MetadataRoute } from 'next'
import { SITE_TITLE, SITE_DESCRIPTION } from '@/lib/site'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             SITE_TITLE,
    short_name:       SITE_TITLE,
    description:      SITE_DESCRIPTION,
    start_url:        '/',
    display:          'standalone',
    background_color: '#1E2420',
    theme_color:      '#1E2420',
    icons: [
      { src: '/icons/icon-192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}