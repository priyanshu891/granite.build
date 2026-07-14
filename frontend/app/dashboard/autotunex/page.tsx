'use client'

import Link from 'next/link'
import { Button } from '@carbon/react'
import { Rocket } from '@carbon/icons-react'
import { PageHeader } from '@/components/PageHeader'
import styles from './page.module.scss'

export default function AutoTuneXPage() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <PageHeader crumbs={[{ label: 'AutoTuneX' }]} />
      <div className={styles.hero}>
        <h2 className={styles.heroTitle}>AutoTuneX</h2>
        <p className={styles.heroSubtitle}>
          Fine-tune a model with supervised fine-tuning, preference learning, or reinforcement learning — upload a
          dataset, pick a configuration, and launch a tuning job.
        </p>
        <Button as={Link} href="/dashboard/autotunex/start-tuning" renderIcon={Rocket}>
          Start Tuning
        </Button>
      </div>
    </div>
  )
}
