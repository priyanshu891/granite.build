'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button, InlineNotification } from '@carbon/react'
import { Rocket } from '@carbon/icons-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getJobs, deleteJob } from '@/api/autotunex'
import { PageHeader } from '@/components/PageHeader'
import { AutotunexTabs } from '@/components/AutotunexTabs'
import { TuningsTable } from '@/components/TuningsTable'
import { TuningDeleteModal } from '@/components/TuningDeleteModal'
import { TuningCompareModal } from '@/components/TuningCompareModal'

export default function AutoTuneXPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)

  const { data: jobs = [], isLoading, error } = useQuery({
    queryKey: ['autotunex-jobs'],
    queryFn: getJobs,
  })

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteJob(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autotunex-jobs'] })
      setSelectedIds([])
      setDeleteOpen(false)
    },
  })

  const filtered = search
    ? jobs.filter((j) => j.experiment_name.toLowerCase().includes(search.toLowerCase()))
    : jobs

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  const handlePageChange = useCallback((p: number, ps: number) => {
    setPage(p)
    setPageSize(ps)
  }, [])

  const handleSearch = useCallback((term: string) => {
    setSearch(term)
    setPage(1)
  }, [])

  const selectedJobs = jobs.filter((j) => selectedIds.includes(j.id))

  return (
    <div style={{ padding: '1.5rem' }}>
      <PageHeader crumbs={[{ label: 'AutoTuneX' }]} />
      <AutotunexTabs active="tunings" />

      {error && (
        <InlineNotification
          kind="error"
          title="Failed to load tunings"
          subtitle={String(error)}
          style={{ marginBottom: '1rem' }}
        />
      )}

      <TuningsTable
        jobs={paged}
        total={filtered.length}
        page={page}
        pageSize={pageSize}
        isLoading={isLoading}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
        onPageChange={handlePageChange}
        onSearch={handleSearch}
        onRowClick={(id) => router.push(`/dashboard/autotunex/${id}/?id=${id}`)}
        onDeleteSelected={() => setDeleteOpen(true)}
        onCompareSelected={() => setCompareOpen(true)}
      />

      <TuningDeleteModal
        open={deleteOpen}
        count={selectedIds.length}
        isDeleting={deleteMutation.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />

      <TuningCompareModal
        open={compareOpen}
        jobs={selectedJobs}
        onClose={() => setCompareOpen(false)}
      />
    </div>
  )
}
