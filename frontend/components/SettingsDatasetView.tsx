'use client'

import {
  Modal,
  InlineLoading,
  FormLabel,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
} from '@carbon/react'
import { useQuery } from '@tanstack/react-query'
import { getDataset } from '@/api/autotunex'
import type { Dataset } from '@/types'

interface Props {
  open: boolean
  datasetId: string | null
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function PreviewTable({ rows }: { rows: Record<string, any>[] }) {
  if (!rows || rows.length === 0) {
    return <p style={{ padding: '1rem 0', color: 'var(--cds-text-secondary, #525252)' }}>No preview rows available.</p>
  }
  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
  return (
    <Table size="sm">
      <TableHead>
        <TableRow>
          {columns.map((c) => <TableHeader key={c}>{c}</TableHeader>)}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.slice(0, 50).map((r, i) => (
          <TableRow key={i}>
            {columns.map((c) => (
              <TableCell key={c}>
                {typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c] ?? '')}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function SettingsDatasetView({ open, datasetId, onClose }: Props) {
  const { data: dataset, isLoading } = useQuery<Dataset>({
    queryKey: ['autotunex-dataset', datasetId],
    queryFn: () => getDataset(datasetId as string),
    enabled: open && datasetId != null,
  })

  return (
    <Modal
      open={open}
      passiveModal
      size="lg"
      modalHeading={dataset ? `Dataset: ${dataset.name}` : 'Dataset'}
      onRequestClose={onClose}
    >
      {isLoading || !dataset ? (
        <InlineLoading description="Loading dataset…" />
      ) : (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '1.5rem' }}>
            {([
              ['Training samples', dataset.train_records?.toLocaleString() ?? '0'],
              ['Validation samples', dataset.validation_records?.toLocaleString() ?? '0'],
              ['Training file size', formatBytes(dataset.train_file_size)],
              ['Validation file size', formatBytes(dataset.validation_file_size)],
              ['Format', dataset.data_format ?? '—'],
              ['Created on', dataset.created_at ? new Date(dataset.created_at).toLocaleString() : '—'],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} style={{ minWidth: '10rem' }}>
                <FormLabel>{label}</FormLabel>
                <div style={{ fontFamily: 'monospace' }}>{value}</div>
              </div>
            ))}
          </div>

          <Tabs>
            <TabList aria-label="Dataset preview">
              <Tab>Train</Tab>
              <Tab>Validation</Tab>
            </TabList>
            <TabPanels>
              <TabPanel>
                <PreviewTable rows={dataset.train_data ?? []} />
              </TabPanel>
              <TabPanel>
                <PreviewTable rows={dataset.validation_data ?? []} />
              </TabPanel>
            </TabPanels>
          </Tabs>
        </div>
      )}
    </Modal>
  )
}
