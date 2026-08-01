# Copyright LLM.build Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""Plumbing test for the autotunex bash step.

The fixture's build.yaml and buildtest.yaml live in the directory returned by
_get_yaml_spec_dir below. Unlike the 1step fixture this needs no HF token and no
network, so it runs in the fast suite rather than the extended one.
"""

from pathlib import Path

import pytest
from libgbtest.buildrunner.buildtest import (
    AbstractYamlBuildRunnerTest,
    get_test_data_dir_for,
)

pytestmark = pytest.mark.standalone


@pytest.mark.xdist_group(name="buildtest_local")
class TestBuildRunnerAutotunex(AbstractYamlBuildRunnerTest):
    """AutoTuneX-shaped config (custom_code_config + k8s.additional_files) on Bash."""

    def _get_yaml_spec_dir(self) -> Path:
        return get_test_data_dir_for(__file__) / "autotunex"
