# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""Pure assembly of a granite.build local-bash ``build.yaml`` from a job.

Ports the 2025 ``utilites.granite_build_bash.BashLocalBuild``: the
``space://environments/bash`` shape used to run AutoTune locally (MPS/CPU on Apple
Silicon). HuggingFace models only.

The workload runs on granite.build's built-in ``space://steps/command`` step, which
ships with gbserver, so no space has to provide an AutoTuneX step. The command is
the same ``python main.py …`` the custom_code and LSF builders emit
(:func:`~autotunex.services.launch._shared.start_command`), preceded by the few lines
the bash environment cannot supply on its own: it starts every step with no PATH and
no Python packages, and has no ``additional_files`` to carry the tuning config.
"""

from __future__ import annotations

import base64
from typing import Any

import yaml

from autotunex.services.launch._shared import BlockStringDumper, start_command
from autotunex.services.launch.protocols import LaunchContext

_DEFAULT_SERVER_URL = "http://localhost:8001"
"""Fallback base URL a local-bash worker reports back to when no callback is set."""

_STEP_URI = "space://steps/command"

_ARTIFACT_ID = "custom"
"""The target output the command registers; must match ``outputs.custom``."""


def _step_command(
    ctx: LaunchContext, *, fm_tune_extra: str, backend: str, callback_url: str
) -> str:
    """Return ``command_config.command``: set up the bash runtime, then run ``main.py``.

    The command step runs this with ``sh -c`` in a PATH-less env, so it is POSIX sh.
    One venv is cached across builds in ``.gb-venvs`` beside gbserver's ``workdir``
    (the first run installs fm-tune's ``fm_tune_extra`` extras; later runs only
    re-link the editable install). The tuning config is decoded beside
    ``$OUTPUT_PATH``, so it does not ship inside the ``custom`` model artifact. The
    last line registers ``$OUTPUT_PATH`` as that artifact; the bare ``echo`` before the
    marker keeps it at column 0 even if ``main.py`` left a partial progress line, since
    the bash monitor's artifact regex is ``^``-anchored. ``set -e`` means a failed run
    prints no marker. No command line may *start* with the marker: the command step
    echoes the whole command into ``job.log`` before running it, and a newline escape
    there (which ``sh``'s ``echo`` may expand) would plant a bogus marker line.
    """
    install_target = f'"${{FM_TUNE_ROOT}}[{fm_tune_extra}]"' if fm_tune_extra else '"$FM_TUNE_ROOT"'
    lines = [
        "set -eu",
        'export PATH="${LLMB_BASH_PYTHON_DIR:+$LLMB_BASH_PYTHON_DIR:}'
        '${PATH:-/usr/local/bin:/usr/bin:/bin}"',
        'export OUTPUT_PATH="$LLMB_BASH_OUTPUT_DIR"',
        'case "$OUTPUT_PATH" in'
        ' */workdir/*) VENV_BASE="${OUTPUT_PATH%%/workdir/*}/.gb-venvs" ;;'
        ' *) VENV_BASE="${TMPDIR:-/tmp}/.gb-venvs" ;; esac',
        'export HF_HOME="$VENV_BASE/hf-cache"',
        'VENV="$VENV_BASE/autotune"',
        '[ -x "$VENV/bin/python" ] ||'
        ' { python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet --upgrade pip; }',
        f'"$VENV/bin/pip" install --quiet -e {install_target}',
        'export PATH="$VENV/bin:$PATH"',
        'AUTOTUNE_CONFIG_FILE="$(dirname "$OUTPUT_PATH")/autotune_config.yaml"',
        'printf \'%s\' "$AUTOTUNE_CONFIG_B64" | base64 -d > "$AUTOTUNE_CONFIG_FILE"',
        'cd "$FM_TUNE_ROOT"',
        start_command(
            ctx,
            config_file="$AUTOTUNE_CONFIG_FILE",
            callback_url=callback_url,
            cuda_home=None,
            bind_base_model=True,
            backend=backend,
        ),
        f'echo; echo "GB_ARTIFACT_ID:{_ARTIFACT_ID} GB_ARTIFACT_PATH:$OUTPUT_PATH"',
    ]
    return "\n".join(lines) + "\n"


def build_bash_spec(
    ctx: LaunchContext,
    *,
    fm_tune_root: str | None,
    fm_tune_extra: str,
    backend: str,
    callback_url: str | None,
    output_uri_root: str,
    num_nodes: int = 1,
) -> str:
    """Return the local-bash ``build.yaml`` text for ``ctx``.

    HuggingFace-only model: bound as the ``base_model`` input ``hf:///<model>``
    (three slashes, the local-bash convention for a bare HF repo id), which gbserver
    pulls. The dataset is referenced by ``ctx.dataset_uri`` (the dataset's
    ``artifact_url``) verbatim — the builder is scheme-agnostic: an ``hf://`` artifact
    is pulled by gbserver, and, in standalone mode, a local ``file://`` directory
    (what upload persists there; see the 2026-08-25 standalone-dataset-upload spec) is
    mounted by the same-host gbserver. A caller must ensure it is set. Its split files
    are named ``<dataset_name>_train.<data_format>`` (and ``_validation``), as the
    other builders assume.
    ``config_data`` is serialized to YAML and passed base64-encoded as
    ``AUTOTUNE_CONFIG_B64`` in ``bash.env`` (base64 keeps any ``{{`` in the config
    away from gbserver's Jinja rendering); the caller's object is never mutated. No
    reward-function injection here — mirror 2025 (the ``local`` runner handles
    online RL).

    Args:
        ctx: the launch inputs assembled from the job and its snapshot.
        fm_tune_root: ``FM_TUNE_ROOT`` for ``bash.env``: the absolute path of a local
            fm-tune checkout on the gbserver host (the command ``cd``s into it and runs
            its ``main.py``). A repo URL is rejected.
        fm_tune_extra: fm-tune extras installed into the step's venv (empty installs
            the base package only).
        backend: fm-tune's ``--backend`` (``mlx`` on Apple Silicon, or ``torch``).
        callback_url: base URL a worker reports back to; passed as
            ``--autotunex_server_url``, defaulting to :data:`_DEFAULT_SERVER_URL` when unset.
        output_uri_root: root URI the run's artifacts are written under; the output
            is emitted as ``<root>/autotune_<job-id>/``. Pass an **absolute** URI
            (e.g. ``file:///data/artifacts``): gbserver resolves a *relative* ``file:``
            URI against its own process CWD, which in the container is the ephemeral
            image path — so a relative root silently strands artifacts off the ``/data``
            volume. The registry anchors this under ``settings.artifact_dir``.
        num_nodes: ``compute_config.num_nodes`` for the step (local runs use 1).

    Returns:
        The rendered ``build.yaml`` document as text.

    Raises:
        ValueError: ``fm_tune_root`` is unset or a repo URL rather than a local path.
    """
    if not fm_tune_root or fm_tune_root.startswith("git@") or "://" in fm_tune_root:
        raise ValueError(
            "The bash runner needs AUTOTUNEX_BASH_FM_TUNE_ROOT set to a local fm-tune "
            f"checkout on the gbserver host, got {fm_tune_root!r}."
        )
    config_yaml = yaml.safe_dump(ctx.config_data, default_flow_style=False, sort_keys=False)
    env = {
        "FM_TUNE_ROOT": fm_tune_root,
        "AUTOTUNE_CONFIG_B64": base64.b64encode(config_yaml.encode("utf-8")).decode("ascii"),
    }
    command = _step_command(
        ctx,
        fm_tune_extra=fm_tune_extra,
        backend=backend,
        callback_url=callback_url or _DEFAULT_SERVER_URL,
    )
    output_uri = f"{output_uri_root.rstrip('/')}/autotune_{ctx.job_id}/"
    build: dict[str, Any] = {
        "granite.build": {
            "name": f"custom-model-{ctx.experiment_name}",
            "version": "0.0.1",
            "targets": {
                "custom": {
                    "environment_uri": "space://environments/bash",
                    "inputs": {
                        "base_model": {"uri": f"hf:///{ctx.model}"},
                        "dataset_files": {"uri": ctx.dataset_uri},
                    },
                    "outputs": {_ARTIFACT_ID: {"uri": output_uri}},
                    "steps": [
                        {
                            "step_uri": _STEP_URI,
                            "config": {
                                "command_config": {"command": command},
                                # The command prints its own GB_ARTIFACT_ID marker for
                                # `custom`; don't also auto-scan the output dir.
                                "bash": {"env": env, "skip_finding_output_artifacts": True},
                                "compute_config": {"num_nodes": num_nodes},
                            },
                        }
                    ],
                }
            },
        }
    }
    return yaml.dump(build, Dumper=BlockStringDumper, default_flow_style=False, sort_keys=False)
