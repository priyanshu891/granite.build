import type { ModelSource } from '@/types'
import type { DmfModel } from '@/api/autotunex'

export type ModelSuggestion = { id: string; text: string; isOpen?: boolean; rawModel?: DmfModel }

/**
 * Which item the wizard's model ComboBox should treat as selected.
 *
 * Deliberately independent of the suggestion list. Carbon's ComboBox
 * (@carbon/react 1.108.0, lib/components/ComboBox/ComboBox.js:138-155) reads
 * every *reference* change of its `selectedItem` prop as an instruction to
 * overwrite the text field — with `itemToString(selectedItem)`, or with an empty
 * string when the prop is null. Deriving the prop from `suggestions` therefore
 * wiped whatever the user was mid-way through typing as soon as a search
 * replaced the list, since HuggingFace results for a partial term rarely contain
 * the exact model id that was already selected.
 *
 * Memoize the result on (modelSource, selectedModel, selectedDmfModel) so the
 * identity only moves when the selection genuinely does.
 */
export function resolveModelComboItem(
  modelSource: ModelSource,
  selectedModel: string,
  selectedDmfModel: ModelSuggestion | null,
): ModelSuggestion | null {
  if (!selectedModel) return null
  // PVC entries display a human label that differs from their id, so the fetched
  // record wins when it matches. Before it arrives — or if it is left over from
  // an earlier pick — showing the raw id still beats showing an empty field.
  if (modelSource === 'dmf' && selectedDmfModel?.id === selectedModel) return selectedDmfModel
  return { id: selectedModel, text: selectedModel }
}
