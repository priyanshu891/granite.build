'use client'

import { SkeletonText, InlineNotification } from '@carbon/react'
import { useQuery } from '@tanstack/react-query'
import { getJobByBuildId } from '@/api/autotunex'
import { TrialsTable } from '@/components/TrialsTable'
import { TuningLogViewer } from '@/components/TuningLogViewer'

/**
 * Trials & Logs for the AutoTuneX tuning job linked to a build, mirroring the
 * AutoTuneX tuning detail page. Both panels share the linked-job query with
 * AutoTuneXPanel (same query key), so they resolve from cache.
 */

// Shared fetch of the tuning job linked to this build.
function useLinkedTuningJob(buildId: string) {
  return useQuery({
    queryKey: ['autotunex-job-by-build', buildId],
    queryFn: () => getJobByBuildId(buildId),
  })
}

function Loading() {
  return (
    <div style={{ padding: '1rem 1.5rem' }}>
      <SkeletonText paragraph lineCount={6} />
    </div>
  )
}

function NoJob() {
  return (
    <div style={{ padding: '1rem 1.5rem' }}>
      <InlineNotification
        kind="info"
        title="No AutoTuneX job linked to this build"
        hideCloseButton
        lowContrast
      />
    </div>
  )
}

export function AutoTuneXTrialsPanel({ buildId }: { buildId: string }) {
  const { data: job, isLoading } = useLinkedTuningJob(buildId)

  if (isLoading) return <Loading />
  if (!job) return <NoJob />

  return (
    <div style={{ padding: '1rem 1.5rem' }}>
      <TrialsTable jobId={job.id} />
    </div>
  )
}

export function AutoTuneXLogsPanel({ buildId }: { buildId: string }) {
  const { data: job, isLoading } = useLinkedTuningJob(buildId)

  if (isLoading) return <Loading />
  if (!job) return <NoJob />

  return (
    <div style={{ padding: '1rem 1.5rem' }}>
      <TuningLogViewer jobId={job.id} status={job.status} />
    </div>
  )
}
