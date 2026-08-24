# Copyright IBM Corp. 2024-2026
# SPDX-License-Identifier: Apache-2.0
"""Storage backend selection from settings (the ``ArtifactStore`` seam)."""

from __future__ import annotations

import os
import shutil
from urllib.parse import urlparse

from autotunex.core.config import Settings
from autotunex.core.exceptions import JobArtifactsNotFoundError
from autotunex.core.logging import get_logger
from autotunex.services.storage.artifacts import ArtifactLister
from autotunex.services.storage.base import StorageBackend
from autotunex.services.storage.fallback import PreviewFallbackStorageBackend
from autotunex.services.storage.hf_viewer import repo_id_from_artifact_url
from autotunex.services.storage.huggingface import HuggingFaceStorageBackend
from autotunex.services.storage.local import LocalStorageBackend

logger = get_logger(__name__)


def _huggingface(settings: Settings) -> HuggingFaceStorageBackend:
    return HuggingFaceStorageBackend(
        llmb_command=settings.llmb_command,
        hf_token_env=settings.hf_token_env,
        gb_token_env=settings.gb_token_env,
        hf_namespace=settings.hf_namespace,
        hf_preview_enabled=settings.hf_preview_enabled,
        hf_viewer_base_url=settings.hf_viewer_base_url,
        hf_viewer_timeout_seconds=settings.hf_viewer_timeout_seconds,
        tags=settings.gb_tags,
        push_timeout_seconds=settings.dataset_push_timeout_seconds,
    )


def _huggingface_with_local_fallback(settings: Settings) -> PreviewFallbackStorageBackend:
    """HuggingFace primary with a local-storage preview fallback.

    When the HF viewer cannot serve a preview (no ``artifact_url``, viewer
    disabled/unavailable, or token missing) the wrapper reads the preview from
    the same local directory the local backend uses, so datasets whose files also
    live on disk still render rather than showing "Unable to load dataset".
    """
    return PreviewFallbackStorageBackend(
        primary=_huggingface(settings),
        fallback=LocalStorageBackend(root=settings.dataset_storage_dir),
    )


def _llmb_enabled(settings: Settings) -> bool:
    """Usable when ``llmb`` resolves and BOTH tokens are present.

    The HF push needs two credentials: the GB token authenticates the CLI
    (``llmb auth login``) and the HF token is the push destination (``--store hf``),
    so ``auto`` only chooses HuggingFace when both env vars are set.
    """
    return bool(
        shutil.which(settings.llmb_command)
        and os.environ.get(settings.gb_token_env)
        and os.environ.get(settings.hf_token_env)
    )


def get_storage_backend(settings: Settings) -> StorageBackend:
    """Return the storage backend chosen by ``dataset_storage_backend``.

    ``"local"``/``"huggingface"`` force the choice (a forced ``huggingface`` with
    either token missing is already refused at settings validation). ``"auto"``
    resolves to HuggingFace only when ``llmb`` and both tokens are available, else
    local. Whenever the choice is HuggingFace the backend is wrapped with a local
    preview fallback (:func:`_huggingface_with_local_fallback`); a plain ``local``
    backend has nothing to fall back to and is returned unwrapped.
    """
    if settings.dataset_storage_backend == "local":
        return LocalStorageBackend(root=settings.dataset_storage_dir)
    if settings.dataset_storage_backend == "huggingface":
        return _huggingface_with_local_fallback(settings)
    if _llmb_enabled(settings):
        return _huggingface_with_local_fallback(settings)
    logger.info(
        "dataset_storage_backend=auto: llmb or %s/%s unavailable, using local storage.",
        settings.gb_token_env,
        settings.hf_token_env,
    )
    return LocalStorageBackend(root=settings.dataset_storage_dir)


def resolve_artifact_lister(
    artifact_uri: str, *, filesystem: ArtifactLister, huggingface: ArtifactLister
) -> tuple[ArtifactLister, str]:
    """Return the ``(lister, location)`` for a stored ``artifact_uri``, by scheme.

    ``hf://`` yields the HuggingFace lister and the derived ``owner/repo`` id;
    ``file://`` yields the filesystem lister and the local path. An unrecognised
    scheme, or a value that yields no repo id / path, raises
    :class:`JobArtifactsNotFoundError`.
    """
    uri = artifact_uri.strip()
    if uri.startswith("hf://"):
        repo_id = repo_id_from_artifact_url(uri)
        if repo_id is None:
            raise JobArtifactsNotFoundError
        return huggingface, repo_id
    if uri.startswith("file://"):
        path = urlparse(uri).path
        if not path:
            raise JobArtifactsNotFoundError
        return filesystem, path
    raise JobArtifactsNotFoundError
