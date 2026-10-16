# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""Assembly helpers shared by the remote granite.build spec builders.

The custom_code builder (``spec.py``) and the LSF/SkyPilot builder
(``lsf_spec.py``) emit different ``build.yaml`` trees but share four concerns:
the ``|``-literal YAML dumper, the ``num_gpus_per_node`` derivation, reward-
function injection for online RL, and the ``python main.py`` start command.
They live here so there is exactly one implementation of each, rather than a
copy per builder. The local-bash builder (``bash_spec.py``) is a different
execution shape and shares only the dumper and the start command.
"""

from __future__ import annotations

import shlex
from collections.abc import Sequence
from typing import Any

import yaml

from autotunex.core.constants import HF_MODEL_URI_PREFIX
from autotunex.services.launch.protocols import LaunchContext
from autotunex.services.storage.hf_hub import is_allowlisted

REWARD_FUNCTION_PATH = "/tmp/reward_function.py"
"""In-container path the injected reward function is written to, and the value
``training_rl_config.reward_function_path`` is rewritten to for online RL."""

_DATASET_BINDING = "{{ bindings.dataset_files.binding.path }}"
"""Granite-build runtime binding that resolves to the mounted dataset directory."""

_BASE_MODEL_BINDING = "{{ bindings.base_model.binding.path }}"
"""Where gbserver mounts a base model bound as the ``base_model`` input."""


def base_model_uri(ctx: LaunchContext, namespaces: Sequence[str]) -> str | None:
    """The ``hf://`` input to bind ``ctx.model`` as, or ``None`` to pass it by name.

    Only a HuggingFace model whose owner is in ``namespaces`` (the
    ``hf_import_namespaces`` allowlist) is bound. The tuning workload has no HF
    token, so a private model named on the command line 401s inside the job
    (probe build 4cdbbe7e); as an input artifact gbserver pulls it with the
    space's credentials instead. Every other model keeps the by-name path, so its
    download behaviour is unchanged. Same owner rule as ``hf_hub.token_for``
    (:func:`~autotunex.services.storage.hf_hub.is_allowlisted`), which also refuses
    anything but ``owner/name``, since gbserver reads a third segment as a revision.
    """
    if ctx.model_source != "huggingface" or not is_allowlisted(ctx.model, namespaces):
        return None
    return f"{HF_MODEL_URI_PREFIX}{ctx.model}"


class BlockStringDumper(yaml.SafeDumper):
    """A ``SafeDumper`` that renders multi-line strings as ``|`` literal blocks.

    The embedded per-trial config and any injected reward function are multi-line;
    literal-block style keeps them readable in the generated ``build.yaml`` instead
    of collapsing to a single escaped line. Subclassed rather than mutating the
    global representer registry, so nothing else in the process is affected.
    """


def _represent_str(dumper: BlockStringDumper, data: str) -> yaml.nodes.ScalarNode:
    """Represent multi-line strings with block style; everything else as plain."""
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


BlockStringDumper.add_representer(str, _represent_str)


def num_gpus_per_node(config_data: dict[str, Any]) -> int:
    """Return ``max_concurrent_trials * num_gpus_per_trial``, each defaulting to 1.

    Mirrors ``gb_runner.update_compute_config`` exactly, including the ``.default``
    lookups into ``tune_config`` / ``training_config``.
    """
    tune = config_data.get("tune_config", {}).get("max_concurrent_trials", {})
    train = config_data.get("training_config", {}).get("num_gpus_per_trial", {})
    return int(tune.get("default", 1)) * int(train.get("default", 1))


def inject_reward_function(config_data: dict[str, Any], ctx: LaunchContext) -> dict[str, str]:
    """Rewrite the RL reward paths in ``config_data`` and return the file to embed.

    For online RL (``ctx.reward_function_code`` present) the config's
    ``training_rl_config.reward_function_path`` — and ``reward_function_name`` when
    ``ctx.reward_function_name`` is set — are rewritten to point at
    :data:`REWARD_FUNCTION_PATH`, and ``{REWARD_FUNCTION_PATH: code}`` is returned
    to merge into the build's ``additional_files``. Mutates ``config_data`` in
    place, so callers pass a deep copy. Returns ``{}`` when there is no reward code.
    """
    if not ctx.reward_function_code:
        return {}
    rl_config = config_data.get("training_rl_config")
    if isinstance(rl_config, dict):
        reward_path = rl_config.get("reward_function_path")
        if isinstance(reward_path, dict):
            reward_path["default"] = REWARD_FUNCTION_PATH
        if ctx.reward_function_name:
            reward_name = rl_config.get("reward_function_name")
            if isinstance(reward_name, dict):
                reward_name["default"] = ctx.reward_function_name
    return {REWARD_FUNCTION_PATH: ctx.reward_function_code}


def start_command(
    ctx: LaunchContext,
    *,
    config_file: str,
    callback_url: str | None,
    cuda_home: str | None,
    model_at_root: bool = False,
    keep_diagnostics: bool = False,
    bind_base_model: bool = False,
    backend: str | None = None,
    shell_quote: bool = False,
) -> str:
    """Build the container's ``main.py`` invocation, a faithful port of build_start_cmd.

    Flag order and the ``export … && export … && python main.py`` prefix match the
    2025 command; ``--tuning_algo``, ``--rl_algo``, ``--no_autotune`` and
    ``--autotunex_server_url`` are conditional. ``cuda_home`` is the only value that
    differs between the custom_code (``/usr/local/cuda-13.0``) and LSF
    (``/opt/share/cuda-12.9``) builders — every other flag is identical. The local-bash
    builder passes ``cuda_home=None`` (no CUDA export) and a ``backend``, appended as
    fm-tune's ``--backend`` (``mlx`` or ``torch``).

    ``model_at_root`` appends fm-tune's ``--model_at_root`` (the saved model is moved
    to the root of ``$OUTPUT_PATH``, everything else deleted), and with it
    ``keep_diagnostics`` appends ``--keep_diagnostics`` (everything else is moved into
    ``diagnostics/`` instead). Only the custom_code builder, whose output is uploaded
    as the model repo, sets it.

    ``bind_base_model`` points ``--model_name_or_path`` at the ``base_model`` input's
    mount instead of naming ``ctx.model`` (see :func:`base_model_uri`).

    ``shell_quote`` single-quotes every value taken from the job (names, the model,
    the binding paths) and double-quotes ``$OUTPUT_PATH``, so a name holding a space,
    ``;`` or ``$(…)`` stays one inert argument; ``config_file`` is emitted as given.
    The local-bash builder sets it, since its command runs under ``sh -c`` on the
    gbserver host. The custom_code step renders ``start_command`` into a
    single-quoted YAML scalar, where an added ``'`` would break the chart, so the
    remote builders leave it off.
    """
    quote = shlex.quote if shell_quote else str
    output_path = '"$OUTPUT_PATH"' if shell_quote else "$OUTPUT_PATH"
    model = _BASE_MODEL_BINDING if bind_base_model else ctx.model

    def split(name: str) -> str:
        return quote(f"{_DATASET_BINDING}/{ctx.dataset_name}_{name}.{ctx.data_format}")

    flags = [
        "python main.py",
        f"--config_file {config_file}",
        f"--train_file {split('train')}",
        f"--validation_file {split('validation')}",
        f"--model_name_or_path {quote(model)}",
    ]
    if ctx.tuning_type:
        flags.append(f"--tuning_algo {quote(ctx.tuning_type)}")
    if ctx.rl_tuner_type:
        flags.append(f"--rl_algo {quote(ctx.rl_tuner_type)}")
    flags.append(f"--run_name {quote(ctx.experiment_name)}")
    flags.append(f"--output_dir {output_path}")
    flags.append(f"--output_model_name {quote(ctx.experiment_name)}")
    flags.append("--cleanup --save_history")
    if model_at_root:
        flags.append("--model_at_root")
        if keep_diagnostics:
            flags.append("--keep_diagnostics")
    if not ctx.autotune:
        flags.append("--no_autotune")
    flags.append(f"--job_id {ctx.job_id}")
    if callback_url:
        flags.append(f"--autotunex_server_url {quote(callback_url)}")
    if backend:
        flags.append(f"--backend {quote(backend)}")
    python_cmd = " ".join(flags)
    cuda_export = f"export CUDA_HOME={cuda_home} && " if cuda_home else ""
    return f"{cuda_export}export LOG_PATH={output_path} && {python_cmd}"
