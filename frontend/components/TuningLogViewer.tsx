'use client'

import { getJobLogs } from '@/api/autotunex'
import { useScrollingLogs } from '@/hooks/useScrollingLogs'
import type { TuningJob } from '@/types'
import { LogLines } from './LogLines'

const ACTIVE_STATUSES = new Set(['running', 'pending'])

interface Props {
  jobId: string
  status: TuningJob['status']
}

export function TuningLogViewer({ jobId, status }: Props) {
  const isActive = ACTIVE_STATUSES.has(status)
  const { logs, isLoading, isLoadingMore, handleScroll } = useScrollingLogs({
    queryKey: ['autotunex-job-logs', jobId],
    fetchLogs: (opts) => getJobLogs(jobId, opts),
    isActive,
  })

  return <LogLines logs={logs} isLoading={isLoading} isLoadingMore={isLoadingMore} onScroll={handleScroll} />
}
