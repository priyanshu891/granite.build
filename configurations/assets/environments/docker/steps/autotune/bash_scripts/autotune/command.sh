#!/bin/bash
# autotune step entrypoint (Bash + Docker). Jinja-rendered with strict=True at
# run time, then executed. Stages:
#   S1  materialize the tuning config (inline config.autotune-config, else the
#       hpo_config input) to a YAML file and export AUTOTUNE_CONFIG_FILE
#   S2  provide a Python interpreter (venv on bash; image python on docker)
#   S3  optional SETUP_COMMAND update hook, run inside $FM_TUNE_ROOT
#   S4  exec run.py, which builds the main.py argv and runs fm-tune
#
# Absolute #!/bin/bash (not env): the launcher runs with a sanitized PATH-less
# env, so lead PATH with the launcher's pinned python dir (bash). Shell ${VAR}
# uses single braces and is NOT a Jinja token.
set -eu
export PATH="${LLMB_BASH_PYTHON_DIR:-/usr/local/bin}:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${FM_TUNE_ROOT:?command.sh: FM_TUNE_ROOT must be set (fm-tune checkout on bash; image path on docker)}"
OUT="${LLMB_BASH_OUTPUT_DIR:?command.sh: LLMB_BASH_OUTPUT_DIR unset}"
mkdir -p "$OUT"

# --- S1: materialize the tuning config -------------------------------------
CONFIG_FILE="$OUT/autotune_config.yaml"
{% if 'autotune-config' in config %}
echo '{{ config['autotune-config'] | to_yaml | b64encode }}' | base64 -d > "$CONFIG_FILE"
{% else %}
if [ -n "${LLMB_BASH_INPUT_HPO_CONFIG:-}" ]; then
  cp "$LLMB_BASH_INPUT_HPO_CONFIG" "$CONFIG_FILE"
else
  echo "command.sh: no config.autotune-config block and no hpo_config input bound" >&2
  exit 1
fi
{% endif %}
export AUTOTUNE_CONFIG_FILE="$CONFIG_FILE"

# --- S2: interpreter --------------------------------------------------------
if [ "${BASH_BUILD_VENV:-true}" = "true" ]; then
  case "$OUT" in
    */workdir/*) VENV_BASE="${OUT%%/workdir/*}/.gb-venvs" ;;
    *)           VENV_BASE="${TMPDIR:-/tmp}/.gb-venvs" ;;
  esac
  mkdir -p "$VENV_BASE"
  export HF_HOME="$VENV_BASE/hf-cache"
  PY="${LLMB_BASH_PYTHON_DIR:-}/python3"; [ -x "$PY" ] || PY=python3
  VENV="$VENV_BASE/autotune"
  [ -x "$VENV/bin/python" ] || { "$PY" -m venv "$VENV"; "$VENV/bin/pip" install --quiet --upgrade pip; }
  "$VENV/bin/pip" install --quiet -e "${FM_TUNE_ROOT}[mlx]"
  PYTHON="$VENV/bin/python"
else
  PYTHON="$(command -v python3 || command -v python)"
fi

# --- S3: optional update hook ----------------------------------------------
if [ -n "${SETUP_COMMAND:-}" ]; then
  ( cd "$FM_TUNE_ROOT" && sh -c "$SETUP_COMMAND" )
fi

# --- S4: run ----------------------------------------------------------------
exec "$PYTHON" "$SCRIPT_DIR/run.py"
