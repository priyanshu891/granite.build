"""The pure local-bash build-spec builder. Assertions parse the YAML, never match strings.

The generated document is a granite.build ``build.yaml`` in the local-bash shape —
a top-level ``granite.build`` key wrapping ``targets.custom`` bound to
``space://environments/bash`` and a single ``space://steps/command`` step whose
``command_config.command`` ends in the shared ``python main.py …`` start command — so
the helpers below navigate that tree rather than the flat shape an earlier draft used.
"""

from __future__ import annotations

import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest
import yaml

from autotunex.services.launch.bash_spec import build_bash_spec
from autotunex.services.launch.protocols import LaunchContext

JOB_ID = UUID("87b98242-7ebd-476e-90f4-147a727ca4ad")
DATASET_BINDING = "{{ bindings.dataset_files.binding.path }}"
MODEL_BINDING = "{{ bindings.base_model.binding.path }}"


def _ctx(**overrides: object) -> LaunchContext:
    base: dict[str, object] = {
        "job_id": JOB_ID,
        "model": "HuggingFaceTB/SmolLM2-135M-Instruct",
        "model_source": "huggingface",
        "experiment_name": "SmolLM2-135M-Instruct_smollm2",
        "tuning_type": "lora",
        "rl_tuner_type": None,
        "config_name": "config",
        "config_data": {"tune_config": {"num_samples": {"default": 4}}},
        "dataset_name": "policy_val",
        "dataset_uri": "hf://huggingface.co/datasets/example-org/policy_val_193a11ef",
        "data_format": "jsonl",
        "autotune": True,
        "seed": 42,
        "reward_function_code": None,
        "reward_function_name": None,
    }
    base.update(overrides)
    return LaunchContext(**base)  # type: ignore[arg-type]


def _spec(ctx: LaunchContext | None = None, **overrides: str | None) -> str:
    kwargs: dict[str, Any] = {
        "fm_tune_root": "/opt/fm-tune",
        "fm_tune_extra": "full,mlx",
        "backend": "mlx",
        "callback_url": None,
        "output_uri_root": "file:///data/artifacts",
    }
    kwargs.update(overrides)
    return build_bash_spec(ctx or _ctx(), **kwargs)


def _custom(text: str) -> dict[str, Any]:
    doc = cast("dict[str, Any]", yaml.safe_load(text))
    return cast("dict[str, Any]", doc["granite.build"]["targets"]["custom"])


def _step_config(text: str) -> dict[str, Any]:
    return cast("dict[str, Any]", _custom(text)["steps"][0]["config"])


def _command(text: str) -> str:
    return cast(str, _step_config(text)["command_config"]["command"])


def _main_py_argv(text: str) -> list[str]:
    """The ``python main.py …`` arguments of the command's start line.

    The input bindings contain spaces, so they become ``<dataset>``/``<model>`` first.
    """
    line = next(ln for ln in _command(text).splitlines() if "python main.py" in ln)
    line = line.replace(DATASET_BINDING, "<dataset>").replace(MODEL_BINDING, "<model>")
    return shlex.split(line.split("python main.py", 1)[1])


def _flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def test_build_bash_spec_matches_the_bash_shape() -> None:
    text = _spec()

    doc = cast("dict[str, Any]", yaml.safe_load(text))["granite.build"]
    target = doc["targets"]["custom"]
    step = target["steps"][0]

    assert doc["name"] == "custom-model-SmolLM2-135M-Instruct_smollm2"
    assert doc["version"] == "0.0.1"
    assert target["environment_uri"] == "space://environments/bash"
    assert target["inputs"]["base_model"]["uri"] == "hf:///HuggingFaceTB/SmolLM2-135M-Instruct"
    assert (
        target["inputs"]["dataset_files"]["uri"]
        == "hf://huggingface.co/datasets/example-org/policy_val_193a11ef"
    )
    assert (
        target["outputs"]["custom"]["uri"]
        == "file:///data/artifacts/autotune_87b98242-7ebd-476e-90f4-147a727ca4ad/"
    )
    assert step["step_uri"] == "space://steps/command"
    assert step["config"]["compute_config"]["num_nodes"] == 1
    assert step["config"]["bash"]["skip_finding_output_artifacts"] is True


def test_build_bash_spec_env_carries_the_root_and_the_encoded_config() -> None:
    env = _step_config(_spec())["bash"]["env"]

    assert set(env) == {"FM_TUNE_ROOT", "AUTOTUNE_CONFIG_B64"}
    assert env["FM_TUNE_ROOT"] == "/opt/fm-tune"
    decoded = yaml.safe_load(base64.b64decode(env["AUTOTUNE_CONFIG_B64"]))
    assert decoded == {"tune_config": {"num_samples": {"default": 4}}}


def test_build_bash_spec_runs_the_shared_start_command() -> None:
    argv = _main_py_argv(_spec(_ctx(autotune=False)))

    assert _flag(argv, "--config_file") == "$AUTOTUNE_CONFIG_FILE"
    assert _flag(argv, "--train_file") == "<dataset>/policy_val_train.jsonl"
    assert _flag(argv, "--validation_file") == "<dataset>/policy_val_validation.jsonl"
    assert _flag(argv, "--model_name_or_path") == "<model>"
    assert _flag(argv, "--tuning_algo") == "lora"
    assert _flag(argv, "--run_name") == "SmolLM2-135M-Instruct_smollm2"
    assert _flag(argv, "--output_dir") == "$OUTPUT_PATH"
    assert _flag(argv, "--job_id") == str(JOB_ID)
    assert _flag(argv, "--backend") == "mlx"
    assert "--no_autotune" in argv
    assert "CUDA_HOME" not in _command(_spec())


def test_build_bash_spec_names_splits_by_the_dataset_format() -> None:
    # HF-imported datasets are stored as <name>_train.parquet.
    argv = _main_py_argv(_spec(_ctx(data_format="parquet")))

    assert _flag(argv, "--train_file") == "<dataset>/policy_val_train.parquet"


def test_build_bash_spec_defaults_server_url_when_callback_absent() -> None:
    assert _flag(_main_py_argv(_spec()), "--autotunex_server_url") == "http://localhost:8001"
    explicit = _main_py_argv(_spec(callback_url="http://bridge:9001"))
    assert _flag(explicit, "--autotunex_server_url") == "http://bridge:9001"


def test_build_bash_spec_installs_the_configured_extras() -> None:
    assert '-e "${FM_TUNE_ROOT}[full,mlx]"' in _command(_spec())
    # An empty extra installs the base package only.
    assert '-e "$FM_TUNE_ROOT"' in _command(_spec(fm_tune_extra=""))


@pytest.mark.parametrize(
    "root", [None, "", "https://github.example.com/org/fm-tune", "git@host:org/fm-tune.git"]
)
def test_build_bash_spec_rejects_a_missing_or_remote_fm_tune_root(root: str | None) -> None:
    with pytest.raises(ValueError, match="AUTOTUNEX_BASH_FM_TUNE_ROOT"):
        _spec(fm_tune_root=root)


def test_build_bash_spec_command_has_no_jinja_beyond_the_bindings() -> None:
    # gbserver Jinja-renders the command; only the two input bindings may be templated.
    rest = _command(_spec()).replace(DATASET_BINDING, "").replace(MODEL_BINDING, "")
    for token in ("{{", "{%", "{#"):
        assert token not in rest, token


def test_build_bash_spec_command_never_starts_a_line_with_the_marker() -> None:
    # The command step echoes the command into job.log before running it, and sh's
    # echo may expand `\n`; a line starting with the marker there is a bogus artifact.
    expanded = _command(_spec()).replace("\\n", "\n")
    for line in expanded.splitlines():
        assert not line.startswith("GB_ARTIFACT_"), line


def test_build_bash_spec_anchors_output_under_root() -> None:
    # A trailing slash on the root must not double up in the emitted URI, and the
    # absolute root must be preserved verbatim (gbserver honors an absolute file:
    # URI; a relative one would resolve against gbserver's own CWD instead).
    text = _spec(output_uri_root="file:///data/artifacts/")

    assert (
        _custom(text)["outputs"]["custom"]["uri"]
        == "file:///data/artifacts/autotune_87b98242-7ebd-476e-90f4-147a727ca4ad/"
    )


def test_build_bash_spec_does_not_mutate_config_data() -> None:
    original = {"tune_config": {"num_samples": {"default": 4}}}

    _spec(_ctx(config_data=original))

    assert original == {"tune_config": {"num_samples": {"default": 4}}}


def test_build_bash_spec_passes_file_uri_dataset_through() -> None:
    # A standalone local dataset is referenced by an absolute file:// directory
    # URI; the bash spec is scheme-agnostic and must carry it verbatim.
    file_uri = "file:///data/artifacts/datasets/193a11ef-0000-0000-0000-000000000000"
    text = _spec(_ctx(dataset_uri=file_uri))

    assert _custom(text)["inputs"]["dataset_files"]["uri"] == file_uri


def test_generated_command_runs_main_py_and_registers_the_output(tmp_path: Path) -> None:
    """Run the emitted command as the command step would, against a fake fm-tune.

    A pre-seeded venv (the test interpreter plus a no-op pip) stands in for the cached
    one, so nothing is installed; the bindings are rendered the way gbserver does.
    """
    fm_tune = tmp_path / "fm-tune"
    fm_tune.mkdir()
    record = tmp_path / "main_py_call.json"
    (fm_tune / "main.py").write_text(
        "import json, os, sys\n"
        "argv = sys.argv[1:]\n"
        "cfg = argv[argv.index('--config_file') + 1]\n"
        "sys.stdout.write('Trial 3/8 [====>    ] 50%')\n"
        f"json.dump({{'argv': argv, 'cwd': os.getcwd(), 'config': open(cfg).read()}},"
        f" open({str(record)!r}, 'w'))\n"
    )
    venv_bin = tmp_path / ".gb-venvs" / "autotune" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").symlink_to(sys.executable)
    (venv_bin / "pip").write_text("#!/bin/sh\nexit 0\n")
    (venv_bin / "pip").chmod(0o755)
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    out = tmp_path / "workdir" / "outputs"
    out.mkdir(parents=True)

    text = _spec(fm_tune_root=str(fm_tune))
    command = (
        _command(text)
        .replace(DATASET_BINDING, str(dataset))
        .replace(MODEL_BINDING, "/models/smollm2")
    )
    # gbserver stringifies every bash.env value and hands the step no inherited
    # environment, so mirror both.
    env = {k: str(v) for k, v in _step_config(text)["bash"]["env"].items()}
    env |= {
        "LLMB_BASH_PYTHON_DIR": os.path.dirname(sys.executable),
        "LLMB_BASH_OUTPUT_DIR": str(out),
    }
    proc = subprocess.run(
        [shutil.which("sh") or "/bin/sh", "-c", command],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 0, proc.stderr
    # The marker starts its own line even after main.py's unterminated progress line.
    assert f"GB_ARTIFACT_ID:custom GB_ARTIFACT_PATH:{out}" in proc.stdout.splitlines()
    call = json.loads(record.read_text())
    argv = call["argv"]
    assert Path(call["cwd"]).resolve() == fm_tune.resolve()
    assert yaml.safe_load(call["config"]) == {"tune_config": {"num_samples": {"default": 4}}}
    assert _flag(argv, "--train_file") == f"{dataset}/policy_val_train.jsonl"
    assert _flag(argv, "--model_name_or_path") == "/models/smollm2"
    assert _flag(argv, "--output_dir") == str(out)
    # The tuning config does not ship inside the `custom` artifact.
    assert not Path(_flag(argv, "--config_file")).is_relative_to(out)
    assert list(out.iterdir()) == []


def test_generated_command_prints_no_marker_when_main_py_fails(tmp_path: Path) -> None:
    fm_tune = tmp_path / "fm-tune"
    fm_tune.mkdir()
    (fm_tune / "main.py").write_text("raise SystemExit(7)\n")
    venv_bin = tmp_path / ".gb-venvs" / "autotune" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").symlink_to(sys.executable)
    (venv_bin / "pip").write_text("#!/bin/sh\nexit 0\n")
    (venv_bin / "pip").chmod(0o755)
    out = tmp_path / "workdir" / "outputs"
    out.mkdir(parents=True)

    text = _spec(fm_tune_root=str(fm_tune))
    command = _command(text).replace(DATASET_BINDING, "/d").replace(MODEL_BINDING, "/m")
    env = {k: str(v) for k, v in _step_config(text)["bash"]["env"].items()}
    env |= {
        "LLMB_BASH_PYTHON_DIR": os.path.dirname(sys.executable),
        "LLMB_BASH_OUTPUT_DIR": str(out),
    }
    proc = subprocess.run(
        [shutil.which("sh") or "/bin/sh", "-c", command],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 7
    assert "GB_ARTIFACT_ID:" not in proc.stdout
