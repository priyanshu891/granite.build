/**
 * Stub API client for the AutoTuneX Start Tuning wizard.
 *
 * The real AutoTuneX backend is a separate FastAPI service this repo doesn't
 * yet proxy to. Every function here mirrors the real API's signature/shape
 * (see the AutoTuneX SvelteKit app's `api.ts`) but resolves mock data after a
 * short simulated delay instead of making a network call. Swapping a
 * function's body for a real `axios`/`fetch` call later is a same-signature
 * change — nothing that calls these functions needs to change.
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
  TrialScore,
  TuningAsset,
  TuningForm,
  TuningJob,
  TuningStatus,
} from '@/types'
import axios from 'axios'
import { autotunexApiBase } from '@/api/client'

const client = axios.create({ baseURL: autotunexApiBase('') })

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function generateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// ── HuggingFace models ────────────────────────────────────────────────────────

const MOCK_HF_MODELS: HuggingFaceModel[] = [
  'ibm-granite/granite-4.0-h-micro',
  'ibm-granite/granite-4.0-h-tiny',
  'ibm-granite/granite-3.3-8b-instruct',
  'meta-llama/Llama-3.1-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'Qwen/Qwen2.5-7B-Instruct',
].map((id, i) => ({
  _id: generateId('hf'),
  id,
  likes: 1000 - i * 50,
  trendingScore: 100 - i * 5,
  private: false,
  config: { architectures: ['GraniteForCausalLM'], model_type: 'granite' },
  downloads: 500000 - i * 10000,
  tags: ['text-generation', 'transformers'],
  pipeline_tag: 'text-generation',
  library_name: 'transformers',
  createdAt: new Date(2025, 0, 1).toISOString(),
  modelId: id,
}))

export async function getHFModels(search = '', limit = 10): Promise<HuggingFaceModel[]> {
  const term = search.toLowerCase()
  const results = term ? MOCK_HF_MODELS.filter((m) => m.id.toLowerCase().includes(term)) : MOCK_HF_MODELS
  return delay(results.slice(0, limit))
}

export async function getHFModelCard(modelId: string): Promise<string> {
  return delay(
    `---\nlicense: apache-2.0\n---\n\n# ${modelId}\n\nThis is a mock model card (AutoTuneX backend integration not wired up yet).\n\n## Model Details\n\n- **Model ID**: ${modelId}\n- **Pipeline**: text-generation\n`,
    150
  )
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

/** Simulates the real tus-resumable chunked upload's progress callback. */
export async function uploadDatasetChunked(datasetId: string, opts: UploadDatasetChunkedOptions): Promise<void> {
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await delay(null, 80)
    opts.onProgress?.(Math.round((i / steps) * 100))
  }
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
