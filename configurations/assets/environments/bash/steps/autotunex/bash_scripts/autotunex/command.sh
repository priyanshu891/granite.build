#!/bin/bash
# AutoTuneX workload driver for the bash backend.
#
# This file is a Jinja template: gbserver renders it with strict=True before the
# launcher runs it, so every optional config reference below is guarded with
# `is defined` / `| default(...)`. An unguarded reference FAILS THE BUILD.
#
# Absolute `#!/bin/bash` (not `env`): the launcher runs steps with a PATH-less
# env, so env-based interpreter resolution can fail.
#
# Every config-derived value reaches the shell base64-encoded and is decoded
# into a variable, never interpolated into the script text. base64 output is
# always [A-Za-z0-9+/=], so a value containing a quote, a newline or `$(...)`
# can neither break out of its quoting nor execute. The config is user-supplied
# (AutoTuneX builds `additional_files` keys from a wizard-entered config name
# that only has spaces sanitized), so this is not hypothetical.
set -eu

{#- Guarded Jinja locals. `config` always exists; everything under it may not. #}
{%- set ccc = config.custom_code_config if config is defined and config.custom_code_config is defined else {} %}
{#- `| trim` so a whitespace-only start_command fails fast like an empty one:
    without it the full script renders and `sh -c "   "` exits 0 having run
    nothing, which then registers an empty output artifact. #}
{%- set start_command = ccc.start_command | default('', true) | trim %}
{%- set output_binding_id = ccc.output_binding_id | default('custom', true) %}

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

{#- INPUT_PATH preference order: `input_artifact_path` is the documented binding
    for a bring-your-own-step payload (docs/steps/bring-your-own-step.md, and
    the k8s chart's values.yaml), so it wins; `dataset_files` is the fallback
    this step's own schema exposes. Neither bound => INPUT_PATH stays unset,
    because start_command runs under `sh -c` without `set -u` and would expand
    an unset $INPUT_PATH to the empty string silently. #}
{%- set iap = bindings.input_artifact_path.binding.path if bindings is defined and bindings.input_artifact_path is defined and bindings.input_artifact_path.binding is defined and bindings.input_artifact_path.binding.path is defined else '' %}
{%- set dsf = bindings.dataset_files.binding.path if bindings is defined and bindings.dataset_files is defined and bindings.dataset_files.binding is defined and bindings.dataset_files.binding.path is defined else '' %}
{%- if iap %}
export INPUT_PATH="$(printf '%s' '{{ iap | b64encode }}' | base64 -d)"
echo "autotunex: INPUT_PATH=$INPUT_PATH (source: bindings.input_artifact_path)"
{%- elif dsf %}
export INPUT_PATH="$(printf '%s' '{{ dsf | b64encode }}' | base64 -d)"
echo "autotunex: INPUT_PATH=$INPUT_PATH (source: bindings.dataset_files)"
{%- endif %}

echo "autotunex: OUTPUT_PATH=$OUTPUT_PATH"

# ---- S1: materialize config.k8s.additional_files --------------------------
# AutoTuneX emits its tune config here. The shipped wrapper implements the same
# feature but keyed config.gb.additional_files, so entries under `k8s:` are
# never written — hence this local copy. Same base64 technique as the wrapper.
{%- set add_files = config.k8s.additional_files if config is defined and config.k8s is defined and config.k8s.additional_files is defined else {} %}
{%- for fname, fcontents in add_files.items() %}
FNAME="$(printf '%s' '{{ fname | b64encode }}' | base64 -d)"
echo "autotunex: writing additional file $FNAME"
mkdir -p "$(dirname "$FNAME")"
printf '%s' '{{ fcontents | b64encode }}' | base64 -d > "$FNAME"
{%- endfor %}

# ---- S2: obtain the repo --------------------------------------------------
{%- set github_url = ccc.github_url | default('', true) %}
{%- set dir_to_save = ccc.dir_to_save | default('.', true) %}
{%- if github_url %}
REPO_SPEC="$(printf '%s' '{{ github_url | b64encode }}' | base64 -d)"
case "$REPO_SPEC" in
  file://*) LOCAL_PATH="${REPO_SPEC#file://}" ;;
  /*)       LOCAL_PATH="$REPO_SPEC" ;;
  *)        LOCAL_PATH="" ;;
esac
# Validate BEFORE the destructive rm -rf below, so a bad local path does not
# leave an empty autotunex-src behind.
if [ -n "$LOCAL_PATH" ] && [ ! -d "$LOCAL_PATH" ]; then
  echo "autotunex: ERROR local repo path not found: $LOCAL_PATH" >&2
  exit 3
fi
# `:?` on the asset dir: the next line is `rm -rf "$SRC"`, so the expansion it
# is built from must be provably non-empty at the point of use.
SRC="${LLMB_BASH_ASSET_DIR:?command.sh: launcher must set LLMB_BASH_ASSET_DIR}/autotunex-src"
rm -rf "$SRC"
mkdir -p "$SRC"
if [ -n "$LOCAL_PATH" ]; then
  # Copy, never run in place: setup_command typically does `git checkout <ref>`,
  # which would destructively mutate the developer's own working tree.
  echo "autotunex: copying local repo $LOCAL_PATH -> $SRC"
  cp -R "$LOCAL_PATH/." "$SRC/"
else
  echo "autotunex: cloning $REPO_SPEC -> $SRC"
  case "$REPO_SPEC" in
    http://*|https://*|git@*) git clone "$REPO_SPEC" "$SRC" ;;
    *)                        git clone "https://$REPO_SPEC" "$SRC" ;;
  esac || { echo "autotunex: ERROR git clone failed for $REPO_SPEC" >&2; exit 3; }
fi
DIR_TO_SAVE="$(printf '%s' '{{ dir_to_save | b64encode }}' | base64 -d)"
WORKDIR="$SRC/$DIR_TO_SAVE"
{%- else %}
WORKDIR="${LLMB_BASH_ASSET_DIR:-$PWD}"
echo "autotunex: no github_url set — running in $WORKDIR"
{%- endif %}

# ---- S3: cached venv + setup_command --------------------------------------
{%- set setup_command = ccc.setup_command | default('', true) %}
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

cd "$WORKDIR" || {
  echo "autotunex: ERROR cannot enter workdir $WORKDIR — check config.custom_code_config.dir_to_save" >&2
  exit 4
}
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
# Gated on success. buildrun.py pushes a registered artifact with no status
# check, and the real AutoTuneX target's output is
# hf://huggingface.co/ibm-research/autotunex_<id>/ — a shared org namespace, so
# a failed run must not publish into it.
if [ "$RC" -eq 0 ]; then
  if [ -z "$(ls -A "$OUTPUT_PATH" 2>/dev/null)" ]; then
    echo "autotunex: WARNING $OUTPUT_PATH is empty — registering it anyway"
  fi
  # b64 like every other config value: spliced raw into this double-quoted echo,
  # an output_binding_id containing `"` would close the quote and execute. The
  # decode lives inside this branch so the failure path does no work at all.
  # The marker text stays unprefixed: the bash monitor anchors its regex at the
  # start of the LOG line, which this source indentation does not affect.
  OUTPUT_BINDING_ID="$(printf '%s' '{{ output_binding_id | b64encode }}' | base64 -d)"
  echo "LLMB_ARTIFACT_ID:$OUTPUT_BINDING_ID LLMB_ARTIFACT_PATH:$OUTPUT_PATH"
else
  echo "autotunex: start_command failed ($RC) — not registering an output artifact"
fi

exit $RC
{%- endif %}
