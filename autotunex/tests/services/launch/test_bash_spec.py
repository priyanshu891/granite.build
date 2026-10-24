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


def test_build_bash_spec_keeps_each_job_value_one_shell_word() -> None:
    # The command runs under `sh -c` on the gbserver host, so a name must not split.
    name = "my run; touch /tmp/pwned $(id)"
    argv = _main_py_argv(_spec(_ctx(experiment_name=name, dataset_name="policy val")))

    assert _flag(argv, "--run_name") == name
    assert _flag(argv, "--output_model_name") == name
    assert _flag(argv, "--train_file") == "<dataset>/policy val_train.jsonl"


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
    "root",
    [
        None,
        "",
        "https://github.example.com/org/fm-tune",
        "git@host:org/fm-tune.git",
        "relative/fm-tune",
        "file:///opt/fm-tune",
    ],
)
def test_build_bash_spec_rejects_an_fm_tune_root_that_is_not_an_absolute_path(
    root: str | None,
) -> None:
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


def _fake_python_dir(tmp_path: Path) -> tuple[Path, Path]:
    """A ``python3`` whose ``-m venv`` makes a venv of the test interpreter and a fake pip.

    The fake pip logs each call and sleeps briefly, so a second install racing the
    first would show up in the log; everything else runs the real interpreter.
    """
    pybin = tmp_path / "pybin"
    pybin.mkdir()
    pip_log = tmp_path / "pip.log"
    (pybin / "python3").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = -m ] && [ "$2" = venv ]; then\n'
        "  for venv; do :; done\n"
        '  [ "$3" != --clear ] || rm -rf "$venv"\n'
        f'  mkdir -p "$venv/bin" && ln -sf {shlex.quote(sys.executable)} "$venv/bin/python"\n'
        f'  printf \'#!/bin/sh\\necho "$*" >> {pip_log}\\nsleep 0.3\\n\' > "$venv/bin/pip"\n'
        '  chmod +x "$venv/bin/pip"; exit 0\n'
        "fi\n"
        f'exec {shlex.quote(sys.executable)} "$@"\n'
    )
    (pybin / "python3").chmod(0o755)
    return pybin, pip_log


def _fake_fm_tune(tmp_path: Path, main_py: str) -> Path:
    fm_tune = tmp_path / "fm-tune"
    fm_tune.mkdir(exist_ok=True)
    (fm_tune / "main.py").write_text(main_py)
    (fm_tune / "pyproject.toml").write_text('[project]\nname = "fm-tune"\n')
    return fm_tune


def _launch(
    text: str, out: Path, pybin: Path, *, dataset: str = "/d", model: str = "/m"
) -> subprocess.Popen[str]:
    """Start the emitted command as the command step would, bindings rendered."""
    command = _command(text).replace(DATASET_BINDING, dataset).replace(MODEL_BINDING, model)
    # gbserver stringifies every bash.env value and hands the step no inherited
    # environment, so mirror both.
    env = {k: str(v) for k, v in _step_config(text)["bash"]["env"].items()}
    env |= {"LLMB_BASH_PYTHON_DIR": str(pybin), "LLMB_BASH_OUTPUT_DIR": str(out)}
    out.mkdir(parents=True, exist_ok=True)
    # gbserver tees the step's output into job.log inside the output dir.
    (out / "job.log").write_text("gbserver log\n")
    return subprocess.Popen(
        [shutil.which("sh") or "/bin/sh", "-c", command],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _finish(proc: subprocess.Popen[str]) -> tuple[int, str, str]:
    try:
        stdout, stderr = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise
    return proc.returncode, stdout, stderr


def _build_out(gb_home: Path, build: str = "llm-build-1") -> Path:
    """The step output dir gbserver hands a bash launch, under ``<gb_home>/workdir``."""
    return gb_home / "workdir" / build / "target-custom" / "step-command" / "launch-1" / "outputs"


def test_generated_command_runs_main_py_and_registers_the_output(tmp_path: Path) -> None:
    record = tmp_path / "main_py_call.json"
    fm_tune = _fake_fm_tune(
        tmp_path,
        "import json, os, sys\n"
        "argv = sys.argv[1:]\n"
        "cfg = argv[argv.index('--config_file') + 1]\n"
        "out = argv[argv.index('--output_dir') + 1]\n"
        "open(os.path.join(out, 'adapter.bin'), 'w').close()\n"
        "sys.stdout.write('Trial 3/8 [====>    ] 50%')\n"
        f"json.dump({{'argv': argv, 'cwd': os.getcwd(), 'config': open(cfg).read()}},"
        f" open({str(record)!r}, 'w'))\n",
    )
    pybin, _ = _fake_python_dir(tmp_path)
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    pwned = tmp_path / "pwned"
    name = f"my run; touch {pwned} $(touch {pwned})"
    # A GB home path that itself holds a `/workdir/` must not move the venv cache.
    gb_home = tmp_path / "workdir" / "gb-home"
    out = _build_out(gb_home)

    text = _spec(_ctx(experiment_name=name), fm_tune_root=str(fm_tune))
    returncode, stdout, stderr = _finish(
        _launch(text, out, pybin, dataset=str(dataset), model="/models/smollm2")
    )

    assert returncode == 0, stderr
    model = out / "model"
    # The marker starts its own line even after main.py's unterminated progress line,
    # and registers the model subdirectory, not the dir gbserver's job.log is in.
    assert f"GB_ARTIFACT_ID:custom GB_ARTIFACT_PATH:{model}" in stdout.splitlines()
    assert sorted(p.name for p in model.iterdir()) == ["adapter.bin"]
    call = json.loads(record.read_text())
    argv = call["argv"]
    assert Path(call["cwd"]).resolve() == fm_tune.resolve()
    assert yaml.safe_load(call["config"]) == {"tune_config": {"num_samples": {"default": 4}}}
    assert _flag(argv, "--train_file") == f"{dataset}/policy_val_train.jsonl"
    assert _flag(argv, "--model_name_or_path") == "/models/smollm2"
    assert _flag(argv, "--output_dir") == str(model)
    assert _flag(argv, "--run_name") == name
    assert not pwned.exists()
    # The tuning config does not ship inside the `custom` artifact.
    assert not Path(_flag(argv, "--config_file")).is_relative_to(model)
    # The venv is cached beside gbserver's workdir, keyed per fm-tune checkout.
    assert len(list((gb_home / ".gb-venvs").glob("autotune-*/.installed"))) == 1


def test_generated_command_reuses_the_venv_without_reinstalling(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, pip_log = _fake_python_dir(tmp_path)
    text = _spec(fm_tune_root=str(fm_tune))

    for build in ("llm-build-1", "llm-build-2"):
        returncode, _, stderr = _finish(_launch(text, _build_out(tmp_path, build), pybin))
        assert returncode == 0, stderr

    installs = [ln for ln in pip_log.read_text().splitlines() if " -e " in ln]
    assert installs == [f"install --quiet -e {fm_tune}[full,mlx]"]


def test_generated_command_installs_once_for_concurrent_first_builds(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, pip_log = _fake_python_dir(tmp_path)
    text = _spec(fm_tune_root=str(fm_tune))

    procs = [_launch(text, _build_out(tmp_path, f"llm-build-{i}"), pybin) for i in range(3)]
    results = [_finish(proc) for proc in procs]

    assert [code for code, _, _ in results] == [0, 0, 0], [err for _, _, err in results]
    installs = [ln for ln in pip_log.read_text().splitlines() if " -e " in ln]
    assert len(installs) == 1, installs


def test_generated_command_takes_over_a_lock_whose_owner_died(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, pip_log = _fake_python_dir(tmp_path)
    text = _spec(fm_tune_root=str(fm_tune))
    assert _finish(_launch(text, _build_out(tmp_path, "llm-build-1"), pybin))[0] == 0
    (venv,) = (tmp_path / ".gb-venvs").glob("autotune-*")
    # A build killed mid-install leaves its lock behind and no finished install.
    (venv / ".installed").unlink()
    dead = subprocess.Popen(["true"])
    dead.wait()
    lock = venv.with_name(f"{venv.name}.lock")
    lock.mkdir()
    (lock / "pid").write_text(f"{dead.pid}\n")

    returncode, _, stderr = _finish(_launch(text, _build_out(tmp_path, "llm-build-2"), pybin))

    assert returncode == 0, stderr
    assert not lock.exists()
    assert len([ln for ln in pip_log.read_text().splitlines() if " -e " in ln]) == 2


def test_generated_command_rebuilds_a_venv_whose_interpreter_is_gone(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, pip_log = _fake_python_dir(tmp_path)
    text = _spec(fm_tune_root=str(fm_tune))
    assert _finish(_launch(text, _build_out(tmp_path, "llm-build-1"), pybin))[0] == 0
    (venv,) = (tmp_path / ".gb-venvs").glob("autotune-*")
    (venv / "bin" / "python").unlink()

    returncode, _, stderr = _finish(_launch(text, _build_out(tmp_path, "llm-build-2"), pybin))

    assert returncode == 0, stderr
    assert len([ln for ln in pip_log.read_text().splitlines() if " -e " in ln]) == 2


def test_generated_command_keys_the_venv_by_fm_tune_dependencies(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, _ = _fake_python_dir(tmp_path)
    text = _spec(fm_tune_root=str(fm_tune))

    assert _finish(_launch(text, _build_out(tmp_path, "llm-build-1"), pybin))[0] == 0
    (fm_tune / "pyproject.toml").write_text('[project]\nname = "fm-tune"\nversion = "2"\n')
    assert _finish(_launch(text, _build_out(tmp_path, "llm-build-2"), pybin))[0] == 0

    assert len(list((tmp_path / ".gb-venvs").glob("autotune-*/.installed"))) == 2


def test_generated_command_outside_the_workdir_layout_uses_a_per_build_venv(
    tmp_path: Path,
) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "pass\n")
    pybin, _ = _fake_python_dir(tmp_path)
    out = tmp_path / "elsewhere" / "outputs"

    returncode, _, stderr = _finish(_launch(_spec(fm_tune_root=str(fm_tune)), out, pybin))

    assert returncode == 0, stderr
    assert list((tmp_path / "elsewhere" / ".gb-venvs").glob("autotune-*/.installed"))


def test_generated_command_prints_no_marker_when_main_py_fails(tmp_path: Path) -> None:
    fm_tune = _fake_fm_tune(tmp_path, "raise SystemExit(7)\n")
    pybin, _ = _fake_python_dir(tmp_path)

    returncode, stdout, _ = _finish(
        _launch(_spec(fm_tune_root=str(fm_tune)), _build_out(tmp_path), pybin)
    )

    assert returncode == 7
    assert "GB_ARTIFACT_ID:" not in stdout
