import type { NextConfig } from 'next'

if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

const isProd = process.env.NODE_ENV === 'production'
const gbserverApiUrl = process.env.GBSERVER_API_URL
const autotunexApiUrl = process.env.AUTOTUNEX_API_URL

const nextConfig: NextConfig = {
  // output: 'export' is standalone-only — it conflicts with rewrites (used in dev).
  ...(isProd ? { output: 'export' } : {}),
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  // Expose GBSERVER_API_URL to the client bundle without a NEXT_PUBLIC_ prefix.
  env: { GBSERVER_API_URL: gbserverApiUrl ?? '', AUTOTUNEX_API_URL: autotunexApiUrl ?? '' },
  // Dev mode: proxy /api/* to gbserver server-side (no CORS). Optional — omit
  // GBSERVER_API_URL to run the UI with no backend (pages load, data shows empty).
  ...(!isProd && (gbserverApiUrl || autotunexApiUrl)
    ? {
        async rewrites() {
          const rules: { source: string; destination: string }[] = []
          if (autotunexApiUrl) {
            rules.push({
              source: '/api/autotunex/:path*',
              destination: `${autotunexApiUrl}/fmtune/api/:path*`,
            })
          }
          if (gbserverApiUrl) {
            rules.push({ source: '/api/:path*', destination: `${gbserverApiUrl}/api/:path*` })
          }
          return rules
        },
      }
    : {}),
}

export default nextConfig
