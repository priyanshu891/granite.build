'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableSelectAll,
  TableSelectRow,
  ProgressBar,
  InlineNotification,
} from '@carbon/react'
import { RadarChart } from '@carbon/charts-react'
import { getJobTrials } from '@/api/autotunex'
import { useChartsTheme } from '@/hooks/useTheme'
import type { Trial } from '@/types'

const HEADERS = [
  { key: 'created_at', header: 'Created on' },
  { key: 'id', header: 'Trial id' },
  { key: 'status', header: 'Status' },
  { key: 'loss', header: 'Loss' },
  { key: 'total_time', header: 'Total time' },
]

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0 s'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

function toRadarData(trials: Trial[]): { product: string; feature: string; score: number }[] {
  const withScores = trials.filter((t) => t.score)
  if (withScores.length === 0) return []
  const metricNames = Object.keys(withScores[0].score!.metrics)
  const bounds: Record<string, { min: number; max: number }> = {}
  for (const name of metricNames) {
    const values = withScores.map((t) => t.score!.metrics[name]).filter((v) => v !== undefined)
    bounds[name] = { min: Math.min(...values), max: Math.max(...values) }
  }
  const data: { product: string; feature: string; score: number }[] = []
  for (const trial of withScores) {
    for (const name of metricNames) {
      const value = trial.score!.metrics[name]
      if (value === undefined) continue
      const { min, max } = bounds[name]
      const normalized = min === max ? 0 : (value - min) / (max - min)
      data.push({
        product: trial.id,
        feature: name.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        score: normalized,
      })
    }
  }
  return data
}

interface Props {
  jobId: string
}

export function TrialsTable({ jobId }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const theme = useChartsTheme()

  const { data: trials = [], isLoading } = useQuery({
    queryKey: ['autotunex-job-trials', jobId],
    queryFn: () => getJobTrials(jobId),
  })

  if (isLoading) {
    return <ProgressBar size="small" label="Loading trials..." />
  }

  if (trials.length === 0) {
    return <InlineNotification kind="info" title="No trial data available" hideCloseButton />
  }

  const rows = trials.map((t) => ({
    id: t.id,
    created_at: t.created_at,
    status: t.status,
    loss: t.score?.metrics[t.score.metric] ?? undefined,
    total_time: t.score?.metrics.total_time,
  }))

  const selectedTrials = trials.filter((t) => selectedIds.includes(t.id))
  const canCompare = selectedTrials.filter((t) => t.status === 'COMPLETED').length >= 2

  return (
    <div>
      <DataTable rows={rows} headers={HEADERS} isSortable>
        {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps, getSelectionProps }) => (
          <Table {...getTableProps()} size="sm">
            <TableHead>
              <TableRow>
                <TableSelectAll
                  {...getSelectionProps()}
                  onSelect={(e) => {
                    getSelectionProps().onSelect(e)
                    setSelectedIds((e.target as HTMLInputElement).checked ? tableRows.map((r) => r.id) : [])
                  }}
                />
                {headers.map((h) => {
                  const { key: _k, ...hProps } = getHeaderProps({ header: h })
                  return <TableHeader key={h.key} {...hProps}>{h.header}</TableHeader>
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((row) => {
                const { key: _k, ...rowProps } = getRowProps({ row })
                const selectionProps = getSelectionProps({ row })
                return (
                  <TableRow key={row.id} {...rowProps}>
                    <TableSelectRow
                      {...selectionProps}
                      onSelect={(e) => {
                        selectionProps.onSelect(e)
                        const checked = (e.target as HTMLInputElement).checked
                        setSelectedIds((prev) => (checked ? [...prev, row.id] : prev.filter((id) => id !== row.id)))
                      }}
                    />
                    {row.cells.map((cell) => (
                      <TableCell key={cell.id}>
                        {cell.info.header === 'created_at'
                          ? new Date(cell.value as string).toLocaleString()
                          : cell.info.header === 'loss' && typeof cell.value === 'number'
                          ? cell.value.toFixed(4)
                          : cell.info.header === 'total_time' && typeof cell.value === 'number'
                          ? formatTime(cell.value)
                          : (cell.value as React.ReactNode) ?? '—'}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </DataTable>

      {canCompare && (
        <div style={{ height: '420px', marginTop: '1.5rem' }}>
          <RadarChart
            data={toRadarData(selectedTrials)}
            options={{
              title: 'Trial comparison',
              radar: { axes: { angle: 'feature', value: 'score' } },
              data: { groupMapsTo: 'product' },
              theme,
              height: '420px',
            }}
          />
        </div>
      )}
    </div>
  )
}
