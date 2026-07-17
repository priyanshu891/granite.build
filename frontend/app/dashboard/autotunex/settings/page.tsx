'use client'

import { PageHeader } from '@/components/PageHeader'
import { AutotunexTabs } from '@/components/AutotunexTabs'
import styles from './Settings.module.scss'

export default function SettingsPage() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <PageHeader crumbs={[{ label: 'AutoTuneX', to: '/dashboard/autotunex' }, { label: 'Settings' }]} />
      <AutotunexTabs active="settings" />

      <section className={styles.section}>
        <h4 className={styles.sectionHeading}>Configurations</h4>
        <p>Configurations table coming soon.</p>
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionHeading}>Data sets</h4>
        <p>Datasets table coming soon.</p>
      </section>
    </div>
  )
}
