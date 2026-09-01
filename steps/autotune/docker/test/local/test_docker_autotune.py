#!/usr/bin/env python3

# Copyright LLM.build Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Integration test: the autotune step runs end to end on the Docker environment.

Covers what the bash build test cannot, since `command.sh` / `run.py` are shared
byte-for-byte and only `step.yaml` differs:

  * the step asset dir bind-mounted at ``/gb-workspace`` and an output written there
  * the container -> host artifact path translation on push
    (``Docker._resolve_host_path`` / ``pushasset_filestore``)
  * that run.py's ``GB_ARTIFACT_ID`` marker is scraped by the *docker* monitor
  * that ``config.docker.env`` actually reaches the container -- ``BACKEND`` is set
    from the build here, which only works because it was removed from the launcher
    env (launcher env WINS over ``config.docker.env``)

Needs a local fm-tune runtime image, which this repo does not publish -- see the
build commands in ``test-data/local/build.yaml`` and the ``Dockerfile`` beside it.
Auto-skips (rather than failing) when the image or a reachable Docker/Podman socket
is absent, so a plain checkout is unaffected. Extended suite only.

Podman: export DOCKER_HOST to its socket first; gbserver honours it
(see src/gbserver/environment/docker.py).
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
import yaml
from libgbtest.buildrunner.buildtest import (
    AbstractYamlBuildRunnerTest,
    get_test_data_dir_for,
)
from libgbtest.constants import extended_testing_only

IMAGE = "localhost/fm-tune-runtime:verify-data"


def _image_present() -> bool:
    """True when IMAGE exists locally (podman or docker)."""
    for tool in ("podman", "docker"):
        exe = shutil.which(tool)
        if not exe:
            continue
        try:
            out = subprocess.run(
                [exe, "images", "--format", "{{.Repository}}:{{.Tag}}"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if out.returncode == 0 and IMAGE in out.stdout:
            return True
    return False


@extended_testing_only
@pytest.mark.docker_required
@pytest.mark.skipif(
    not _image_present(),
    reason=(
        f"{IMAGE} not built locally; see test-data/local/build.yaml for the "
        "podman build commands"
    ),
)
class TestDockerAutotune(AbstractYamlBuildRunnerTest):
    """autotune trains once in a container and registers its output."""

    def _out_dir(self) -> Path:
        """Absolute, durable output dir for this run.

        The build's `outputs.custom.uri` MUST be absolute: gbserver resolves a
        relative file: URI against its own CWD, which for the harness is an
        ephemeral workspace that is torn down after the run -- so the pushed
        artifact would disappear and the recorded URI would point at nothing.
        Kept after the run so the tuned model can be inspected.
        """
        d = Path(tempfile.mkdtemp(prefix="autotune-out-"))
        return d

    def _get_yaml_spec_dir(self) -> Path:
        """Copy the fixture to a temp spec dir with an absolute ``space_uri``.

        Unlike the bash fixture this needs no path substitution -- the model and
        dataset are hf:// (the only inputs the docker environment bind-mounts) and
        the jsonl files are baked into the image -- but ``space_uri`` is resolved
        relative to the spec dir, so it must be absolutised when the dir moves.
        """
        fixture = get_test_data_dir_for(__file__)
        spec = Path(tempfile.mkdtemp(prefix="autotune-docker-buildtest-"))
        build = (fixture / "build.yaml").read_text()
        build = build.replace("@OUTPUT_DIR@", str(self._out_dir()))
        (spec / "build.yaml").write_text(build)

        bt = yaml.safe_load((fixture / "buildtest.yaml").read_text())
        raw = str(bt.get("space_uri", "../../space")).removeprefix("file://")
        if not Path(raw).is_absolute():
            raw = str((fixture / raw).resolve())
        bt["space_uri"] = f"file://{raw}"
        (spec / "buildtest.yaml").write_text(yaml.safe_dump(bt, sort_keys=False))
        return spec
