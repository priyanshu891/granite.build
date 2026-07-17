'use client'

import { useMemo, useState } from 'react'
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
  Button,
  Link as CarbonLink,
  Modal,
  InlineNotification,
} from '@carbon/react'
import { Add, TrashCan } from '@carbon/icons-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { Dataset } from '@/types'
import { getDatasets, deleteDataset } from '@/api/autotunex'
import { SettingsDeleteModal } from './SettingsDeleteModal'

const HEADERS = [
  { key: 'name', header: 'Name' },
  { key: 'train_records', header: 'Training samples' },
  { key: 'validation_records', header: 'Validation samples' },
  { key: 'created_at', header: 'Created on' },
]

function formatCompact(n: number): string {
  if (n == null || Number.isNaN(n)) return '0'
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

function isUndeletable(d: Dataset): boolean {
  return (d.associated_jobs?.length ?? 0) > 0
}

export function DatasetsTable() {
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)
  const [createOpen, setCreateOpen] = useState(false)
  const [viewId, setViewId] = useState<string | null>(null)

  const { data: datasets = [], isLoading } = useQuery({
    queryKey: ['autotunex', 'datasets'],
    queryFn: getDatasets,
  })

  const byId = useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets])
  const selectedDatasets = selectedIds.map((id) => byId.get(id)).filter(Boolean) as Dataset[]
  const anyUndeletable = selectedDatasets.some(isUndeletable)

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteDataset(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autotunex', 'datasets'] })
      setSelectedIds([])
      setDeleteOpen(false)
      setDeleteError(undefined)
    },
    onError: (err) => {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setDeleteError('This dataset is in use by a running job and cannot be deleted.')
      } else {
        setDeleteError('Something went wrong while deleting. Please try again.')
      }
    },
  })

  const rows = datasets.map((d) => ({
    id: d.id,
    name: d.name,
    train_records: formatCompact(d.train_records),
    validation_records: formatCompact(d.validation_records),
    created_at: d.created_at ?? '',
  }))

  if (isLoading) {
    return <DataTableSkeleton headers={HEADERS} rowCount={5} showHeader={false} showToolbar={false} />
  }

  return (
    <>
      <DataTable rows={rows} headers={HEADERS} isSortable>
        {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps, getSelectionProps, getBatchActionProps }) => {
          const batchActionProps = getBatchActionProps()
          return (
            <TableContainer>
              <TableToolbar>
                <TableBatchActions {...batchActionProps} onCancel={() => setSelectedIds([])}>
                  <TableBatchAction
                    renderIcon={TrashCan}
                    disabled={anyUndeletable}
                    onClick={() => { setDeleteError(undefined); setDeleteOpen(true) }}
                  >
                    Delete
                  </TableBatchAction>
                </TableBatchActions>
                <TableToolbarContent>
                  <TableToolbarSearch placeholder="Search datasets…" onChange={() => {}} />
                  <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>
                    Create New Dataset
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} size="md">
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
                            {cell.info.header === 'name' ? (
                              <CarbonLink href="#" onClick={(e) => { e.preventDefault(); setViewId(row.id) }}>
                                {cell.value}
                              </CarbonLink>
                            ) : cell.info.header === 'created_at' ? (
                              cell.value ? new Date(cell.value as string).toLocaleString() : '—'
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
              <Pagination totalItems={rows.length} pageSize={10} page={1} pageSizes={[10, 20, 50]} onChange={() => {}} />
            </TableContainer>
          )
        }}
      </DataTable>

      {anyUndeletable && selectedIds.length > 0 && (
        <InlineNotification
          kind="info"
          title="Some selected datasets can't be deleted"
          subtitle="Datasets in use by a tuning cannot be deleted."
          lowContrast
          hideCloseButton
          style={{ marginTop: '0.5rem' }}
        />
      )}

      <SettingsDeleteModal
        open={deleteOpen}
        count={selectedIds.length}
        itemLabel="dataset"
        isDeleting={deleteMutation.isPending}
        errorMessage={deleteError}
        onClose={() => { setDeleteOpen(false); setDeleteError(undefined) }}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />

      {/* Create modal — replaced by SettingsDatasetCreate in Task 9 */}
      <Modal open={createOpen} passiveModal modalHeading="Create New Dataset" size="lg" onRequestClose={() => setCreateOpen(false)}>
        <p>Dataset create form coming soon.</p>
      </Modal>

      {/* View modal — replaced by SettingsDatasetView in Task 7 */}
      <Modal open={viewId != null} passiveModal modalHeading="Dataset" size="lg" onRequestClose={() => setViewId(null)}>
        <p>Dataset view coming soon.</p>
      </Modal>
    </>
  )
}
