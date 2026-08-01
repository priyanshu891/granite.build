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
| `config.custom_code_config.start_command` | `""` | **Required.** The workload. The step's exit status is this command's. |
| `config.custom_code_config.dir_to_save` | `.` | Subdir of the repo to run in. |
| `config.custom_code_config.output_binding_id` | `custom` | Target output the artifact marker binds to. |
| `config.k8s.additional_files` | `{}` | `{absolute path: contents}`, written before the workload runs. Read from the `k8s` key on purpose — that is where AutoTuneX puts it. |

## Environment bridge

The k8s/LSF `gbstep` exports `OUTPUT_PATH`; the bash jobsub exports
`LLMB_BASH_OUTPUT_DIR`. This step exports `OUTPUT_PATH` from it, so a
k8s-authored `--output_dir $OUTPUT_PATH` works unchanged. A bound `dataset_files`
input is also bridged to `INPUT_PATH`.

## Not supported on bash

`config.workload.commands` (k8s/LSF only) and `config.k8s.image` (bash runs a
local process, not a container) are ignored. `compute_config` is inert — bash
does not enforce resource limits.
