import type { ModelSource } from '@/types'

/**
 * Data Model Factory is being sunset. The user-facing label for the `dmf`
 * source is now "PVC" — POST /dmf/search already dispatches through a
 * ModelRegistry seam to whichever backend AUTOTUNEX_REGISTRY selects, and the
 * `local` registry's store is a PVC in a Kubernetes deploy.
 *
 * The wire value stays `dmf` until the backend's ModelSource enum gains `pvc`.
 * When it does, this file is the only frontend edit.
 */
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  huggingface: 'Huggingface',
  dmf: 'PVC',
  custom_path: 'Local',
}

/** Render order of the model-source radios in Start Tuning step 1. */
export const MODEL_SOURCE_OPTIONS: { value: ModelSource; id: string }[] = [
  { value: 'huggingface', id: 'model-source-hf' },
  { value: 'dmf', id: 'model-source-pvc' },
  { value: 'custom_path', id: 'model-source-local' },
]

/**
 * Label for a source read back from the API. Takes `string` rather than
 * `ModelSource` because job records come from the database, which can hold
 * values this build does not know about (legacy rows, or a newer backend);
 * those fall back to the raw value instead of rendering blank.
 *
 * Indexing MODEL_SOURCE_LABELS with a ModelSource-typed value yields `string`,
 * so a `??` fallback at the call site would be dead code by the type system
 * while still being necessary at runtime. This does the widening in one place.
 */
export function modelSourceLabel(source: string): string {
  return MODEL_SOURCE_LABELS[source as ModelSource] ?? source
}
