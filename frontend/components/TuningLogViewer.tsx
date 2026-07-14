'use client'

import { useQuery } from '@tanstack/react-query'
import { ProgressBar } from '@carbon/react'
import { getJobLogs } from '@/api/autotunex'
import type { TuningJob } from '@/types'
import styles from './TuningLogViewer.module.scss'

const ACTIVE_STATUSES = new Set(['RUNNING', 'PENDING', 'SUBMITTED'])

interface Props {
  jobId: string
  status: TuningJob['status']
}

export function TuningLogViewer({ jobId, status }: Props) {
  const isActive = ACTIVE_STATUSES.has(status)
  const { data, isLoading } = useQuery({
    queryKey: ['autotunex-job-logs', jobId, status],
    queryFn: () => getJobLogs(jobId, { status }),
    refetchInterval: isActive ? 10_000 : false,
  })

  if (isLoading) {
    return <ProgressBar size="small" label="Loading" helperText="Loading logs..." />
  }

  const logs = data?.logs ?? []

  if (logs.length === 0) {
    return <div className={styles.logViewer}><div className={styles.logLine}>No logs available</div></div>
  }

  return (
    <div className={styles.logViewer}>
      {logs.map((log, i) => (
        <div className={styles.logLine} key={i}>
          {new Date(log.timestamp).toLocaleString()} {log.level} -- {log.filename} -- {log.message}
        </div>
      ))}
    </div>
  )
}
