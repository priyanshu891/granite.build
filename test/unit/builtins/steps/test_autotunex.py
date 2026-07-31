"""Unit tests for the autotunex bash step asset.

The step reproduces the Kubernetes custom-code contract on the bash backend.
These tests load the shipped asset and render command.sh through the same Jinja
renderer production uses (gbserver.utils.template.fill_template), with
strict=True to prove no unguarded reference can fail a real build.
"""

import os
from base64 import b64encode
from pathlib import Path

import yaml

from gbserver.utils.template import fill_template

REPO_ROOT = Path(__file__).resolve().parents[4]
STEP_DIR = REPO_ROOT / "configurations/assets/environments/bash/steps/autotunex"
STEP_YAML = STEP_DIR / "step.yaml"
COMMAND_SH = STEP_DIR / "bash_scripts/autotunex/command.sh"


def _load() -> dict:
    return yaml.safe_load(STEP_YAML.read_text())


def _render(config: dict | None = None, bindings: dict | None = None) -> str:
    """Render command.sh exactly as targetsteprun does: strict, full config."""
    data: dict = {"config": config if config is not None else {}}
    if bindings is not None:
        data["bindings"] = bindings
    return fill_template(COMMAND_SH.read_text(), data, strict=True)


def _b64(s: str) -> str:
    return b64encode(s.encode()).decode()


MINIMAL = {"custom_code_config": {"start_command": "echo hi"}}


class TestAutotunexStepYaml:
    def test_step_yaml_exists(self):
        assert STEP_YAML.exists(), f"{STEP_YAML} does not exist"

    def test_step_name_matches_bash_scripts_dir(self):
        # The jobsub resolves bash_scripts/{{ step.name }}, so these must agree.
        assert _load()["name"] == "autotunex"
        assert COMMAND_SH.parent.name == "autotunex"

    def test_declares_bash_nohup_launcher(self):
        # This block is the one thing builtin gbstep lacks on bash.
        env_configs = _load()["environment_configs"]
        assert "Bash" in env_configs
        assert env_configs["Bash"]["launchers"]["autotunex"]["type"] == "nohup"

    def test_uses_shared_bash_monitor(self):
        monitors = _load()["environment_configs"]["Bash"]["monitors"]
        assert monitors["log_monitor"]["ref"] == "space://monitors/bash"

    def test_skips_output_artifact_autoscan(self):
        # single_output_artifact would emit id "outputs", which cannot bind to
        # the target's outputs.custom; the step emits its own marker instead.
        assert _load()["config"]["bash"]["skip_finding_output_artifacts"] is True

    def test_io_schema_is_permissive(self):
        cfg = _load()
        assert cfg["inputs"]["allow_unknown"] is True
        assert cfg["outputs"]["allow_unknown"] is True
        assert "required" not in cfg["inputs"]
        assert cfg["inputs"]["optional"]["dataset_files"]["type"] == "dataset"
        assert cfg["inputs"]["optional"]["model_to_tune"]["type"] == "model"

    def test_command_sh_is_executable(self):
        assert os.access(COMMAND_SH, os.X_OK), f"{COMMAND_SH} must be mode 100755"


class TestAutotunexCommandSh:
    def test_renders_strict_with_minimal_config(self):
        # strict=True: any unguarded reference raises instead of blanking.
        assert _render(MINIMAL)

    def test_renders_strict_with_empty_config(self):
        assert _render({})

    def test_exports_output_path_from_launcher_var(self):
        assert 'export OUTPUT_PATH="${LLMB_BASH_OUTPUT_DIR' in _render(MINIMAL)

    def test_start_command_is_base64_embedded(self):
        # Base64 avoids YAML -> Jinja -> shell quote mangling for commands
        # containing && and $VARs.
        rendered = _render({"custom_code_config": {"start_command": "a && b $X"}})
        assert _b64("a && b $X") in rendered
        assert "a && b $X" not in rendered

    def test_emits_artifact_marker_at_column_zero(self):
        rendered = _render(MINIMAL)
        assert (
            'echo "LLMB_ARTIFACT_ID:custom LLMB_ARTIFACT_PATH:$OUTPUT_PATH"'
            in rendered
        )

    def test_artifact_id_is_overridable(self):
        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "output_binding_id": "adapter",
                }
            }
        )
        assert "LLMB_ARTIFACT_ID:adapter" in rendered

    def test_exits_with_start_command_status(self):
        assert "exit $RC" in _render(MINIMAL)

    def test_missing_custom_code_config_fails_fast(self):
        rendered = _render({})
        assert "custom_code_config is missing" in rendered
        assert "exit 2" in rendered

    def test_empty_start_command_fails_fast(self):
        rendered = _render({"custom_code_config": {"dir_to_save": "."}})
        assert "start_command is empty" in rendered
        assert "exit 2" in rendered

    def test_input_path_exported_when_dataset_bound(self):
        rendered = _render(
            MINIMAL, bindings={"dataset_files": {"binding": {"path": "/data/ds"}}}
        )
        assert 'export INPUT_PATH="/data/ds"' in rendered

    def test_no_input_path_when_dataset_unbound(self):
        assert "INPUT_PATH" not in _render(MINIMAL)
