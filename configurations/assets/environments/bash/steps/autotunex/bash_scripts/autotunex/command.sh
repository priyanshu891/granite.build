#!/bin/bash
# AutoTuneX workload driver for the bash backend.
#
# This file is a Jinja template: gbserver renders it with strict=True before the
# launcher runs it, so every optional config reference below is guarded with
# `is defined` / `| default(...)`. An unguarded reference FAILS THE BUILD.
#
# Absolute `#!/bin/bash` (not `env`): the launcher runs steps with a PATH-less
# env, so env-based interpreter resolution can fail.
set -eu

{#- Guarded Jinja locals. `config` always exists; everything under it may not. #}
{%- set ccc = config.custom_code_config if config is defined and config.custom_code_config is defined else {} %}
{%- set start_command = ccc.start_command | default('') %}
{%- set output_binding_id = ccc.output_binding_id | default('custom') %}

{%- if not ccc %}
echo "autotunex: ERROR config.custom_code_config is missing — nothing to run" >&2
exit 2
{%- elif not start_command %}
echo "autotunex: ERROR config.custom_code_config.start_command is empty" >&2
exit 2
{%- else %}

# ---- S0: bridge the k8s env-var names -------------------------------------
# The k8s/LSF gbstep exports OUTPUT_PATH; the bash jobsub exports
# LLMB_BASH_OUTPUT_DIR instead. AutoTuneX's start_command uses $OUTPUT_PATH, so
# without this bridge `--output_dir $OUTPUT_PATH` expands to the empty string.
export OUTPUT_PATH="${LLMB_BASH_OUTPUT_DIR:?command.sh: launcher must set LLMB_BASH_OUTPUT_DIR}"
mkdir -p "$OUTPUT_PATH"

# The child env carries no PATH (the launcher does not inherit os.environ), so
# lead with the launcher's pinned interpreter dir.
export PATH="${LLMB_BASH_PYTHON_DIR:-/usr/bin}:/usr/local/bin:/usr/bin:/bin"

{%- if bindings is defined and bindings.dataset_files is defined and bindings.dataset_files.binding is defined and bindings.dataset_files.binding.path is defined %}
export INPUT_PATH="{{ bindings.dataset_files.binding.path }}"
echo "autotunex: INPUT_PATH=$INPUT_PATH"
{%- endif %}

echo "autotunex: OUTPUT_PATH=$OUTPUT_PATH"

# ---- S1: materialize config.k8s.additional_files --------------------------
# AutoTuneX emits its tune config here. The shipped wrapper implements the same
# feature but keyed config.gb.additional_files, so entries under `k8s:` are
# never written — hence this local copy. Same base64 technique as the wrapper.
{%- set add_files = config.k8s.additional_files if config is defined and config.k8s is defined and config.k8s.additional_files is defined else {} %}
{%- for fname, fcontents in add_files.items() %}
echo "autotunex: writing additional file {{ fname }}"
mkdir -p "$(dirname '{{ fname }}')"
printf '%s' '{{ fcontents | b64encode }}' | base64 -d > '{{ fname }}'
{%- endfor %}

# ---- S2: obtain the repo --------------------------------------------------
{%- set github_url = ccc.github_url | default('') %}
{%- set dir_to_save = ccc.dir_to_save | default('.') %}
{%- if github_url %}
SRC="${LLMB_BASH_ASSET_DIR}/autotunex-src"
rm -rf "$SRC"
mkdir -p "$SRC"
REPO_SPEC='{{ github_url }}'
case "$REPO_SPEC" in
  file://*) LOCAL_PATH="${REPO_SPEC#file://}" ;;
  /*)       LOCAL_PATH="$REPO_SPEC" ;;
  *)        LOCAL_PATH="" ;;
esac
if [ -n "$LOCAL_PATH" ]; then
  # Copy, never run in place: setup_command typically does `git checkout <ref>`,
  # which would destructively mutate the developer's own working tree.
  if [ ! -d "$LOCAL_PATH" ]; then
    echo "autotunex: ERROR local repo path not found: $LOCAL_PATH" >&2
    exit 3
  fi
  echo "autotunex: copying local repo $LOCAL_PATH -> $SRC"
  cp -R "$LOCAL_PATH/." "$SRC/"
else
  echo "autotunex: cloning $REPO_SPEC -> $SRC"
  case "$REPO_SPEC" in
    http://*|https://*|git@*) git clone "$REPO_SPEC" "$SRC" ;;
    *)                        git clone "https://$REPO_SPEC" "$SRC" ;;
  esac || { echo "autotunex: ERROR git clone failed for $REPO_SPEC" >&2; exit 3; }
fi
WORKDIR="$SRC/{{ dir_to_save }}"
{%- else %}
WORKDIR="${LLMB_BASH_ASSET_DIR:-$PWD}"
echo "autotunex: no github_url set — running in $WORKDIR"
{%- endif %}

# ---- S3: cached venv + setup_command --------------------------------------
{%- set setup_command = ccc.setup_command | default('') %}
{%- set venv_key = (ccc.github_url | default('')) ~ '|' ~ (ccc.setup_command | default('')) %}
# Cache the venv under the GB home (recovered from LLMB_BASH_OUTPUT_DIR, not
# $HOME which the launcher does not pass) so it survives across reruns. Same
# derivation as the sibling lora-finetune / inference steps.
case "$OUTPUT_PATH" in
  */workdir/*) VENV_BASE="${OUTPUT_PATH%%/workdir/*}/.gb-venvs" ;;
  ?*)          VENV_BASE="$OUTPUT_PATH/.gb-venvs" ;;
  *)           VENV_BASE="${TMPDIR:-/tmp}/.gb-venvs" ;;
esac
mkdir -p "$VENV_BASE"

PY="${LLMB_BASH_PYTHON_DIR:-}/python3"
[ -x "$PY" ] || PY="python3"
VENV="$VENV_BASE/autotunex-{{ venv_key | short_hash }}"
if [ ! -x "$VENV/bin/python" ]; then
  echo "autotunex: creating venv at $VENV using $PY"
  "$PY" -m venv "$VENV"
fi
export VIRTUAL_ENV="$VENV"
export PATH="$VENV/bin:$PATH"

cd "$WORKDIR"
{%- if setup_command %}
SETUP_CMD="$(printf '%s' '{{ setup_command | b64encode }}' | base64 -d)"
echo "autotunex: setup_command: $SETUP_CMD"
sh -c "$SETUP_CMD"
echo "autotunex: setup_command finished"
{%- endif %}

# ---- S4: run the workload -------------------------------------------------
# Base64 + `sh -c`: start_command carries `&&`, `$OUTPUT_PATH` and nested
# quotes, so embedding it literally would be mangled by YAML -> Jinja -> shell
# quoting. `sh -c` is required for `&&` and `$VAR` to expand.
cd "$WORKDIR"
START_CMD="$(printf '%s' '{{ start_command | b64encode }}' | base64 -d)"
echo "autotunex: start_command: $START_CMD"
set +e
sh -c "$START_CMD"
RC=$?
set -e
echo "autotunex: start_command exited $RC"

# ---- S5: register the output artifact -------------------------------------
if [ -z "$(ls -A "$OUTPUT_PATH" 2>/dev/null)" ]; then
  echo "autotunex: WARNING $OUTPUT_PATH is empty — registering it anyway"
fi
echo "LLMB_ARTIFACT_ID:{{ output_binding_id }} LLMB_ARTIFACT_PATH:$OUTPUT_PATH"

exit $RC
{%- endif %}
