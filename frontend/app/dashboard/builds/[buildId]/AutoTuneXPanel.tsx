'use client'

import * as React from 'react'
import { useState } from 'react'
import { Link as CarbonLink, Modal, InlineLoading, SkeletonText } from '@carbon/react'
import { useQuery } from '@tanstack/react-query'
import { getConfiguration, getJobByBuildId } from '@/api/autotunex'
import { ConfigDisplay } from '../../autotunex/start-tuning/ConfigDisplay'
import { SettingsDatasetView } from '@/components/SettingsDatasetView'
import styles from './DetailsPanel.module.scss'

interface DetailFieldProps {
  label: string
  children: React.ReactNode
}

function DetailField({ label, children }: DetailFieldProps) {
  return (
    <div>
      <div className={styles.fieldLabel}>{label}</div>
      <div className={styles.fieldValue}>{children}</div>
    </div>
  )
}

interface AutoTuneXPanelProps {
  buildId: string
}

/**
 * Details for the AutoTuneX tuning job linked to a build. Rendered side-by-side
 * with DetailsPanel in the Details tab, only for builds tagged "autotunex".
 * Configuration and Data set names open the existing view modals inline.
 */
export function AutoTuneXPanel({ buildId }: AutoTuneXPanelProps) {
  const [configOpen, setConfigOpen] = useState(false)
  const [datasetOpen, setDatasetOpen] = useState(false)

  const { data: job, isLoading } = useQuery({
    queryKey: ['autotunex-job-by-build', buildId],
    queryFn: () => getJobByBuildId(buildId),
  })

  // Loaded lazily when the configuration modal is opened (matches TuningDetailTabs).
  const { data: configuration } = useQuery({
    queryKey: ['autotunex-config', job?.config_id],
    queryFn: () => getConfiguration(job!.config_id),
    enabled: configOpen && !!job?.config_id,
  })

  if (isLoading) {
    return (
      <div style={{ padding: '0.5rem 1rem' }}>
        <h5 style={{ marginBottom: '1rem' }}>Model Customization</h5>
        <SkeletonText paragraph lineCount={5} />
      </div>
    )
  }

  // No tuning job linked to this build — render nothing so DetailsPanel fills the row.
  if (!job) return null
  return (
    <div style={{ padding: '0.5rem 1rem' }}>
      {/* <h5 style={{ marginBottom: '1rem' }}>AutoTuneX</h5> */}
      <dl className={styles.detailsList}>
        <DetailField label="Experiment name">
          <span className={styles.wordBreakAll}>{job.experiment_name}</span>
        </DetailField>
        <DetailField label="Model">
          <span className={styles.wordBreakAll}>{job.model}</span>
        </DetailField>
        <DetailField label="Tuning type">{job.tuning_type}</DetailField>
        <DetailField label="Configuration">
          <CarbonLink href="#" onClick={(e) => { e.preventDefault(); setConfigOpen(true) }}>
            {job.config_name}
          </CarbonLink>
        </DetailField>
        <DetailField label="Data set">
          <CarbonLink href="#" onClick={(e) => { e.preventDefault(); setDatasetOpen(true) }}>
            {job.dataset}
          </CarbonLink>
        </DetailField>
      </dl>

      <Modal
        open={configOpen}
        passiveModal
        modalHeading={`Configuration: ${job.config_name}`}
        size="lg"
        onRequestClose={() => setConfigOpen(false)}
      >
        {configuration ? (
          <ConfigDisplay configuration={configuration} />
        ) : (
          <InlineLoading description="Loading configuration…" />
        )}
      </Modal>

      <SettingsDatasetView
        open={datasetOpen}
        datasetId={job.dataset_id}
        onClose={() => setDatasetOpen(false)}
      />
    </div>
  )
}
