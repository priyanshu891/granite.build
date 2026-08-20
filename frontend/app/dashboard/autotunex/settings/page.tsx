'use client'

import { PageHeader } from '@/components/PageHeader'
import { AutotunexTabs } from '@/components/AutotunexTabs'
import { ConfigurationsTable } from '@/components/ConfigurationsTable'
import { DatasetsTable } from '@/components/DatasetsTable'
import styles from './Settings.module.scss'

export default function SettingsPage() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <PageHeader crumbs={[{ label: 'Model Customization', to: '/dashboard/autotunex' }, { label: 'Settings' }]} />
      <AutotunexTabs active="settings" />

      <div className={styles.grid}>
        <section className={styles.section}>
          <ConfigurationsTable />
        </section>

        <section className={styles.section}>
          <DatasetsTable />
        </section>
      </div>
    </div>
  )
}
