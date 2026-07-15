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
  Dataset,
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

const MOCK_DMF_MODELS: DmfModel[] = [
  { model_id: 'granite-4.0-micro', model_label: 'Granite 4.0 Micro', base_model: 'granite-4.0-micro', namespace: 'ibm', revision: 'main', open: true },
  { model_id: 'granite-3.3-8b', model_label: 'Granite 3.3 8B', base_model: 'granite-3.3-8b', namespace: 'ibm', revision: 'main', open: true },
]

export async function searchDMFModels(query: string): Promise<{ data: DmfModel[] }> {
  const term = query.toLowerCase()
  const data = term ? MOCK_DMF_MODELS.filter((m) => m.model_id.toLowerCase().includes(term)) : MOCK_DMF_MODELS
  return delay({ data })
}

// ── Configurations ────────────────────────────────────────────────────────────

// Field `type` follows the real template's runtime contract: 'str' | 'int' | 'float' | 'bool' | 'list'
// (not the 'string' the source app's own `Type` enum claims — every actual type check in its
// config-editing form compares against the literal 'str').
function mockConfigData(): ConfigData {
  return {
    tune_config: {
      scheduler: { type: 'str', values: ['fifo', 'hyperband'], default: 'fifo', max_val: null, min_val: null, description: 'Trial scheduler.' },
      search_alg: { type: 'str', values: ['random', 'bayesopt'], default: 'random', max_val: null, min_val: null, description: 'Search algorithm.' },
      num_samples: { type: 'int', values: null, default: 4, max_val: 32, min_val: 1, description: 'Number of hyperparameter configurations to try.' },
      max_discrepancy: { type: 'int', values: null, default: 4, max_val: 16, min_val: 1, description: 'Max discrepancy for the lds search algorithm.' },
      max_concurrent_trials: { type: 'int', values: null, default: 4, max_val: 16, min_val: 1, description: 'Max trials run in parallel.' },
    },
    tuners_config: {
      lora: {
        title: 'LoRA',
        tuner_name: 'lora',
        description: 'Low-Rank Adaptation.',
        hyperparams: {
          r: { type: 'int', values: [4, 8, 16, 32], default: 8, max_val: 64, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA rank.' },
          bias: { type: 'str', values: ['none', 'all', 'lora_only'], default: 'none', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'Bias training mode.' },
          alpha_ratio: { type: 'float', values: [0.5, 1, 2], default: 1, max_val: 4, min_val: 0.25, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA alpha / rank ratio.' },
          lora_dropout: { type: 'float', values: [0, 0.05, 0.1], default: 0.05, max_val: 0.5, min_val: 0, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA dropout.' },
          learning_rate: { type: 'float', values: [1e-5, 1e-4, 1e-3], default: 1e-4, max_val: 1e-2, min_val: 1e-6, options: ['loguniform'], strategy: 'loguniform', for_tuner: true, description: 'Learning rate.' },
          lr_scheduler_type: { type: 'str', values: ['linear', 'cosine'], default: 'linear', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'LR scheduler.' },
          gradient_accumulation_steps: { type: 'int', values: [1, 2, 4], default: 1, max_val: 16, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Gradient accumulation steps.' },
          per_device_train_batch_size: { type: 'int', values: [1, 2, 4], default: 2, max_val: 32, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Per-device batch size.' },
          invocation_string: { type: 'str', values: ['[UNK]'], default: '', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Prompt invocation string (aLoRA only).' },
        },
      },
      alora: {
        title: 'aLoRA',
        tuner_name: 'alora',
        description: 'Adaptive LoRA.',
        hyperparams: {
          r: { type: 'int', values: [4, 8, 16], default: 8, max_val: 64, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA rank.' },
          bias: { type: 'str', values: ['none', 'all'], default: 'none', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'Bias training mode.' },
          alpha_ratio: { type: 'float', values: [0.5, 1, 2], default: 1, max_val: 4, min_val: 0.25, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA alpha / rank ratio.' },
          lora_dropout: { type: 'float', values: [0, 0.05], default: 0.05, max_val: 0.5, min_val: 0, options: ['choice'], strategy: 'choice', for_tuner: true, description: 'LoRA dropout.' },
          learning_rate: { type: 'float', values: [1e-5, 1e-4], default: 1e-4, max_val: 1e-2, min_val: 1e-6, options: ['loguniform'], strategy: 'loguniform', for_tuner: true, description: 'Learning rate.' },
          lr_scheduler_type: { type: 'str', values: ['linear'], default: 'linear', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'LR scheduler.' },
          gradient_accumulation_steps: { type: 'int', values: [1, 2], default: 1, max_val: 16, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Gradient accumulation steps.' },
          per_device_train_batch_size: { type: 'int', values: [1, 2], default: 2, max_val: 32, min_val: 1, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Per-device batch size.' },
          invocation_string: { type: 'str', values: ['[UNK]'], default: '[UNK]', max_val: null, min_val: null, options: ['choice'], strategy: 'choice', for_tuner: false, description: 'Prompt invocation string.' },
        },
      },
    },
    training_config: {
      seed: { type: 'int', values: null, default: 42, max_val: 10000, min_val: 0, description: 'Random seed.' },
      precision: { type: 'str', values: ['fp32', 'bf16'], default: 'bf16', max_val: null, min_val: null, description: 'Training precision.' },
      max_length: { type: 'int', values: null, default: 1024, max_val: 8192, min_val: 128, description: 'Max sequence length.' },
      input_column: { type: 'str', values: null, default: 'input', max_val: null, min_val: null, description: 'Input column name.' },
      warmup_ratio: { type: 'float', values: null, default: 0.1, max_val: 1, min_val: 0, description: 'Warmup ratio.' },
      output_column: { type: 'str', values: null, default: 'output', max_val: null, min_val: null, description: 'Output column name.' },
      hpo_num_epochs: { type: 'int', values: null, default: 3, max_val: 20, min_val: 1, description: 'Epochs per HPO trial.' },
      num_train_epochs: { type: 'int', values: null, default: 3, max_val: 20, min_val: 1, description: 'Training epochs.' },
      use_chat_template: { type: 'bool', values: null, default: true, max_val: null, min_val: null, description: 'Apply chat template.' },
      num_gpus_per_trial: { type: 'int', values: null, default: 1, max_val: 8, min_val: 1, description: 'GPUs per trial.' },
      num_cpus_per_worker: { type: 'int', values: null, default: 4, max_val: 32, min_val: 1, description: 'CPUs per worker.' },
      use_flash_attention: { type: 'bool', values: null, default: true, max_val: null, min_val: null, description: 'Use flash attention.' },
      train_implementation: { type: 'str', values: ['trl', 'peft'], default: 'peft', max_val: null, min_val: null, description: 'Training implementation.' },
      hpo_dataset_percentage: { type: 'float', values: null, default: 0.2, max_val: 1, min_val: 0.01, description: 'Fraction of the dataset used during HPO.' },
    },
    tuners_rl_config: {
      grpo: {
        title: 'GRPO',
        tuner_name: 'grpo',
        description: 'Group Relative Policy Optimization',
        hyperparams: {
          learning_rate: { type: 'float', values: [1e-6, 1e-5, 1e-4], default: 1e-5, max_val: 1e-3, min_val: 1e-7, options: ['loguniform'], strategy: 'loguniform', for_tuner: true, description: 'Learning rate.' },
        },
      },
      ppo: {
        title: 'PPO',
        tuner_name: 'ppo',
        description: 'Proximal Policy Optimization',
        hyperparams: {
          learning_rate: { type: 'float', values: [1e-6, 1e-5, 1e-4], default: 1e-5, max_val: 1e-3, min_val: 1e-7, options: ['loguniform'], strategy: 'loguniform', for_tuner: true, description: 'Learning rate.' },
        },
      },
      dapo: {
        title: 'DAPO',
        tuner_name: 'dapo',
        description: 'Decoupled Advantage Policy Optimization',
        hyperparams: {
          learning_rate: { type: 'float', values: [1e-6, 1e-5, 1e-4], default: 1e-5, max_val: 1e-3, min_val: 1e-7, options: ['loguniform'], strategy: 'loguniform', for_tuner: true, description: 'Learning rate.' },
        },
      },
    },
    training_rl_config: {
      rl_algorithm: { type: 'str', values: ['none', 'ppo', 'grpo', 'dapo'], default: 'none', max_val: null, min_val: null, description: 'RL algorithm.' },
      kl_coef: { type: 'float', values: null, default: 0.001, max_val: 1, min_val: 0, description: 'KL penalty coefficient.' },
    },
    general_config: {
      seed: { type: 'int', values: null, default: 42, max_val: 10000, min_val: 0, description: 'Random seed.' },
    },
    tokenizer_config: {
      special_tokens: { type: 'list', values: null, default: [], max_val: null, min_val: null, description: 'Additional special tokens.' },
    },
  }
}

export async function getConfigurationTemplate(): Promise<ConfigData> {
  return delay(mockConfigData(), 400)
}

const MOCK_CONFIGURATIONS: Configuration[] = [
  {
    id: 'cfg-lora-default',
    user_id: 'mock-user',
    name: 'LoRA Default',
    tuner_type: 'lora',
    rl_tuner_type: null,
    artifact_id: '',
    artifact_url: '',
    config_data: mockConfigData(),
    created_at: new Date(2025, 5, 1).toISOString(),
    updated_at: new Date(2025, 5, 1).toISOString(),
  },
  {
    id: 'cfg-alora-fast',
    user_id: 'mock-user',
    name: 'aLoRA Fast',
    tuner_type: 'alora',
    rl_tuner_type: null,
    artifact_id: '',
    artifact_url: '',
    config_data: mockConfigData(),
    created_at: new Date(2025, 6, 1).toISOString(),
    updated_at: new Date(2025, 6, 1).toISOString(),
  },
]

export async function getConfigurations(): Promise<Configuration[]> {
  return delay(MOCK_CONFIGURATIONS)
}

export async function getConfiguration(id: string): Promise<Configuration> {
  const found = MOCK_CONFIGURATIONS.find((c) => c.id === id)
  if (!found) throw new Error(`Configuration ${id} not found`)
  return delay(found)
}

export async function createConfiguration(payload: PendingConfigData): Promise<Configuration> {
  const config: Configuration = {
    id: generateId('cfg'),
    user_id: 'mock-user',
    name: payload.name,
    tuner_type: payload.tuner_type ?? 'lora',
    rl_tuner_type: payload.rl_tuner_type,
    artifact_id: '',
    artifact_url: '',
    config_data: payload.config_data,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  MOCK_CONFIGURATIONS.push(config)
  return delay(config, 500)
}

export async function updateConfiguration(configId: string, payload: PendingConfigUpdate): Promise<Configuration> {
  const existing = MOCK_CONFIGURATIONS.find((c) => c.id === configId)
  const updated: Configuration = {
    ...(existing ?? MOCK_CONFIGURATIONS[0]),
    id: configId,
    name: payload.name,
    tuner_type: payload.tuner_type ?? 'lora',
    rl_tuner_type: payload.rl_tuner_type,
    config_data: payload.config_data,
    updated_at: new Date().toISOString(),
  }
  return delay(updated, 500)
}

// ── Datasets ───────────────────────────────────────────────────────────────────

const MOCK_DATASET_PREVIEW_ROWS = Array.from({ length: 8 }, (_, i) => ({
  input: `Sample instruction #${i + 1}`,
  output: `Sample response #${i + 1}`,
}))

const MOCK_DATASETS: Dataset[] = [
  {
    id: 'ds-instructions',
    user_id: 'mock-user',
    name: 'Instruction pairs (sample)',
    description: 'A small sample instruction-following dataset.',
    train_file: 'train.jsonl',
    train_records: 4800,
    train_file_size: 2_400_000,
    validation_file: 'validation.jsonl',
    validation_records: 1200,
    validation_file_size: 600_000,
    artifact_id: '',
    artifact_url: '',
    created_at: new Date(2025, 4, 12).toISOString(),
    updated_at: new Date(2025, 4, 12).toISOString(),
    train_data: MOCK_DATASET_PREVIEW_ROWS,
    validation_data: MOCK_DATASET_PREVIEW_ROWS.slice(0, 3),
  },
]

export async function getDatasets(): Promise<Dataset[]> {
  return delay(MOCK_DATASETS)
}

export async function getDataset(id: string): Promise<Dataset> {
  const found = MOCK_DATASETS.find((d) => d.id === id)
  if (!found) throw new Error(`Dataset ${id} not found`)
  return delay(found)
}

export async function createDataset(payload: { name: string; description: string }): Promise<Dataset> {
  const dataset: Dataset = {
    id: generateId('ds'),
    user_id: 'mock-user',
    name: payload.name,
    description: payload.description,
    train_file: '',
    train_records: 0,
    train_file_size: 0,
    validation_file: '',
    validation_records: 0,
    validation_file_size: 0,
    artifact_id: '',
    artifact_url: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  MOCK_DATASETS.push(dataset)
  return delay(dataset, 500)
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
  return delay(
    {
      model_size_billion_params: 3,
      gpu_memory_gb: 24,
      cpu_memory_gb: 32,
      num_gpus: 1,
      weights_memory: 6,
      optimizer_memory: 6,
      gradients_memory: 6,
      activations_memory: 4,
    },
    400
  )
}

export async function startJob(tuning: TuningForm): Promise<{ id: string }> {
  return delay({ id: generateId('job') }, 500)
}

// ── Dataset type metadata (backend-informed column requirements) ─────────────

export async function getAutotuneDatasetTypes(): Promise<Record<string, any>> {
  return delay({
    dataset_type_a: {
      columns: {
        input: { name: 'input', desc: 'Instruction or prompt', required: true },
        output: { name: 'output', desc: 'Expected response', required: true },
      },
    },
    dataset_type_b: {
      columns: {
        prompt: { name: 'prompt', desc: 'Prompt', required: true },
        chosen: { name: 'chosen', desc: 'Preferred response', required: true },
        rejected: { name: 'rejected', desc: 'Rejected response', required: true },
      },
    },
    dataset_type_c: {
      columns: {
        prompt: { name: 'prompt', desc: 'Prompt', required: true },
        completion: { name: 'completion', desc: 'Completion', required: true },
        label: { name: 'label', desc: 'true/false feedback label', required: true },
      },
    },
    dataset_type_d: {
      columns: {
        prompt: { name: 'prompt', desc: 'Prompt', required: true },
      },
    },
  })
}

// ── AI-assisted column mapping ────────────────────────────────────────────────

export async function suggestColumnMappingAI(
  sampleData: Record<string, any>[],
  columnNames: string[],
  columnSamples: Record<string, string[]>,
  targetDatasetType?: string
): Promise<AiMappingSuggestion> {
  return delay(
    {
      dataset_type: targetDatasetType ?? 'dataset_type_a',
      dataset_type_desc: 'Mock dataset type — AutoTuneX backend integration not wired up yet.',
      algorithm: 'lora',
      confidence: 0.75,
      column_mapping: Object.fromEntries(columnNames.map((c) => [c, { source_column: c, confidence: 0.75 }])),
      reasoning: 'Mock suggestion — column names matched heuristically since the real backend is not wired up yet.',
    },
    600
  )
}

// ── Reward function validation & test execution (Online RL step) ─────────────

const DANGEROUS_CODE_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /\bos\.system\s*\(/, message: "Use of 'os.system()' is not allowed in reward functions." },
  { pattern: /\bsubprocess\./, message: "Use of the 'subprocess' module is not allowed in reward functions." },
  { pattern: /\beval\s*\(/, message: "Use of 'eval()' is not allowed in reward functions." },
  { pattern: /\b__import__\s*\(/, message: "Use of '__import__()' is not allowed in reward functions." },
  { pattern: /\bopen\s*\(/, message: "File access via 'open()' is not allowed in reward functions." },
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractFinalNumber(text: string): string | null {
  const matches = text.match(/[-+]?\d+(?:\.\d+)?/g)
  return matches && matches.length > 0 ? matches[matches.length - 1] : null
}

function normalizeGroundTruth(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const cleaned = String(value).trim().replace(/,/g, '').replace(/\$/g, '')
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Mock reward-function "backend": there's no real Python sandbox here. This
 * runs a handful of plausible static checks (balanced parens, banned
 * imports/builtins, function signature) and, when `testExecution` is
 * requested, scores each test input with a crude numeric-match heuristic —
 * good enough to exercise the UI's pass/fail/error states without a real
 * execution engine.
 */
export async function validateRewardFunction(
  code: string,
  functionName: string,
  testExecution: boolean = false,
  testInputs?: Record<string, any> | Record<string, any>[]
): Promise<RewardFunctionValidationResult> {
  await delay(null, 450)

  const syntaxErrors: string[] = []
  const securityIssues: string[] = []

  const trimmed = code.trim()
  if (trimmed.length === 0) {
    syntaxErrors.push('Reward function code is empty.')
  } else {
    const opens = (code.match(/\(/g) || []).length
    const closes = (code.match(/\)/g) || []).length
    if (opens !== closes) syntaxErrors.push('Unbalanced parentheses detected.')
  }

  for (const { pattern, message } of DANGEROUS_CODE_PATTERNS) {
    if (pattern.test(code)) securityIssues.push(message)
  }

  const signatureMatch = code.match(new RegExp(`def\\s+${escapeRegExp(functionName)}\\s*\\(([^)]*)\\)`))
  const functionFound = signatureMatch !== null
  const paramCount = signatureMatch ? signatureMatch[1].split(',').filter((p) => p.trim().length > 0).length : 0
  const functionSignatureValid = functionFound && paramCount >= 2

  const syntaxValid = syntaxErrors.length === 0
  const securityValid = securityIssues.length === 0
  const success = syntaxValid && securityValid && functionFound && functionSignatureValid

  let testResult: RewardFunctionValidationResult['test_result'] = null
  if (testExecution) {
    const inputs = Array.isArray(testInputs) ? testInputs : testInputs ? [testInputs] : []
    if (!success) {
      testResult = { executed: false, error: 'Fix validation errors above before running test cases.', results: [] }
    } else {
      const results = inputs.map((input) => {
        const solutionStr = typeof input.solution_str === 'string' ? input.solution_str : ''
        const groundTruth = normalizeGroundTruth(input.ground_truth)
        if (!solutionStr && groundTruth === null) {
          return { error: "Missing 'solution_str'/'ground_truth' in test input." }
        }
        const predicted = extractFinalNumber(solutionStr)
        const isCorrect = predicted !== null && groundTruth !== null && predicted === groundTruth
        const formatBonus = solutionStr.includes('####') ? 0.05 : 0
        const lengthPenalty = solutionStr ? -Math.min(solutionStr.length / 4000, 0.2) : 0
        const base = isCorrect ? 1 : -1
        return { return_value: Math.round((base + formatBonus + lengthPenalty) * 1000) / 1000 }
      })
      testResult = {
        executed: true,
        stdout: `Ran ${results.length} test case(s) against ${functionName}().`,
        results,
      }
    }
  }

  return {
    success,
    syntax_errors: syntaxErrors,
    security_issues: securityIssues,
    validation: {
      syntax_valid: syntaxValid,
      security_valid: securityValid,
      function_found: functionFound,
      function_signature_valid: functionSignatureValid,
    },
    test_result: testResult,
  }
}

export async function generateTestSolutions(
  prompts: Array<Array<{ role: string; content: string }>>
): Promise<{ solutions: string[] }> {
  const solutions = prompts.map((messages, i) => {
    const text = messages.map((m) => m.content).join(' ')
    const numbers = text.match(/[-+]?\d+(?:\.\d+)?/g)
    const guess = numbers && numbers.length > 0 ? parseFloat(numbers[numbers.length - 1]) : 10 + i
    // Mock LLM: right most of the time, occasionally off by a bit — plausible
    // mixed pass/fail behavior once these solutions are scored downstream.
    const noisyGuess = Math.random() < 0.7 ? guess : guess + (Math.random() < 0.5 ? 1 : -1) * (Math.floor(Math.random() * 5) + 1)
    return `Mock model response (backend not wired up yet). Working through the problem step by step... #### ${noisyGuess}`
  })
  return delay({ solutions }, 500)
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

function mockLogLines(jobId: string, count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.now() - (count - i) * 15_000).toISOString(),
    level: i % 7 === 0 ? 'WARNING' : 'INFO',
    filename: 'trainer.py',
    message: `[${jobId}] step ${i + 1}/${count}: mock training log line (backend not wired up yet).`,
  }))
}

export async function getJobLogs(
  jobId: string,
  opts?: { status?: TuningJob['status'] }
): Promise<{ logs: LogEntry[]; hasMore: boolean }> {
  const isActive = opts?.status ? ['RUNNING', 'PENDING', 'SUBMITTED'].includes(opts.status) : false
  const count = isActive ? 12 + Math.floor(Math.random() * 4) : 20
  return delay({ logs: mockLogLines(jobId, count), hasMore: false }, 300)
}
