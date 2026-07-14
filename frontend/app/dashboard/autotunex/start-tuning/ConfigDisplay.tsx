'use client'

import { FormLabel, ProgressBar, Tooltip } from '@carbon/react'
import { Information } from '@carbon/icons-react'
import type { Configuration } from '@/types'
import { toUpperCase } from './wizardUtils'
import styles from './ConfigDisplay.module.scss'
import layoutStyles from './layout.module.scss'

const GENERAL_CONFIG_KEYS = [
  'num_gpus_per_trial',
  'num_cpus_per_worker',
  'num_train_epochs',
  'hpo_num_epochs',
  'precision',
  'num_samples',
  'hpo_dataset_percentage',
]

const NON_INCLUDED_KEYS = [
  'description',
  'tuner_name',
  'resource_name',
  'seed',
  'reward_function_name',
  'reward_function_path',
  'reward_model_path',
]

function displayListValue(val: unknown): string {
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : 'N/A'
  if (val === null || val === undefined || val === '') return 'N/A'
  return String(val)
}

function FieldTile({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabelRow}>
        <FormLabel>{toUpperCase(label)}</FormLabel>
        {description && (
          <Tooltip label={description}>
            <button type="button" className={styles.tooltipTrigger} aria-label={description}>
              <Information size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      <span className={styles.fieldValue}>{children}</span>
    </div>
  )
}

/**
 * Read-only configuration preview (this wizard never renders it in edit mode —
 * the source component also supports inline editing, but Step2Configure only
 * ever passes a fully-loaded, non-editable configuration for preview purposes).
 */
export function ConfigDisplay({ configuration }: { configuration: Configuration }) {
  if (!configuration.config_data) {
    return <ProgressBar size="small" label="Loading" helperText="Loading configuration details..." />
  }

  const { config_data } = configuration
  const isRlConfig = !!configuration.rl_tuner_type && configuration.rl_tuner_type !== 'none'
  const tuner = isRlConfig
    ? config_data.tuners_rl_config?.[configuration.rl_tuner_type as string]
    : config_data.tuners_config?.[configuration.tuner_type]

  const tokenizerEntries = Object.entries(config_data.tokenizer_config ?? {})
  const hasTokenizerConfig = tokenizerEntries.length > 0

  const trainingConfigEntries = Object.entries(config_data.training_config || {}).filter(
    ([key, value]) => (value as any).type !== 'bool' && !NON_INCLUDED_KEYS.includes(key) && !GENERAL_CONFIG_KEYS.includes(key)
  )
  const tuneConfigEntries = Object.entries(config_data.tune_config || {}).filter(
    ([key]) => !NON_INCLUDED_KEYS.includes(key) && !GENERAL_CONFIG_KEYS.includes(key)
  )
  const trainingRlConfigEntries = Object.entries(config_data.training_rl_config || {}).filter(
    ([key, value]) => 'type' in (value as any) && (value as any).type !== 'bool' && !NON_INCLUDED_KEYS.includes(key)
  )

  const hyperparams = tuner?.hyperparams ?? {}

  return (
    <div>
      <div className={styles.section}>
        <h5 className={styles.sectionHeading}>Overview</h5>
        <div className={layoutStyles.rowWrap}>
          {tuner && (
            <FieldTile label="Tuner type" description={tuner.description}>
              {toUpperCase(tuner.title)}
            </FieldTile>
          )}
          {GENERAL_CONFIG_KEYS.filter((key) => !NON_INCLUDED_KEYS.includes(key)).map((key) => {
            const item = (config_data.training_config as any)?.[key] ?? (config_data.tune_config as any)?.[key]
            if (!item) return null
            return (
              <FieldTile key={key} label={key} description={item.description}>
                {String(item.default)}
              </FieldTile>
            )
          })}
        </div>
      </div>

      <div className={styles.section}>
        <h5 className={styles.sectionHeading}>Training config</h5>
        <div className={layoutStyles.rowWrap}>
          {trainingConfigEntries.map(([key, value]) => (
            <FieldTile key={key} label={key} description={(value as any).description}>
              {String((value as any).default)}
            </FieldTile>
          ))}
        </div>
      </div>

      {isRlConfig && trainingRlConfigEntries.length > 0 && (
        <div className={styles.section}>
          <h5 className={styles.sectionHeading}>Training RL config</h5>
          <div className={layoutStyles.rowWrap}>
            {trainingRlConfigEntries.map(([key, value]) => (
              <FieldTile key={key} label={key} description={(value as any).description}>
                {String((value as any).default ?? 'N/A')}
              </FieldTile>
            ))}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <h5 className={styles.sectionHeading}>Tune config</h5>
        <div className={layoutStyles.rowWrap}>
          {tuneConfigEntries.map(([key, value]) => (
            <FieldTile key={key} label={key} description={(value as any).description}>
              {String((value as any).default)}
            </FieldTile>
          ))}
        </div>
      </div>

      {hasTokenizerConfig && (
        <div className={styles.section}>
          <h5 className={styles.sectionHeading}>Tokenizer config</h5>
          <div className={layoutStyles.rowWrap}>
            {tokenizerEntries.map(([key, field]: [string, any]) => (
              <FieldTile key={key} label={key} description={field.description}>
                {field.type === 'list' ? displayListValue(field.default) : String(field.default ?? 'N/A')}
              </FieldTile>
            ))}
          </div>
        </div>
      )}

      {tuner && (
        <div className={styles.section}>
          <h5 className={styles.sectionHeading}>{tuner.title} Configuration</h5>
          <div className={layoutStyles.rowWrap}>
            {Object.entries(hyperparams)
              .filter(([key]) => !NON_INCLUDED_KEYS.includes(key))
              .map(([key, value]: [string, any]) => (
                <div className={styles.tunerParamCard} key={key}>
                  <div className={styles.tunerParamRow}>
                    <FormLabel>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{toUpperCase(value.description)}</span>
                    </FormLabel>
                    <div className={layoutStyles.row}>
                      {value.type === 'str' && value.values?.length === 1 ? (
                        <div>
                          <FormLabel style={{ display: 'block' }}>Value</FormLabel>
                          <span className={styles.fieldValue}>{value.default}</span>
                        </div>
                      ) : (
                        <>
                          <div>
                            <FormLabel style={{ display: 'block' }}>Strategy</FormLabel>
                            <span className={styles.fieldValue}>{value.strategy}</span>
                          </div>
                          <div>
                            <FormLabel style={{ display: 'block' }}>Default</FormLabel>
                            <span className={styles.fieldValue}>{value.default}</span>
                          </div>
                          {value.strategy === 'uniform' ? (
                            <>
                              <div>
                                <FormLabel style={{ display: 'block' }}>Min value</FormLabel>
                                <span className={styles.fieldValue}>{value.min_val}</span>
                              </div>
                              <div>
                                <FormLabel style={{ display: 'block' }}>Max value</FormLabel>
                                <span className={styles.fieldValue}>{value.max_val}</span>
                              </div>
                            </>
                          ) : (
                            <div>
                              <FormLabel style={{ display: 'block' }}>Values</FormLabel>
                              <span className={styles.fieldValue}>
                                {Array.isArray(value.values) && value.values.length > 1 ? value.values.join(', ') : value.values}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
