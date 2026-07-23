'use client'

import { Fragment, useState } from 'react'
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
  TableExpandHeader,
  TableExpandRow,
  TableExpandedRow,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  CodeSnippet,
  Button,
  ProgressBar,
  InlineNotification,
} from '@carbon/react'
import { ArrowLeft } from '@carbon/icons-react'
import { RadarChart } from '@carbon/charts-react'
import { getJobTrials } from '@/api/autotunex'
import { useChartsTheme } from '@/hooks/useTheme'
import { TrialLogViewer } from '@/components/TrialLogViewer'
import { TrialCompare } from '@/components/TrialCompare'
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

function toFeatureLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

// Carbon's RadarChart requires a complete grid: every group (trial) must carry a
// value for every axis (feature). If any (group, feature) pair is missing — e.g.
// one trial reports `loss` and another doesn't — the chart rejects with the name
// of the offending axis (that was the "Uncaught (in promise) Loss" error).
//
// So we take the *union* of metric names across all trials, then emit one entry
// per trial per axis, defaulting a missing metric to 0.
function toRadarData(trials: Trial[]): { product: string; feature: string; score: number }[] {
  const withScores = trials.filter((t) => t.score)
  if (withScores.length === 0) return []

  const metricNames = Array.from(
    new Set(withScores.flatMap((t) => Object.keys(t.score!.metrics)))
  )

  const bounds: Record<string, { min: number; max: number }> = {}
  for (const name of metricNames) {
    const values = withScores
      .map((t) => t.score!.metrics[name])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    bounds[name] = {
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
    }
  }

  const data: { product: string; feature: string; score: number }[] = []
  for (const trial of withScores) {
    for (const name of metricNames) {
      const raw = trial.score!.metrics[name]
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : bounds[name].min
      const { min, max } = bounds[name]
      const normalized = min === max ? 0 : (value - min) / (max - min)
      data.push({
        product: trial.id,
        feature: toFeatureLabel(name),
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
  const [showCompare, setShowCompare] = useState(false)
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

  // Full-screen compare view: replaces the table + radar, mirroring AutoTuneX.
  const selectedForCompare = trials.filter((t) => selectedIds.includes(t.id) && t.status === 'COMPLETED' && t.score)
  if (showCompare && selectedForCompare.length > 0) {
    return (
      <div>
        <Button
          kind="ghost"
          size="sm"
          renderIcon={ArrowLeft}
          onClick={() => setShowCompare(false)}
          style={{ marginBottom: '1rem' }}
        >
          Back to trials
        </Button>
        <TrialCompare trials={selectedForCompare} />
      </div>
    )
  }

  const rows = trials.map((t) => ({
    id: t.id,
    created_at: t.created_at,
    status: t.status,
    loss: t.score?.metrics[t.score.metric] ?? undefined,
    total_time: t.score?.metrics.total_time,
  }))

  const selectedTrials = trials.filter((t) => selectedIds.includes(t.id))
  // Only completed trials with a score can be plotted — the radar needs a full
  // metric grid, and running/errored trials have no (or partial) score.
  const comparableTrials = selectedTrials.filter((t) => t.status === 'COMPLETED' && t.score)
  const radarData = toRadarData(comparableTrials)
  // A radar needs at least 2 axes (distinct metrics) to render; a single axis
  // makes Carbon's RadarChart reject.
  const axisCount = new Set(radarData.map((d) => d.feature)).size
  const canShowRadar = comparableTrials.length >= 2 && axisCount >= 2
  // The diff-table only needs 2+ completed trials with a score — no axis constraint.
  const canOpenCompare = comparableTrials.length >= 2

  const trialsById = new Map(trials.map((t) => [t.id, t]))

  return (
    <div>
      {canOpenCompare && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
          <Button size="sm" onClick={() => setShowCompare(true)}>
            Compare {comparableTrials.length} trials
          </Button>
        </div>
      )}
      <DataTable rows={rows} headers={HEADERS} isSortable>
        {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps, getExpandedRowProps, getSelectionProps }) => (
          <Table {...getTableProps()} size="sm">
            <TableHead>
              <TableRow>
                <TableExpandHeader aria-label="Expand row" />
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
                const trial = trialsById.get(row.id)
                return (
                  <Fragment key={row.id}>
                    <TableExpandRow {...rowProps}>
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
                    </TableExpandRow>
                    {row.isExpanded && trial && (
                      <TableExpandedRow {...getExpandedRowProps({ row })} colSpan={headers.length + 2}>
                        <Tabs>
                          <TabList aria-label="Trial detail tabs" contained>
                            <Tab>Logs</Tab>
                            <Tab>Configuration</Tab>
                          </TabList>
                          <TabPanels>
                            <TabPanel>
                              <TrialLogViewer trialId={trial.id} status={trial.status} />
                            </TabPanel>
                            <TabPanel>
                              <CodeSnippet type="multi" wrapText>
                                {JSON.stringify(trial.config, null, 2)}
                              </CodeSnippet>
                            </TabPanel>
                          </TabPanels>
                        </Tabs>
                      </TableExpandedRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}
      </DataTable>

      {canShowRadar && (
        <div style={{ height: '420px', marginTop: '1.5rem' }}>
          <RadarChart
            data={radarData}
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
