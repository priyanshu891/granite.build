// Core build status union — mirrors gbserver's Status enum
// (src/gbserver/types/status.py) plus 'planned', a frontend-only synthetic
// status for target steps that haven't started yet.
export type BuildStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'pending'
  | 'submitted'
  | 'invalid'
  | 'cancelled'
  | 'cancel_requested'
  | 'retry_pending'
  | 'planned'

// ── Build hierarchy ──────────────────────────────────────────────────────────

export interface BuildStepRun {
  step_name: string
  status: BuildStatus
  uri?: string
  started_at?: string
  updated_at?: string
  log_path?: string
}

export interface BuildTargetRun {
  target_name: string
  status: BuildStatus
  started_at?: string
  updated_at?: string
  steps: BuildStepRun[]
  inputs?: Record<string, string>
  outputs?: Record<string, string>
}

export interface Build {
  uuid: string
  name: string
  space_name: string
  username: string
  status: BuildStatus
  tags: string[]
  source_uri?: string
  description?: string
  created_time: string
  updated_time: string
  finished_at?: string
  targets?: BuildTargetRun[]
  resources?: {
    cpu?: string
    memory?: string
    gpu?: number
    storage?: string
  }
  failure_reason?: string
  failure_message?: string
  // Raw build.yaml contents (for Build Definition tab)
  build_archive?: string
}

export interface BuildEvent {
  time: string
  description: string
}

export interface BuildStatusDetail {
  details: {
    build_id: string
    name: string
    started_at: string
    updated_at: string
    status: BuildStatus
    source_pr?: string
  }
  history: BuildEvent[]
  targets: Record<string, BuildTargetRun>
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export type ArtifactType = 'MODEL' | 'DATASET' | 'FILESET' | 'TABLE'

// Mirrors gbserver's ArtifactRegistrationStatus enum
// (src/gbserver/storage/artifact_registration.py).
export type ArtifactStatus = 'pending' | 'success' | 'failed' | 'cancelled'

export interface Artifact {
  uuid: string
  name: string
  artifact_type: ArtifactType
  status: ArtifactStatus
  space_name: string
  username: string
  uri: string
  build_id?: string
  created_time: string
  updated_time: string
  tags: string[]
  description?: string
  archived: boolean
  checksum?: string
}

// ── Spaces ───────────────────────────────────────────────────────────────────

export interface Space {
  uuid: string
  name: string
  git_repo_uri?: string
  is_admin: boolean
}

// ── Analytics ────────────────────────────────────────────────────────────────

// Mirrors gbserver's Status enum (src/gbserver/types/status.py).
export interface BuildStatusChartPoint {
  date: string
  running: number
  success: number
  failed: number
  invalid: number
  pending: number
  submitted: number
  retry_pending: number
  cancel_requested: number
  cancelled: number
  running_test: number
  success_test: number
  failed_test: number
  invalid_test: number
  pending_test: number
  submitted_test: number
  retry_pending_test: number
  cancel_requested_test: number
  cancelled_test: number
}

export interface FailureTrendResponse {
  labels: string[]
  categories: string[]
  series: Record<string, number[]>
  builds_by_category: Record<string, CategorizedBuild[]>
  total_analyzed: number
  analysis_time_ms: number
}

export interface CategorizedBuild {
  build_id: string
  name: string
  username: string
  space_name: string
  created_at: string
  category: string
  confidence: number
  summary?: string
}

export interface TrendHistoryItem {
  update_id: string
  title?: string
  summary: string
  date_range_start: string
  date_range_end: string
  category_count: number
  total_builds: number
  is_public: boolean
  author: string
  created_at: string
}

export interface TrendHistoryResponse {
  items: TrendHistoryItem[]
  total_count: number
}

// ── AI Analysis ──────────────────────────────────────────────────────────────

export interface AIAnalysisIssue {
  type: string
  severity: 'critical' | 'high' | 'warning' | 'info' | string
  description: string
}

export interface AIAnalysis {
  update_id: string
  build_id: string
  source: 'llm_phase1' | 'llm_phase2' | 'human' | 'system'
  analysis_type?: string
  summary: string
  root_cause: string
  suggested_action: string
  issues: AIAnalysisIssue[]
  confidence: number
  model_name?: string
  error_category_1?: string
  error_category_2?: string
  kb_recommendation?: string
  parent_uid?: string
  created_at: string
  // User feedback
  feedback_rating?: number
  feedback_helpful?: boolean
  corrected_root_cause?: string
  feedback_comment?: string
  upvotes: number
  downvotes: number
}

export interface Metric {
  name: string
  value: string
  units?: string
  build_id?: string
  recorded_at: string
}

// ── API response wrappers ─────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

// ── AutoTuneX / Start Tuning wizard ───────────────────────────────────────────

export type TuningGoal = 'sft' | 'offline_rl' | 'online_rl'

export type ModelSource = 'huggingface' | 'dmf' | 'custom_path'

export type DatasetFormatType =
  | 'preference_pairs'
  | 'kto_format'
  | 'standard_pairs'
  | 'prompt_only'
  | 'unknown'

export interface ColumnMetadata {
  name: string
  detectedType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  sampleValues: string[]
  nullCount: number
  uniqueCount: number
}

export interface DatasetFormatInfo {
  format: DatasetFormatType
  columns: ColumnMetadata[]
  totalRecords: number
  fileSize: number
  fileName: string
  compatibleMethods: string[]
}

export type ParsedDataRow = Record<string, any>

// Maps a required column name to the user's actual column name
export type ColumnMapping = Record<string, string>

export interface AiMappingSuggestion {
  dataset_type: string
  dataset_type_desc: string
  algorithm: string
  confidence: number
  column_mapping: Record<string, { source_column: string; confidence: number }>
  reasoning: string
}

export interface AlgorithmOption {
  id: string
  name: string
  category: TuningGoal
  requiredColumns: string[]
}

export interface AlgorithmDetail {
  id: string
  name: string
  category: TuningGoal
  recommended: boolean
  shortDescription: string
  requiredColumns: string[]
}

export interface DatasetForm {
  name: string
  description: string
  train_file: File | null
  validation_file: File | null
  trainSetPercentage?: number
}

export interface Dataset {
  id: string
  user_id: string
  name: string
  description: string
  train_file: string
  train_records: number
  train_file_size: number
  validation_file: string
  validation_records: number
  validation_file_size: number
  artifact_id: string
  artifact_url: string
  created_at: string
  updated_at: string
  // Small preview slices, populated when a single dataset is fetched by id
  train_data?: Record<string, any>[]
  validation_data?: Record<string, any>[]
}

export type HpoStrategy = 'choice' | 'loguniform' | 'uniform'

// Matches the real config template's runtime field.type values (the source app's
// own `Type` enum says 'string', but every actual type check in its config form
// compares against the literal 'str' — this follows the runtime contract).
export type FieldValueType = 'str' | 'int' | 'float' | 'bool' | 'list'

export interface HpoDatasetPercentage {
  type: FieldValueType
  values: null
  default: number
  max_val: number
  min_val: number
  description: string
  search_alg?: string[]
  required?: boolean
}

export interface InputColumn {
  type: FieldValueType
  values: string[] | number[] | null
  default: string | number | boolean | string[] | null
  max_val: number | null
  min_val: number | null
  description: string
  required?: boolean
  search_alg?: string[]
  scheduler?: string[]
}

export interface NumberInputColumn {
  default: number | null
  description: string
  min_val: number
  max_val: number
  type: string
}

export interface TuneConfig {
  [key: string]: InputColumn | HpoDatasetPercentage | NumberInputColumn | undefined
  scheduler: InputColumn
  search_alg: InputColumn
  num_samples: HpoDatasetPercentage
  max_discrepancy: HpoDatasetPercentage
  max_concurrent_trials: HpoDatasetPercentage
  time_budget_s?: NumberInputColumn
}

export interface AlphaRatio {
  type: FieldValueType
  values: number[]
  default: number
  max_val: number
  min_val: number
  options: HpoStrategy[]
  strategy: HpoStrategy
  for_tuner: boolean
  description: string
}

export interface Bias {
  type: FieldValueType
  values: string[]
  default: string
  max_val: null
  min_val: null
  options: HpoStrategy[]
  strategy: HpoStrategy
  for_tuner: boolean
  description: string
}

export interface Field {
  type: FieldValueType
  values: number[] | string[]
  default: number | string
  max_val: number | null
  min_val: number | null
  options: HpoStrategy[]
  strategy: HpoStrategy
  for_tuner: boolean
  description: string
}

// Keyed by hyperparameter name — varies per tuner (LoRA's r/alpha_ratio/... vs.
// an RL tuner's learning_rate-only set), so this is an open map, not a fixed shape.
export type Hyperparams = Record<string, AlphaRatio | Bias | Field>

export interface Tuner {
  title: string
  tuner_name: string
  description: string
  hyperparams: Hyperparams
}

export interface TunersConfig {
  [key: string]: Tuner
  lora: Tuner
  alora: Tuner
}

export interface TunersRlConfig {
  [key: string]: Tuner
}

export interface TrainingConfig {
  [key: string]: HpoDatasetPercentage | InputColumn
  seed: HpoDatasetPercentage
  precision: InputColumn
  max_length: HpoDatasetPercentage
  input_column: InputColumn
  warmup_ratio: HpoDatasetPercentage
  output_column: InputColumn
  hpo_num_epochs: HpoDatasetPercentage
  num_train_epochs: HpoDatasetPercentage
  use_chat_template: InputColumn
  num_gpus_per_trial: HpoDatasetPercentage
  num_cpus_per_worker: HpoDatasetPercentage
  use_flash_attention: InputColumn
  train_implementation: InputColumn
  hpo_dataset_percentage: HpoDatasetPercentage
}

export interface TrainingRlConfig {
  [key: string]: InputColumn | NumberInputColumn
}

export interface ConfigData {
  tune_config: TuneConfig
  tuners_config: TunersConfig
  training_config: TrainingConfig
  training_rl_config?: TrainingRlConfig
  tuners_rl_config?: TunersRlConfig
  // Present on the editable config template returned by getConfigurationTemplate();
  // may be absent on an already-saved Configuration's config_data.
  general_config?: Record<string, InputColumn | HpoDatasetPercentage>
  tokenizer_config?: Record<string, InputColumn>
}

export interface Configuration {
  id: string
  user_id: string
  name: string
  tuner_type: string
  rl_tuner_type?: string | null
  artifact_id: string
  artifact_url: string
  // Absent/null on list responses (GET /configs) — only populated on a
  // single-config fetch (GET /config/{id}).
  config_data?: ConfigData | null
  // Not returned by the real backend's single-config Pydantic response model —
  // may be absent even though the underlying row has them.
  created_at?: string
  updated_at?: string
  associated_jobs?: unknown[]
}

export interface ConfigMutationResult {
  id: string
  status: string
  message?: string
}

// The editable form shape used by the config template/editor: a flat name +
// tuner selection merged with the config's own sections.
export type ConfigForm = {
  name?: string
  tuner_type?: string | null
  rl_tuner_type?: string | null
} & ConfigData

export interface TuningForm {
  config_id: string | undefined
  dataset_id: string | undefined
  model: string
  model_source: ModelSource
  experiment_name: string
  autotune: boolean
  additional_info?: any
  reward_function_code?: string
  reward_function_name?: string
}

// ── Reward function validation (Online RL "Reward Function" step) ──────────

export interface RewardFunctionValidationFlags {
  syntax_valid: boolean
  security_valid: boolean
  function_found: boolean
  function_signature_valid: boolean
}

export interface RewardFunctionTestCaseResult {
  return_value?: number
  error?: string
}

export interface RewardFunctionTestExecution {
  executed: boolean
  error?: string
  stdout?: string
  results: RewardFunctionTestCaseResult[]
}

export interface RewardFunctionValidationResult {
  success: boolean
  syntax_errors: string[]
  security_issues: string[]
  validation: RewardFunctionValidationFlags
  test_result: RewardFunctionTestExecution | null
}

// Deferred config creation/update, staged in the wizard until launch time
export interface PendingConfigData {
  name: string
  tuner_type: string | null
  rl_tuner_type: string | null
  config_data: ConfigData
}

export interface PendingConfigUpdate {
  configId: string
  name: string
  tuner_type: string | null
  rl_tuner_type: string | null
  config_data: ConfigData
}

// ── Tunings list / detail view ────────────────────────────────────────────────

export type TuningStatus = 'COMPLETED' | 'ERROR' | 'RUNNING' | 'TERMINATED' | 'PENDING' | 'SUBMITTED' | 'PAUSED'

export interface TuningJob {
  id: string
  status: TuningStatus
  model: string
  model_source: ModelSource
  experiment_name: string
  config_id: string
  config_name: string
  dataset_id: string
  dataset: string
  seed: number
  precision: string
  autotune: boolean
  created_at: string
  updated_at: string
}

export interface TrialScore {
  metric: string
  metrics: Record<string, number>
}

export interface Trial {
  id: string
  job_id: string
  status: TuningStatus
  config: Record<string, any>
  score: TrialScore | null
  created_at: string
  updated_at: string
}

export interface TuningAsset {
  filename: string
  size: number
  modified: string
}

export interface LogEntry {
  id: number
  timestamp: string
  level: string
  filename: string
  message: string
}

export type LaunchPhase =
  | 'creating_dataset'
  | 'uploading_files'
  | 'creating_config'
  | 'updating_config'
  | 'launching_job'
  | null

export interface Resources {
  model_size_billion_params: number
  gpu_memory_gb: number
  cpu_memory_gb: number
  num_gpus: number
  weights_memory: number
  optimizer_memory: number
  gradients_memory: number
  activations_memory: number
}

export interface Estimation {
  model_name: string
  config_id: string
  gpu_memory: number
}

export interface WizardDraft {
  savedAt: string
  currentStep: number
  completedSteps: boolean[]
  selectedGoal: TuningGoal | null
  selectedAlgorithm: string
  selectedModel: string
  modelSource: ModelSource
  datasetForm: { name: string; description: string }
  existingDatasetId: string | null
  splitRatio: number
  selectedConfigId: string | null
  experimentName: string
  autotuneEnabled?: boolean
}

export type HuggingFaceLibraryName = 'sentence-transformers' | 'transformers'

export interface HuggingFaceModelConfig {
  architectures: string[]
  model_type: string
  chat_template_jinja?: string
  processor_config?: { chat_template: string }
}

export interface HuggingFaceModel {
  _id: string
  id: string
  likes: number
  trendingScore: number
  private: boolean
  config: HuggingFaceModelConfig
  downloads: number
  tags: string[]
  pipeline_tag: string
  library_name: HuggingFaceLibraryName
  createdAt: string
  modelId: string
}
