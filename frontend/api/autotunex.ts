/**
 * API client for the AutoTuneX backend (FastAPI service, proxied via
 * /api/autotunex/* — see `autotunexApiBase` in `@/api/client`).
 *
 * Dev mode: calls go through the Next.js dev proxy. Standalone builds target
 * AUTOTUNEX_API_URL directly when it's baked in at build time. `getHFModels`/
 * `getHFModelCard` are the two exceptions — they call the public HuggingFace
 * API directly via bare `axios`, not through this backend.
 */
import type {
  AiMappingSuggestion,
  Configuration,
  ConfigData,
  ConfigMutationResult,
  Dataset,
  DatasetInfo,
  Estimation,
  HuggingFaceModel,
  LogEntry,
  ModelSource,
  PendingConfigData,
  PendingConfigUpdate,
  Resources,
  RewardFunctionValidationResult,
  Trial,
  TuningAsset,
  TuningForm,
  TuningJob,
  TuningStatus,
} from '@/types'
import axios from 'axios'
import { autotunexApiBase } from '@/api/client'

const client = axios.create({ baseURL: autotunexApiBase('') })

// ── HuggingFace models ────────────────────────────────────────────────────────

export async function getHFModels(search = '', limit = 10): Promise<HuggingFaceModel[]> {
  const params = new URLSearchParams({ search, limit: String(limit), config: 'true' })
  const { data } = await axios.get<{ models: HuggingFaceModel[] } | HuggingFaceModel[]>(
    `https://huggingface.co/api/models?${params.toString()}`
  )
  return Array.isArray(data) ? data : []
}

export async function getHFModelCard(modelId: string): Promise<string> {
  const { data } = await axios.get<string>(`https://huggingface.co/${modelId}/raw/main/README.md`, {
    responseType: 'text',
  })
  return data
}

// ── DMF models ─────────────────────────────────────────────────────────────────

export interface DmfModel {
  model_id: string
  model_label: string
  base_model: string
  namespace: string
  revision: string
  open: boolean
}

export async function searchDMFModels(query: string): Promise<{ data: DmfModel[] }> {
  const { data } = await client.post<{ data: DmfModel[] } | DmfModel[]>('/dmf/search', { query })
  // Real response envelope is unconfirmed from source — accept either a bare
  // array or a {data: [...]} wrapper so an unexpected shape degrades to an
  // empty result instead of throwing.
  if (Array.isArray(data)) return { data }
  if (data && Array.isArray((data as { data: DmfModel[] }).data)) return data as { data: DmfModel[] }
  return { data: [] }
}

// ── Configurations ────────────────────────────────────────────────────────────

function adaptConfiguration(raw: Record<string, unknown>): Configuration {
  return {
    id: raw.id as string,
    user_id: raw.user_id as string,
    name: raw.name as string,
    tuner_type: raw.tuner_type as string,
    rl_tuner_type: (raw.rl_tuner_type as string | null | undefined) ?? null,
    artifact_id: (raw.artifact_id as string) ?? '',
    artifact_url: (raw.artifact_url as string) ?? '',
    config_data: (raw.config_data as ConfigData | null | undefined) ?? null,
    created_at: raw.created_at as string | undefined,
    updated_at: raw.updated_at as string | undefined,
    associated_jobs: (raw.associated_jobs as unknown[]) ?? [],
  }
}

export async function getConfigurationTemplate(): Promise<ConfigData> {
  const { data } = await client.get<Record<string, unknown>>('/config')
  return data as unknown as ConfigData
}

export async function getConfigurations(): Promise<Configuration[]> {
  const { data } = await client.get<Record<string, unknown>[]>('/configs')
  return (data ?? []).map(adaptConfiguration)
}

export async function getConfiguration(id: string): Promise<Configuration> {
  const { data } = await client.get<Record<string, unknown>>(`/config/${id}`)
  return adaptConfiguration(data)
}

export async function createConfiguration(payload: PendingConfigData): Promise<ConfigMutationResult> {
  const { data } = await client.post<{ id: string; status: string; message?: string }>('/config', {
    name: payload.name,
    tuner_type: payload.tuner_type,
    rl_tuner_type: payload.rl_tuner_type,
    config_data: payload.config_data,
  })
  return data
}

export async function updateConfiguration(
  configId: string,
  payload: PendingConfigUpdate
): Promise<ConfigMutationResult> {
  const { data } = await client.put<{ id: string; status: string; message?: string }>(
    `/config/${configId}`,
    {
      name: payload.name,
      tuner_type: payload.tuner_type,
      rl_tuner_type: payload.rl_tuner_type,
      config_data: payload.config_data,
    }
  )
  return data
}

// ── Datasets ───────────────────────────────────────────────────────────────────

function adaptDataset(raw: Record<string, unknown>): Dataset {
  return {
    id: raw.id as string,
    user_id: raw.user_id as string,
    name: raw.name as string,
    description: raw.description as string,
    train_file: (raw.train_file as string) ?? '',
    train_records: (raw.train_records as number) ?? 0,
    train_file_size: (raw.train_file_size as number) ?? 0,
    validation_file: (raw.validation_file as string) ?? '',
    validation_records: (raw.validation_records as number) ?? 0,
    validation_file_size: (raw.validation_file_size as number) ?? 0,
    artifact_id: (raw.artifact_id as string) ?? '',
    artifact_url: (raw.artifact_url as string) ?? '',
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
    data_format: raw.data_format as Dataset['data_format'],
    associated_jobs: (raw.associated_jobs as unknown[]) ?? [],
    train_data: raw.train_data as Record<string, any>[] | undefined,
    validation_data: raw.validation_data as Record<string, any>[] | undefined,
  }
}

export async function getDatasets(): Promise<Dataset[]> {
  const { data } = await client.get<Record<string, unknown>[]>('/datasets')
  return (data ?? []).map(adaptDataset)
}

export async function getDataset(id: string): Promise<Dataset> {
  const { data } = await client.get<Record<string, unknown>>(`/dataset/${id}`)
  return adaptDataset(data)
}

export async function createDataset(payload: { name: string; description: string }): Promise<DatasetInfo> {
  const { data } = await client.post<DatasetInfo>('/dataset', payload)
  return data
}

export interface UploadDatasetChunkedOptions {
  trainFile: File
  validationFile?: File | null
  columnMapping?: Record<string, string> | null
  trainSetPercentage?: number | null
  onProgress?: (percent: number) => void
}

export async function uploadDatasetChunked(datasetId: string, opts: UploadDatasetChunkedOptions): Promise<void> {
  const { Upload } = await import('tus-js-client')
  const endpoint = autotunexApiBase('/datasets/tus')
  const chunkSize = 16 * 1024 * 1024

  const hasValidation = !!opts.validationFile
  const files: Array<{ file: File; role: 'source' | 'train' | 'validation' }> = hasValidation
    ? [
        { file: opts.trainFile, role: 'train' },
        { file: opts.validationFile as File, role: 'validation' },
      ]
    : [{ file: opts.trainFile, role: 'source' }]
  const expects = files.map((f) => f.role).join(',')

  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0)
  const uploaded: Record<string, number> = {}
  const reportProgress = () => {
    if (!opts.onProgress) return
    const done = Object.values(uploaded).reduce((a, b) => a + b, 0)
    opts.onProgress(Math.min(100, Math.round((done / Math.max(1, totalBytes)) * 100)))
  }

  const uploadOne = (file: File, role: 'source' | 'train' | 'validation'): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const metadata: Record<string, string> = {
        dataset_id: datasetId,
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
        role,
        expects,
      }
      if (opts.columnMapping) metadata.column_mapping = JSON.stringify(opts.columnMapping)
      if (!hasValidation && opts.trainSetPercentage != null) {
        metadata.train_set_percentage = String(opts.trainSetPercentage)
      }

      const upload = new Upload(file, {
        endpoint,
        chunkSize,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        removeFingerprintOnSuccess: true,
        metadata,
        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject() as XMLHttpRequest
          xhr.withCredentials = true
        },
        onError: (error) => reject(error),
        onProgress: (bytesUploaded) => {
          uploaded[role] = bytesUploaded
          reportProgress()
        },
        onSuccess: () => {
          uploaded[role] = file.size
          reportProgress()
          resolve()
        },
      })

      upload
        .findPreviousUploads()
        .then((previous) => {
          if (previous.length) upload.resumeFromPreviousUpload(previous[0])
          upload.start()
        })
        .catch(() => upload.start())
    })

  await Promise.all(files.map((f) => uploadOne(f.file, f.role)))
  opts.onProgress?.(100)
}

// ── Job estimation & launch ───────────────────────────────────────────────────

export async function estimateUsage(payload: Estimation): Promise<Resources> {
  const { data } = await client.post<Resources>('/job/estimate_usages', payload)
  return data
}

export async function startJob(tuning: TuningForm): Promise<{ id: string }> {
  const { data } = await client.post<{ job_id: string }>('/job', tuning)
  return { id: data.job_id }
}

// ── Dataset type metadata (backend-informed column requirements) ─────────────

function stripColSuffix(key: string): string {
  return key.endsWith('_col') ? key.slice(0, -4) : key
}

export async function getAutotuneDatasetTypes(): Promise<Record<string, any>> {
  const { data } = await client.get<Record<string, { desc?: string; columns?: Record<string, unknown> }>>(
    '/autotune_dataset_types'
  )
  const normalized: Record<string, any> = {}
  for (const [typeKey, typeVal] of Object.entries(data ?? {})) {
    const columns: Record<string, unknown> = {}
    for (const [colKey, colVal] of Object.entries(typeVal.columns ?? {})) {
      columns[stripColSuffix(colKey)] = colVal
    }
    normalized[typeKey] = { desc: typeVal.desc, columns }
  }
  return normalized
}

// ── AI-assisted column mapping ────────────────────────────────────────────────

export async function suggestColumnMappingAI(
  sampleData: Record<string, any>[],
  columnNames: string[],
  columnSamples: Record<string, string[]>,
  targetDatasetType?: string
): Promise<AiMappingSuggestion> {
  const { data } = await client.post<Record<string, unknown>>('/datasets/suggest-mapping', {
    sample_data: sampleData,
    column_names: columnNames,
    column_samples: columnSamples,
    ...(targetDatasetType ? { target_dataset_type: targetDatasetType } : {}),
  })
  return {
    dataset_type: data.dataset_type as string,
    dataset_type_desc: (data.dataset_type_desc as string) ?? '',
    algorithm: data.algorithm as string,
    confidence: data.confidence as number,
    column_mapping: data.column_mapping as AiMappingSuggestion['column_mapping'],
    reasoning: data.reasoning as string,
  }
}

// ── Reward function validation & test execution (Online RL step) ────────────

export async function validateRewardFunction(
  code: string,
  functionName: string,
  testExecution: boolean = false,
  testInputs?: Record<string, any> | Record<string, any>[]
): Promise<RewardFunctionValidationResult> {
  const { data } = await client.post<RewardFunctionValidationResult>('/reward-function/validate', {
    code,
    function_name: functionName,
    test_execution: testExecution,
    test_inputs: testInputs,
  })
  return data
}

export async function generateTestSolutions(
  prompts: Array<Array<{ role: string; content: string }>>
): Promise<{ solutions: string[] }> {
  const { data } = await client.post<{ solutions: string[] }>('/generate-test-solutions', { prompts })
  return data
}

// ── Tuning jobs (Tunings list / detail view) ──────────────────────────────────

function adaptJob(raw: Record<string, unknown>): TuningJob {
  return {
    id: raw.id as string,
    status: raw.status as TuningStatus,
    model: raw.model as string,
    model_source: raw.model_source as ModelSource,
    experiment_name: raw.experiment_name as string,
    config_id: raw.config_id as string,
    config_name: raw.config_name as string,
    dataset_id: raw.dataset_id as string,
    dataset: raw.dataset as string,
    seed: raw.seed as number,
    precision: raw.precision as string,
    autotune: Boolean(raw.autotune),
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  }
}

export async function getJobs(): Promise<TuningJob[]> {
  const { data } = await client.get<Record<string, unknown>[]>('/jobs')
  return (data ?? []).map(adaptJob)
}

export async function getJob(id: string): Promise<TuningJob> {
  const { data } = await client.get<Record<string, unknown>>(`/job/${id}`, {
    params: { include_logs: false },
  })
  return adaptJob(data)
}

export async function deleteJob(id: string): Promise<void> {
  await client.delete(`/job/${id}`)
}

export async function deleteDataset(id: string): Promise<void> {
  await client.delete(`/dataset/${id}`)
}

export async function deleteConfiguration(id: string): Promise<void> {
  await client.delete(`/config/${id}`)
}

// ── Trials (autotune jobs only) ───────────────────────────────────────────────

function adaptTrial(raw: Record<string, unknown>): Trial {
  const rawScore = raw.score as Record<string, unknown> | undefined
  const hasScore = !!rawScore && Object.keys(rawScore).length > 0
  return {
    id: raw.id as string,
    job_id: raw.job_id as string,
    status: raw.status as TuningStatus,
    config: (raw.config as Record<string, any>) ?? {},
    score: hasScore
      ? { metric: rawScore!.metric as string, metrics: rawScore!.metrics as Record<string, number> }
      : null,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  }
}

export async function getJobTrials(jobId: string): Promise<Trial[]> {
  try {
    const { data } = await client.get<Record<string, unknown>[]>(`/job/${jobId}/trials`)
    return (data ?? []).map(adaptTrial)
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return []
    throw err
  }
}

// ── Output assets (Results tab) ───────────────────────────────────────────────

export async function getJobAssets(jobId: string): Promise<TuningAsset[]> {
  try {
    const { data } = await client.get<Record<string, unknown>[]>(`/job/${jobId}/result_report`)
    return (data ?? []).map((a) => ({
      filename: a.filename as string,
      size: a.size as number,
      modified: a.modified as string,
    }))
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 400) return []
    throw err
  }
}

// ── Logs ───────────────────────────────────────────────────────────────────────

function adaptLogEntry(raw: Record<string, unknown>): LogEntry {
  return {
    id: raw.id as number,
    timestamp: raw.timestamp as string,
    level: raw.level as string,
    filename: raw.filename as string,
    message: raw.message as string,
  }
}

export async function getJobLogs(
  jobId: string,
  opts?: { beforeId?: number; limit?: number }
): Promise<{ logs: LogEntry[]; hasMore: boolean }> {
  const { data } = await client.get<{ logs: Record<string, unknown>[]; has_more: boolean }>(
    `/job/${jobId}/logs`,
    { params: { before_id: opts?.beforeId ?? 0, limit: opts?.limit ?? 50 } }
  )
  return {
    logs: (data.logs ?? []).map(adaptLogEntry),
    hasMore: Boolean(data.has_more),
  }
}

// Mirrors the reference AutoTuneX endpoint: /job/trial/{trialId}/logs — keyed
// on trialId only (no jobId in the path), same shape/pagination as job logs.
export async function getTrialLogs(
  trialId: string,
  opts?: { beforeId?: number; limit?: number }
): Promise<{ logs: LogEntry[]; hasMore: boolean }> {
  const { data } = await client.get<{ logs: Record<string, unknown>[]; has_more: boolean }>(
    `/job/trial/${trialId}/logs`,
    { params: { before_id: opts?.beforeId ?? 0, limit: opts?.limit ?? 50 } }
  )
  return {
    logs: (data.logs ?? []).map(adaptLogEntry),
    hasMore: Boolean(data.has_more),
  }
}
