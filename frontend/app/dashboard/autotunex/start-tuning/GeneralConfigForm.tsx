'use client'

import { NumberInput, TextInput, Tile } from '@carbon/react'
import type { ConfigData } from '@/types'
import { TimeInput } from './TimeInput'
import layoutStyles from './layout.module.scss'

interface GeneralConfigFormProps {
  config: ConfigData
  onConfigChange: (updater: (prev: ConfigData) => ConfigData) => void
  isTuning?: boolean
}

export function GeneralConfigForm({ config, onConfigChange, isTuning = false }: GeneralConfigFormProps) {
  const numGpusPerTrial = config.training_config.num_gpus_per_trial
  const maxConcurrentTrials = config.tune_config.max_concurrent_trials
  const numSamples = config.tune_config.num_samples
  const timeBudget = config.tune_config.time_budget_s
  const invocationString = (config.tuners_config as any)?.alora?.hyperparams?.invocation_string

  return (
    <Tile>
      <div className={layoutStyles.rowWrap} style={{ marginBottom: '2rem' }}>
        <div style={{ flex: '1 1 240px' }}>
          <NumberInput
            id="num_gpus_per_trial"
            label="Num GPUs per trial"
            helperText={numGpusPerTrial.description}
            value={numGpusPerTrial.default}
            min={numGpusPerTrial.min_val}
            max={numGpusPerTrial.max_val}
            invalidText={`Value must be between ${numGpusPerTrial.min_val} and ${numGpusPerTrial.max_val}`}
            step={1}
            onChange={(_e, { value }) => {
              const num = typeof value === 'number' ? value : Number(value)
              onConfigChange((prev) => ({
                ...prev,
                training_config: { ...prev.training_config, num_gpus_per_trial: { ...prev.training_config.num_gpus_per_trial, default: num } },
                tune_config: {
                  ...prev.tune_config,
                  max_concurrent_trials: {
                    ...prev.tune_config.max_concurrent_trials,
                    default: Math.floor(prev.training_config.num_gpus_per_trial.max_val / num),
                  },
                },
              }))
            }}
          />
        </div>
        <div style={{ flex: '1 1 240px' }}>
          <NumberInput
            id="max_concurrent_trials"
            label="Max concurrent trials"
            helperText={maxConcurrentTrials.description}
            value={maxConcurrentTrials.default}
            min={maxConcurrentTrials.min_val}
            max={Math.floor(numGpusPerTrial.max_val / numGpusPerTrial.default)}
            invalidText={`Value must be between ${maxConcurrentTrials.min_val} and ${Math.floor(numGpusPerTrial.max_val / numGpusPerTrial.default)}`}
            step={1}
            onChange={(_e, { value }) => {
              const num = typeof value === 'number' ? value : Number(value)
              onConfigChange((prev) => ({
                ...prev,
                tune_config: { ...prev.tune_config, max_concurrent_trials: { ...prev.tune_config.max_concurrent_trials, default: num } },
              }))
            }}
          />
        </div>
      </div>

      <div className={layoutStyles.rowWrap} style={{ marginBottom: '2rem' }}>
        <div style={{ flex: '1 1 240px' }}>
          <NumberInput
            id="num_samples"
            label="Num samples (trials)"
            helperText={numSamples.description}
            value={numSamples.default}
            min={numSamples.min_val}
            max={numSamples.max_val}
            invalidText={`Value must be between ${numSamples.min_val} and ${numSamples.max_val}`}
            step={1}
            onChange={(_e, { value }) => {
              const num = typeof value === 'number' ? value : Number(value)
              onConfigChange((prev) => ({ ...prev, tune_config: { ...prev.tune_config, num_samples: { ...prev.tune_config.num_samples, default: num } } }))
            }}
          />
        </div>
        {timeBudget && (
          <div style={{ flex: '1 1 280px' }}>
            <TimeInput
              label="Time Budget"
              value={timeBudget}
              onChange={(next) => onConfigChange((prev) => ({ ...prev, tune_config: { ...prev.tune_config, time_budget_s: next } }))}
            />
          </div>
        )}
      </div>

      {isTuning && invocationString && (
        <TextInput
          id="invocation_string"
          labelText="Invocation string"
          helperText={invocationString.description}
          placeholder="Enter invocation string"
          value={invocationString.default ?? ''}
          onChange={(e) =>
            onConfigChange((prev) => ({
              ...prev,
              tuners_config: {
                ...prev.tuners_config,
                alora: {
                  ...prev.tuners_config.alora,
                  hyperparams: { ...prev.tuners_config.alora.hyperparams, invocation_string: { ...(prev.tuners_config.alora.hyperparams as any).invocation_string, default: e.target.value } },
                },
              },
            }))
          }
        />
      )}
    </Tile>
  )
}
