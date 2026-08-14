'use client'

import {
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
  Tag,
} from '@carbon/react'
import type { Trial } from '@/types'

// ── Reference-parity helpers (ported from AutoTuneX Compare.svelte / Utils) ────

// Keys hidden from the comparison entirely.
const IGNORE_KEYS = ['id']
// Result/metric keys — rendered in their own top section.
const RESULT_KEYS = ['loss', 'train_loss', 'total_time']
// training_config keys stripped before flattening (paths / run-specific noise).
const STRIP_TRAINING_KEYS = [
  'output_dir',
  'train_file',
  'test_file',
  'validation_file',
  'resource_name',
]
// Flattened keys always hidden from the comparison, regardless of value —
// redundant with data shown elsewhere (model path) or only meaningful for
// online RL trials (reward function name/path).
const HIDDEN_KEYS = [
  'training_config.model_name_or_path',
  'training_rl_config.reward_function_name',
  'training_rl_config.reward_function_path',
]

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function toUpperCase(text: string): string {
  if (!text) return ''
  const t = text.replaceAll('_', ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0 s'
  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

function flattenObject(obj: Record<string, any>, parentKey = '', sep = '.'): Record<string, any> {
  const flat: Record<string, any> = {}
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
    const newKey = parentKey ? parentKey + sep + key : key
    const value = obj[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flattenObject(value, newKey, sep))
    } else {
      flat[newKey] = value
    }
  }
  return flat
}

// Keys whose value is not identical across every row.
function findDifferingKeys(rows: Record<string, any>[]): Set<string> {
  const differing = new Set<string>()
  if (rows.length === 0) return differing
  for (const key in rows[0]) {
    if (!Object.prototype.hasOwnProperty.call(rows[0], key)) continue
    const values = rows.map((r) => r[key])
    // Compare by stringified value so arrays/objects don't count as always-differing.
    const first = JSON.stringify(values[0])
    if (!values.every((v) => JSON.stringify(v) === first)) differing.add(key)
  }
  return differing
}

// For each differing key, the minority ("odd one out") values — bolded in the UI.
function getOddOnesOut(rows: Record<string, any>[], keys: string[]): Record<string, Set<string>> {
  const oddOnes: Record<string, Set<string>> = {}
  for (const key of keys) {
    const counts = new Map<string, number>()
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue
      const v = String(row[key])
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const entries = [...counts.entries()].sort((a, b) => a[1] - b[1])
    if (entries.length <= 1) continue
    const minCount = entries[0][1]
    const maxCount = entries[entries.length - 1][1]
    if (minCount === maxCount) continue
    const minority = new Set<string>()
    for (const [value, count] of entries) {
      if (count === minCount) minority.add(value)
    }
    oddOnes[key] = minority
  }
  return oddOnes
}

// Build one comparison row per trial: id + flattened (stripped) config + rounded metrics.
function toCompareRow(trial: Trial): Record<string, any> {
  const rawConfig = (trial.config ?? {}) as Record<string, any>
  const config = structuredClone(rawConfig)
  if (config.training_config && typeof config.training_config === 'object') {
    for (const k of STRIP_TRAINING_KEYS) delete config.training_config[k]
  }
  const flatConfig = flattenObject(config)

  const metrics: Record<string, any> = { ...(trial.metrics ?? {}) }
  if (typeof metrics.loss === 'number') metrics.loss = +metrics.loss.toFixed(5)
  if (typeof metrics.train_loss === 'number') metrics.train_loss = +metrics.train_loss.toFixed(5)
  if (typeof metrics.total_time === 'number') metrics.total_time = formatTime(+metrics.total_time)

  return { id: trial.id, ...flatConfig, ...metrics }
}

// ── Cell rendering ─────────────────────────────────────────────────────────────

function CompareValue({
  value,
  isOdd,
}: {
  value: unknown
  isOdd: boolean
}) {
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((el, i) => {
          if (typeof el === 'string') return <Tag key={i}>{el}</Tag>
          if (el && typeof el === 'object' && 'experiment_name' in el) return <Tag key={i}>{el.experiment_name}</Tag>
          if (el && typeof el === 'object' && 'name' in el) return <Tag key={i}>{el.name}</Tag>
          return <Tag key={i}>No name attribute</Tag>
        })}
      </>
    )
  }
  const display = value === null || value === undefined ? '' : String(value)
  return isOdd ? <strong>{display}</strong> : <>{display}</>
}

// The "loss" a trial is judged on — its primary metric (score.metric), matching
// the Loss column in the trials table, falling back to a literal `loss` metric.
function lossOf(trial: Trial): number | null {
  const metrics = trial.metrics
  if (!metrics) return null
  const primary = trial.metric ? metrics[trial.metric] : undefined
  const value = typeof primary === 'number' ? primary : metrics.loss
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface Props {
  trials: Trial[]
}

export function TrialCompare({ trials }: Props) {
  // Sort by loss ascending — lowest loss first; trials without a loss sink to the end.
  const sortedTrials = [...trials].sort((a, b) => {
    const la = lossOf(a)
    const lb = lossOf(b)
    if (la === null && lb === null) return 0
    if (la === null) return 1
    if (lb === null) return -1
    return la - lb
  })

  const rows = sortedTrials.map(toCompareRow)
  if (rows.length === 0) return null

  const differing = findDifferingKeys(rows)
  const oddOnes = getOddOnesOut(rows, [...differing].filter((k) => !['id', ...RESULT_KEYS].includes(k)))

  // Fixed label column + data columns split evenly across the available width.
  // Carbon's default auto table layout leaves large gaps when cell content is
  // short (numbers, short strings), so we pin the layout explicitly instead.
  const labelColWidth = '13rem'
  const dataColMinWidth = '10rem'
  const dataColWidth = `calc((100% - ${labelColWidth}) / ${rows.length})`

  const allKeys = Object.keys(rows[0]).filter(
    (k) => !HIDDEN_KEYS.includes(k) && !rows.every((row) => isEmptyValue(row[k]))
  )
  const differingResultKeys = allKeys.filter((k) => RESULT_KEYS.includes(k) && differing.has(k))
  const differingConfigKeys = allKeys.filter(
    (k) => !IGNORE_KEYS.includes(k) && !RESULT_KEYS.includes(k) && differing.has(k)
  )
  const sameKeys = allKeys.filter((k) => !IGNORE_KEYS.includes(k) && !differing.has(k))

  const renderRows = (keys: string[]) =>
    keys.map((key) => (
      <StructuredListRow key={key}>
        <StructuredListCell style={{ paddingRight: '2rem' }}>
          <strong>{toUpperCase(key)}</strong>
        </StructuredListCell>
        {rows.map((row) => (
          <StructuredListCell key={row.id}>
            <CompareValue value={row[key]} isOdd={!!oddOnes[key]?.has(String(row[key]))} />
          </StructuredListCell>
        ))}
      </StructuredListRow>
    ))

  const sectionDivider = (key: string) =>
    differing.size > 0 ? (
      <StructuredListRow key={key}>
        <StructuredListCell style={{ borderTop: '2px solid var(--cds-border-strong)', padding: 0 }} />
        {rows.map((row) => (
          <StructuredListCell key={row.id} style={{ borderTop: '2px solid var(--cds-border-strong)', padding: 0 }} />
        ))}
      </StructuredListRow>
    ) : null

  return (
    <StructuredListWrapper isCondensed isFlush style={{ tableLayout: 'fixed', width: '100%' }}>
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head style={{ width: labelColWidth, maxWidth: 'none' }} />
          {rows.map((row) => (
            <StructuredListCell
              key={row.id}
              head
              style={{ width: dataColWidth, minWidth: dataColMinWidth, maxWidth: 'none' }}
            >
              {row.id}
            </StructuredListCell>
          ))}
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {renderRows(differingResultKeys)}
        {differingResultKeys.length > 0 && sectionDivider('divider-1')}
        {renderRows(differingConfigKeys)}
        {differingConfigKeys.length > 0 && sectionDivider('divider-2')}
        {renderRows(sameKeys)}
      </StructuredListBody>
    </StructuredListWrapper>
  )
}
