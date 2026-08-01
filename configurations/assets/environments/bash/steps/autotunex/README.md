# `autotunex` (Bash)

Runs an AutoTuneX-generated payload on the standalone bash backend.

AutoTuneX emits a Kubernetes-shaped step config. This step consumes those keys
**verbatim**, so a generated `build.yaml` runs on bash after changing only two
lines:

```yaml
environment_uri: space://environments/bash
- step_uri: space://steps/autotunex
```

The builtin `gbstep` cannot be used on bash: it declares `environment_configs`
for `k8s` and `Lsf` only, so it fails validation with
`Environment config for 'Bash' not found in environment_configs`.

## Config

| Key | Default | Behavior |
|---|---|---|
| `config.custom_code_config.github_url` | `""` | Git URL, **or a local path / `file://` URI**, which is copied (never used in place, so `setup_command`'s `git checkout` cannot mutate your working tree). Empty → run in the step asset dir. |
| `config.custom_code_config.setup_command` | `""` | Run in the repo inside a cached venv. |
| `config.custom_code_config.start_command` | `""` | **Required.** The workload. The step's exit status is this command's. Whitespace-only counts as empty and fails fast. |
| `config.custom_code_config.dir_to_save` | `.` | Subdir of the **obtained repo** to run in — see the caveat below. |
| `config.custom_code_config.output_binding_id` | `custom` | Target output the artifact marker binds to. |
| `config.k8s.additional_files` | `{}` | `{absolute path: contents}`, written before the workload runs. Read from the `k8s` key on purpose — that is where AutoTuneX puts it. |

### `dir_to_save` means something different on this step

**This step's `dir_to_save` selects a subdirectory of the obtained repo to `cd`
into before running `setup_command` / `start_command`.** It has no effect on what
is captured as the output artifact.

That diverges from the meaning documented elsewhere in this repo — in
[`docs/glossary.md`](../../../../../../docs/glossary.md),
[`docs/help/faq.md`](../../../../../../docs/help/faq.md) and
[`docs/steps/bring-your-own-step.md`](../../../../../../docs/steps/bring-your-own-step.md),
`dir_to_save` selects **which part of `$OUTPUT_PATH` to capture as the output
artifact** (and the k8s chart defaults it to `/tmp`). This step keeps the
run-directory meaning deliberately, because that is what the AutoTuneX-generated
payloads it consumes rely on: they set `dir_to_save` to the repo subdirectory
their entry point lives in.

Consequence: a `dir_to_save` naming a directory that does not exist inside the
obtained repo aborts the step with exit 4 **before** `start_command` runs, rather
than being silently ignored. The whole of `$OUTPUT_PATH` is always what gets
registered as the output artifact.

## Environment bridge

The k8s/LSF `gbstep` exports `OUTPUT_PATH`; the bash jobsub exports
`LLMB_BASH_OUTPUT_DIR`. This step exports `OUTPUT_PATH` from it, so a
k8s-authored `--output_dir $OUTPUT_PATH` works unchanged.

`INPUT_PATH` is bridged from a bound input, in this preference order:

1. `bindings.input_artifact_path` — the binding a canonical bring-your-own-step
   payload uses (`docs/steps/bring-your-own-step.md`, and the k8s chart's
   `values.yaml`).
2. `bindings.dataset_files` — fallback, for AutoTuneX's tuning-data binding.

If neither is bound, `INPUT_PATH` is **not** exported. `start_command` runs under
`sh -c` without `set -u`, so an unset `$INPUT_PATH` would otherwise expand to the
empty string silently — the failure class this step exists to eliminate. The
chosen source is echoed to the log.

## Output artifact registration

The `LLMB_ARTIFACT_ID` marker is emitted **only when `start_command` exits 0**.
The platform pushes registered artifacts with no status gating, and the real
AutoTuneX target publishes into a shared org namespace
(`hf://huggingface.co/ibm-research/autotunex_<id>/`), so a failed run must not
register an output. On failure the step logs
`autotunex: start_command failed (<rc>) — not registering an output artifact` and
exits with the workload's status.

## Config values and the shell

Every config-derived value (`github_url`, `dir_to_save`, `setup_command`,
`start_command`, `additional_files` keys and contents, bound input paths) is
base64-encoded by the template and decoded into a shell variable at run time,
never interpolated into the script text. base64 output is always
`[A-Za-z0-9+/=]`, so a value containing a quote, a newline or `$(...)` can
neither break the script's quoting nor execute.

## Not supported on bash

`config.workload.commands` (k8s/LSF only) and `config.k8s.image` (bash runs a
local process, not a container) are ignored. `compute_config` is inert — bash
does not enforce resource limits.
