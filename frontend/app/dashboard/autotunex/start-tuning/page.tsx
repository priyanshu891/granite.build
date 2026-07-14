import { PageHeader } from '@/components/PageHeader'
import { StartTuningWizard } from './StartTuningWizard'

export default function StartTuningPage() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <PageHeader
        crumbs={[
          { label: 'AutoTuneX', to: '/dashboard/autotunex' },
          { label: 'Start Tuning' },
        ]}
      />
      <StartTuningWizard />
    </div>
  )
}
