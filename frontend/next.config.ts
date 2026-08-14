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
          // trailingSlash: true means requests can arrive with a trailing slash
          // (e.g. /api/v1/spaces/). With only a `:path*` rule, Next.js's rewrite
          // matcher drops that trailing slash when building the destination, so
          // the proxied request reaches gbserver as /api/v1/spaces — which then
          // 404s (or, pre-fix on the gbserver side, 307-redirected to an
          // absolute gbserver URL that the browser followed cross-origin into a
          // CORS error). A dedicated `:path*/` rule preserves it, per
          // https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites#rewriting-to-an-external-url
          const rules: { source: string; destination: string }[] = []
          if (autotunexApiUrl) {
            rules.push(
              {
                source: '/api/autotunex/:path*/',
                destination: `${autotunexApiUrl}/api/v1/:path*/`,
              },
              {
                source: '/api/autotunex/:path*',
                destination: `${autotunexApiUrl}/api/v1/:path*`,
              }
            )
          }
          if (gbserverApiUrl) {
            rules.push(
              { source: '/api/:path*/', destination: `${gbserverApiUrl}/api/:path*/` },
              { source: '/api/:path*', destination: `${gbserverApiUrl}/api/:path*` }
            )
          }
          return rules
        },
      }
    : {}),
}

export default nextConfig
