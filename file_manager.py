"""文件管理组件：受限目录配置、目录缓存、浏览与下载。"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode

from fastapi import HTTPException

from auth import get_settings_section, update_settings_section


DEFAULT_ROOT = "~/reproduce"
MAX_ROOTS = 24
MAX_DIRECTORY_ENTRIES = 1_000
CACHE_TTL_SECONDS = 15
IGNORED_DIRECTORY_NAMES = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".venv", "venv"}


@dataclass(frozen=True)
class DirectoryRecord:
    """单个目录条目的缓存记录。"""

    name: str
    path: str
    type: "directory" | "file" | "other"
    size: int
    modified: float
    extension: str


_DIRECTORY_CACHE: dict[tuple[Path, str], tuple[float, list[DirectoryRecord], int]] = {}
_DIRECTORY_OPTIONS_CACHE: dict[tuple[Path, ...], tuple[float, list[dict[str, str]], bool]] = {}
_CACHE_LOCK = threading.RLock()


def _default_roots() -> list[str]:
    """首次使用时只暴露当前用户的 reproduce 目录。"""
    return [DEFAULT_ROOT] if Path(DEFAULT_ROOT).expanduser().is_dir() else []


def _normalize_root_text(value: object) -> str:
    """校验可保存的顶层目录文本，保留 ~ 以便设置文件可迁移。"""
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="顶层目录必须是字符串")
    text = value.strip()
    if not text:
        raise HTTPException(status_code=422, detail="顶层目录不能为空")
    if len(text) > 1_024:
        raise HTTPException(status_code=422, detail="顶层目录过长")
    expanded = Path(text).expanduser()
    if not expanded.is_absolute():
        raise HTTPException(status_code=422, detail="顶层目录请使用绝对路径或以 ~/ 开头")
    return text


def _resolve_root(root_text: str) -> Path:
    """展开并规范化顶层目录，确保它是可浏览的真实目录。"""
    root = Path(root_text).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(status_code=422, detail=f"顶层目录不存在或不是目录：{root_text}")
    return root


def resolve_root(root_text: str) -> Path:
    """供复用模块展开并校验文件管理顶层目录。"""
    return _resolve_root(root_text)


def configured_roots() -> list[str]:
    """读取文件管理组件暴露的顶层目录；未配置时默认仅暴露 ~/reproduce。"""
    value = get_settings_section("file_manager")
    if isinstance(value, dict) and isinstance(value.get("roots"), list):
        return [item for item in value["roots"] if isinstance(item, str)]

    # 兼容早期点云查看器单独保存的 roots；空列表不再阻止默认 reproduce 暴露。
    legacy = get_settings_section("point_cloud")
    if isinstance(legacy, dict) and isinstance(legacy.get("roots"), list) and legacy["roots"]:
        return [item for item in legacy["roots"] if isinstance(item, str)]
    return _default_roots()


def save_roots(values: object) -> list[str]:
    """保存文件管理组件的顶层目录，拒绝无效或重复路径。"""
    if not isinstance(values, list):
        raise HTTPException(status_code=422, detail="roots 必须是目录数组")
    if len(values) > MAX_ROOTS:
        raise HTTPException(status_code=422, detail=f"最多可配置 {MAX_ROOTS} 个顶层目录")

    roots: list[str] = []
    seen: set[Path] = set()
    for item in values:
        text = _normalize_root_text(item)
        resolved = _resolve_root(text)
        if resolved in seen:
            continue
        seen.add(resolved)
        roots.append(text)

    update_settings_section("file_manager", {"roots": roots})
    clear_directory_cache()
    return roots


def _normalize_relative_path(value: str) -> str:
    """校验目录相对路径，拒绝空段、.、.. 与反斜杠。"""
    if not value or value == ".":
        return ""
    if "\\" in value or len(value) > 4_096:
        raise HTTPException(status_code=422, detail="目录路径格式不受支持")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise HTTPException(status_code=422, detail="目录路径格式不受支持")
    return "/".join(parts)


def _scan_directory(root: Path, relative_path: str) -> tuple[list[DirectoryRecord], bool]:
    """读取单个目录的直接子项，并按文件夹、名称稳定排序。"""
    directory = root if not relative_path else root / relative_path
    records: list[DirectoryRecord] = []
    truncated = False
    try:
        with os.scandir(directory) as iterator:
            for item in iterator:
                try:
                    if item.is_dir(follow_symlinks=False) and item.name in IGNORED_DIRECTORY_NAMES:
                        continue
                    stat = item.stat(follow_symlinks=False)
                    child_path = f"{relative_path}/{item.name}" if relative_path else item.name
                    if item.is_dir(follow_symlinks=False):
                        record_type: "directory" | "file" | "other" = "directory"
                        size = 0
                        extension = ""
                    elif item.is_file(follow_symlinks=False):
                        record_type = "file"
                        size = stat.st_size
                        extension = Path(item.name).suffix.lower().removeprefix(".")
                    else:
                        record_type = "other"
                        size = 0
                        extension = ""
                    records.append(DirectoryRecord(item.name, child_path, record_type, size, stat.st_mtime, extension))
                except OSError:
                    continue
                if len(records) >= MAX_DIRECTORY_ENTRIES:
                    truncated = True
                    break
    except OSError as exc:
        raise HTTPException(status_code=404, detail="目录不存在或无法读取") from exc

    records.sort(key=lambda record: (record.type != "directory", record.name.lower(), record.name))
    return records, truncated


def _directory_records(
    root_text: str,
    relative_path: str,
    *,
    refresh: bool = False,
) -> tuple[list[DirectoryRecord], bool, float]:
    """读取目录记录；TTL 内复用缓存，refresh 时强制同步。"""
    root = _resolve_root(root_text)
    safe_path = _normalize_relative_path(relative_path)
    key = (root, safe_path)
    directory = root if not safe_path else root / safe_path
    try:
        directory_mtime = directory.stat().st_mtime_ns
    except OSError as exc:
        raise HTTPException(status_code=404, detail="目录不存在或无法读取") from exc

    now = time.time()
    with _CACHE_LOCK:
        cached = _DIRECTORY_CACHE.get(key)
        if (
            not refresh
            and cached
            and now - cached[0] < CACHE_TTL_SECONDS
            and cached[2] == directory_mtime
        ):
            return cached[1], True, cached[0]

    records, _ = _scan_directory(root, safe_path)
    generated_at = time.time()
    with _CACHE_LOCK:
        _DIRECTORY_CACHE[key] = (generated_at, records, directory.stat().st_mtime_ns)
    return records, False, generated_at


def _entry_payload(record: DirectoryRecord, root_index: int) -> dict[str, Any]:
    """生成前端浏览和下载所需的目录条目。"""
    payload: dict[str, Any] = {
        "name": record.name,
        "path": record.path,
        "type": record.type,
        "size": record.size,
        "modified": record.modified,
        "extension": record.extension,
    }
    if record.type == "file":
        payload["download_url"] = f"/api/file-manager/download?{urlencode({'root': root_index, 'path': record.path})}"
    return payload


def list_directory(root_index: int, relative_path: str, *, refresh: bool = False) -> dict[str, Any]:
    """返回某个已暴露顶层目录内的直接文件与文件夹。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root_text = roots[root_index]
    records, cached, generated_at = _directory_records(root_text, relative_path, refresh=refresh)
    return {
        "root_index": root_index,
        "root_path": root_text,
        "path": _normalize_relative_path(relative_path),
        "entries": [_entry_payload(record, root_index) for record in records],
        "cached": cached,
        "generated_at": generated_at,
        "expires_at": generated_at + CACHE_TTL_SECONDS,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
        "max_entries": MAX_DIRECTORY_ENTRIES,
        "truncated": len(records) >= MAX_DIRECTORY_ENTRIES,
    }


def iter_root_files(
    root_text: str,
    extensions: Iterable[str],
    *,
    max_files: int,
    refresh: bool = False,
    scope: str = "",
) -> tuple[Path, list[Path], bool]:
    """递归发现指定后缀文件，只对命中的文件执行 stat，供点云等模块复用。"""
    root = _resolve_root(root_text)
    allowed = {extension.lower().lstrip(".") for extension in extensions}
    safe_scope = _normalize_relative_path(scope)
    files: list[Path] = []
    truncated = False
    pending: deque[str] = deque([safe_scope])

    while pending:
        relative_path = pending.popleft()
        directory = root if not relative_path else root / relative_path
        try:
            with os.scandir(directory) as iterator:
                children = sorted(iterator, key=lambda item: item.name.lower())
        except OSError as exc:
            # 递归扫描时单个子目录不可读不应导致整次扫描失败；范围本身不可读时返回明确错误。
            if relative_path == safe_scope:
                raise HTTPException(status_code=404, detail=f"目录不存在或无法读取：{relative_path or root_text}") from exc
            continue

        for item in children:
            child_path = f"{relative_path}/{item.name}" if relative_path else item.name
            try:
                if item.is_dir(follow_symlinks=False):
                    if item.name in IGNORED_DIRECTORY_NAMES or item.name.startswith("."):
                        continue
                    pending.append(child_path)
                    continue
                if not item.is_file(follow_symlinks=False) or Path(item.name).suffix.lower().lstrip(".") not in allowed:
                    continue
                files.append(root / child_path)
            except OSError:
                continue
            if len(files) >= max_files:
                truncated = True
                pending.clear()
                break
        if truncated:
            break
    return root, files, truncated



def directory_options(root_index: int, *, refresh: bool = False) -> dict[str, Any]:
    """返回某个顶层目录内的文件夹选项，供点云等模块选择扫描范围。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root_texts = roots[root_index:root_index + 1]
    cache_key = tuple(_resolve_root(root_text) for root_text in root_texts)
    now = time.time()
    with _CACHE_LOCK:
        cached = _DIRECTORY_OPTIONS_CACHE.get(cache_key)
        if not refresh and cached and now - cached[0] < CACHE_TTL_SECONDS:
            generated_at, options, truncated = cached
            return {
                "root_index": root_index,
                "root_path": roots[root_index],
                "directories": options,
                "truncated": truncated,
                "max_directories": 10_000,
                "cached": True,
                "generated_at": generated_at,
                "cache_ttl_seconds": CACHE_TTL_SECONDS,
            }

    root_text = roots[root_index]
    root = _resolve_root(root_text)
    options: list[dict[str, str]] = [{"path": "", "name": root.name or root_text}]
    truncated = False
    pending: deque[str] = deque([""])

    while pending:
        relative_path = pending.popleft()
        directory = root if not relative_path else root / relative_path
        try:
            with os.scandir(directory) as iterator:
                children = sorted(iterator, key=lambda item: item.name.lower())
        except OSError:
            continue
        for item in children:
            try:
                if not item.is_dir(follow_symlinks=False):
                    continue
                if item.name in IGNORED_DIRECTORY_NAMES or item.name.startswith("."):
                    continue
                child_path = f"{relative_path}/{item.name}" if relative_path else item.name
                options.append({"path": child_path, "name": item.name})
                pending.append(child_path)
            except OSError:
                continue
            if len(options) >= 10_000:
                truncated = True
                pending.clear()
                break
        if truncated:
            break

    options.sort(key=lambda item: (item["path"] == "", item["path"].lower()))
    generated_at = time.time()
    with _CACHE_LOCK:
        _DIRECTORY_OPTIONS_CACHE[cache_key] = (generated_at, options, truncated)
    return {
        "root_index": root_index,
        "root_path": root_text,
        "directories": options,
        "truncated": truncated,
        "max_directories": 10_000,
        "cached": False,
        "generated_at": generated_at,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }


def resolve_file(root_index: int, relative_path: str) -> Path:
    """只允许下载已暴露顶层目录内部的普通文件。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    candidate = (root / _normalize_relative_path(relative_path)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="文件路径不在允许的顶层目录内") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="文件不存在或不是普通文件")
    return candidate


def clear_directory_cache() -> None:
    """清空目录与文件夹选项缓存，下一次访问会重新同步磁盘状态。"""
    with _CACHE_LOCK:
        _DIRECTORY_CACHE.clear()
        _DIRECTORY_OPTIONS_CACHE.clear()


def sync_roots() -> dict[str, Any]:
    """手动同步所有已暴露目录；先清空缓存，由后续浏览或扫描按需重建。"""
    clear_directory_cache()
    return {
        "roots": configured_roots(),
        "synced_at": time.time(),
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }
