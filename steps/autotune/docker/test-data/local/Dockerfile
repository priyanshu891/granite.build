# Local verification image for the autotune step's docker variant.
# NOT part of the step: a Dockerfile inside steps/autotune/docker/ would flip
# STEP_USES_IMAGE=true and make REGISTRY mandatory (steps/common.mk:79,94-97).
#
# Build context is autotunex/src/fm-tune.
FROM python:3.12-slim

# git: command.sh's FM_TUNE_ROOT-as-git-URL branch and fm-tune's own tooling.
# build-essential: source builds for any dep without an aarch64 wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential \
    && rm -rf /var/lib/apt/lists/*

# fm-tune's pyproject uses setuptools-scm, which needs git metadata we do not copy.
ENV SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/tmp/hf-cache

WORKDIR /opt/fm-tune
COPY . /opt/fm-tune

# [core] carries ray (main.py imports it unconditionally) + torch and the trainers.
RUN pip install --no-cache-dir -e ".[core]"

# Fail the build rather than a later gbserver run if the contract is not met.
RUN python -c "import ray, torch, transformers, peft, trl; print('deps OK')" \
 && test -f /opt/fm-tune/main.py
