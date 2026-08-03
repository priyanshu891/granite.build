# autotune (bash) — AutoTune / fm-tune HPO + training step

Runs fm-tune's `main.py` on the standalone **bash** environment. Materializes an
inline `config.autotune-config` block (or the `hpo_config` input) to a YAML file,
then runs the tuning pipeline against a local fm-tune checkout.

## Inputs
- `model` (model, uri|binding) — HF id / Local / PVC; resolved to `$LLMB_BASH_INPUT_MODEL`.
- `dataset_files` (dataset, uri|binding) — a fileset with `*_train.jsonl` + `*_validation.jsonl`.
- `hpo_config` (fileset, optional) — used only if no inline `config.autotune-config`.

## Output
- `custom` (model) — the tuned-model output dir, registered via the artifact marker.

## Key params (`config.bash.env`)
| Param | Meaning | Default |
|---|---|---|
| `FM_TUNE_ROOT` | Path to the fm-tune checkout (required) | — |
| `BACKEND` | `mlx` (Apple Silicon) or `torch` | `torch` |
| `NO_AUTOTUNE` | Skip HPO, single training run | `false` |
| `CLEANUP` / `SAVE_HISTORY` | Pass-through flags | `false` |
| `RUN_NAME` / `OUTPUT_MODEL_NAME` | Run / output-model name | `$JOB_ID` |
| `TUNING_ALGO` / `RL_ALGO` | Override; else read from the config | config / `lora` / `none` |
| `TRAIN_FILE` / `VAL_FILE` | Override split filenames | globbed |
| `SETUP_COMMAND` | Optional `git checkout … && pip install -e .` hook | — |
| `BASH_BUILD_VENV` | Build a venv (bash) vs use image python | `true` |
| `JOB_ID` | `{{ run_metadata.build_id }}` | — |

See `docs/superpowers/specs/2026-08-03-autotune-gb-step-design.md`.
