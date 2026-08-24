# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""Health check endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from autotunex import __version__
from autotunex.api.deps import SettingsDep
from autotunex.models.common import HealthResponse

router = APIRouter(tags=["meta"])


@router.get("/health", summary="Liveness probe")
async def health(settings: SettingsDep) -> HealthResponse:
    """Report that the service is up.

    Does not touch the database — this is a liveness probe, not a readiness one.
    """
    return HealthResponse(status="ok", service=settings.app_name, version=__version__)
