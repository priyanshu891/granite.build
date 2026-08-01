"""Unit tests for the autotunex bash step asset.

The step reproduces the Kubernetes custom-code contract on the bash backend.
These tests load the shipped asset and render command.sh through the same Jinja
renderer production uses (gbserver.utils.template.fill_template), with
strict=True to prove no unguarded reference can fail a real build.
"""

import os
import shutil
import subprocess
from base64 import b64encode
from pathlib import Path

import pytest
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

BASH = shutil.which("bash")


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

    def test_declares_input_artifact_path_input(self):
        # The documented bring-your-own-step binding; command.sh prefers it over
        # dataset_files when bridging INPUT_PATH.
        iap = _load()["inputs"]["optional"]["input_artifact_path"]
        assert iap["type"] == "fileset"
        assert iap["accept"] == ["uri", "binding"]

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

    def test_emits_artifact_marker_unprefixed(self):
        # The monitor anchors ^LLMB_ARTIFACT_ID: on the LOG line, so nothing may
        # precede the marker inside the echo. Source indentation is irrelevant.
        rendered = _render(MINIMAL)
        assert (
            'echo "LLMB_ARTIFACT_ID:$OUTPUT_BINDING_ID LLMB_ARTIFACT_PATH:$OUTPUT_PATH"'
            in rendered
        )
        assert _b64("custom") in rendered

    def test_artifact_id_is_overridable(self):
        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "output_binding_id": "adapter",
                }
            }
        )
        # b64-encoded and decoded into $OUTPUT_BINDING_ID (see TestShellInjection).
        assert _b64("adapter") in rendered
        assert _b64("custom") not in rendered

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
        assert "export INPUT_PATH=" in rendered
        assert _b64("/data/ds") in rendered

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
        # The path is b64-encoded too (see TestShellInjection) — it reaches the
        # shell only via $FNAME.
        assert _b64("/tmp/autotunex-lora-new.yaml") in rendered
        assert _b64("tune_config:\n  marker: ok\n") in rendered
        assert "base64 -d" in rendered

    def test_creates_parent_directory(self):
        assert 'mkdir -p "$(dirname "$FNAME")"' in _render(self.CFG)

    def test_no_additional_files_block_when_key_absent(self):
        # strict=True must not trip on a missing config.k8s.
        assert "base64 -d >" not in _render(MINIMAL)

    def test_written_before_start_command(self):
        rendered = _render(self.CFG)
        assert rendered.index(_b64("/tmp/autotunex-lora-new.yaml")) < rendered.index(
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
        # b64-encoded, decoded into $REPO_SPEC — never spliced into the script.
        rendered = self._render_url("github.ibm.com/ibm-research/fm-tune.git")
        assert "REPO_SPEC=" in rendered
        assert _b64("github.ibm.com/ibm-research/fm-tune.git") in rendered

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
        assert 'SRC="${LLMB_BASH_ASSET_DIR:?' in rendered
        assert '}/autotunex-src"' in rendered

    def test_asset_dir_is_guarded_before_destructive_rm(self):
        # M3: the line right after SRC= is `rm -rf "$SRC"`, so the expansion SRC
        # is built from must be provably non-empty at the point of use.
        rendered = self._render_url("/Users/dev/fm-tune")
        src_line = next(
            line for line in rendered.splitlines() if line.startswith("SRC=")
        )
        assert "${LLMB_BASH_ASSET_DIR:?" in src_line
        lines = rendered.splitlines()
        assert lines[lines.index(src_line) + 1] == 'rm -rf "$SRC"'

    def test_dir_to_save_selects_subdir(self):
        rendered = _render(self._cfg("/Users/dev/fm-tune", "subproj"))
        assert 'WORKDIR="$SRC/$DIR_TO_SAVE"' in rendered
        assert _b64("subproj") in rendered

    def test_missing_local_path_fails_with_exit_3(self):
        # Assert the guard CONDITION renders, not just that the literal "exit 3"
        # appears: both exit-3 branches render together whenever github_url is
        # set, so a bare "exit 3" check passes even with an inverted condition.
        rendered = self._render_url("/Users/dev/fm-tune")
        assert 'if [ -n "$LOCAL_PATH" ] && [ ! -d "$LOCAL_PATH" ]; then' in rendered
        assert "ERROR local repo path not found" in rendered
        assert "exit 3" in rendered

    def test_local_path_validated_before_destroying_src(self):
        # M4: rm -rf/mkdir must come AFTER the existence check, otherwise a bad
        # path leaves an empty autotunex-src behind.
        rendered = self._render_url("/Users/dev/fm-tune")
        assert rendered.index('[ ! -d "$LOCAL_PATH" ]') < rendered.index(
            'rm -rf "$SRC"'
        )

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

    def test_venv_hash_is_shell_safe_without_b64(self):
        # VENV="$VENV_BASE/autotunex-{{ venv_key | short_hash }}" is the one
        # remaining raw splice. short_alphanumeric_lower_hash b64s a sha256 digest
        # then drops every non-alnum char and lowercases, so its output is
        # [a-z0-9]{8} by construction and needs no b64 hardening. This pins that:
        # hostile config must not survive into the VENV path.
        import re

        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "github_url": '/tmp/x"; touch /tmp/gb-autotunex-pwned; echo "y',
                    "setup_command": "$(id) && rm -rf /",
                }
            }
        )
        venv = re.search(r'^VENV="(.*)"$', rendered, re.MULTILINE).group(1)
        assert venv.startswith("$VENV_BASE/autotunex-")
        assert re.fullmatch(
            r"[a-z0-9]{1,8}", venv.rsplit("autotunex-", 1)[1]
        ), f"venv hash is not [a-z0-9]: {venv!r}"

    def test_cd_to_workdir_reports_its_own_error(self):
        # Without the `||` block this is the one failure path that surfaces as
        # bash's bare "No such file or directory" with no autotunex: prefix.
        rendered = _render(MINIMAL)
        assert 'cd "$WORKDIR" || {' in rendered
        assert "ERROR cannot enter workdir" in rendered
        assert "exit 4" in rendered


# Every branch of the template must produce a script bash can PARSE, not merely
# one that looks plausible as text. This matrix is the only thing standing
# between "quoting is broken" and "quoting is broken and nobody noticed".
RENDER_MATRIX: list[tuple[str, dict, dict | None]] = [
    ("empty_config", {}, None),
    ("missing_start_command", {"custom_code_config": {"dir_to_save": "."}}, None),
    (
        "whitespace_start_command",
        {"custom_code_config": {"start_command": "  \t "}},
        None,
    ),
    ("minimal", MINIMAL, None),
    (
        "full_with_additional_files",
        {
            "custom_code_config": {
                "start_command": 'python tune.py --out "$OUTPUT_PATH" && echo done',
                "setup_command": 'git checkout stage && pip install -e ".[full]"',
                "github_url": "github.ibm.com/ibm-research/fm-tune.git",
                "dir_to_save": "scripts",
                "output_binding_id": "adapter",
            },
            "k8s": {
                "additional_files": {
                    "/tmp/autotunex-lora.yaml": "tune_config:\n  lr: 1e-4\n",
                    "/tmp/nested/dir/extra.json": '{"a": 1}',
                }
            },
        },
        {"input_artifact_path": {"binding": {"path": "/data/model"}}},
    ),
    (
        "local_path_github_url",
        {
            "custom_code_config": {
                "start_command": "echo hi",
                "github_url": "/Users/dev/fm-tune",
            }
        },
        None,
    ),
    (
        "file_uri_github_url",
        {
            "custom_code_config": {
                "start_command": "echo hi",
                "github_url": "file:///Users/dev/fm-tune",
            }
        },
        None,
    ),
    (
        "dir_to_save_subdir",
        {
            "custom_code_config": {
                "start_command": "echo hi",
                "github_url": "/Users/dev/fm-tune",
                "dir_to_save": "subproj/deeper",
            }
        },
        None,
    ),
    (
        "setup_command_only",
        {
            "custom_code_config": {
                "start_command": "echo hi",
                "setup_command": "pip install -r requirements.txt",
            }
        },
        None,
    ),
    (
        "binding_input_artifact_path",
        MINIMAL,
        {"input_artifact_path": {"binding": {"path": "/data/iap"}}},
    ),
    (
        "binding_dataset_files",
        MINIMAL,
        {"dataset_files": {"binding": {"path": "/data/dsf"}}},
    ),
    (
        "binding_both",
        MINIMAL,
        {
            "input_artifact_path": {"binding": {"path": "/data/iap"}},
            "dataset_files": {"binding": {"path": "/data/dsf"}},
        },
    ),
    ("binding_empty", MINIMAL, {}),
    (
        "injected_values",
        {
            "custom_code_config": {
                "start_command": "echo hi",
                "github_url": "/Users/dev/it's-a-repo",
                "dir_to_save": "$(touch /tmp/gb-autotunex-pwned)",
                "output_binding_id": 'x"; touch /tmp/gb-autotunex-pwned; echo "y',
            },
            "k8s": {"additional_files": {"/tmp/it's a config.yaml": "a: 1"}},
        },
        None,
    ),
]


@pytest.mark.skipif(BASH is None, reason="bash not available on PATH")
@pytest.mark.parametrize(
    ("case_id", "cfg", "bindings"), RENDER_MATRIX, ids=[c[0] for c in RENDER_MATRIX]
)
def test_rendered_script_passes_bash_n(case_id, cfg, bindings, tmp_path):
    """`bash -n` every rendered permutation: syntax errors, not string presence."""
    script = tmp_path / f"{case_id}.sh"
    script.write_text(_render(cfg, bindings))
    proc = subprocess.run(
        [BASH, "-n", str(script)], capture_output=True, text=True, check=False
    )
    assert proc.returncode == 0, f"{case_id}: bash -n failed:\n{proc.stderr}"


class TestShellInjection:
    """No config value may reach the shell as script text.

    The config is user-controlled: AutoTuneX builds the additional_files key from
    a wizard-entered config name that sanitizes only spaces, so a literal `'` or
    `$(...)` really does arrive here. base64 output is always [A-Za-z0-9+/=] and
    therefore cannot break out of single quotes.
    """

    DANGEROUS_DIR = "$(touch /tmp/gb-autotunex-pwned)"
    QUOTED_FNAME = "/tmp/it's a config.yaml"
    QUOTED_URL = "/Users/dev/it's-a-repo"
    # Worse than the $(...) payloads: the `"` closes the echo's own quoting, so
    # the rest is a fresh command list rather than a substitution.
    QUOTE_BREAKING_ID = 'x"; touch /tmp/gb-autotunex-pwned; echo "y'

    def test_dir_to_save_substitution_is_not_interpolated(self):
        # This was the executable one: WORKDIR="$SRC/{{ dir_to_save }}" sat in
        # DOUBLE quotes, so $(id) ran at step run time.
        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "github_url": "/Users/dev/fm-tune",
                    "dir_to_save": self.DANGEROUS_DIR,
                }
            }
        )
        assert self.DANGEROUS_DIR not in rendered
        assert _b64(self.DANGEROUS_DIR) in rendered
        assert 'WORKDIR="$SRC/$DIR_TO_SAVE"' in rendered

    def test_additional_file_name_with_quote_is_not_interpolated(self):
        rendered = _render(
            {
                "custom_code_config": {"start_command": "echo hi"},
                "k8s": {"additional_files": {self.QUOTED_FNAME: "a: 1"}},
            }
        )
        assert self.QUOTED_FNAME not in rendered
        assert _b64(self.QUOTED_FNAME) in rendered
        assert (
            "printf '%s' '{}' | base64 -d > \"$FNAME\"".format(_b64("a: 1")) in rendered
        )

    def test_github_url_with_quote_is_not_interpolated(self):
        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "github_url": self.QUOTED_URL,
                }
            }
        )
        assert self.QUOTED_URL not in rendered
        assert _b64(self.QUOTED_URL) in rendered

    def test_output_binding_id_cannot_break_the_marker_quoting(self):
        # The marker echo is double-quoted, so a `"` in output_binding_id used to
        # close it and run the remainder: `x"; touch /tmp/pwn; echo "y` really did
        # create the file. Now it only ever reaches $OUTPUT_BINDING_ID.
        rendered = _render(
            {
                "custom_code_config": {
                    "start_command": "echo hi",
                    "output_binding_id": self.QUOTE_BREAKING_ID,
                }
            }
        )
        assert self.QUOTE_BREAKING_ID not in rendered
        assert "touch /tmp/gb-autotunex-pwned" not in rendered
        assert _b64(self.QUOTE_BREAKING_ID) in rendered
        assert (
            'echo "LLMB_ARTIFACT_ID:$OUTPUT_BINDING_ID LLMB_ARTIFACT_PATH:$OUTPUT_PATH"'
            in rendered
        )

    @pytest.mark.skipif(BASH is None, reason="bash not available on PATH")
    def test_injected_values_still_parse(self, tmp_path):
        script = tmp_path / "injected.sh"
        script.write_text(
            _render(
                {
                    "custom_code_config": {
                        "start_command": "echo hi",
                        "github_url": self.QUOTED_URL,
                        "dir_to_save": self.DANGEROUS_DIR,
                        "output_binding_id": self.QUOTE_BREAKING_ID,
                    },
                    "k8s": {"additional_files": {self.QUOTED_FNAME: "a: 1"}},
                }
            )
        )
        proc = subprocess.run(
            [BASH, "-n", str(script)], capture_output=True, text=True, check=False
        )
        assert proc.returncode == 0, proc.stderr

    @pytest.mark.skipif(BASH is None, reason="bash not available on PATH")
    @pytest.mark.parametrize(
        "raw",
        [
            DANGEROUS_DIR,
            QUOTED_FNAME,
            QUOTED_URL,
            QUOTE_BREAKING_ID,
            "trailing\nnewline",
            "a\\'b",
        ],
    )
    def test_b64_decode_idiom_recovers_the_value_exactly(self, raw):
        # The decode side of the contract: whatever went in comes back out byte
        # for byte, and the encoded form is inert inside single quotes.
        proc = subprocess.run(
            [BASH, "-c", f"printf '%s' '{_b64(raw)}' | base64 -d"],
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout == raw


class TestOutputArtifactGating:
    """The marker must not fire on failure.

    buildrun.py pushes a registered artifact with no status check, and the real
    AutoTuneX target publishes to hf://huggingface.co/ibm-research/autotunex_<id>/
    — a shared org namespace.
    """

    GUARD = 'if [ "$RC" -eq 0 ]; then'

    def _lines(self) -> list[str]:
        return _render(MINIMAL).splitlines()

    def test_marker_is_inside_the_rc_zero_guard(self):
        lines = self._lines()
        guard = lines.index(self.GUARD)
        els = lines.index("else", guard)
        # Match the echo itself, not a comment that merely names the marker.
        marker = next(
            i for i, ln in enumerate(lines) if ln.strip().startswith('echo "LLMB_')
        )
        assert guard < marker < els

    def test_binding_id_decode_is_inside_the_guard(self):
        # Deliberate placement: the decode does no work on the failure path.
        lines = self._lines()
        guard = lines.index(self.GUARD)
        els = lines.index("else", guard)
        decode = next(
            i
            for i, ln in enumerate(lines)
            if ln.strip().startswith("OUTPUT_BINDING_ID=")
        )
        marker = next(
            i for i, ln in enumerate(lines) if ln.strip().startswith('echo "LLMB_')
        )
        assert guard < decode < marker < els

    def test_failure_branch_says_it_is_not_registering(self):
        rendered = _render(MINIMAL)
        assert 'echo "autotunex: start_command failed ($RC)' in rendered
        assert "not registering an output artifact" in rendered

    def test_empty_dir_warning_stays_on_the_success_path(self):
        lines = self._lines()
        guard = lines.index(self.GUARD)
        els = lines.index("else", guard)
        warn = next(i for i, ln in enumerate(lines) if "is empty — registering" in ln)
        assert guard < warn < els

    def test_exit_rc_is_last_and_unconditional(self):
        lines = [ln for ln in self._lines() if ln.strip()]
        assert lines[-1] == "exit $RC"


class TestInputPathBridge:
    """I4: input_artifact_path is the documented binding, so it wins."""

    IAP = {"input_artifact_path": {"binding": {"path": "/data/iap"}}}
    DSF = {"dataset_files": {"binding": {"path": "/data/dsf"}}}

    def test_input_artifact_path_is_used(self):
        rendered = _render(MINIMAL, bindings=self.IAP)
        assert _b64("/data/iap") in rendered
        assert "source: bindings.input_artifact_path" in rendered

    def test_dataset_files_is_the_fallback(self):
        rendered = _render(MINIMAL, bindings=self.DSF)
        assert _b64("/data/dsf") in rendered
        assert "source: bindings.dataset_files" in rendered

    def test_input_artifact_path_wins_over_dataset_files(self):
        rendered = _render(MINIMAL, bindings={**self.IAP, **self.DSF})
        assert _b64("/data/iap") in rendered
        assert _b64("/data/dsf") not in rendered
        assert "source: bindings.input_artifact_path" in rendered
        assert rendered.count("export INPUT_PATH=") == 1

    def test_nothing_exported_when_neither_is_bound(self):
        assert "INPUT_PATH" not in _render(MINIMAL, bindings={})

    def test_incomplete_binding_shape_exports_nothing(self):
        # Present but with no .binding.path: must not render a broken export, and
        # must not trip strict=True either.
        assert "INPUT_PATH" not in _render(
            MINIMAL, bindings={"input_artifact_path": {}}
        )
        assert "INPUT_PATH" not in _render(
            MINIMAL, bindings={"dataset_files": {"binding": {}}}
        )


class TestWhitespaceOnlyStartCommand:
    """M2: `sh -c "   "` exits 0 having run nothing — worse than failing."""

    def test_whitespace_only_start_command_fails_fast(self):
        rendered = _render({"custom_code_config": {"start_command": "  \t \n "}})
        assert "start_command is empty" in rendered
        assert "exit 2" in rendered
        assert "START_CMD=" not in rendered
        assert "LLMB_ARTIFACT_ID:" not in rendered

    def test_null_start_command_fails_fast(self):
        # `start_command:` with no value in YAML parses to None.
        rendered = _render({"custom_code_config": {"start_command": None}})
        assert "start_command is empty" in rendered
        assert "START_CMD=" not in rendered

    def test_start_command_is_trimmed_before_encoding(self):
        rendered = _render({"custom_code_config": {"start_command": "  echo hi  "}})
        assert _b64("echo hi") in rendered
