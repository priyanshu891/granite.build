"""Tests for the health endpoint."""

from __future__ import annotations

from httpx import AsyncClient


async def test_health_reports_ok(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_health_reports_service_name_and_version(client: AsyncClient) -> None:
    response = await client.get("/health")

    body = response.json()
    assert body["service"] == "AutoTuneX API"
    assert body["version"]


async def test_openapi_schema_is_served(client: AsyncClient) -> None:
    response = await client.get("/openapi.json")

    assert response.status_code == 200
    assert "/api/v1/jobs" in response.json()["paths"]
