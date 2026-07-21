'use client'

import { getTrialLogs } from '@/api/autotunex'
import { useScrollingLogs } from '@/hooks/useScrollingLogs'
import type { TuningStatus } from '@/types'
import { LogLines } from './LogLines'

const ACTIVE_STATUSES = new Set<TuningStatus>(['RUNNING', 'PENDING', 'SUBMITTED'])

interface Props {
  trialId: string
  status: TuningStatus
}

export function TrialLogViewer({ trialId, status }: Props) {
  const isActive = ACTIVE_STATUSES.has(status)
  const { logs, isLoading, isLoadingMore, handleScroll } = useScrollingLogs({
    queryKey: ['autotunex-trial-logs', trialId],
    fetchLogs: (opts) => getTrialLogs(trialId, opts),
    isActive,
    pageSize: 50,
    pollIntervalMs: 60_000,
  })

  return <LogLines logs={logs} isLoading={isLoading} isLoadingMore={isLoadingMore} onScroll={handleScroll} />
}
