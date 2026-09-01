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

## OPEN: a successful build produces an EMPTY model artifact

This is why docker is deferred. Verified in a single run:

```
step emitted (marker):  /gb-workspace/output
push rsync source:      .../workspace/tmp…/builds/<b>/targetruns/<t>/output
push rsync dest:        /var/folders/…/autotune-out-…/<b>-out/     → created, 0B
```

The marker's **path is not used as the push source**. The step writes the tuned model
to `/gb-workspace/output`, but the push reads the target-run's own `output/` dir, which
the step never writes to. rsync copies an empty source, returns 0, and the artifact
registers `success` at a directory that is empty. The build reports SUCCESS.

Same failure class as the column-0 marker bug fixed on the bash branch — build looks
green, deliverable is missing — but one layer deeper.

**Not yet attributed.** Two readings with opposite fixes:

1. *Step*: `step-template.yaml` hardcodes `LLMB_BASH_OUTPUT_DIR: /gb-workspace/output`.
   If gbserver expects a step to write into a dir it provides, hardcoding is wrong.
2. *gbserver*: the marker path should drive the push source, and
   `Docker.pushasset_filestore`'s `/gb-workspace` translation (docker.py:781-792)
   exists for exactly this but is not reached — `source_path` is already a host path
   when it arrives.

A bash run showed an empty artifact too, and there `LLMB_BASH_OUTPUT_DIR` is set *by*
gbserver, which weakly favours (2). Not confident enough to assert it; needs whoever
owns the artifact-push contract.

### The test currently passes anyway — do not trust it yet

`buildtest.yaml`'s `output_artifact_count: 1` is satisfied by **registration alone**,
so `make test` is green while the artifact is empty. Before this ships, the fixture
needs an assertion that the pushed directory is non-empty; both the bash and docker
tests should then go red, correctly, until the above is resolved.
