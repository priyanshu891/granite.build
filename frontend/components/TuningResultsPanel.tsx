'use client'

import { useQuery } from '@tanstack/react-query'
import {
  StructuredListWrapper,
  StructuredListHead,
  StructuredListRow,
  StructuredListCell,
  StructuredListBody,
  ProgressBar,
  InlineNotification,
  Button,
} from '@carbon/react'
import { getJobAssets } from '@/api/autotunex'

function formatSize(bytes: number): string {
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / 1_048_576).toFixed(2)} MB`
}

interface Props {
  jobId: string
}

export function TuningResultsPanel({ jobId }: Props) {
  const { data: assets = [], isLoading } = useQuery({
    queryKey: ['autotunex-job-assets', jobId],
    queryFn: () => getJobAssets(jobId),
  })

  if (isLoading) {
    return <ProgressBar size="small" label="Loading" helperText="Loading result details..." />
  }

  if (assets.length === 0) {
    return <InlineNotification kind="info" title="No results data available" hideCloseButton />
  }

  return (
    <StructuredListWrapper>
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head>File name</StructuredListCell>
          <StructuredListCell head>File size</StructuredListCell>
          <StructuredListCell head>Created on</StructuredListCell>
          <StructuredListCell head />
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {assets.map((asset) => (
          <StructuredListRow key={asset.filename}>
            <StructuredListCell>{asset.filename}</StructuredListCell>
            <StructuredListCell>{formatSize(asset.size)}</StructuredListCell>
            <StructuredListCell>{new Date(asset.modified).toLocaleString()}</StructuredListCell>
            <StructuredListCell>
              <Button kind="ghost" size="sm" disabled title="Backend not wired up yet">
                Download
              </Button>
            </StructuredListCell>
          </StructuredListRow>
        ))}
      </StructuredListBody>
    </StructuredListWrapper>
  )
}
