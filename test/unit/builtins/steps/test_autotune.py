"""Structural unit tests for the `autotune` step asset (bash + docker copies)."""
import importlib.util
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
BASH_STEP = REPO_ROOT / "configurations/assets/environments/bash/steps/autotune"
DOCKER_STEP = REPO_ROOT / "configurations/assets/environments/docker/steps/autotune"
RUN_PY = BASH_STEP / "bash_scripts/autotune/run.py"


def _load_run_module():
    spec = importlib.util.spec_from_file_location("autotune_run", RUN_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _base_env(tmp_path):
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "finance_train.jsonl").write_text("{}\n")
    (ds / "finance_validation.jsonl").write_text("{}\n")
    cfg = tmp_path / "autotune_config.yaml"
    cfg.write_text("training_config:\n  tuning_algorithm:\n    default: lora\n")
    out = tmp_path / "out"
    out.mkdir()
    return {
        "LLMB_BASH_INPUT_MODEL": "/models/granite",
        "LLMB_BASH_INPUT_DATASET_FILES": str(ds),
        "AUTOTUNE_CONFIG_FILE": str(cfg),
        "LLMB_BASH_OUTPUT_DIR": str(out),
        "JOB_ID": "job-123",
    }


class TestRunPyDriver:
    def test_build_argv_core_flags(self, tmp_path):
        mod = _load_run_module()
        argv = mod.build_argv(_base_env(tmp_path))
        assert argv[0] == "main.py"
        assert "--model_name_or_path" in argv
        assert argv[argv.index("--model_name_or_path") + 1] == "/models/granite"
        assert "--output_dir" in argv
        assert "--job_id" in argv and argv[argv.index("--job_id") + 1] == "job-123"
        # train/validation resolved by glob
        assert any(a.endswith("finance_train.jsonl") for a in argv)
        assert any(a.endswith("finance_validation.jsonl") for a in argv)

    def test_algo_default_read_from_config(self, tmp_path):
        mod = _load_run_module()
        argv = mod.build_argv(_base_env(tmp_path))
        assert argv[argv.index("--tuning_algo") + 1] == "lora"

    def test_bool_flags_added_when_true(self, tmp_path):
        mod = _load_run_module()
        env = _base_env(tmp_path)
        env.update({"NO_AUTOTUNE": "true", "CLEANUP": "1", "SAVE_HISTORY": "yes"})
        argv = mod.build_argv(env)
        assert "--no_autotune" in argv and "--cleanup" in argv and "--save_history" in argv

    def test_missing_required_input_exits(self, tmp_path):
        mod = _load_run_module()
        env = _base_env(tmp_path)
        del env["LLMB_BASH_INPUT_MODEL"]
        with pytest.raises(SystemExit):
            mod.build_argv(env)

    def test_artifact_marker_format_and_column0(self):
        mod = _load_run_module()
        marker = mod.artifact_marker("/abs/out")
        assert marker == "LLMB_ARTIFACT_ID:custom LLMB_ARTIFACT_PATH:/abs/out"
        assert marker.startswith("LLMB_ARTIFACT_ID:")  # column 0, no leading space

    def test_run_py_has_no_jinja_tokens(self):
        text = RUN_PY.read_text()
        for tok in ("{{", "{%", "{#"):
            assert tok not in text, f"run.py must not contain Jinja token {tok!r}"
