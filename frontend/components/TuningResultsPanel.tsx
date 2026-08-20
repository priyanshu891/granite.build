'use client'

import {
  StructuredListWrapper,
  StructuredListHead,
  StructuredListRow,
  StructuredListCell,
  StructuredListBody,
  InlineNotification,
  Button,
} from '@carbon/react'

// `output_artifacts` is a loosely-typed name→(path|uri|{uri/url/path,...})
// map straight off the job-detail record — v0.3.5 has no fixed schema for it
// yet (see `GbTask`'s comment in @/types for the same situation). We only
// know how to point a download at it when the value resolves to an absolute
// http(s) URL; anything else (a bare GPFS path, an opaque object) still shows
// its raw location but leaves the download control disabled, same as before.
function resolveArtifactRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    const candidate = v.uri ?? v.url ?? v.path
    if (typeof candidate === 'string') return candidate
  }
  return undefined
}

function artifactUrl(value: unknown): string | undefined {
  const ref = resolveArtifactRef(value)
  return ref && /^https?:\/\//i.test(ref) ? ref : undefined
}

function artifactLocation(value: unknown): string {
  return resolveArtifactRef(value) ?? JSON.stringify(value)
}

interface Props {
  outputArtifacts: Record<string, unknown> | null
}

export function TuningResultsPanel({ outputArtifacts }: Props) {
  const entries = Object.entries(outputArtifacts ?? {})

  if (entries.length === 0) {
    return <InlineNotification kind="info" title="No results data available" hideCloseButton />
  }

  return (
    <StructuredListWrapper>
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head>File name</StructuredListCell>
          <StructuredListCell head>Location</StructuredListCell>
          <StructuredListCell head />
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {entries.map(([name, value]) => {
          const url = artifactUrl(value)
          return (
            <StructuredListRow key={name}>
              <StructuredListCell>{name}</StructuredListCell>
              <StructuredListCell style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {artifactLocation(value)}
              </StructuredListCell>
              <StructuredListCell>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={!url}
                  title={url ? undefined : 'Backend not wired up yet'}
                  {...(url ? { href: url, target: '_blank', rel: 'noreferrer' } : {})}
                >
                  Download
                </Button>
              </StructuredListCell>
            </StructuredListRow>
          )
        })}
      </StructuredListBody>
    </StructuredListWrapper>
  )
}
