# Per-Step Training Metrics Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist HF Trainer's per-step metrics (`loss`, `grad_norm`, `learning_rate`, `epoch`) from every fm-tune training run into a structured `training_metrics` table in AutotuneX, queryable via a read API, in both the `local` and `llmb` backends.

**Architecture:** A new fm-tune `TrainerCallback.on_log` builds one row per log event and routes it by backend: `local` → prints a marked JSON line that AutotuneX's `_SinkStream` parses into a new `sink.training_metric()`; `llmb` → POSTs the row to a new `/fmtune/api/record_metrics` api-bridge endpoint. Both writers land in one `training_metrics` table read back by a jobs-router endpoint.

**Tech Stack:** Python 3, HuggingFace `transformers` TrainerCallback, Ray Tune; AutotuneX = FastAPI + SQLAlchemy 2.0 async ORM (main service) + SQLAlchemy Core (api-bridge) + Alembic; SQLite (dev/test) / MySQL (prod).

## Global Constraints

- **Paths.** `$AUTOTUNEX_REPO` below stands for your local AutoTuneX checkout — an
  absolute developer path here would trip AutoTuneX's OSS compliance scan once this
  tree is vendored into `src/fm-tune/`.
- **Two repos.** Phase A edits **this repo** (`fm-tune_forked`, package root `autotune/`). Phase B edits the **AutotuneX repo** at `$AUTOTUNEX_REPO`, in a dedicated git worktree.
- **Shared marker contract:** the string `@@FMTUNE_METRIC@@` is emitted by fm-tune and parsed by AutotuneX. It is a cross-repo contract — if it ever changes, both repos change together. Define it as a named constant on each side.
- **Row contract (JSON):** `{"job_id": str|None, "trial_id": str|None, "global_step": int, "epoch": float|None, "loss": float|None, "grad_norm": float|None, "learning_rate": float|None, "split": "train"|"eval", "extra": dict}`.
- **The emitter must never raise into the training loop.** Wrap the whole `on_log` body in `try/except` that swallows.
- **Multi-GPU dedupe:** emit only when `state.is_world_process_zero` is True.
- **Do NOT ruff/black-format the vendored `src/fm-tune/` tree inside AutotuneX** — it creates a permanent diff and breaks subtree pulls. fm-tune changes are made in this repo and pulled via `git subtree pull --prefix=src/fm-tune fm-tune oss-main --squash`.
- **fm-tune lint:** `ruff check .` (E, F, W, I). Style: `from __future__ import annotations` where the file already uses it; match surrounding files.
- **AutotuneX house style:** `from __future__ import annotations`; ORM uses `Mapped`/`mapped_column`; all Alembic schema changes on existing tables go through `op.batch_alter_table` (SQLite portability), but `op.create_table` for new tables is fine; repositories take `session: AsyncSession` in `__init__` and own their transactions (`await self._session.commit()`); services depend on repository Protocols, not concrete classes.

---

## File Structure

**Phase A — fm-tune (this repo):**
- Create: `autotune/callbacks/training_metrics.py` — the `TrainingMetricsCallback` + `METRIC_MARKER`.
- Modify: `autotune/callbacks/logging_service.py` — add `RecordType.RECORD_METRICS`.
- Modify: `autotune/trainers/driver_single.py`, `driver_single_trl.py` — add callback (top-level).
- Modify: `autotune/trainers/driver_multi_hf_ds.py`, `driver_multi_hf_fsdp.py`, `driver_multi_trl_ds.py`, `driver_multi_trl_fsdp.py` — add callback inside `train_loop_per_worker`.
- Test: `tests/test_training_metrics_callback.py`.

**Phase B — AutotuneX (worktree):**
- Create: `src/autotunex/db/tables/training_metrics.py` — ORM table.
- Modify: `src/autotunex/db/tables/__init__.py` — register table.
- Create: `alembic/versions/<rev>_add_training_metrics.py` — migration.
- Modify: `src/autotunex/db/repositories/protocols.py`, `sqlalchemy.py` — `TrainingMetricsRepository`.
- Create: `src/autotunex/models/metric.py` — `MetricPointRead`, `MetricPage`.
- Modify: `src/autotunex/services/local/protocols.py` — `TrainingMetricRecord` + `TrialSink.training_metric`.
- Modify: `src/autotunex/services/local/sink.py` — `DbTrialSink.training_metric`.
- Modify: `src/autotunex/services/local/trainer.py` — `_SinkStream` marker routing + `FMTUNE_METRIC_MARKER`.
- Create: `src/autotunex/services/metrics.py` — `MetricsService`.
- Modify: `src/autotunex/api/deps.py` — `MetricsServiceDep`.
- Modify: `src/autotunex/api/routers/jobs.py` — two read routes.
- Modify (api-bridge): `src/api-bridge/src/api_bridge/model.py`, `tables.py`, `database.py`, `log_service.py`, `server.py`.
- Tests: extend `tests/api/routers/test_jobs.py`, add sink/trainer tests, add `src/api-bridge/tests` cases.

---

# PHASE A — fm-tune (this repo)

## Task A1: RecordType + TrainingMetricsCallback

**Files:**
- Modify: `autotune/callbacks/logging_service.py:20-25` (the `RecordType` enum)
- Create: `autotune/callbacks/training_metrics.py`
- Test: `tests/test_training_metrics_callback.py`

**Interfaces:**
- Consumes: `BufferedLogHandler` and `RecordType` from `autotune.callbacks.logging_service`.
- Produces:
  - `RecordType.RECORD_METRICS` (value `"record_metrics"`).
  - `METRIC_MARKER = "@@FMTUNE_METRIC@@"`.
  - `TrainingMetricsCallback(trial_id: str | None = None)` — a `transformers.TrainerCallback` whose `on_log(args, state, control, logs=None, **kwargs)` emits one row (POST if `AUTOTUNE_ENDPOINT_URL` set, else printed marker line).
  - `TrainingMetricsCallback._build_row(logs: dict, state) -> dict` returning the row contract.

- [ ] **Step 1: Add the enum member.** In `autotune/callbacks/logging_service.py`, extend `RecordType`:

```python
class RecordType(Enum):
    """Enumeration for record type"""

    RECORD_TRIAL = "record_trial"
    UPDATE_STATUS = "update_status"
    RECORD_RESULT = "insert_trial_result"
    RECORD_METRICS = "record_metrics"
```

- [ ] **Step 2: Write the failing test** in `tests/test_training_metrics_callback.py`:

```python
import json
import types

from autotune.callbacks.logging_service import RecordType
from autotune.callbacks.training_metrics import METRIC_MARKER, TrainingMetricsCallback


def _state(global_step=10, epoch=0.04, is_zero=True):
    return types.SimpleNamespace(global_step=global_step, epoch=epoch, is_world_process_zero=is_zero)


def test_record_type_has_record_metrics():
    assert RecordType.RECORD_METRICS.value == "record_metrics"


def test_build_row_maps_known_fields_and_collects_extra():
    cb = TrainingMetricsCallback(trial_id="t1")
    logs = {"loss": 15.3477, "grad_norm": 2.85, "learning_rate": 6.5e-07, "epoch": 0.04}
    row = cb._build_row(logs, _state())
    assert row["trial_id"] == "t1"
    assert row["global_step"] == 10
    assert row["loss"] == 15.3477
    assert row["grad_norm"] == 2.85
    assert row["learning_rate"] == 6.5e-07
    assert row["split"] == "train"
    assert row["extra"] == {}


def test_build_row_marks_eval_split_and_keeps_eval_loss_in_extra():
    cb = TrainingMetricsCallback(trial_id="t1")
    row = cb._build_row({"eval_loss": 1.2, "eval_runtime": 3.0}, _state())
    assert row["split"] == "eval"
    assert row["extra"]["eval_loss"] == 1.2
    assert row["extra"]["eval_runtime"] == 3.0


def test_on_log_prints_marker_when_no_endpoint(monkeypatch, capsys):
    monkeypatch.delenv("AUTOTUNE_ENDPOINT_URL", raising=False)
    cb = TrainingMetricsCallback(trial_id="t1")
    cb.on_log(None, _state(), None, logs={"loss": 1.0, "epoch": 0.5})
    out = capsys.readouterr().out.strip().splitlines()
    marker_lines = [ln for ln in out if METRIC_MARKER in ln]
    assert len(marker_lines) == 1
    payload = json.loads(marker_lines[0].split(METRIC_MARKER, 1)[1].strip())
    assert payload["loss"] == 1.0
    assert payload["trial_id"] == "t1"


def test_on_log_posts_when_endpoint_set(monkeypatch):
    monkeypatch.setenv("AUTOTUNE_ENDPOINT_URL", "http://x/fmtune/api")
    monkeypatch.setenv("AUTOTUNE_JOB_ID", "job-1")
    cb = TrainingMetricsCallback(trial_id="t1")
    calls = []
    cb._handler = types.SimpleNamespace(record_data=lambda data, record_type: calls.append((data, record_type)))
    cb.on_log(None, _state(), None, logs={"loss": 1.0})
    assert len(calls) == 1
    data, record_type = calls[0]
    assert record_type is RecordType.RECORD_METRICS
    assert data["loss"] == 1.0
    assert data["job_id"] == "job-1"


def test_on_log_noop_off_main_process(monkeypatch, capsys):
    monkeypatch.delenv("AUTOTUNE_ENDPOINT_URL", raising=False)
    cb = TrainingMetricsCallback(trial_id="t1")
    cb.on_log(None, _state(is_zero=False), None, logs={"loss": 1.0})
    assert METRIC_MARKER not in capsys.readouterr().out
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pytest tests/test_training_metrics_callback.py -v`
Expected: FAIL — `ModuleNotFoundError: autotune.callbacks.training_metrics`.

- [ ] **Step 4: Implement `autotune/callbacks/training_metrics.py`:**

```python
# coding=utf-8
# Copyright 2023-present the International Business Machines.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""HF TrainerCallback that persists per-step training metrics.

On every HF Trainer logging step, `on_log` receives the metrics dict
(`{'loss', 'grad_norm', 'learning_rate', 'epoch'}`). This callback turns it
into one structured row and emits it toward AutotuneX by whichever channel the
current backend provides:

* llmb (remote): if `AUTOTUNE_ENDPOINT_URL` is set, POST the row to the
  api-bridge via `BufferedLogHandler.record_data(row, RECORD_METRICS)`.
* local / standalone: otherwise print one marked line,
  `@@FMTUNE_METRIC@@ {json}`, which AutotuneX's local `_SinkStream` parses.

`@@FMTUNE_METRIC@@` is a cross-repo contract shared with AutotuneX's
`FMTUNE_METRIC_MARKER`. The callback never raises into the training loop.
"""

from __future__ import annotations

import json
import os

from transformers import TrainerCallback

from autotune.callbacks.logging_service import BufferedLogHandler, RecordType

METRIC_MARKER = "@@FMTUNE_METRIC@@"

_KNOWN_KEYS = {"loss", "grad_norm", "learning_rate", "epoch"}


class TrainingMetricsCallback(TrainerCallback):
    """Emit one `training_metrics` row per HF logging step.

    Args:
        trial_id: The Ray Tune trial id for the current run (or None for a run
            with no trial context). Passed by the driver at construction so the
            callback need not reach into the tune context itself.
    """

    def __init__(self, trial_id: str | None = None) -> None:
        self._trial_id = trial_id
        self._endpoint = os.environ.get("AUTOTUNE_ENDPOINT_URL")
        self._job_id = os.environ.get("AUTOTUNE_JOB_ID")
        self._handler: BufferedLogHandler | None = None
        if self._endpoint:
            # No flush_interval => no background timer; record_data POSTs directly.
            self._handler = BufferedLogHandler(job_id=self._job_id, endpoint_url=self._endpoint)

    def _build_row(self, logs: dict, state) -> dict:
        return {
            "job_id": self._job_id,
            "trial_id": self._trial_id,
            "global_step": int(state.global_step),
            "epoch": float(state.epoch) if state.epoch is not None else None,
            "loss": logs.get("loss"),
            "grad_norm": logs.get("grad_norm"),
            "learning_rate": logs.get("learning_rate"),
            "split": "eval" if "eval_loss" in logs else "train",
            "extra": {k: v for k, v in logs.items() if k not in _KNOWN_KEYS},
        }

    def on_log(self, args, state, control, logs=None, **kwargs):
        # Best-effort: a metrics emit must never crash training.
        try:
            if not logs or not getattr(state, "is_world_process_zero", True):
                return
            row = self._build_row(logs, state)
            if self._handler is not None:
                self._handler.record_data(row, RecordType.RECORD_METRICS)
            else:
                print(f"{METRIC_MARKER} {json.dumps(row)}", flush=True)
        except Exception:
            return
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `pytest tests/test_training_metrics_callback.py -v`
Expected: PASS (all 6).

- [ ] **Step 6: Lint**

Run: `ruff check autotune/callbacks/training_metrics.py autotune/callbacks/logging_service.py tests/test_training_metrics_callback.py`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add autotune/callbacks/training_metrics.py autotune/callbacks/logging_service.py tests/test_training_metrics_callback.py
git commit -m "feat(metrics): TrainingMetricsCallback + RECORD_METRICS record type"
```

---

## Task A2: Wire the callback into the single-GPU drivers

**Files:**
- Modify: `autotune/trainers/driver_single.py` (after `Trainer(...)`, near the existing `trainer.add_callback(...)` block around L416–431)
- Modify: `autotune/trainers/driver_single_trl.py` (after the trainer is built, near L454–469)

**Interfaces:**
- Consumes: `TrainingMetricsCallback` from `autotune.callbacks.training_metrics`; `trial_id` local variable already present in each driver (`tune.get_context().get_trial_id()`).
- Produces: the callback attached to the trainer unconditionally (independent of the top-rung gate).

- [ ] **Step 1: `driver_single.py` — add the import** near the other callback imports at top of file:

```python
from autotune.callbacks.training_metrics import TrainingMetricsCallback
```

- [ ] **Step 2: `driver_single.py` — attach the callback.** Immediately after the `AloraGradCheckpointDrainCallback` add-site (around L416), before the gated `PerEpochTuneReportCallback` block, add:

```python
    # Persist per-step training metrics (loss/grad_norm/lr/epoch) to AutotuneX.
    # Added unconditionally — all trials AND final training — independent of the
    # per-epoch top-rung gate below.
    trainer.add_callback(TrainingMetricsCallback(trial_id=trial_id))
```

- [ ] **Step 3: `driver_single_trl.py` — add the same import** and, after its trainer is constructed (near L454, alongside `AloraGradCheckpointDrainCallback`), add the identical `trainer.add_callback(TrainingMetricsCallback(trial_id=trial_id))` line. Confirm the local variable holding the Ray trial id is named `trial_id` in this file (it is set from `tune.get_context().get_trial_id()`); if it is named differently, pass that variable.

- [ ] **Step 4: Smoke-check imports** (no training run needed):

Run: `python -c "import autotune.trainers.driver_single, autotune.trainers.driver_single_trl"`
Expected: no ImportError.

- [ ] **Step 5: Run the full callback test + lint**

Run: `pytest tests/test_training_metrics_callback.py -q && ruff check autotune/trainers/driver_single.py autotune/trainers/driver_single_trl.py`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add autotune/trainers/driver_single.py autotune/trainers/driver_single_trl.py
git commit -m "feat(metrics): emit per-step metrics from single-GPU drivers"
```

---

## Task A3: Wire the callback into the multi-GPU drivers

**Files:**
- Modify: `autotune/trainers/driver_multi_hf_ds.py` (inside `train_loop_per_worker`, near L830–853)
- Modify: `autotune/trainers/driver_multi_hf_fsdp.py` (inside `train_loop_per_worker`, near L762–768)
- Modify: `autotune/trainers/driver_multi_trl_ds.py` (inside `train_loop_per_worker`, near L609–629)
- Modify: `autotune/trainers/driver_multi_trl_fsdp.py` (inside `train_loop_per_worker`, near L545–549)

**Interfaces:**
- Consumes: `TrainingMetricsCallback`; the worker's `train_loop_config["trial_id"]` (already forwarded — see the driver's `train_loop_per_worker`).
- Produces: the callback attached to the trainer **inside the worker**, before `prepare_trainer(trainer)`. Rank-0 dedupe is handled inside `on_log` via `state.is_world_process_zero`, so a single unconditional `add_callback` per worker is correct.

- [ ] **Step 1: For each of the four drivers, add the import** at the top:

```python
from autotune.callbacks.training_metrics import TrainingMetricsCallback
```

- [ ] **Step 2: Attach the callback inside `train_loop_per_worker`.** In each driver, locate where `trainer.add_callback(AloraGradCheckpointDrainCallback())` is called inside the worker function and add immediately after it:

```python
    # Per-step metrics: added on every worker; on_log self-guards to rank 0.
    trainer.add_callback(TrainingMetricsCallback(trial_id=train_loop_config.get("trial_id")))
```

Confirm the in-scope variable holding the forwarded config is `train_loop_config` (the worker's parameter). If a driver already unpacks `trial_id = train_loop_config["trial_id"]` earlier in the worker, pass that local instead: `TrainingMetricsCallback(trial_id=trial_id)`.

This add-site must be **before** the `trainer = prepare_trainer(trainer)` line in each driver.

- [ ] **Step 3: Smoke-check imports**

Run: `python -c "import autotune.trainers.driver_multi_hf_ds, autotune.trainers.driver_multi_hf_fsdp, autotune.trainers.driver_multi_trl_ds, autotune.trainers.driver_multi_trl_fsdp"`
Expected: no ImportError. (If a driver import pulls heavy optional deps, run each in its own `-c` and skip only those that fail on unrelated missing deps in this environment — note which.)

- [ ] **Step 4: Lint**

Run: `ruff check autotune/trainers/driver_multi_hf_ds.py autotune/trainers/driver_multi_hf_fsdp.py autotune/trainers/driver_multi_trl_ds.py autotune/trainers/driver_multi_trl_fsdp.py`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add autotune/trainers/driver_multi_hf_ds.py autotune/trainers/driver_multi_hf_fsdp.py autotune/trainers/driver_multi_trl_ds.py autotune/trainers/driver_multi_trl_fsdp.py
git commit -m "feat(metrics): emit per-step metrics from multi-GPU drivers (rank-0)"
```

**End of Phase A.** The fm-tune side is complete and safe to land: in `local` it prints marker lines (currently captured as ordinary `log_entries` text until Phase B's parser exists); in `llmb` `record_data` tolerates a missing endpoint (it logs and returns).

---

# PHASE B — AutotuneX (worktree)

> All Phase B steps run in the AutotuneX repo. Test commands assume the worktree directory as CWD. The api-bridge is a self-contained subproject (its own `pytest` rootdir under `src/api-bridge`).

## Task B1: Create the AutotuneX worktree

**Files:** none (setup).

- [ ] **Step 1: Create a worktree of the AutotuneX repo** (not this repo):

```bash
git -C $AUTOTUNEX_REPO worktree add \
  $AUTOTUNEX_REPO/.worktrees/training-metrics \
  -b feat/training-metrics
```

- [ ] **Step 2: Confirm the tree and install dev deps** (follow the repo's README/Makefile — typically):

```bash
cd $AUTOTUNEX_REPO/.worktrees/training-metrics
make install    # or: uv pip install -e . ; uv pip install -e ./src/api-bridge
```

Expected: importable `autotunex` and `api_bridge` packages; `pytest -q` runs (existing suite green).

---

## Task B2: `training_metrics` ORM table + registration + migration

**Files:**
- Create: `src/autotunex/db/tables/training_metrics.py`
- Modify: `src/autotunex/db/tables/__init__.py`
- Create: `alembic/versions/<newrev>_add_training_metrics.py`
- Test: `tests/db/test_training_metrics_table.py` (new)

**Interfaces:**
- Produces: `TrainingMetricTable` (ORM), registered on `Base.metadata`; a migration whose `down_revision = "0a2caef2a185"` (current head) creating the `training_metrics` table.

- [ ] **Step 1: Create the ORM table** `src/autotunex/db/tables/training_metrics.py`:

```python
# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""The ``training_metrics`` table — per-step training metrics time series."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import JSON, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from autotunex.db.base import Base
from autotunex.db.tables._helpers import utcnow
from autotunex.db.types import UtcDateTime, Uuid36

if TYPE_CHECKING:
    from autotunex.db.tables.jobs import JobTable


class TrainingMetricTable(Base):
    """One per-step metrics row emitted by a training run.

    ``trial_id`` is a soft reference (indexed, no FK): the final-training run may
    have no ``trials`` row, mirroring ``log_entries.trial_id``.
    """

    __tablename__ = "training_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[UUID] = mapped_column(Uuid36, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    trial_id: Mapped[str | None] = mapped_column(String(16), default=None, index=True)
    global_step: Mapped[int] = mapped_column(Integer, nullable=False)
    epoch: Mapped[float | None] = mapped_column(Float, default=None)
    loss: Mapped[float | None] = mapped_column(Float, default=None)
    grad_norm: Mapped[float | None] = mapped_column(Float, default=None)
    learning_rate: Mapped[float | None] = mapped_column(Float, default=None)
    split: Mapped[str] = mapped_column(String(16), nullable=False, default="train")
    extra: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)

    job: Mapped[JobTable] = relationship("JobTable")
```

- [ ] **Step 2: Register the table** in `src/autotunex/db/tables/__init__.py` — add the import (alphabetical, after `TrialTable`/before `UserTable` as fits) and the `__all__` entry:

```python
from autotunex.db.tables.training_metrics import TrainingMetricTable
```
```python
("TrainingMetricTable",)
```

- [ ] **Step 3: Write the failing table test** `tests/db/test_training_metrics_table.py`:

```python
from __future__ import annotations

import pytest
from sqlalchemy import select

from autotunex.db.tables import TrainingMetricTable


@pytest.mark.asyncio
async def test_training_metrics_row_roundtrips(session, user, job):
    session.add(
        TrainingMetricTable(
            job_id=job.id,
            trial_id="t1",
            global_step=10,
            epoch=0.04,
            loss=15.3477,
            grad_norm=2.85,
            learning_rate=6.5e-07,
            split="train",
            extra={},
        )
    )
    await session.commit()
    row = (await session.execute(select(TrainingMetricTable))).scalar_one()
    assert row.loss == 15.3477
    assert row.trial_id == "t1"
    assert row.created_at is not None
```

(Reuse the existing `session`/`user`/`job` fixtures from `tests/conftest.py`. If a `job` fixture is not visible to `tests/db/`, import the one used by `tests/api/routers/test_jobs.py`, or seed a `JobTable` inline following that file's pattern.)

- [ ] **Step 4: Run it to confirm it fails**

Run: `pytest tests/db/test_training_metrics_table.py -v`
Expected: FAIL — table not in `create_schema` metadata (until Step 2 is picked up) or missing fixtures. Fix fixture wiring until the failure is purely "table/row assertion", then proceed.

- [ ] **Step 5: Create the Alembic migration** `alembic/versions/<newrev>_add_training_metrics.py` (generate `<newrev>` however the repo does; hand-authored is fine):

```python
"""Add training_metrics table.

Revision ID: <newrev>
Revises: 0a2caef2a185
Create Date: 2026-08-26 00:00:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

import autotunex.db.types

revision = "<newrev>"
down_revision = "0a2caef2a185"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the per-step training_metrics time-series table."""
    op.create_table(
        "training_metrics",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("job_id", autotunex.db.types.Uuid36(length=36), nullable=False),
        sa.Column("trial_id", sa.String(length=16), nullable=True),
        sa.Column("global_step", sa.Integer(), nullable=False),
        sa.Column("epoch", sa.Float(), nullable=True),
        sa.Column("loss", sa.Float(), nullable=True),
        sa.Column("grad_norm", sa.Float(), nullable=True),
        sa.Column("learning_rate", sa.Float(), nullable=True),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("extra", sa.JSON(), nullable=True),
        sa.Column("created_at", autotunex.db.types.UtcDateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_training_metrics_job_trial_step",
        "training_metrics",
        ["job_id", "trial_id", "global_step"],
    )


def downgrade() -> None:
    """Drop the training_metrics table."""
    op.drop_index("ix_training_metrics_job_trial_step", table_name="training_metrics")
    op.drop_table("training_metrics")
```

- [ ] **Step 6: Run migration up/down on a scratch SQLite DB**

```bash
AUTOTUNEX_DATABASE_URL="sqlite:///./_scratch_migration.db" alembic upgrade head
AUTOTUNEX_DATABASE_URL="sqlite:///./_scratch_migration.db" alembic downgrade -1
rm -f _scratch_migration.db
```
Expected: upgrade creates `training_metrics`; downgrade drops it; no errors. (Alembic reads the URL from app settings via `env.py`; the env var override matches how `config.py` resolves `database_url`.)

- [ ] **Step 7: Run the table test**

Run: `pytest tests/db/test_training_metrics_table.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/autotunex/db/tables/training_metrics.py src/autotunex/db/tables/__init__.py alembic/versions/*_add_training_metrics.py tests/db/test_training_metrics_table.py
git commit -m "feat(db): add training_metrics table + migration"
```

---

## Task B3: `TrainingMetricsRepository` (insert + read)

**Files:**
- Modify: `src/autotunex/db/repositories/protocols.py`
- Modify: `src/autotunex/db/repositories/sqlalchemy.py`
- Test: `tests/db/test_training_metrics_repo.py` (new)

**Interfaces:**
- Produces:
  - `TrainingMetricsRepository` Protocol with `insert(...)` and `metrics_page(...)`.
  - `SqlAlchemyTrainingMetricsRepository(session: AsyncSession)`.
  - `insert(self, job_id: UUID, *, trial_id: str | None, global_step: int, epoch: float | None, loss: float | None, grad_norm: float | None, learning_rate: float | None, split: str, extra: dict[str, Any] | None) -> None` (append + commit).
  - `metrics_page(self, job_id: UUID, *, trial_id: str | None, after_id: int, limit: int) -> tuple[Sequence[TrainingMetricTable], bool]` — ascending by `id`, `id > after_id`, `limit + 1` for `has_more`.
  - `is_visible(...)` is reused from `JobRepository` for scoping (already exists).

- [ ] **Step 1: Add the Protocol** to `src/autotunex/db/repositories/protocols.py` (near `ResultRepository`):

```python
class TrainingMetricsRepository(Protocol):
    """Write + keyset-read for the per-step ``training_metrics`` time series."""

    async def insert(
        self,
        job_id: UUID,
        *,
        trial_id: str | None,
        global_step: int,
        epoch: float | None,
        loss: float | None,
        grad_norm: float | None,
        learning_rate: float | None,
        split: str,
        extra: dict[str, Any] | None,
    ) -> None:
        """Append one metrics row to ``job_id``, committing."""
        ...

    async def metrics_page(
        self, job_id: UUID, *, trial_id: str | None, after_id: int, limit: int
    ) -> tuple[Sequence["TrainingMetricTable"], bool]:
        """Ascending keyset page of metrics rows (oldest first) for charting."""
        ...
```

(Ensure `Sequence` and `Any` are imported in `protocols.py`; add `from autotunex.db.tables import TrainingMetricTable` under `TYPE_CHECKING` if the file uses that pattern, else import directly.)

- [ ] **Step 2: Write the failing repo test** `tests/db/test_training_metrics_repo.py`:

```python
from __future__ import annotations

import pytest

from autotunex.db.repositories.sqlalchemy import SqlAlchemyTrainingMetricsRepository


@pytest.mark.asyncio
async def test_insert_and_page_ascending(session, user, job):
    repo = SqlAlchemyTrainingMetricsRepository(session)
    for step in (10, 20, 30):
        await repo.insert(
            job.id,
            trial_id="t1",
            global_step=step,
            epoch=0.1,
            loss=float(step),
            grad_norm=1.0,
            learning_rate=1e-6,
            split="train",
            extra=None,
        )
    rows, has_more = await repo.metrics_page(job.id, trial_id="t1", after_id=0, limit=2)
    assert [r.global_step for r in rows] == [10, 20]
    assert has_more is True
    rows2, has_more2 = await repo.metrics_page(job.id, trial_id="t1", after_id=rows[-1].id, limit=2)
    assert [r.global_step for r in rows2] == [30]
    assert has_more2 is False


@pytest.mark.asyncio
async def test_page_filters_by_trial(session, user, job):
    repo = SqlAlchemyTrainingMetricsRepository(session)
    await repo.insert(
        job.id,
        trial_id="t1",
        global_step=1,
        epoch=None,
        loss=1.0,
        grad_norm=None,
        learning_rate=None,
        split="train",
        extra=None,
    )
    await repo.insert(
        job.id,
        trial_id="t2",
        global_step=1,
        epoch=None,
        loss=2.0,
        grad_norm=None,
        learning_rate=None,
        split="train",
        extra=None,
    )
    rows, _ = await repo.metrics_page(job.id, trial_id="t2", after_id=0, limit=50)
    assert [r.loss for r in rows] == [2.0]
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pytest tests/db/test_training_metrics_repo.py -v`
Expected: FAIL — `SqlAlchemyTrainingMetricsRepository` not defined.

- [ ] **Step 4: Implement the repository** in `src/autotunex/db/repositories/sqlalchemy.py` (add `TrainingMetricTable` to the existing `from autotunex.db.tables import (...)` block, then add the class):

```python
class SqlAlchemyTrainingMetricsRepository:
    """Per-step metrics persistence backed by an :class:`AsyncSession`.

    Satisfies :class:`~autotunex.db.repositories.protocols.TrainingMetricsRepository`.
    Append-only; owns its transactions.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def insert(
        self,
        job_id: UUID,
        *,
        trial_id: str | None,
        global_step: int,
        epoch: float | None,
        loss: float | None,
        grad_norm: float | None,
        learning_rate: float | None,
        split: str,
        extra: dict[str, Any] | None,
    ) -> None:
        """Append one metrics row to ``job_id``, committing."""
        self._session.add(
            TrainingMetricTable(
                job_id=job_id,
                trial_id=trial_id,
                global_step=global_step,
                epoch=epoch,
                loss=loss,
                grad_norm=grad_norm,
                learning_rate=learning_rate,
                split=split,
                extra=extra,
            )
        )
        await self._session.commit()

    async def metrics_page(
        self, job_id: UUID, *, trial_id: str | None, after_id: int, limit: int
    ) -> tuple[Sequence[TrainingMetricTable], bool]:
        """Ascending keyset page (oldest first) for charting; see the Protocol."""
        statement = select(TrainingMetricTable).where(TrainingMetricTable.job_id == job_id)
        if trial_id is not None:
            statement = statement.where(TrainingMetricTable.trial_id == trial_id)
        if after_id > 0:
            statement = statement.where(TrainingMetricTable.id > after_id)
        statement = statement.order_by(TrainingMetricTable.id.asc()).limit(limit + 1)
        rows = (await self._session.execute(statement)).scalars().all()
        has_more = len(rows) > limit
        return rows[:limit], has_more
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `pytest tests/db/test_training_metrics_repo.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/autotunex/db/repositories/protocols.py src/autotunex/db/repositories/sqlalchemy.py tests/db/test_training_metrics_repo.py
git commit -m "feat(db): TrainingMetricsRepository insert + keyset page"
```

---

## Task B4: Local sink — `TrainingMetricRecord`, `sink.training_metric`, `_SinkStream` marker routing

**Files:**
- Modify: `src/autotunex/services/local/protocols.py`
- Modify: `src/autotunex/services/local/sink.py`
- Modify: `src/autotunex/services/local/trainer.py`
- Test: `tests/services/local/test_metric_capture.py` (new)

**Interfaces:**
- Consumes: `SqlAlchemyTrainingMetricsRepository` (Task B3); `DbTrialSink.coerce_trial_id`.
- Produces:
  - `TrainingMetricRecord` frozen dataclass in `protocols.py`.
  - `TrialSink.training_metric(self, record: TrainingMetricRecord) -> None`.
  - `DbTrialSink.training_metric(...)` implementation.
  - `FMTUNE_METRIC_MARKER = "@@FMTUNE_METRIC@@"` in `trainer.py`, and `_SinkStream` routing marked lines to `sink.training_metric` (falling back to `sink.log` on parse failure).

- [ ] **Step 1: Add the record type + Protocol method** to `src/autotunex/services/local/protocols.py` (beside `LogRecord` and in `TrialSink`):

```python
@dataclass(frozen=True)
class TrainingMetricRecord:
    """One per-step metrics row captured during a local run."""

    trial_id: str | None
    global_step: int
    epoch: float | None
    loss: float | None
    grad_norm: float | None
    learning_rate: float | None
    split: str
    extra: dict[str, Any] | None
```

Add to the `TrialSink` Protocol:

```python
    def training_metric(self, record: TrainingMetricRecord) -> None:
        """Persist one per-step training-metrics row."""
        ...
```

- [ ] **Step 2: Implement `DbTrialSink.training_metric`** in `src/autotunex/services/local/sink.py` (add the import of the repo and `TrainingMetricRecord`, then the method + its coroutine, mirroring `_upsert_result`/`trial_result`):

```python
async def _insert_metric(self, record: TrainingMetricRecord) -> None:
    trial_id = self.coerce_trial_id(record.trial_id) if record.trial_id is not None else None
    async with self._session_factory() as session:
        await SqlAlchemyTrainingMetricsRepository(session).insert(
            self._job_id,
            trial_id=trial_id,
            global_step=record.global_step,
            epoch=record.epoch,
            loss=record.loss,
            grad_norm=record.grad_norm,
            learning_rate=record.learning_rate,
            split=record.split,
            extra=record.extra,
        )


def training_metric(self, record: TrainingMetricRecord) -> None:
    """Persist one per-step training-metrics row (worker-thread only)."""
    self._run(self._insert_metric(record))
```

Imports to add at the top of `sink.py`: `SqlAlchemyTrainingMetricsRepository` in the existing repositories import block, and `TrainingMetricRecord` in the `from autotunex.services.local.protocols import (...)` block.

- [ ] **Step 3: Write the failing capture test** `tests/services/local/test_metric_capture.py`:

```python
from __future__ import annotations

import json

from autotunex.services.local.protocols import LogRecord, TrainingMetricRecord
from autotunex.services.local.trainer import FMTUNE_METRIC_MARKER, _SinkStream, _TrialContext


class _FakeSink:
    def __init__(self):
        self.metrics: list[TrainingMetricRecord] = []
        self.logs: list[LogRecord] = []

    def training_metric(self, record):
        self.metrics.append(record)

    def log(self, record):
        self.logs.append(record)


class _FakeStream:
    def write(self, s):
        return len(s)

    def flush(self):
        pass

    def fileno(self):
        return 1


def test_marked_line_becomes_a_training_metric():
    sink = _FakeSink()
    ctx = _TrialContext()
    ctx.current_trial_id = "ctx-trial"
    stream = _SinkStream(sink, _FakeStream(), context=ctx)
    row = {
        "trial_id": "t1",
        "global_step": 10,
        "epoch": 0.04,
        "loss": 1.5,
        "grad_norm": 2.0,
        "learning_rate": 1e-6,
        "split": "train",
        "extra": {},
    }
    stream.write(f"{FMTUNE_METRIC_MARKER} {json.dumps(row)}\n")
    assert len(sink.metrics) == 1
    assert sink.metrics[0].trial_id == "t1"  # payload wins over ctx
    assert sink.metrics[0].loss == 1.5
    assert sink.logs == []  # not double-written as a log


def test_unmarked_line_stays_a_log():
    sink = _FakeSink()
    stream = _SinkStream(sink, _FakeStream(), context=_TrialContext())
    stream.write("plain training output\n")
    assert sink.metrics == []
    assert len(sink.logs) == 1


def test_malformed_marker_falls_back_to_log():
    sink = _FakeSink()
    stream = _SinkStream(sink, _FakeStream(), context=_TrialContext())
    stream.write(f"{FMTUNE_METRIC_MARKER} not-json\n")
    assert sink.metrics == []
    assert len(sink.logs) == 1
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pytest tests/services/local/test_metric_capture.py -v`
Expected: FAIL — `FMTUNE_METRIC_MARKER` not defined.

- [ ] **Step 5: Add the marker + routing to `_SinkStream`** in `src/autotunex/services/local/trainer.py`.

Add the module-level constant (top of file, after imports):

```python
FMTUNE_METRIC_MARKER = "@@FMTUNE_METRIC@@"
"""Shared contract with fm-tune's ``training_metrics.METRIC_MARKER`` — a marked
stdout line the emitter prints in local mode. Both repos change together."""
```

Add the imports `import json` (if not present) and `TrainingMetricRecord` to the `from autotunex.services.local.protocols import (...)` block.

Modify `_SinkStream._forward` so a marked line is routed to `sink.training_metric`, else logged:

```python
def _forward(self, line: str) -> None:
    # capturing logs must never break the run
    with suppress(Exception):
        if FMTUNE_METRIC_MARKER in line:
            if self._forward_metric(line):
                return
        self._sink.log(
            LogRecord(
                trial_id=self._context.current_trial_id,
                level=self._level,
                filename=None,
                message=line.rstrip(),
                iteration=None,
                epoch=None,
            )
        )


def _forward_metric(self, line: str) -> bool:
    """Parse a marked metric line and forward it; return False to fall back to log."""
    try:
        payload = line.split(FMTUNE_METRIC_MARKER, 1)[1].strip()
        data = json.loads(payload)
    except (IndexError, ValueError):
        return False
    self._sink.training_metric(
        TrainingMetricRecord(
            trial_id=data.get("trial_id") or self._context.current_trial_id,
            global_step=int(data.get("global_step", 0)),
            epoch=data.get("epoch"),
            loss=data.get("loss"),
            grad_norm=data.get("grad_norm"),
            learning_rate=data.get("learning_rate"),
            split=data.get("split", "train"),
            extra=data.get("extra"),
        )
    )
    return True
```

(Note: `_SinkStream.write` calls `_forward` per complete line; Ray prefixes forwarded worker output, so the marker is matched as a substring, not a prefix — which `in` already handles.)

- [ ] **Step 6: Run tests to confirm they pass**

Run: `pytest tests/services/local/test_metric_capture.py -v`
Expected: PASS (3).

- [ ] **Step 7: Full local-services suite + lint**

Run: `pytest tests/services/local -q`
Expected: existing tests still green (the `TrialSink` Protocol gained a method — confirm any in-repo fake sinks used by other tests either inherit a default or are updated; if a fake in another test now fails Protocol conformance at runtime, add a no-op `training_metric` to it).

- [ ] **Step 8: Commit**

```bash
git add src/autotunex/services/local/protocols.py src/autotunex/services/local/sink.py src/autotunex/services/local/trainer.py tests/services/local/test_metric_capture.py
git commit -m "feat(local): capture marked metric lines into training_metrics"
```

---

## Task B5: api-bridge — `record_metrics` endpoint (llmb path)

**Files:**
- Modify: `src/api-bridge/src/api_bridge/model.py`
- Modify: `src/api-bridge/src/api_bridge/tables.py`
- Modify: `src/api-bridge/src/api_bridge/database.py`
- Modify: `src/api-bridge/src/api_bridge/log_service.py`
- Modify: `src/api-bridge/src/api_bridge/server.py`
- Test: `src/api-bridge/tests/test_metrics_roundtrip.py` (new)

**Interfaces:**
- Produces:
  - `bridge_models.TrainingMetric` (Pydantic).
  - Core `tables.training_metrics`.
  - `Database.insert_metrics(buffer: list) -> bool`.
  - `LogService.record_metrics(metrics: list[bridge_models.TrainingMetric])`.
  - `POST /fmtune/api/record_metrics` route → same `training_metrics` table.

- [ ] **Step 1: Add the Pydantic model** to `src/api-bridge/src/api_bridge/model.py` (copy the `LogEntry` shape — real fields + `getattr`-based item access):

```python
class TrainingMetric(BaseModel):
    job_id: str | None = Field(..., description="Job ID as a 36-character UUID")
    trial_id: str | None = None
    global_step: int = Field(..., description="Global training step")
    epoch: float | None = None
    loss: float | None = None
    grad_norm: float | None = None
    learning_rate: float | None = None
    split: str = Field("train", description="'train' or 'eval'")
    extra: dict[str, Any] | None = None

    def __getitem__(self, key):
        return getattr(self, key)

    def __setitem__(self, key, value):
        setattr(self, key, value)
```

- [ ] **Step 2: Add the Core table** to `src/api-bridge/src/api_bridge/tables.py` (after `log_entries`; `created_at` uses the module's `UtcDateTime`):

```python
training_metrics = Table(
    "training_metrics",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("job_id", Uuid36Str, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
    Column("trial_id", String(16), index=True),
    Column("global_step", Integer, nullable=False),
    Column("epoch", Float),
    Column("loss", Float),
    Column("grad_norm", Float),
    Column("learning_rate", Float),
    Column("split", String(16), nullable=False),
    Column("extra", JSON),
    Column("created_at", UtcDateTime),
)
```

- [ ] **Step 3: Write the failing round-trip test** `src/api-bridge/tests/test_metrics_roundtrip.py` (reuse the `db` fixture + FK-seeding helpers pattern from `tests/test_roundtrip.py`):

```python
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.pool import StaticPool

from api_bridge.database import Database
from api_bridge.tables import metadata, training_metrics
from tests.test_roundtrip import _config, _dataset, seed_job, seed_user


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    metadata.create_all(engine)
    return Database(engine=engine)


def test_insert_metrics_roundtrip(db):
    user_id = seed_user(db)
    config_id = str(db.insert_configuration(_config(user_id)))
    dataset_id = str(db.insert_dataset(_dataset(user_id)).id)
    job_id = seed_job(db, user_id, config_id, dataset_id)

    buffer = [
        {
            "job_id": job_id,
            "trial_id": "t1",
            "global_step": s,
            "epoch": 0.1,
            "loss": float(s),
            "grad_norm": 1.0,
            "learning_rate": 1e-6,
            "split": "train",
            "extra": {},
        }
        for s in (10, 20)
    ]
    assert db.insert_metrics(buffer) is True

    with db._engine.connect() as conn:
        rows = conn.execute(select(training_metrics).order_by(training_metrics.c.id)).mappings().all()
    assert [r["loss"] for r in rows] == [10.0, 20.0]
    assert rows[0]["trial_id"] == "t1"
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `cd src/api-bridge && pytest tests/test_metrics_roundtrip.py -v`
Expected: FAIL — `insert_metrics` / `training_metrics` not defined.

- [ ] **Step 5: Implement `Database.insert_metrics`** in `src/api-bridge/src/api_bridge/database.py` (mirror `insert_logs`, stamping `created_at`):

```python
    def insert_metrics(self, buffer: list) -> bool:
        """Insert a batch of per-step training-metrics rows. Returns success."""
        if not buffer:
            return True
        try:
            now = datetime.now(UTC)
            rows = [
                {
                    "job_id": entry["job_id"],
                    "trial_id": entry.get("trial_id"),
                    "global_step": entry["global_step"],
                    "epoch": entry.get("epoch"),
                    "loss": entry.get("loss"),
                    "grad_norm": entry.get("grad_norm"),
                    "learning_rate": entry.get("learning_rate"),
                    "split": entry.get("split", "train"),
                    "extra": entry.get("extra"),
                    "created_at": now,
                }
                for entry in buffer
            ]
            with self._engine.begin() as connection:
                connection.execute(insert(tables.training_metrics), rows)
            return True
        except Exception as e:
            logger.error(f"Error inserting metrics: {e!s}")
            return False
```

(`entry` may be a Pydantic `TrainingMetric` or a dict; both support `entry["k"]` — `TrainingMetric.__getitem__` delegates to `getattr`, but `.get(...)` does not exist on the model. To keep the list-of-models path working, in `LogService.record_metrics` convert each model to a dict via `m.model_dump()` before calling `insert_metrics` — see Step 6 — so `insert_metrics` always receives dicts.)

- [ ] **Step 6: Implement `LogService.record_metrics`** in `src/api-bridge/src/api_bridge/log_service.py` (mirror `record_logs`, normalizing models to dicts):

```python
    async def record_metrics(self, metrics: list[bridge_models.TrainingMetric]):
        """Record a batch of per-step training-metrics rows."""
        try:
            rows = [m.model_dump() if hasattr(m, "model_dump") else m for m in metrics]
            result = self.db.insert_metrics(rows)
            if result:
                return {"message": "metrics inserted", "success": True}
            return {"message": "failed to insert metrics", "success": False}
        except Exception as e:
            logger.error("Failed to insert metrics", exc_info=e)
            raise HTTPException(status_code=400, detail=f"Something went wrong: {e}")
```

- [ ] **Step 7: Add the endpoint** to `src/api-bridge/src/api_bridge/server.py` (beside `record_logs`). fm-tune's `record_data` POSTs a single JSON object, so accept both a single model and a list:

```python
@prefix_router.post("/api/record_metrics", tags=["Utils"], dependencies=[Depends(require_write_token)])
async def record_metrics(
    metrics: list[bridge_models.TrainingMetric] | bridge_models.TrainingMetric,
):
    """Record per-step training metrics (single row or a batch)."""
    batch = metrics if isinstance(metrics, list) else [metrics]
    return await log.record_metrics(batch)
```

- [ ] **Step 8: Run the round-trip test + an endpoint auth test**

Run: `cd src/api-bridge && pytest tests/test_metrics_roundtrip.py -v`
Expected: PASS.

Add one endpoint test to `tests/test_server_auth.py`'s parametrize list (the `("/fmtune/api/record_metrics", {...single row...})` case) and run:

Run: `cd src/api-bridge && pytest tests/test_server_auth.py -v`
Expected: PASS (401 without token; matches the other write routes).

- [ ] **Step 9: Commit**

```bash
git add src/api-bridge/src/api_bridge/model.py src/api-bridge/src/api_bridge/tables.py src/api-bridge/src/api_bridge/database.py src/api-bridge/src/api_bridge/log_service.py src/api-bridge/src/api_bridge/server.py src/api-bridge/tests/test_metrics_roundtrip.py src/api-bridge/tests/test_server_auth.py
git commit -m "feat(api-bridge): POST /fmtune/api/record_metrics into training_metrics"
```

---

## Task B6: Read-back API — models, service, dependency, routes

**Files:**
- Create: `src/autotunex/models/metric.py`
- Create: `src/autotunex/services/metrics.py`
- Modify: `src/autotunex/api/deps.py`
- Modify: `src/autotunex/api/routers/jobs.py`
- Test: extend `tests/api/routers/test_jobs.py`

**Interfaces:**
- Consumes: `SqlAlchemyTrainingMetricsRepository`, `JobRepository.is_visible`, the scoping helpers (`resolve_owner_filter`, `sees_nothing`), `get_job_repository`, `PrincipalDep`.
- Produces:
  - `MetricPointRead`, `MetricPage` models.
  - `MetricsService(metrics_repo, job_repo, principal)` with `get_job_metrics(...)` / `get_trial_metrics(...)`.
  - `MetricsServiceDep`.
  - `GET /{job_id}/metrics` and `GET /{job_id}/trials/{trial_id}/metrics`.

- [ ] **Step 1: Create response models** `src/autotunex/models/metric.py` (mirror `models/log.py`):

```python
# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""API models for the per-step training-metrics endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class MetricPointRead(BaseModel):
    """One ``training_metrics`` row as returned by the metrics endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    trial_id: str | None = None
    global_step: int
    epoch: float | None = None
    loss: float | None = None
    grad_norm: float | None = None
    learning_rate: float | None = None
    split: str
    extra: dict[str, Any] | None = None
    created_at: datetime | None = None


class MetricPage(BaseModel):
    """One ascending keyset page of metric points (oldest first)."""

    metrics: list[MetricPointRead]
    has_more: bool
    next_after_id: int | None = None
```

- [ ] **Step 2: Create the service** `src/autotunex/services/metrics.py` (mirror `services/logs.py`'s scope guard + page builder):

```python
# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""Reads a job/trial's per-step training metrics, scoped to the principal."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from autotunex.core.exceptions import JobNotFoundError
from autotunex.db.repositories.protocols import JobRepository, TrainingMetricsRepository
from autotunex.db.tables import TrainingMetricTable
from autotunex.models.auth import Principal
from autotunex.models.common import DataScope
from autotunex.models.metric import MetricPage, MetricPointRead
from autotunex.services.scoping import resolve_owner_filter, sees_nothing


class MetricsService:
    def __init__(
        self,
        metrics_repository: TrainingMetricsRepository,
        job_repository: JobRepository,
        principal: Principal,
    ) -> None:
        self._metrics = metrics_repository
        self._jobs = job_repository
        self._principal = principal

    async def get_job_metrics(
        self, job_id: UUID, *, after_id: int, limit: int, scope: DataScope = DataScope.OWN
    ) -> MetricPage:
        await self._require_visible(job_id, scope)
        rows, has_more = await self._metrics.metrics_page(job_id, trial_id=None, after_id=after_id, limit=limit)
        return self._to_page(rows, has_more)

    async def get_trial_metrics(
        self, job_id: UUID, trial_id: str, *, after_id: int, limit: int, scope: DataScope = DataScope.OWN
    ) -> MetricPage:
        await self._require_visible(job_id, scope)
        rows, has_more = await self._metrics.metrics_page(job_id, trial_id=trial_id, after_id=after_id, limit=limit)
        return self._to_page(rows, has_more)

    async def _require_visible(self, job_id: UUID, scope: DataScope) -> None:
        owner_id = resolve_owner_filter(self._principal, scope)
        if sees_nothing(self._principal, scope):
            raise JobNotFoundError(job_id)
        if not await self._jobs.is_visible(job_id, owner_id=owner_id):
            raise JobNotFoundError(job_id)

    def _to_page(self, rows: Sequence[TrainingMetricTable], has_more: bool) -> MetricPage:
        points = [MetricPointRead.model_validate(row) for row in rows]
        next_after_id = points[-1].id if has_more and points else None
        return MetricPage(metrics=points, has_more=has_more, next_after_id=next_after_id)
```

- [ ] **Step 3: Add the dependency** to `src/autotunex/api/deps.py` (mirror `get_log_service`; add a metrics-repo provider):

```python
def get_training_metrics_repository(session: SessionDep) -> TrainingMetricsRepository:
    """Provide the training-metrics repository implementation."""
    return SqlAlchemyTrainingMetricsRepository(session)


def get_metrics_service(
    metrics_repository: Annotated[TrainingMetricsRepository, Depends(get_training_metrics_repository)],
    job_repository: Annotated[JobRepository, Depends(get_job_repository)],
    principal: PrincipalDep,
) -> MetricsService:
    """Provide the metrics service, scoped to the resolved principal."""
    return MetricsService(metrics_repository=metrics_repository, job_repository=job_repository, principal=principal)


MetricsServiceDep = Annotated[MetricsService, Depends(get_metrics_service)]
```

Add imports to `deps.py`: `from autotunex.db.repositories.protocols import TrainingMetricsRepository`, `from autotunex.db.repositories.sqlalchemy import SqlAlchemyTrainingMetricsRepository`, `from autotunex.services.metrics import MetricsService`.

- [ ] **Step 4: Add the routes** to `src/autotunex/api/routers/jobs.py` (mirror `get_trial_logs`; add `MetricsServiceDep` to the `deps` import and `MetricPage` to the model imports):

```python
@router.get(
    "/{job_id}/metrics",
    summary="Get a job's per-step training metrics",
    responses={
        HTTPStatus.FORBIDDEN: _PROBLEM_RESPONSE,
        HTTPStatus.NOT_FOUND: _PROBLEM_RESPONSE,
        **_AUTH_RESPONSES,
    },
)
async def get_job_metrics(
    job_id: UUID,
    service: MetricsServiceDep,
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=10000),
    scope: DataScope = Query(default=DataScope.OWN),
) -> MetricPage:
    """Return an ascending keyset page of the job's per-step metrics (all trials)."""
    return await service.get_job_metrics(job_id, after_id=after_id, limit=limit, scope=scope)


@router.get(
    "/{job_id}/trials/{trial_id}/metrics",
    summary="Get a trial's per-step training metrics",
    responses={
        HTTPStatus.FORBIDDEN: _PROBLEM_RESPONSE,
        HTTPStatus.NOT_FOUND: _PROBLEM_RESPONSE,
        **_AUTH_RESPONSES,
    },
)
async def get_trial_metrics(
    job_id: UUID,
    trial_id: str,
    service: MetricsServiceDep,
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=10000),
    scope: DataScope = Query(default=DataScope.OWN),
) -> MetricPage:
    """Return an ascending keyset page of one trial's per-step metrics."""
    return await service.get_trial_metrics(job_id, trial_id, after_id=after_id, limit=limit, scope=scope)
```

- [ ] **Step 5: Write the failing route tests** — append to `tests/api/routers/test_jobs.py` (reuse `client`/`session`/`as_principal`/`user`/`job` fixtures and add a `_seed_metric` helper):

```python
async def _seed_metric(session, job, *, id, trial_id, global_step, loss):
    from autotunex.db.tables import TrainingMetricTable

    session.add(
        TrainingMetricTable(
            id=id,
            job_id=job.id,
            trial_id=trial_id,
            global_step=global_step,
            loss=loss,
            split="train",
        )
    )
    await session.commit()


async def test_get_job_metrics_returns_ascending_page(client, session, as_principal, user, job):
    _act_as(as_principal, user)
    await _seed_metric(session, job, id=1, trial_id="t1", global_step=10, loss=3.0)
    await _seed_metric(session, job, id=2, trial_id="t1", global_step=20, loss=2.0)

    response = await client.get(f"{API}/jobs/{job.id}/metrics")

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert [p["global_step"] for p in body["metrics"]] == [10, 20]
    assert body["has_more"] is False


async def test_get_trial_metrics_filters_by_trial(client, session, as_principal, user, job):
    _act_as(as_principal, user)
    await _seed_metric(session, job, id=1, trial_id="t1", global_step=1, loss=1.0)
    await _seed_metric(session, job, id=2, trial_id="t2", global_step=1, loss=2.0)

    response = await client.get(f"{API}/jobs/{job.id}/trials/t2/metrics")

    body = response.json()
    assert [p["loss"] for p in body["metrics"]] == [2.0]


async def test_get_job_metrics_of_another_users_job_is_404(client, session, as_principal, user, job, other_user):
    _act_as(as_principal, other_user)
    response = await client.get(f"{API}/jobs/{job.id}/metrics")
    assert response.status_code == HTTPStatus.NOT_FOUND
```

(If the file has no `other_user` fixture, model the 404 test on the existing `test_get_job_logs_of_another_users_job_is_404` in the same file — reuse whatever fixture it uses for a second principal.)

- [ ] **Step 6: Run to confirm they fail, then that they pass** after Steps 1–4 are in:

Run: `pytest tests/api/routers/test_jobs.py -k metrics -v`
Expected: PASS (3).

- [ ] **Step 7: Full suite + lint**

Run: `pytest -q && ruff check src/autotunex/models/metric.py src/autotunex/services/metrics.py src/autotunex/api/deps.py src/autotunex/api/routers/jobs.py`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/autotunex/models/metric.py src/autotunex/services/metrics.py src/autotunex/api/deps.py src/autotunex/api/routers/jobs.py tests/api/routers/test_jobs.py
git commit -m "feat(api): read-back endpoints for per-step training metrics"
```

---

## Task B7: End-to-end verification + subtree sync

**Files:** none (verification + vendoring).

- [ ] **Step 1: Local end-to-end smoke.** After landing the fm-tune changes into AutotuneX's `src/fm-tune/` (Step 3 below), run a tiny `AUTOTUNEX_JOB_BACKEND=local` job (smallest model/dataset available) and confirm `training_metrics` rows appear:

```bash
AUTOTUNEX_DATABASE_URL="sqlite:///./autotunex.db" \
  sqlite3 autotunex.db "SELECT trial_id, global_step, loss FROM training_metrics ORDER BY id LIMIT 5;"
```
Expected: rows with real `loss`/`global_step`, and the printed `@@FMTUNE_METRIC@@` lines NOT present as `log_entries` rows for those steps.

- [ ] **Step 2: Read-API smoke.** `GET /api/v1/jobs/{job_id}/metrics` returns the ascending series.

- [ ] **Step 3: Vendor the fm-tune changes** (only after Phase A is committed/pushed on the `fm-tune` `oss-main` branch), from the AutotuneX repo root:

```bash
git subtree pull --prefix=src/fm-tune fm-tune oss-main --squash
```
Do **not** reformat `src/fm-tune/` and do **not** amend the squash commit. Confirm `src/fm-tune/autotune/callbacks/training_metrics.py` and the driver edits are present.

- [ ] **Step 4: Confirm the marker constants match** across the boundary: fm-tune `METRIC_MARKER` == AutotuneX `FMTUNE_METRIC_MARKER` == `@@FMTUNE_METRIC@@`.

- [ ] **Step 5: Final full test run** in AutotuneX (main + api-bridge):

```bash
pytest -q
cd src/api-bridge && pytest -q
```
Expected: green.

- [ ] **Step 6: Commit / open PRs** on both repos' feature branches (do not merge without review).

---

## Notes & follow-ups (out of scope for this plan)

- **verl** (`driver_multi_verl.py`, `_InMemoryMetricsLogger`) and **MLX** (`autotune/mlx_backend.py`) metric emission — the `training_metrics` schema (nullable numeric columns + `extra` JSON) already accommodates their keys (reward/kl); wiring is a later additive task.
- **UI training-curve chart** (Carbon `@carbon/charts-svelte`) — deferred.
- **Batching** — immediate emit per log event is fine at `logging_steps ≈ 10/epoch`; revisit if lowered.
