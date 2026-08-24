.DEFAULT_GOAL := help
.PHONY: help install install-locked install-training lock audit dev dev-api-bridge docker-api-bridge docker-runtime test test-cov lint format typecheck check migration migrate migrations-check downgrade clean oss-export oss-export-dry oss-doctor

PYTHON ?= python
PORT ?= 8000
API_BRIDGE_PORT ?= 8001
API_BRIDGE_IMAGE ?= autotunex-api-bridge:local
RUNTIME_IMAGE ?= autotunex-runtime:local
INSTALL_POSTGRES ?= 0
GH_USER ?=
GH_TOKEN ?=

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Install the package with dev dependencies
	uv pip install -e ".[dev]" || $(PYTHON) -m pip install -e ".[dev]"
	uv pip install -e "./src/fm-tune" || $(PYTHON) -m pip install -e "./src/fm-tune"

install-locked:  ## Install the exact, hash-verified set from requirements.lock (use in CI)
	uv pip sync requirements.lock
	uv pip install -e . --no-deps

install-training:  ## Also install the heavy fm-tune training stack ([full],mlx) for the local runner
	uv pip install -e "./src/fm-tune[full,mlx]" || $(PYTHON) -m pip install -e "./src/fm-tune[full,mlx]"

lock:  ## Regenerate requirements.lock from the pins in pyproject.toml
	uv pip compile --python-version 3.11 --generate-hashes \
		-o requirements.lock pyproject.toml --extra dev --extra postgres --extra mysql

audit:  ## Fail if any locked dependency has a known CVE
	uvx pip-audit -r requirements.lock

dev:  ## Run the API locally with autoreload
	uvicorn autotunex.main:app --reload --port $(PORT)

dev-api-bridge:  ## Run the api-bridge logging server on port 8001 (override API_BRIDGE_PORT=...; needs: pip install ./src/api-bridge)
	cd src/api-bridge && API_BRIDGE_SERVER_PORT=$(API_BRIDGE_PORT) PYTHONPATH=src $(PYTHON) -m api_bridge.server

docker-api-bridge:  ## Build the api-bridge image (override API_BRIDGE_IMAGE=...; add INSTALL_POSTGRES=1 for psycopg)
	docker build -t $(API_BRIDGE_IMAGE) --build-arg INSTALL_POSTGRES=$(INSTALL_POSTGRES) src/api-bridge

docker-runtime:  ## Build the internal CUDA training-runtime image (needs GH_USER=... GH_TOKEN=... for the step-sdk clone)
	@test -n "$(GH_USER)" && test -n "$(GH_TOKEN)" || (echo 'Usage: make docker-runtime GH_USER=... GH_TOKEN=...' && exit 1)
	docker build -f docker/runtime/Dockerfile -t $(RUNTIME_IMAGE) \
		--build-arg GH_USER="$(GH_USER)" --build-arg GH_TOKEN="$(GH_TOKEN)" docker/runtime

test:  ## Run the test suite
	pytest

test-cov:  ## Run tests with a coverage report
	pytest --cov=autotunex --cov-report=term-missing --cov-report=xml

lint:  ## Check lint and formatting
	ruff check .
	ruff format --check .
	ruff check src/api-bridge
	ruff format --check src/api-bridge
	ruff check src/fm-tune
	ruff format --check src/fm-tune

format:  ## Apply lint fixes and formatting
	ruff check --fix .
	ruff format .
	ruff check --fix src/api-bridge
	ruff format src/api-bridge
	ruff check --fix src/fm-tune
	ruff format src/fm-tune

typecheck:  ## Run mypy in strict mode
	mypy

check: lint typecheck test  ## Everything CI runs

migration:  ## Autogenerate a migration: make migration m="add trials table"
	@test -n "$(m)" || (echo 'Usage: make migration m="description"' && exit 1)
	alembic revision --autogenerate -m "$(m)"

migrate:  ## Apply migrations up to head
	alembic upgrade head

migrations-check:  ## Fail if db/tables.py has drifted from the migrations
	alembic check

downgrade:  ## Roll back one migration
	alembic downgrade -1

clean:  ## Remove caches and build artifacts
	rm -rf build dist .pytest_cache .mypy_cache .ruff_cache htmlcov .coverage coverage.xml
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type d -name '*.egg-info' -prune -exec rm -rf {} +

oss-export:  ## Compose, gate, and commit the OSS export onto the oss-export branch
	bash .github/scripts/oss-export.sh

oss-export-dry:  ## Dry-run the OSS export: compose, gate, report the file list, write nothing
	bash .github/scripts/oss-export.sh --dry-run

oss-doctor:  ## Check the environment is ready to run the OSS export
	bash .github/scripts/oss-doctor.sh
