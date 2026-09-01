# autotune / docker — deferred, with an open artifact-delivery question

This branch parks the docker variant of the autotune step. It is **not** part of
PR #340, which ships the bash variant only. Everything here runs; the reason it is
deferred is the open question in the last section.

## What was verified end to end

Against a locally built fm-tune runtime image on podman (arm64), the docker step
completed a real build:

- fm-tune ran in-container to `Done (exit code 0)`
- `run.py` emitted `GB_ARTIFACT_ID:custom` and the **docker** monitor scraped it
- the build reached `Status.SUCCESS` and registered the artifact as
  `type=ArtifactType.MODEL, status=success`
- `config.docker.env` reached the container — the fixture sets `BACKEND` there,
  which only works because it was removed from the launcher env (launcher env WINS
  over `config.docker.env`; `Docker.get_launch_env_vars`, docker.py:416-420)
- `/gb-workspace` bind-mount write-back works (verified directly with podman)

Reproduce:

```sh
# 1. image (context is the vendored fm-tune)
podman build --platform linux/arm64 -f steps/autotune/docker/test-data/local/Dockerfile \
  -t localhost/fm-tune-runtime:verify autotunex/src/fm-tune
podman build --platform linux/arm64 -t localhost/fm-tune-runtime:verify-data \
  steps/autotune/docker/test-data/local   # adds /opt/data/*.jsonl

# 2. the docker SDK is in the `thirdparty` extra, NOT `standalone`.
#    Without it the build fails with a bare "No module named 'docker'".
.venv/bin/pip install "docker>=7.0.0"

# 3. point gbserver at podman (it honours DOCKER_HOST; see docker.py:8-9)
export DOCKER_HOST="unix://$(podman machine inspect \
  --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

GB_ENVIRONMENT=STANDALONE make -C steps/autotune/docker test
```

## Docker-specific constraints worth keeping

- **Inputs must be `hf://`.** `docker.py` implements only `_load_hfstore` for inputs
  (plus `pushasset_filestore` for outputs). There is no `file://` input loader, no
  base-class fallback, and no user-declarable extra volumes — so a local `file:`
  dataset cannot be mounted. On bash it works fine, so the asymmetry surprises people.
  The test fixture works around it by baking the jsonl files into the image and using
  `run.py`'s absolute `TRAIN_FILE`/`VAL_FILE` overrides.
- **The image must come from the build** (`config.docker.image`).
  `Docker._resolve_image` (docker.py:181-183) prefers `launcher_config.image`, so an
  image pinned in `step.yaml` could never be overridden. `step-template.yaml`
  therefore pins none, and there is no environment-level default.
- **No `Dockerfile` at the step root.** `steps/common.mk:79` sets
  `STEP_USES_IMAGE := $(if $(wildcard Dockerfile),true,false)`, and once true,
  `REGISTRY` becomes mandatory (common.mk:94-97) — even `make help` errors. The
  verification Dockerfile therefore lives under `test-data/local/`, which does not
  trip that glob.

## RETRACTED: the "empty artifact" issue was a test-harness artifact

An earlier revision of this file claimed that a successful build registers an EMPTY
model artifact, and that the marker's path is not used as the push source. **That was
wrong.** Every observation came from the in-process build-test harness, where the push
reads `<ephemeral workspace>/builds/<b>/targetruns/<t>/output` -- a path the harness
tears down with the run -- so pushed files are not observable from the test.

A real gbserver build (`c989904e-fdc9-4c23-9d2e-060377eab670`, bash environment)
delivers correctly: the marker points at
`~/.granite.build/workdir/llm-build-<id>/.../launch-<id>/outputs`, and the push copied
~85MB to the declared absolute `file:` URI -- `models/`,
`mlx_adapters/*/adapters.safetensors`, `final_checkpoints/`, `ray_results/`.

So docker is **not** blocked by an artifact bug. What remains genuinely unverified for
docker specifically is the container -> host translation on push
(`Docker._resolve_host_path`, docker.py:781-792), which the harness runs did not
exercise end to end. Check that with a real gbserver build against a container image
before shipping the docker variant.

Note on the build test: `output_artifact_count` is satisfied by registration, and under
the harness delivery is not observable -- so do NOT add a non-empty assertion to it. It
would be permanently red for a non-issue. Use gbserver to verify delivery.
