'use client'

import {
  DataTable,
  DataTableSkeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  TableSelectAll,
  TableSelectRow,
  TableBatchActions,
  TableBatchAction,
  Pagination,
  Link as CarbonLink,
} from '@carbon/react'
import { Compare, TrashCan } from '@carbon/icons-react'
import type { TuningJob } from '@/types'
import { TuningStatusBadge } from './TuningStatusBadge'

interface Props {
  jobs: TuningJob[]
  total: number
  page: number
  pageSize: number
  isLoading: boolean
  selectedIds: string[]
  onSelectedIdsChange: (ids: string[]) => void
  onPageChange: (page: number, pageSize: number) => void
  onSearch: (term: string) => void
  onRowClick: (id: string) => void
  onDeleteSelected: () => void
  onCompareSelected: () => void
}

const HEADERS = [
  { key: 'experiment_name', header: 'Experiment' },
  { key: 'created_at', header: 'Created on' },
  { key: 'status', header: 'Status' },
  { key: 'model', header: 'Model' },
  { key: 'config_name', header: 'Configuration' },
  { key: 'dataset', header: 'Data set' },
  { key: 'total_time', header: 'Total time' },
]

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0 s'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function totalTimeSecondsFor(job: TuningJob): number {
  const start = new Date(job.created_at).getTime()
  const end = job.status === 'RUNNING' ? Date.now() : new Date(job.updated_at).getTime()
  return Math.floor((end - start) / 1000)
}

function totalTimeFor(job: TuningJob): string {
  return formatTime(totalTimeSecondsFor(job))
}

// Carbon's DataTable `sortRow` only receives the two cell *values* being
// compared for the sorted column (not the full row), so `total_time`'s cell
// value is kept as the raw numeric seconds for correct numeric sorting. The
// human-formatted string used for display lives in `total_time_display` and
// is looked up by row id at render time.
const sortRow: NonNullable<React.ComponentProps<typeof DataTable>['sortRow']> = (
  cellA,
  cellB,
  { key, sortDirection, sortStates, locale, compare }
) => {
  if (key === 'total_time') {
    const a = typeof cellA === 'number' ? cellA : 0
    const b = typeof cellB === 'number' ? cellB : 0
    return sortDirection === sortStates.ASC ? a - b : b - a
  }
  // Replicate Carbon's own default sort for every other column so existing
  // behavior on Experiment/Created on/Status/Model/etc. is unchanged.
  return sortDirection === sortStates.ASC ? compare(cellA, cellB, locale) : compare(cellB, cellA, locale)
}

export function TuningsTable({
  jobs,
  total,
  page,
  pageSize,
  isLoading,
  selectedIds,
  onSelectedIdsChange,
  onPageChange,
  onSearch,
  onRowClick,
  onDeleteSelected,
  onCompareSelected,
}: Props) {
  if (isLoading) {
    return <DataTableSkeleton headers={HEADERS} rowCount={6} showHeader={false} showToolbar={false} />
  }

  const rows = jobs.map((j) => ({
    id: j.id,
    experiment_name: j.experiment_name,
    created_at: j.created_at,
    status: j.status,
    model: j.model,
    config_name: j.config_name,
    dataset: j.dataset,
    total_time: totalTimeSecondsFor(j),
    total_time_display: totalTimeFor(j),
  }))
  const totalTimeDisplayById = new Map(rows.map((r) => [r.id, r.total_time_display]))

  return (
    <DataTable rows={rows} headers={HEADERS} isSortable sortRow={sortRow}>
      {({
        rows: tableRows,
        headers,
        getTableProps,
        getHeaderProps,
        getRowProps,
        getSelectionProps,
        getBatchActionProps,
      }) => {
        const currentSelectedIds = tableRows.filter((r) => selectedIds.includes(r.id)).map((r) => r.id)
        const batchActionProps = getBatchActionProps()

        return (
          <TableContainer>
            <TableToolbar>
              <TableBatchActions {...batchActionProps} onCancel={() => onSelectedIdsChange([])}>
                <TableBatchAction renderIcon={TrashCan} onClick={onDeleteSelected}>
                  Delete
                </TableBatchAction>
                {currentSelectedIds.length > 1 && (
                  <TableBatchAction renderIcon={Compare} onClick={onCompareSelected}>
                    Compare
                  </TableBatchAction>
                )}
              </TableBatchActions>
              <TableToolbarContent>
                <TableToolbarSearch placeholder="Search tunings…" onChange={(_e, value) => onSearch(value ?? '')} />
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead>
                <TableRow>
                  <TableSelectAll
                    {...getSelectionProps()}
                    onSelect={(e) => {
                      getSelectionProps().onSelect(e)
                      onSelectedIdsChange(
                        (e.target as HTMLInputElement).checked ? tableRows.map((r) => r.id) : []
                      )
                    }}
                  />
                  {headers.map((h) => {
                    const { key: _k, ...hProps } = getHeaderProps({ header: h })
                    return (
                      <TableHeader key={h.key} {...hProps}>
                        {h.header}
                      </TableHeader>
                    )
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
                          onSelectedIdsChange(
                            checked
                              ? [...selectedIds, row.id]
                              : selectedIds.filter((id) => id !== row.id)
                          )
                        }}
                      />
                      {row.cells.map((cell) => (
                        <TableCell key={cell.id}>
                          {cell.info.header === 'status' ? (
                            <TuningStatusBadge status={cell.value} />
                          ) : cell.info.header === 'created_at' ? (
                            new Date(cell.value as string).toLocaleString()
                          ) : cell.info.header === 'experiment_name' ? (
                            <CarbonLink
                              href="#"
                              onClick={(e) => {
                                e.preventDefault()
                                onRowClick(row.id)
                              }}
                            >
                              {cell.value}
                            </CarbonLink>
                          ) : cell.info.header === 'model' && (cell.value as string)?.startsWith('/') ? (
                            <span title={cell.value as string}>
                              {(cell.value as string).split('/').slice(-2).join('/')}
                            </span>
                          ) : cell.info.header === 'model' ? (
                            <a href={`https://huggingface.co/${cell.value}`} target="_blank" rel="noreferrer">
                              {cell.value}
                            </a>
                          ) : cell.info.header === 'total_time' ? (
                            totalTimeDisplayById.get(row.id) ?? ''
                          ) : (
                            (cell.value as React.ReactNode)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination
              totalItems={total}
              pageSize={pageSize}
              page={page}
              pageSizes={[10, 20, 50]}
              onChange={({ page: p, pageSize: ps }) => onPageChange(p, ps)}
            />
          </TableContainer>
        )
      }}
    </DataTable>
  )
}
