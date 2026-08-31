# Per-Step Training Metrics Persistence — Design

**Date:** 2026-08-26
**Status:** Approved (design)
**Repos:** `fm-tune` (this repo, vendored as a subtree in AutotuneX) + `AutoTuneX`

## 1. Goal

Capture the per-step training metrics that HuggingFace Trainer / TRL emit during
tuning — e.g.

```python
{"loss": 15.3477, "grad_norm": 2.8529586791992188, "learning_rate": 6.521739130434783e-07, "epoch": 0.04}
```

— and persist them, in **structured, queryable form**, into the AutotuneX
database so they can be used for analytics and graphing (training curves,
cross-trial comparison). Today this data is printed to stdout and — in `local`
mode — lands in the DB only as free-text `log_entries` rows.

**In scope:** structured storage + a read-back API, working in **both** AutotuneX
execution backends (`local` and `llmb`).
**Out of scope (v1):** any UI chart; verl (PPO/GRPO) and MLX metric paths.

## 2. Current state (what already exists)

AutotuneX selects an execution backend via `AUTOTUNEX_JOB_BACKEND`
(`src/autotunex/core/config.py:418`), with **two** relevant to us. They are
architecturally different, which is the crux of this design:

### `local` backend (the OSS/standalone default)

- Runs fm-tune **in-process** — imports `autotune.*` inside
  `AutotuneLocalTrainer.run` (`src/autotunex/services/local/trainer.py`). **No
  subprocess, no api-bridge, no HTTP, `AUTOTUNEX_SERVER_URL` never set.** fm-tune's
  `BufferedLogHandler` / HTTP bridge is never constructed.
- HPO trials still run as **Ray Tune trial workers** (separate processes); the
  Tune driver runs inside the trainer thread.
- Data reaches the DB via AutotuneX's own sink, `DbTrialSink`
  (`src/autotunex/services/local/sink.py`), bridging worker-thread calls to async
  SQLAlchemy repositories on the app's event loop:
  - **Trials/results** — a Ray Tune callback `_SinkCallback` (`trainer.py:117`):
    `on_trial_start` → `sink.trial_started` → `SqlAlchemyTrialRepository.upsert`
    (**trials**); `on_trial_result` (fired by `tune.report()`) →
    `sink.trial_result` → `SqlAlchemyResultRepository.upsert` (**results**,
    one-to-one, overwritten each report — objective metric, not a time series).
  - **Logs** — `_SinkStream` (`trainer.py:438`) replaces `sys.stdout`/`stderr`;
    Ray forwards every trial worker's stdout to the driver, so each printed line
    is captured → `sink.log` → **log_entries**, tagged with the running trial via
    `_TrialContext`. `iteration`/`epoch` are left `None` (`sink.py:271-282`).
- **Consequence we exploit:** HF Trainer *prints* the per-step metrics dict, so in
  `local` mode `_SinkStream` **already captures it into `log_entries` as free
  text**. The data already arrives; only *structure* is missing.

### `llmb` backend (remote)

- Runs fm-tune as a **subprocess** (`python main.py --job_id … --autotunex_server_url …`).
- fm-tune POSTs typed records over HTTP to the separate `api-bridge` FastAPI
  service, which writes to the **same DB** the main service reads:
  `fm-tune ──HTTP──▶ api-bridge ──▶ shared DB ──▶ main service`.
- Transport: `autotune/callbacks/logging_service.py::BufferedLogHandler`.
  `record_data(data, record_type: RecordType)` POSTs JSON to
  `{endpoint_url}/{record_type.value}` (immediate, with retry) — already used by
  `CustomLoggerCallback` for trials/results/status. `RecordType` currently:
  `RECORD_TRIAL`, `UPDATE_STATUS`, `RECORD_RESULT`. Workers rebuild their own
  handler from env `AUTOTUNE_JOB_ID` / `AUTOTUNE_ENDPOINT_URL`.

### Shared identity & schema

- `jobs.id` (Uuid36, the experiment/run) → `trials.id` (String(16), one HPO trial
  / training run) → `global_step`/`epoch` (ordinal).
- AutotuneX DB: SQLAlchemy 2.0 async ORM (`src/autotunex/db/`), parallel sync
  Core layer in `src/api-bridge/`, Alembic at repo root. SQLite dev/test, MySQL
  prod (baseline `alembic stamp`ed; later revisions run).
- No structured per-step time-series table exists in either backend.
  `PerEpochTuneReportCallback` is the wrong vehicle (gated to top-rung HPO trials,
  only in single-GPU drivers, hooks `on_evaluate` not `on_log`).

## 3. Chosen approach

**Approach A — one dedicated `training_metrics` time-series table**, written by a
new fm-tune `on_log` callback that emits a **single structured row per log
event** and routes it to the DB through the channel each backend already owns:

- **`local`:** the callback **prints one marked JSON line**
  (`@@FMTUNE_METRIC@@ {json}`). AutotuneX's `_SinkStream` detects the marker,
  parses it, and routes it to a **new** `sink.training_metric()` →
  `SqlAlchemyTrainingMetricsRepository.insert` → `training_metrics` table
  (unmarked lines still go to `log_entries`). Live per-step, reuses the exact rail
  that already carries these prints, **no Ray-scheduler involvement**.
- **`llmb`:** the callback POSTs the same row via
  `BufferedLogHandler.record_data(row, RecordType.RECORD_METRICS)` → new
  `POST /fmtune/api/record_metrics` bridge endpoint → same `training_metrics`
  table.

Rejected: routing per-step data through `tune.report()`/`_SinkCallback` (the
result rail) — per-step reports risk the ASHA scheduler and pollute the objective
result stream, and behave differently across backends. Reusing `log_entries` with
added numeric columns — conflates logs with numeric time-series. Extending
`results.metrics` JSON — not queryable, one-to-one with a trial.

## 4. Architecture

```
[fm-tune, this repo]  TrainingMetricsCallback.on_log(logs, state)
      └─ build row {job_id, trial_id, global_step, epoch, loss, grad_norm, learning_rate, split, extra}
             │
   endpoint set? ──yes(llmb)──▶ record_data(row, RECORD_METRICS) ─HTTP─▶ api-bridge
             │                                                    POST /fmtune/api/record_metrics
             └──no(local)──▶ print "@@FMTUNE_METRIC@@ {json}"          │
                                     │ (Ray forwards worker stdout)     │
                                     ▼                                  ▼
                        _SinkStream detects marker           insert_metrics(...)
                          → sink.training_metric(row)                   │
                                     │                                  │
                                     ▼                                  ▼
                        SqlAlchemyTrainingMetricsRepository.insert ─▶ training_metrics table
                                                                        │
                              main service: GET /{job_id}/trials/{trial_id}/metrics  ◀────┘
                                            GET /{job_id}/metrics
```

## 5. Component design

### 5.1 fm-tune emitter (this repo)

**New file `autotune/callbacks/training_metrics.py`:**

- `TrainingMetricsCallback(transformers.TrainerCallback)` overriding
  `on_log(self, args, state, control, logs=None, **kwargs)`.
- Behavior in `on_log`:
  - Return immediately if `logs` is falsy, or if not the main process
    (`state.is_world_process_zero` False). Never raise into the training loop —
    wrap the body so a transport error is swallowed.
  - Build one row:
    ```python
    {
      "job_id": os.environ.get("AUTOTUNE_JOB_ID"),
      "trial_id": <tune.get_context().get_trial_id() / worker train_loop_config["trial_id"]>,  # may be None for final run
      "global_step": int(state.global_step),
      "epoch": float(state.epoch) if state.epoch is not None else None,
      "loss": logs.get("loss"),
      "grad_norm": logs.get("grad_norm"),
      "learning_rate": logs.get("learning_rate"),
      "split": "eval" if "eval_loss" in logs else "train",
      "extra": {k: v for k, v in logs.items() if k not in {"loss","grad_norm","learning_rate","epoch"}},
      "timestamp": <UTC ISO8601>,
    }
    ```
  - **Route by backend, detected via env:**
    - `AUTOTUNE_ENDPOINT_URL` set (llmb) → construct a `BufferedLogHandler` from
      env (no `flush_interval`, so no timer) and
      `record_data(row, RecordType.RECORD_METRICS)`.
    - else (local / standalone) → `print("@@FMTUNE_METRIC@@ " + json.dumps(row), flush=True)`.
  - The marker constant lives in one place in fm-tune (e.g. a module-level
    `METRIC_MARKER = "@@FMTUNE_METRIC@@"`) and is mirrored by an AutotuneX-side
    constant (documented as a shared contract; if it ever changes, both sides
    change together).

**New enum member** in `autotune/callbacks/logging_service.py`:
`RecordType.RECORD_METRICS = "record_metrics"`.

**Add the callback unconditionally** (ignore the top-rung gate) at every HF/TRL
trainer-construction site, so all trials + final training emit:

| Driver | Where to add | Context |
|---|---|---|
| `autotune/trainers/driver_single.py` | after `Trainer(...)` (~L406), near L416 | top-level process |
| `autotune/trainers/driver_single_trl.py` | after `DPOTrainer`/`KTOTrainer` (~L426/441), near L454 | top-level process |
| `autotune/trainers/driver_multi_hf_ds.py` | inside `train_loop_per_worker`, near L830–853 | Ray worker — `is_world_process_zero` guard |
| `autotune/trainers/driver_multi_hf_fsdp.py` | inside `train_loop_per_worker`, near L762–768 | Ray worker — guard |
| `autotune/trainers/driver_multi_trl_ds.py` | inside `train_loop_per_worker`, near L609–629 | Ray worker — guard |
| `autotune/trainers/driver_multi_trl_fsdp.py` | inside `train_loop_per_worker`, near L545–549 | Ray worker — guard |

**Out of scope for v1 (follow-ups):** verl `_InMemoryMetricsLogger`
(`driver_multi_verl.py`) and MLX (`autotune/mlx_backend.py`). Their differing keys
(reward/kl) are accommodated by the nullable columns + `extra` JSON.

### 5.2 AutotuneX `local` ingest (marker route)

**Repo:** AutotuneX, `src/autotunex/`.

- **Protocol:** add `training_metric(self, metric: TrainingMetricRecord) -> None`
  to `TrialSink` (`services/local/protocols.py`); add a `TrainingMetricRecord`
  domain dataclass there (mirrors the row shape).
- **Sink:** implement `DbTrialSink.training_metric` (`services/local/sink.py`) —
  same worker-thread → `run_coroutine_threadsafe` → async repo pattern as
  `trial_result`/`log`. Coerce `trial_id` via the existing `coerce_trial_id`.
- **Marker routing:** in `_SinkStream._forward` (`trainer.py`), detect the marker
  **as a substring** (Ray prefixes forwarded worker lines, e.g. `(func pid=…)`):
  - On match → parse the JSON after the marker → `sink.training_metric(record)`;
    do **not** also write it to `log_entries`.
  - **Prefer the `trial_id` from the payload** over `_TrialContext` (the payload
    is exact; `_TrialContext` can mis-tag under parallel trials).
  - On JSON parse failure → fall back to `sink.log` (treat as an ordinary line),
    so data is never silently dropped.
  - Marker lines still pass through to the real console (acceptable noise);
    optionally suppress the passthrough for matched lines.
- **Repository:** `SqlAlchemyTrainingMetricsRepository.insert(...)` (append, not
  upsert) in `db/repositories/sqlalchemy.py` + its Protocol in
  `db/repositories/protocols.py`.

### 5.3 AutotuneX `llmb` ingest (HTTP route)

**Repo:** AutotuneX, `src/api-bridge/`.

- **Route:** `POST /fmtune/api/record_metrics` in `src/api_bridge/server.py`,
  behind the existing write-token dependency.
- **Model:** Pydantic `TrainingMetric` in `model.py` matching the row shape;
  accept a single object or a list (align with `record_logs`).
- **Table:** SQLAlchemy Core `training_metrics` `Table(...)` in `tables.py`.
- **DB write:** `insert_metrics(...)` in `database.py` (batch insert), following
  `insert_logs`. Writes the **same** `training_metrics` table as the local path.

### 5.4 Storage schema (AutotuneX repo, `src/autotunex/db/` + Alembic)

**New table `training_metrics`** (one table, written by both backends):

| Column | Type | Notes |
|---|---|---|
| `id` | Integer, autoinc PK | matches `log_entries` PK style |
| `job_id` | String(36), FK → `jobs.id` | the experiment/run |
| `trial_id` | String(16), indexed, **no hard FK** | soft reference (final run may have no `trials` row); mirrors `log_entries.trial_id` |
| `global_step` | Integer | per-run ordinal |
| `epoch` | Float, nullable | |
| `loss` | Float, nullable | train loss |
| `grad_norm` | Float, nullable | |
| `learning_rate` | Float, nullable | |
| `split` | String(16) | `"train"` / `"eval"` |
| `extra` | JSON, nullable | unmapped keys (eval_loss, reward/kl later) |
| `timestamp` | UtcDateTime | emit time (UTC) |

- Index on `(job_id, trial_id, global_step)`.
- **ORM class** `src/autotunex/db/tables/training_metrics.py`, registered in
  `tables/__init__.py` (uses existing `Uuid36`/`UtcDateTime` types).
- **Alembic revision** adding the table (additive; safe over the stamped MySQL
  baseline). Must also appear in the api-bridge Core `tables.py`.

### 5.5 Read-back API (AutotuneX repo, `src/autotunex/`)

- **Repository read** method on `SqlAlchemyTrainingMetricsRepository` returning
  rows ordered by `global_step`, filterable by `job_id` + optional `trial_id` /
  `split`.
- **Routes** in `api/routers/jobs.py`:
  - `GET /{job_id}/trials/{trial_id}/metrics`
  - `GET /{job_id}/metrics` (all trials, for cross-trial overlay)
- **Response model** in `src/autotunex/models/`.

## 6. Cross-repo workflow

- fm-tune changes (§5.1) are implemented **here in `fm-tune_forked`** and reach
  AutotuneX via subtree pull into `src/fm-tune/`:
  ```bash
  git subtree pull --prefix=src/fm-tune fm-tune oss-main --squash
  ```
  (remote `fm-tune`, branch `oss-main`; manual/on-demand, no Makefile wrapper.)
  Gotchas: **do not** ruff/format the vendored tree (creates a permanent diff and
  future-pull conflicts) and **do not** amend/squash the subtree commit.
- AutotuneX changes (§5.2–5.5) are implemented **directly in the AutotuneX repo,
  in a dedicated git worktree of that repo** (created via `git -C <autotunex>
  worktree add …` — the `EnterWorktree` tool only operates on the current repo).
- The implementation plan is split into a **fm-tune part** (built and testable
  here first) and an **AutotuneX part**. The fm-tune emitter is safe to land
  first: in `local` it just prints a marked line (ignored until the AutotuneX
  parser exists — it currently falls into `log_entries` as text), and in `llmb`
  `record_data` swallows a 404 from the not-yet-added endpoint.

## 7. Error handling & resilience

- The emitter is best-effort and must **never raise into the training loop**:
  `record_data` already swallows HTTP failures; the `print` path is wrapped too.
- Local marker parsing falls back to `log_entries` on malformed JSON.
- `is_world_process_zero` guard prevents duplicate rows from multi-GPU workers.
- Ingest endpoint validates payload and honors the existing write-token.

## 8. Testing

**fm-tune (here):**
- `TrainingMetricsCallback.on_log`: given a sample `logs` + fake `state`,
  asserts (a) with `AUTOTUNE_ENDPOINT_URL` set → correct row to a stubbed
  `record_data` with `RECORD_METRICS`; (b) unset → a single
  `@@FMTUNE_METRIC@@ {json}` line to stdout with the correct row; (c) no-op when
  `is_world_process_zero` is False.
- `RecordType.RECORD_METRICS` value test.

**AutotuneX:**
- `local`: feed a marked line through `_SinkStream` → asserts a `training_metrics`
  row is written and the line is **not** in `log_entries`; malformed marker →
  falls back to `log_entries`. Round-trip via `SqlAlchemyTrainingMetricsRepository`
  (SQLite).
- `llmb`: `POST /fmtune/api/record_metrics` inserts rows (SQLite).
- Read route returns rows ordered by `global_step`.
- Alembic migration up/down on SQLite.

## 9. Open questions / risks

- **Final-training trial identity:** confirm what `trial_id` (if any) the final
  `fit_best_config` run carries; the soft-reference column tolerates a sentinel /
  `None`, and the local path relies on the payload's `trial_id`.
- **Marker contract:** the `@@FMTUNE_METRIC@@` string is a shared contract across
  the subtree boundary — changing it requires touching both repos. Document it.
- **Volume:** immediate emit per log event is fine at `logging_steps ≈ 10/epoch`;
  revisit batching only if that is lowered or sweeps grow large.

## 10. Out of scope

- UI training-curve chart (Carbon Charts) — deferred.
- verl and MLX metric emission — deferred; schema accommodates them.
- Backfilling historical runs.
