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


class TestAdditionalFiles:
    CFG = {
        "custom_code_config": {"start_command": "echo hi"},
        "k8s": {
            "additional_files": {
                "/tmp/autotunex-lora-new.yaml": "tune_config:\n  marker: ok\n"
            }
        },
    }

    def test_writes_file_from_k8s_key_verbatim(self):
        # AutoTuneX files these under k8s:; the step reads that key as-is rather
        # than making the generator rename it to gb:.
        rendered = _render(self.CFG)
        assert "/tmp/autotunex-lora-new.yaml" in rendered
        assert _b64("tune_config:\n  marker: ok\n") in rendered
        assert "base64 -d" in rendered

    def test_creates_parent_directory(self):
        assert "mkdir -p" in _render(self.CFG)

    def test_no_additional_files_block_when_key_absent(self):
        # strict=True must not trip on a missing config.k8s.
        assert "base64 -d >" not in _render(MINIMAL)

    def test_written_before_start_command(self):
        rendered = _render(self.CFG)
        assert rendered.index("/tmp/autotunex-lora-new.yaml") < rendered.index(
            "START_CMD="
        )


class TestRepoAcquisition:
    def _cfg(self, github_url: str, dir_to_save: str = ".") -> dict:
        return {
            "custom_code_config": {
                "start_command": "echo hi",
                "github_url": github_url,
                "dir_to_save": dir_to_save,
            }
        }

    def test_clones_scheme_less_git_url_over_https(self):
        rendered = self._render_url("github.ibm.com/ibm-research/fm-tune.git")
        assert 'git clone "https://$REPO_SPEC"' in rendered

    def _render_url(self, url: str) -> str:
        return _render(self._cfg(url))

    def test_repo_spec_is_embedded(self):
        assert (
            "REPO_SPEC='github.ibm.com/ibm-research/fm-tune.git'"
            in self._render_url("github.ibm.com/ibm-research/fm-tune.git")
        )

    def test_copies_local_path_instead_of_cloning(self):
        # A local path or file:// URI lets the real payload run on a machine with
        # no github.ibm.com auth.
        rendered = self._render_url("/Users/dev/fm-tune")
        assert "file://*)" in rendered
        assert 'cp -R "$LOCAL_PATH/." "$SRC/"' in rendered

    def test_copies_never_uses_in_place(self):
        # setup_command runs `git checkout stage`; in place that would mutate the
        # developer's own working tree.
        rendered = self._render_url("/Users/dev/fm-tune")
        assert 'cd "$LOCAL_PATH"' not in rendered

    def test_src_lives_under_asset_dir(self):
        rendered = self._render_url("/Users/dev/fm-tune")
        assert 'SRC="${LLMB_BASH_ASSET_DIR}/autotunex-src"' in rendered

    def test_dir_to_save_selects_subdir(self):
        rendered = _render(self._cfg("/Users/dev/fm-tune", "subproj"))
        assert 'WORKDIR="$SRC/subproj"' in rendered

    def test_missing_local_path_fails_with_exit_3(self):
        assert "exit 3" in self._render_url("/Users/dev/fm-tune")

    def test_no_repo_block_when_github_url_absent(self):
        rendered = _render(MINIMAL)
        assert "git clone" not in rendered
        assert 'WORKDIR="${LLMB_BASH_ASSET_DIR:-$PWD}"' in rendered


class TestSetupCommand:
    CFG = {
        "custom_code_config": {
            "start_command": "python main.py",
            "setup_command": 'git checkout stage && pip install -e ".[full]"',
        }
    }

    def test_setup_command_is_base64_embedded(self):
        rendered = _render(self.CFG)
        assert _b64('git checkout stage && pip install -e ".[full]"') in rendered
        assert 'git checkout stage && pip install -e ".[full]"' not in rendered

    def test_setup_runs_in_workdir_before_start(self):
        rendered = _render(self.CFG)
        assert rendered.index("SETUP_CMD=") < rendered.index("START_CMD=")

    def test_venv_base_derived_from_output_dir_not_home(self):
        # The launcher does not pass $HOME, so the venv cache is keyed off the
        # output dir (same approach as the lora-finetune step).
        rendered = _render(self.CFG)
        assert 'case "$OUTPUT_PATH" in' in rendered
        assert ".gb-venvs" in rendered

    def test_venv_is_reused_when_present(self):
        assert '[ ! -x "$VENV/bin/python" ]' in _render(self.CFG)

    def test_venv_leads_path(self):
        assert 'export PATH="$VENV/bin:$PATH"' in _render(self.CFG)

    def test_no_setup_block_when_command_empty(self):
        assert "SETUP_CMD=" not in _render(MINIMAL)

    def test_venv_created_even_without_setup_command(self):
        # start_command is a python invocation; it needs the venv regardless.
        assert "VENV=" in _render(MINIMAL)

    def test_pip_upgrade_is_not_included(self):
        # Finding 1: pip upgrade reaches PyPI and breaks the offline contract.
        # The venv's bundled pip is sufficient; setup_command does its own installs.
        assert "--upgrade pip" not in _render(self.CFG)

    def test_venv_path_keyed_by_config(self):
        # Finding 2: different configs should have different venv directories to
        # avoid stale site-packages from unrelated earlier builds.
        import re
        cfg_1 = {
            "custom_code_config": {
                "start_command": "python main.py",
                "setup_command": "pip install A",
            }
        }
        cfg_2 = {
            "custom_code_config": {
                "start_command": "python main.py",
                "setup_command": "pip install B",
            }
        }
        rendered_1 = _render(cfg_1)
        rendered_2 = _render(cfg_2)
        # Extract VENV= lines
        venv_1 = re.search(r'VENV="[^"]*"', rendered_1).group(0)
        venv_2 = re.search(r'VENV="[^"]*"', rendered_2).group(0)
        assert venv_1 != venv_2

    def test_venv_path_is_stable_for_identical_config(self):
        # Same config should hash to the same venv directory (deterministic).
        import re
        rendered_1 = _render(self.CFG)
        rendered_2 = _render(self.CFG)
        venv_1 = re.search(r'VENV="[^"]*"', rendered_1).group(0)
        venv_2 = re.search(r'VENV="[^"]*"', rendered_2).group(0)
        assert venv_1 == venv_2
