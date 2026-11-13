"""文件管理组件：受限目录配置、目录缓存、浏览与下载。"""

from __future__ import annotations

import logging
import math
import os
import re
import subprocess
import threading
import time
from datetime import date, datetime
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect

from auth import get_settings_section, update_settings_section


DEFAULT_ROOT = "~"
MAX_ROOTS = 24
MAX_DIRECTORY_ENTRIES = 1_000
MAX_FAVORITES = 100
MAX_DATE_SEARCH_FOLDERS = 24
MAX_MARKDOWN_FILES = 2_000
MAX_MARKDOWN_FILE_BYTES = 3 * 1024 * 1024
MAX_GIT_PULL_SECONDS = 120
PROJECT_DOCUMENT_DIRECTORY = Path("LIHAN") / "DOC"
MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024 * 1024
MIN_UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024
UPLOAD_SESSION_TTL_SECONDS = 6 * 60 * 60
CACHE_TTL_SECONDS = 60 * 60
SYNC_DIRECTORIES = {
    "RadioGS-perlight": Path("/home/lihan/reproduce/RadioGS-perlight"),
    "RadioGS-stage1": Path("/home/lihan/reproduce/RadioGS-stage1"),
}
IGNORED_DIRECTORY_NAMES = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".venv", "venv"}


@dataclass
class UploadSession:
    """分片上传会话：临时文件预分配大小，各分片按偏移并发写入，全部到齐后原子替换。"""

    id: str
    username: str
    root: Path
    root_index: int
    directory: str
    full_path: str
    target: Path
    temp_path: Path
    size: int
    chunk_size: int
    total_chunks: int
    overwrite: bool
    received: set[int]
    created: float
    updated: float


_UPLOAD_SESSIONS: dict[str, UploadSession] = {}


@dataclass(frozen=True)
class DirectoryRecord:
    """单个目录条目的缓存记录。"""

    name: str
    path: str
    type: "directory" | "file" | "other"
    size: int
    modified: float
    extension: str
    symlink: bool = False


_DIRECTORY_CACHE: dict[tuple[Path, str], tuple[float, list[DirectoryRecord], int]] = {}
_PLY_CACHE: dict[tuple[Path, str], tuple[float, list[DirectoryRecord]]] = {}
_MARKDOWN_CACHE: dict[tuple[Path, str], tuple[float, list[DirectoryRecord]]] = {}
_CACHE_LOCK = threading.RLock()
_UPLOAD_LOCK = threading.Lock()
# 写入 uvicorn.error，使上传日志与访问日志一起出现在 journalctl 中。
logger = logging.getLogger("uvicorn.error")
_SYNC_LOCK = threading.Lock()
_FAVORITES_LOCK = threading.RLock()
_DATE_SEARCH_DEFAULTS = (
    "~/reproduce/RadioGS-perlight",
    "~/reproduce/RadioGS-stage1",
    "~/reproduce/LumiMotion",
    "~/reproduce/LumiMotion-perlight",
)


def _default_roots() -> list[str]:
    """首次使用时暴露当前用户的家目录。"""
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
    """读取文件管理组件暴露的顶层目录；未配置时默认暴露 ~（家目录）。"""
    value = get_settings_section("file_manager")
    if isinstance(value, dict) and isinstance(value.get("roots"), list):
        return [item for item in value["roots"] if isinstance(item, str)]

    # 兼容早期点云查看器单独保存的 roots；空列表不再阻止默认家目录暴露。
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
    if "\\" in value or len(value) > 4_096 or any(ord(char) < 32 or char == "\x7f" for char in value):
        raise HTTPException(status_code=422, detail="目录路径格式不受支持")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise HTTPException(status_code=422, detail="目录路径格式不受支持")
    return "/".join(parts)


def _resolve_relative(root: Path, relative_path: str) -> Path:
    """按字面逐段解析顶层目录内的相对路径，并跟随其中出现的符号链接。

    顶层目录里的符号链接由管理员在服务器上手动创建，等同于显式开放链接指向的位置，
    因此跳转后的真实路径允许位于顶层目录之外；`..`、空段等越界写法仍然拒绝。
    """
    current = root
    for part in relative_path.split("/") if relative_path else []:
        if part in ("", ".", ".."):
            raise HTTPException(status_code=404, detail="目录路径格式不受支持")
        current = current / part
        if current.is_symlink():
            try:
                current = current.resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise HTTPException(status_code=404, detail="路径中的符号链接已失效") from exc
    return current


def _resolve_directory(root: Path, relative_path: str) -> Path:
    """解析受限目录，跟随顶层目录内的符号链接，并拒绝越界写法。"""
    directory = _resolve_relative(root, relative_path)
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在或无法读取")
    return directory


def _scan_directory(directory: Path, relative_path: str) -> tuple[list[DirectoryRecord], bool]:
    """读取单个目录的直接子项，并按文件夹、名称稳定排序。"""
    records: list[DirectoryRecord] = []
    truncated = False
    try:
        with os.scandir(directory) as iterator:
            for item in iterator:
                try:
                    is_link = item.is_symlink()
                    is_directory = item.is_dir()
                    if is_directory and item.name in IGNORED_DIRECTORY_NAMES:
                        continue
                    child_path = f"{relative_path}/{item.name}" if relative_path else item.name
                    if is_directory:
                        record_type: "directory" | "file" | "other" = "directory"
                        size = 0
                        extension = ""
                        stat = item.stat()
                    elif item.is_file():
                        record_type = "file"
                        stat = item.stat()
                        size = stat.st_size
                        extension = Path(item.name).suffix.lower().removeprefix(".")
                    else:
                        record_type = "other"
                        size = 0
                        extension = ""
                        stat = item.stat(follow_symlinks=False)
                    records.append(DirectoryRecord(item.name, child_path, record_type, size, stat.st_mtime, extension, is_link))
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
    directory = _resolve_directory(root, safe_path)
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

    records, _ = _scan_directory(directory, safe_path)
    generated_at = time.time()
    try:
        scanned_mtime = directory.stat().st_mtime_ns
    except OSError as exc:
        raise HTTPException(status_code=404, detail="目录不存在或无法读取") from exc
    with _CACHE_LOCK:
        _DIRECTORY_CACHE[key] = (generated_at, records, scanned_mtime)
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
        "symlink": record.symlink,
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


def _scan_ply_tree(directory: Path, relative_path: str) -> list[DirectoryRecord]:
    """递归读取 PLY 文件，跟随顶层目录内的符号链接，并跳过环形递归。"""
    records: list[DirectoryRecord] = []
    pending = [(directory, relative_path)]
    visited: set[Path] = set()
    while pending:
        current, current_path = pending.pop()
        try:
            real = current.resolve()
        except (OSError, RuntimeError):
            continue
        if real in visited:
            continue
        visited.add(real)
        try:
            with os.scandir(current) as iterator:
                for item in iterator:
                    try:
                        child_path = f"{current_path}/{item.name}" if current_path else item.name
                        if len(child_path) > 4_096:
                            continue
                        if item.is_dir():
                            if item.name not in IGNORED_DIRECTORY_NAMES:
                                pending.append((current / item.name, child_path))
                        elif item.name.lower().endswith(".ply") and item.is_file():
                            stat = item.stat()
                            records.append(DirectoryRecord(item.name, child_path, "file", stat.st_size, stat.st_mtime, "ply", item.is_symlink()))
                    except OSError:
                        continue
        except OSError as exc:
            if current == directory:
                raise HTTPException(status_code=404, detail="目录不存在或无法读取") from exc
            continue
    records.sort(key=lambda record: (record.path.lower(), record.path))
    return records


def list_ply_files(root_index: int, relative_path: str, *, refresh: bool = False) -> dict[str, Any]:
    """返回当前目录及所有子目录中的 PLY 文件，优先复用同步缓存。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    safe_path = _normalize_relative_path(relative_path)
    directory = _resolve_directory(root, safe_path)
    now = time.time()
    with _CACHE_LOCK:
        if not refresh:
            for (cached_root, cached_path), (generated_at, records) in _PLY_CACHE.items():
                if cached_root == root and now - generated_at < CACHE_TTL_SECONDS and (safe_path == cached_path or not cached_path or safe_path.startswith(f"{cached_path}/")):
                    prefix = f"{safe_path}/" if safe_path else ""
                    matches = [record for record in records if record.path.startswith(prefix)]
                    return {"entries": [{**_entry_payload(record, root_index), "relative_path": record.path[len(prefix):]} for record in matches],
                            "cached": True, "generated_at": generated_at, "expires_at": generated_at + CACHE_TTL_SECONDS}
    records = _scan_ply_tree(directory, safe_path)
    generated_at = time.time()
    with _CACHE_LOCK:
        if refresh:
            for key in list(_PLY_CACHE):
                cached_root, cached_path = key
                if cached_root == root and (cached_path == safe_path or not cached_path or not safe_path
                                            or safe_path.startswith(f"{cached_path}/")
                                            or cached_path.startswith(f"{safe_path}/")):
                    del _PLY_CACHE[key]
        _PLY_CACHE[(root, safe_path)] = (generated_at, records)
    prefix = f"{safe_path}/" if safe_path else ""
    return {"entries": [{**_entry_payload(record, root_index), "relative_path": record.path[len(prefix):]} for record in records],
            "cached": False, "generated_at": generated_at, "expires_at": generated_at + CACHE_TTL_SECONDS}


def _scan_markdown_tree(directory: Path, relative_path: str) -> tuple[list[DirectoryRecord], bool]:
    """递归读取 Markdown 文件，跟随顶层目录内的符号链接，限制返回数量并跳过环形递归。"""
    records: list[DirectoryRecord] = []
    pending = [(directory, relative_path)]
    visited: set[Path] = set()
    while pending:
        current, current_path = pending.pop()
        try:
            real = current.resolve()
        except (OSError, RuntimeError):
            continue
        if real in visited:
            continue
        visited.add(real)
        try:
            with os.scandir(current) as iterator:
                for item in iterator:
                    try:
                        child_path = f"{current_path}/{item.name}" if current_path else item.name
                        if len(child_path) > 4_096:
                            continue
                        if item.is_dir():
                            if item.name not in IGNORED_DIRECTORY_NAMES:
                                pending.append((current / item.name, child_path))
                        elif item.is_file():
                            extension = Path(item.name).suffix.lower().removeprefix(".")
                            if extension in {"md", "markdown", "mdown", "mkdn"}:
                                stat = item.stat()
                                records.append(DirectoryRecord(item.name, child_path, "file", stat.st_size, stat.st_mtime, extension, item.is_symlink()))
                                if len(records) >= MAX_MARKDOWN_FILES:
                                    records.sort(key=lambda record: (record.path.lower(), record.path))
                                    return records, True
                    except OSError:
                        continue
        except OSError as exc:
            if current == directory:
                raise HTTPException(status_code=404, detail="目录不存在或无法读取") from exc
            continue
    records.sort(key=lambda record: (record.path.lower(), record.path))
    return records, False


def list_markdown_files(root_index: int, relative_path: str, *, refresh: bool = False) -> dict[str, Any]:
    """返回受限目录及其子目录中的 Markdown 文件，供文档查看器使用。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    safe_path = _normalize_relative_path(relative_path)
    directory = _resolve_directory(root, safe_path)
    key = (root, safe_path)
    now = time.time()
    with _CACHE_LOCK:
        cached = _MARKDOWN_CACHE.get(key)
        if not refresh and cached and now - cached[0] < CACHE_TTL_SECONDS:
            records = cached[1]
            return {
                "root_index": root_index, "path": safe_path,
                "entries": [{**_entry_payload(record, root_index), "relative_path": record.path[len(safe_path) + 1:] if safe_path else record.path} for record in records],
                "cached": True, "generated_at": cached[0], "expires_at": cached[0] + CACHE_TTL_SECONDS,
                "truncated": len(records) >= MAX_MARKDOWN_FILES,
            }
    records, truncated = _scan_markdown_tree(directory, safe_path)
    generated_at = time.time()
    with _CACHE_LOCK:
        _MARKDOWN_CACHE[key] = (generated_at, records)
    return {
        "root_index": root_index, "path": safe_path,
        "entries": [{**_entry_payload(record, root_index), "relative_path": record.path[len(safe_path) + 1:] if safe_path else record.path} for record in records],
        "cached": False, "generated_at": generated_at, "expires_at": generated_at + CACHE_TTL_SECONDS,
        "truncated": truncated,
    }


def read_markdown_file(root_index: int, relative_path: str) -> dict[str, Any]:
    """读取一个大小受限的 UTF-8 Markdown 文件，避免将任意大文件送入浏览器。"""
    file_path = resolve_file(root_index, relative_path)
    if file_path.suffix.lower() not in {".md", ".markdown", ".mdown", ".mkdn"}:
        raise HTTPException(status_code=422, detail="只能查看 Markdown 文件")
    try:
        stat = file_path.stat()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="文件不存在或无法读取") from exc
    if stat.st_size > MAX_MARKDOWN_FILE_BYTES:
        raise HTTPException(status_code=413, detail=f"Markdown 文件不能超过 {MAX_MARKDOWN_FILE_BYTES // (1024 * 1024)} MB")
    try:
        content = file_path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        raise HTTPException(status_code=404, detail="文件不存在或无法读取") from exc
    return {
        "root_index": root_index, "path": _normalize_relative_path(relative_path), "name": file_path.name,
        "content": content, "size": stat.st_size, "modified": stat.st_mtime,
    }


def _date_search_locations(values: object) -> list[tuple[str, int, str]]:
    """校验多个探查目录，并映射到已开放顶层目录的索引与相对路径。"""
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_DATE_SEARCH_FOLDERS:
        raise HTTPException(status_code=422, detail=f"请提供 1 到 {MAX_DATE_SEARCH_FOLDERS} 个探查目录")
    roots = [_resolve_root(text) for text in configured_roots()]
    locations: list[tuple[str, int, str]] = []
    seen: set[Path] = set()
    for value in values:
        text = _normalize_root_text(value)
        directory = Path(text).expanduser().resolve()
        if not directory.is_dir():
            raise HTTPException(status_code=422, detail=f"探查目录不存在：{text}")
        match = next(((index, root) for index, root in enumerate(roots) if directory.is_relative_to(root)), None)
        if match is None:
            raise HTTPException(status_code=422, detail=f"探查目录不在已开放范围：{text}")
        if directory in seen:
            continue
        seen.add(directory)
        index, root = match
        locations.append((text, index, directory.relative_to(root).as_posix() if directory != root else ""))
    return locations


def date_search_folders() -> list[str]:
    """读取已保存的探查目录；首次使用时采用已存在的示例项目。"""
    saved = get_settings_section("ply_date_search")
    if isinstance(saved, list):
        return [value for value in saved if isinstance(value, str)]
    roots = [_resolve_root(text) for text in configured_roots()]
    return [text for text in _DATE_SEARCH_DEFAULTS
            if (directory := Path(text).expanduser().resolve()).is_dir()
            and any(directory.is_relative_to(root) for root in roots)]


def save_date_search_folders(values: object) -> list[str]:
    """将已授权的多个探查目录保存到 settings.json。"""
    folders = [text for text, _, _ in _date_search_locations(values)]
    update_settings_section("ply_date_search", folders)
    return folders


def _date_prefix(value: object) -> tuple[str, str]:
    """解析 YYYY-MM-DD 或 MMDD；旧实验目录只有月日时按月日匹配。"""
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="日期请使用 YYYY-MM-DD 或 MMDD")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            datetime.strptime(value, "%Y-%m-%d")
            return value[:4], value[5:7] + value[8:10]
        if re.fullmatch(r"\d{4}", value):
            datetime.strptime("2000" + value, "%Y%m%d")
            return "", value
    except ValueError:
        pass
    raise HTTPException(status_code=422, detail="日期请使用有效的 YYYY-MM-DD 或 MMDD")


def _matches_date_folder(name: str, year: str, month_day: str) -> bool:
    """只匹配目录名开头的日期，避免文件路径中的其他数字误命中。"""
    short = re.match(rf"^{month_day}(?:$|[-_])", name)
    year_pattern = year or r"\d{4}"
    long = re.match(rf"^{year_pattern}(?:[-_]?{month_day}|[-_]{month_day[:2]}[-_]{month_day[2:]})(?:$|[-_])", name)
    return bool(short or long)


def search_ply_by_date(date: object, iteration: object = 40000) -> dict[str, Any]:
    """跨已保存目录查找指定日期和迭代的 PLY，复用一小时扫描缓存。"""
    year, month_day = _date_prefix(date)
    if iteration is not None and (not isinstance(iteration, int) or isinstance(iteration, bool) or iteration < 0):
        raise HTTPException(status_code=422, detail="迭代次数必须是非负整数，或留空表示全部")
    locations = _date_search_locations(date_search_folders())
    entries: list[dict[str, Any]] = []
    seen_files: set[tuple[int, str]] = set()
    cached = True
    for source_path, root_index, relative_path in locations:
        result = list_ply_files(root_index, relative_path)
        cached = cached and result["cached"]
        for entry in result["entries"]:
            parts = entry["path"].split("/")[:-1]
            date_folder = next((part for part in parts if _matches_date_folder(part, year, month_day)), None)
            if date_folder is None:
                continue
            if iteration is not None and not any(re.fullmatch(rf"(?:iteration|iter)[_-]?{iteration}", part, re.IGNORECASE) for part in parts):
                continue
            file_key = (root_index, entry["path"])
            if file_key in seen_files:
                continue
            seen_files.add(file_key)
            entries.append({**entry, "root_index": root_index, "source_path": source_path, "date_folder": date_folder})
    entries.sort(key=lambda entry: (entry["source_path"].lower(), entry["path"].lower()))
    return {"entries": entries, "date": date, "iteration": iteration, "cached": cached}


def _parse_range_date(value: object) -> date:
    """解析日期范围端点使用的完整日期。"""
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise HTTPException(status_code=422, detail="日期范围请使用 YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="日期范围包含无效日期") from exc


def _folder_date(name: str) -> tuple[int | None, int, int] | None:
    """提取实验目录名开头的完整日期或四位月日。"""
    for pattern in (r"^(\d{4})[-_](\d{2})[-_](\d{2})(?:$|[-_])",
                    r"^(\d{4})[-_]?(\d{2})(\d{2})(?:$|[-_])"):
        if match := re.match(pattern, name):
            return int(match[1]), int(match[2]), int(match[3])
    if match := re.match(r"^(\d{2})(\d{2})(?:$|[-_])", name):
        return None, int(match[1]), int(match[2])
    return None


def _date_in_range(parts: list[str], start: date, end: date) -> tuple[date, str] | None:
    """从靠近文件的目录开始匹配日期；无年份目录按查询范围推断年份。"""
    for part in reversed(parts):
        parsed = _folder_date(part)
        if parsed is None:
            continue
        year, month, day = parsed
        for candidate_year in ([year] if year is not None else range(end.year, start.year - 1, -1)):
            try:
                candidate = date(candidate_year, month, day)
            except ValueError:
                continue
            if start <= candidate <= end:
                return candidate, part
    return None


def _iteration_in_path(parts: list[str]) -> tuple[int, tuple[str, ...]] | None:
    """识别 iteration_40000、iter40000 等目录，并给出所属输出组。"""
    for index in range(len(parts) - 1, -1, -1):
        if match := re.fullmatch(r"(?:iteration|iter)[_-]?(\d+)", parts[index], re.IGNORECASE):
            return int(match[1]), tuple(parts[:index])
    return None


def search_ply_by_range(start_date: object, end_date: object, iteration_mode: object = "latest",
                        iteration: object = None, refresh: bool = False) -> dict[str, Any]:
    """按日期范围查找 PLY；可选每组最新、指定迭代或全部文件。"""
    start, end = _parse_range_date(start_date), _parse_range_date(end_date)
    if start > end:
        raise HTTPException(status_code=422, detail="开始日期不能晚于结束日期")
    if iteration_mode not in ("latest", "exact", "all"):
        raise HTTPException(status_code=422, detail="迭代过滤方式无效")
    if iteration_mode == "exact" and (not isinstance(iteration, int) or isinstance(iteration, bool) or iteration < 0):
        raise HTTPException(status_code=422, detail="指定迭代需要非负整数")
    if not isinstance(refresh, bool):
        raise HTTPException(status_code=422, detail="刷新参数无效")

    entries: list[dict[str, Any]] = []
    seen_files: set[tuple[int, str]] = set()
    latest_by_group: dict[tuple[int, tuple[str, ...]], int] = {}
    cached = True
    for source_path, root_index, relative_path in _date_search_locations(date_search_folders()):
        result = list_ply_files(root_index, relative_path, refresh=refresh)
        cached = cached and result["cached"]
        for entry in result["entries"]:
            parts = entry["path"].split("/")[:-1]
            matched = _date_in_range(parts, start, end)
            if matched is None:
                continue
            iteration_info = _iteration_in_path(parts)
            if iteration_mode == "exact" and (iteration_info is None or iteration_info[0] != iteration):
                continue
            if iteration_mode == "latest" and iteration_info is None:
                continue
            file_key = (root_index, entry["path"])
            if file_key in seen_files:
                continue
            seen_files.add(file_key)
            matched_date, date_folder = matched
            entries.append({**entry, "root_index": root_index, "source_path": source_path,
                            "date_folder": date_folder, "experiment_date": matched_date.isoformat(),
                            "iteration_number": iteration_info[0] if iteration_info else None})
            if iteration_mode == "latest" and iteration_info:
                group_key = (root_index, iteration_info[1])
                latest_by_group[group_key] = max(latest_by_group.get(group_key, -1), iteration_info[0])
    if iteration_mode == "latest":
        entries = [entry for entry in entries
                   if entry["iteration_number"] == latest_by_group[(entry["root_index"],
                       _iteration_in_path(entry["path"].split("/")[:-1])[1])]]
    entries.sort(key=lambda entry: (entry["experiment_date"], entry["source_path"].lower(), entry["path"].lower()), reverse=True)
    return {"entries": entries, "start_date": start.isoformat(), "end_date": end.isoformat(),
            "iteration_mode": iteration_mode, "iteration": iteration if iteration_mode == "exact" else None, "cached": cached}


def resolve_file(root_index: int, relative_path: str) -> Path:
    """只允许下载已暴露顶层目录内部的普通文件，允许路径经过目录内的符号链接。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    candidate = _resolve_relative(root, _normalize_relative_path(relative_path))
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="文件不存在或不是普通文件")
    return candidate


def _upload_parent(root: Path, file_path: str) -> Path:
    """逐段创建上传父目录，跟随顶层目录内的符号链接，并拒绝被忽略的缓存目录。"""
    parts = file_path.split("/")
    if any(part in IGNORED_DIRECTORY_NAMES for part in parts[:-1]):
        raise HTTPException(status_code=422, detail="上传路径包含服务端忽略的目录")

    current = root
    for part in parts[:-1]:
        candidate = current / part
        if candidate.is_symlink():
            try:
                target = candidate.resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise HTTPException(status_code=422, detail=f"上传路径中的符号链接已失效：{part}") from exc
            if not target.is_dir():
                raise HTTPException(status_code=409, detail="上传目标路径中存在同名文件")
            current = target
            continue
        if candidate.exists():
            if not candidate.is_dir():
                raise HTTPException(status_code=409, detail="上传目标路径中存在同名文件")
        else:
            try:
                candidate.mkdir()
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"创建上传目录失败：{exc}") from exc
        current = candidate
    return current / parts[-1]


def _invalidate_root_caches(root: Path) -> None:
    """上传成功后清空该顶层目录的目录与 PLY 缓存，避免列表显示旧状态。"""
    with _CACHE_LOCK:
        for cache in (_DIRECTORY_CACHE, _PLY_CACHE, _MARKDOWN_CACHE):
            for key in list(cache):
                if key[0] == root:
                    del cache[key]


async def upload_file(
    root_index: int,
    relative_path: str,
    file_path: str,
    request: Request,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """把上传内容原子写入当前受限目录，支持保留拖入文件夹的相对结构。"""
    username = _request_username(request)
    try:
        root, safe_directory, full_path, target = _prepare_upload_target(root_index, relative_path, file_path, overwrite)
    except HTTPException as exc:
        logger.warning("文件上传被拒绝 user=%s root=%s dir=%r file=%r status=%s detail=%s", username, root_index, relative_path, file_path, exc.status_code, exc.detail)
        raise

    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="上传长度格式无效") from exc
    if content_length > MAX_UPLOAD_FILE_BYTES:
        logger.warning("文件上传被拒绝 user=%s path=%r 声明大小 %s 超过 4 GB", username, full_path, content_length)
        raise HTTPException(status_code=413, detail="单个上传文件不能超过 4 GB")

    logger.info("文件上传开始 user=%s root=%s path=%r size=%s overwrite=%s", username, root_index, full_path, content_length, overwrite)
    started = time.monotonic()
    temp_path = target.with_name(f".{target.name}.{uuid4().hex}.upload")
    total_size = 0
    try:
        with temp_path.open("wb") as output:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total_size += len(chunk)
                if total_size > MAX_UPLOAD_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="单个上传文件不能超过 4 GB")
                output.write(chunk)
        if target.exists() and (target.is_symlink() or not target.is_file()):
            raise HTTPException(status_code=409, detail="上传目标在传输期间发生变化，已取消")
        os.replace(temp_path, target)
    except HTTPException as exc:
        temp_path.unlink(missing_ok=True)
        logger.warning("文件上传失败 user=%s path=%r 已接收 %s/%s 字节 status=%s detail=%s", username, full_path, total_size, content_length, exc.status_code, exc.detail)
        raise
    except ClientDisconnect:
        temp_path.unlink(missing_ok=True)
        logger.warning("文件上传中断 user=%s path=%r 客户端或代理断开，已接收 %s/%s 字节，耗时 %.1fs", username, full_path, total_size, content_length, time.monotonic() - started)
        raise
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        logger.error("文件上传写入失败 user=%s path=%r error=%s", username, full_path, exc)
        raise HTTPException(status_code=500, detail=f"写入上传文件失败：{exc}") from exc
    except BaseException:
        temp_path.unlink(missing_ok=True)
        logger.exception("文件上传异常 user=%s path=%r 已接收 %s 字节", username, full_path, total_size)
        raise

    _invalidate_root_caches(root)
    logger.info("文件上传完成 user=%s path=%r size=%s 耗时 %.1fs", username, full_path, total_size, time.monotonic() - started)
    return {
        "root_index": root_index,
        "directory": safe_directory,
        "path": full_path,
        "name": target.name,
        "size": total_size,
        "overwrite": overwrite,
        "modified": time.time(),
    }


def _request_username(request: Request) -> str:
    """读取上传请求所属的登录用户，仅用于日志与分片会话归属。"""
    from auth import current_username

    try:
        return current_username(request.session) or "-"
    except (AssertionError, KeyError):
        return "-"


def _prepare_upload_target(root_index: int, relative_path: str, file_path: str, overwrite: bool) -> tuple[Path, str, str, Path]:
    """校验上传目标：顶层目录、相对路径、父目录创建、链接与同名冲突。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    safe_directory = _normalize_relative_path(relative_path)
    _resolve_directory(root, safe_directory)
    if not file_path:
        raise HTTPException(status_code=422, detail="缺少上传文件相对路径")
    safe_file_path = _normalize_relative_path(file_path)
    full_path = _normalize_relative_path(f"{safe_directory}/{safe_file_path}" if safe_directory else safe_file_path)
    target = _upload_parent(root, full_path)
    # 重新解析父目录，缩小上传期间父目录被替换的窗口；目录内的符号链接按开放范围正常跟随。
    try:
        target = target.parent.resolve(strict=True) / target.name
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail="上传路径不可用") from exc

    if target.is_symlink():
        raise HTTPException(status_code=422, detail="上传目标是指向其他位置的链接，已拒绝")
    if target.exists():
        if not target.is_file():
            raise HTTPException(status_code=409, detail="上传目标已存在同名文件夹")
        if not overwrite:
            raise HTTPException(status_code=409, detail="目标已有同名文件，可勾选覆盖后重试")
    return root, safe_directory, full_path, target


def _cleanup_expired_uploads() -> None:
    """清理超时未完成的分片会话及其临时文件。"""
    now = time.time()
    with _UPLOAD_LOCK:
        expired = [session for session in _UPLOAD_SESSIONS.values() if now - session.updated > UPLOAD_SESSION_TTL_SECONDS]
        for session in expired:
            _UPLOAD_SESSIONS.pop(session.id, None)
    for session in expired:
        session.temp_path.unlink(missing_ok=True)
        logger.warning("分片上传超时清理 user=%s path=%r 已收到 %s/%s 片", session.username, session.full_path, len(session.received), session.total_chunks)


def _upload_session(upload_id: str, username: str) -> UploadSession:
    """查找当前用户的分片会话。"""
    with _UPLOAD_LOCK:
        session = _UPLOAD_SESSIONS.get(upload_id)
    if session is None or session.username != username:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期，请重新上传")
    return session


def init_chunked_upload(root_index: int, relative_path: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """创建分片上传会话：校验目标并预分配临时文件。"""
    _cleanup_expired_uploads()
    username = _request_username(request)
    file_path = payload.get("file_path")
    size = payload.get("size")
    chunk_size = payload.get("chunk_size")
    overwrite = bool(payload.get("overwrite", False))
    if not isinstance(file_path, str):
        raise HTTPException(status_code=422, detail="缺少上传文件相对路径")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise HTTPException(status_code=422, detail="上传文件大小无效")
    if size > MAX_UPLOAD_FILE_BYTES:
        logger.warning("分片上传被拒绝 user=%s file=%r 大小 %s 超过 4 GB", username, file_path, size)
        raise HTTPException(status_code=413, detail="单个上传文件不能超过 4 GB")
    if not isinstance(chunk_size, int) or isinstance(chunk_size, bool) or not MIN_UPLOAD_CHUNK_BYTES <= chunk_size <= MAX_UPLOAD_CHUNK_BYTES:
        raise HTTPException(status_code=422, detail="分片大小需在 1 MB 到 64 MB 之间")
    try:
        root, safe_directory, full_path, target = _prepare_upload_target(root_index, relative_path, file_path, overwrite)
    except HTTPException as exc:
        logger.warning("分片上传被拒绝 user=%s root=%s dir=%r file=%r status=%s detail=%s", username, root_index, relative_path, file_path, exc.status_code, exc.detail)
        raise

    upload_id = uuid4().hex
    temp_path = target.with_name(f".{target.name}.{upload_id}.upload")
    try:
        with temp_path.open("wb") as output:
            output.truncate(size)
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        logger.error("分片上传创建临时文件失败 user=%s path=%r error=%s", username, full_path, exc)
        raise HTTPException(status_code=500, detail=f"创建上传临时文件失败：{exc}") from exc

    now = time.time()
    session = UploadSession(upload_id, username, root, root_index, safe_directory, full_path, target, temp_path, size,
                            chunk_size, max(1, math.ceil(size / chunk_size)), overwrite, set(), now, now)
    with _UPLOAD_LOCK:
        _UPLOAD_SESSIONS[upload_id] = session
    logger.info("分片上传开始 user=%s id=%s root=%s path=%r size=%s chunk=%s 共 %s 片 overwrite=%s",
                username, upload_id, root_index, full_path, size, chunk_size, session.total_chunks, overwrite)
    return {"upload_id": upload_id, "chunk_size": chunk_size, "total_chunks": session.total_chunks}


async def upload_chunk(upload_id: str, index: int, request: Request) -> dict[str, Any]:
    """按偏移写入单个分片；重复上传同一片会覆盖，便于前端重试。"""
    session = _upload_session(upload_id, _request_username(request))
    if index < 0 or index >= session.total_chunks:
        raise HTTPException(status_code=422, detail="分片序号超出范围")
    offset = index * session.chunk_size
    expected = min(session.chunk_size, session.size - offset)
    written = 0
    try:
        fd = os.open(session.temp_path, os.O_WRONLY)
    except OSError as exc:
        logger.error("分片上传打开临时文件失败 id=%s path=%r error=%s", upload_id, session.full_path, exc)
        raise HTTPException(status_code=404, detail="上传临时文件已丢失，请重新上传") from exc
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            if written + len(chunk) > expected:
                raise HTTPException(status_code=422, detail="分片长度超过预期")
            os.pwrite(fd, chunk, offset + written)
            written += len(chunk)
        if written != expected:
            raise HTTPException(status_code=422, detail=f"分片长度不完整：{written}/{expected} 字节")
    except HTTPException as exc:
        logger.warning("分片写入失败 id=%s path=%r 第 %s 片 status=%s detail=%s", upload_id, session.full_path, index, exc.status_code, exc.detail)
        raise
    except ClientDisconnect:
        logger.warning("分片传输中断 id=%s path=%r 第 %s 片 已接收 %s/%s 字节", upload_id, session.full_path, index, written, expected)
        raise
    except OSError as exc:
        logger.error("分片写入失败 id=%s path=%r 第 %s 片 error=%s", upload_id, session.full_path, index, exc)
        raise HTTPException(status_code=500, detail=f"写入上传分片失败：{exc}") from exc
    finally:
        os.close(fd)
    with _UPLOAD_LOCK:
        session.received.add(index)
        session.updated = time.time()
        received = len(session.received)
    return {"upload_id": upload_id, "index": index, "received": received, "total_chunks": session.total_chunks}


def complete_chunked_upload(upload_id: str, request: Request) -> dict[str, Any]:
    """确认所有分片到齐后，把临时文件原子替换为目标文件。"""
    session = _upload_session(upload_id, _request_username(request))
    with _UPLOAD_LOCK:
        missing = [index for index in range(session.total_chunks) if index not in session.received]
    if missing:
        logger.warning("分片上传合并失败 id=%s path=%r 缺少 %s 片（如 %s）", upload_id, session.full_path, len(missing), missing[:5])
        raise HTTPException(status_code=409, detail=f"仍有 {len(missing)} 个分片未上传")
    target = session.target
    try:
        if target.exists() and (target.is_symlink() or not target.is_file()):
            raise HTTPException(status_code=409, detail="上传目标在传输期间发生变化，已取消")
        if target.exists() and not session.overwrite:
            raise HTTPException(status_code=409, detail="目标已有同名文件，可勾选覆盖后重试")
        os.replace(session.temp_path, target)
    except HTTPException as exc:
        abort_upload_session(session, f"合并被拒绝：{exc.detail}")
        raise
    except OSError as exc:
        abort_upload_session(session, f"合并失败：{exc}")
        raise HTTPException(status_code=500, detail=f"写入上传文件失败：{exc}") from exc
    with _UPLOAD_LOCK:
        _UPLOAD_SESSIONS.pop(upload_id, None)
    _invalidate_root_caches(session.root)
    logger.info("分片上传完成 user=%s id=%s path=%r size=%s 共 %s 片 耗时 %.1fs",
                session.username, upload_id, session.full_path, session.size, session.total_chunks, time.time() - session.created)
    return {
        "root_index": session.root_index,
        "directory": session.directory,
        "path": session.full_path,
        "name": target.name,
        "size": session.size,
        "overwrite": session.overwrite,
        "modified": time.time(),
    }


def abort_upload_session(session: UploadSession, reason: str) -> None:
    """取消分片会话并删除临时文件。"""
    with _UPLOAD_LOCK:
        _UPLOAD_SESSIONS.pop(session.id, None)
    session.temp_path.unlink(missing_ok=True)
    logger.warning("分片上传取消 user=%s id=%s path=%r 已收到 %s/%s 片 原因：%s",
                   session.username, session.id, session.full_path, len(session.received), session.total_chunks, reason)


def abort_chunked_upload(upload_id: str, request: Request, reason: str) -> dict[str, Any]:
    """前端放弃上传时调用，清理临时文件。"""
    abort_upload_session(_upload_session(upload_id, _request_username(request)), reason[:200] or "前端取消")
    return {"upload_id": upload_id, "aborted": True}


def _favorite_name(value: object) -> str:
    """校验收藏名称，避免空白或控制字符进入界面。"""
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="收藏名称必须是字符串")
    name = value.strip()
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise HTTPException(status_code=422, detail="收藏名称需为 1 到 80 个可见字符")
    return name


def _plain_inside(root: Path, relative_path: str) -> bool:
    """判断相对路径按字面拼接后是否仍位于顶层目录内，用于收藏的旧写法回退。"""
    try:
        return (root / relative_path).resolve().is_relative_to(root)
    except (OSError, RuntimeError):
        return False


def _stored_favorites() -> list[dict[str, str]]:
    """读取独立配置区段中的有效收藏记录。"""
    value = get_settings_section("file_favorites")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ("id", "name", "root_path", "path"))]


def list_favorites() -> list[dict[str, str]]:
    """展示仍属于开放范围的收藏，并兼容顶层目录路径写法变化与目录内的符号链接。"""
    roots = configured_roots()
    resolved_roots = [Path(text).expanduser().resolve() for text in roots]
    with _FAVORITES_LOCK:
        visible = []
        for item in _stored_favorites():
            stored_root = Path(item["root_path"]).expanduser().resolve()
            index = next((position for position, root in enumerate(resolved_roots) if root == stored_root), None)
            if index is None:
                # 顶层目录写法变化时，按“相对路径仍落在某个开放目录内”重新映射。
                index = next((position for position, root in enumerate(resolved_roots)
                              if _plain_inside(root, item["path"])), None)
            if index is None:
                continue
            try:
                directory = _resolve_relative(resolved_roots[index], item["path"])
            except HTTPException:
                continue
            if directory.is_dir():
                visible.append({**item, "root_path": roots[index], "path": item["path"]})
        return visible


def add_favorite(root_index: object, relative_path: object, name: object = None) -> list[dict[str, str]]:
    """收藏已开放目录，拒绝越界、重复和不存在的目录。"""
    if not isinstance(root_index, int) or isinstance(root_index, bool) or not isinstance(relative_path, str):
        raise HTTPException(status_code=422, detail="收藏目录参数无效")
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root_path = roots[root_index]
    root = _resolve_root(root_path)
    safe_path = _normalize_relative_path(relative_path)
    directory = _resolve_directory(root, safe_path)
    display_name = _favorite_name(name if name is not None else directory.name)
    with _FAVORITES_LOCK:
        favorites = _stored_favorites()
        if any((Path(item["root_path"]).expanduser() / item["path"]).resolve() == directory for item in favorites):
            raise HTTPException(status_code=409, detail="这个目录已经收藏")
        if len(favorites) >= MAX_FAVORITES:
            raise HTTPException(status_code=422, detail=f"最多收藏 {MAX_FAVORITES} 个目录")
        favorites.append({"id": uuid4().hex, "name": display_name, "root_path": root_path, "path": safe_path})
        update_settings_section("file_favorites", favorites)
    return list_favorites()


def rename_favorite(favorite_id: str, name: object) -> list[dict[str, str]]:
    """修改已有收藏的显示名称。"""
    display_name = _favorite_name(name)
    with _FAVORITES_LOCK:
        favorites = _stored_favorites()
        favorite = next((item for item in favorites if item["id"] == favorite_id), None)
        if favorite is None or not any(item["id"] == favorite_id for item in list_favorites()):
            raise HTTPException(status_code=404, detail="收藏目录不存在")
        favorite["name"] = display_name
        update_settings_section("file_favorites", favorites)
    return list_favorites()


def delete_favorite(favorite_id: str) -> list[dict[str, str]]:
    """删除指定收藏。"""
    with _FAVORITES_LOCK:
        favorites = _stored_favorites()
        remaining = [item for item in favorites if item["id"] != favorite_id]
        if len(remaining) == len(favorites):
            raise HTTPException(status_code=404, detail="收藏目录不存在")
        update_settings_section("file_favorites", remaining)
    return list_favorites()


def _git_command(directory: Path, arguments: list[str]) -> str:
    """在项目目录内执行只读或固定参数的 Git 命令，并返回合并输出。"""
    result = subprocess.run(
        ["git", *arguments],
        cwd=directory,
        capture_output=True,
        text=True,
        timeout=MAX_GIT_PULL_SECONDS,
        check=False,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Git 命令失败：{output[:2_000] or result.returncode}")
    return output


def pull_project_updates(root_index: object, relative_path: object) -> dict[str, Any]:
    """拉取收藏项目目录的最新提交，并检查 LIHAN/DOC 文档目录。"""
    if not isinstance(root_index, int) or isinstance(root_index, bool) or not isinstance(relative_path, str):
        raise HTTPException(status_code=422, detail="拉取项目参数无效")
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="文件管理顶层目录不存在")
    root = _resolve_root(roots[root_index])
    safe_path = _normalize_relative_path(relative_path)
    directory = _resolve_directory(root, safe_path)
    document_relative_path = _normalize_relative_path(f"{safe_path}/{PROJECT_DOCUMENT_DIRECTORY}" if safe_path else str(PROJECT_DOCUMENT_DIRECTORY))
    document_directory = root / document_relative_path
    base_result = {
        "root_index": root_index,
        "path": safe_path,
        "document_path": document_relative_path,
        "pulled_at": time.time(),
    }

    if not (directory / ".git").exists():
        return {**base_result, "document_exists": document_directory.is_dir(), "repository": False, "updated": False,
                "output": "当前收藏路径不是 Git 仓库，已跳过拉取。"}

    previous_head = _git_command(directory, ["rev-parse", "HEAD"])
    pull_output = _git_command(directory, ["pull", "--ff-only"])
    current_head = _git_command(directory, ["rev-parse", "HEAD"])
    _invalidate_root_caches(root)
    # 拉取可能新建 LIHAN/DOC，因此必须在 pull 完成后重新检查。
    return {**base_result, "document_exists": document_directory.is_dir(), "repository": True,
            "updated": previous_head != current_head, "output": pull_output[:4_000]}


def clear_directory_cache() -> None:
    """清空目录缓存，下一次访问会重新同步磁盘状态。"""
    with _CACHE_LOCK:
        _DIRECTORY_CACHE.clear()
        _PLY_CACHE.clear()
        _MARKDOWN_CACHE.clear()


def sync_roots(targets: object = None) -> dict[str, Any]:
    """递归预读指定项目的目录列表，使随后浏览直接命中缓存。"""
    selected = list(SYNC_DIRECTORIES) if targets is None else targets
    if not isinstance(selected, list) or not selected or any(not isinstance(value, str) or value not in SYNC_DIRECTORIES for value in selected):
        raise HTTPException(status_code=422, detail="同步目录参数无效")
    roots = [(text, _resolve_root(text)) for text in configured_roots()]
    jobs: list[tuple[str, str]] = []
    for name in dict.fromkeys(selected):
        directory = SYNC_DIRECTORIES[name].resolve()
        if not directory.is_dir():
            raise HTTPException(status_code=404, detail=f"同步目录不存在：{directory}")
        match = next(((text, root) for text, root in roots if directory.is_relative_to(root)), None)
        if match is None:
            raise HTTPException(status_code=422, detail=f"同步目录不在已开放范围：{directory}")
        root_text, root = match
        jobs.append((root_text, directory.relative_to(root).as_posix() if directory != root else ""))

    directory_count = 0
    with _SYNC_LOCK:
        with _CACHE_LOCK:
            for root_text, prefix in jobs:
                root = _resolve_root(root_text)
                for key in list(_DIRECTORY_CACHE):
                    if key[0] == root and (key[1] == prefix or key[1].startswith(f"{prefix}/")):
                        del _DIRECTORY_CACHE[key]
                for key in list(_PLY_CACHE):
                    if key[0] == root and (key[1] == prefix or key[1].startswith(f"{prefix}/") or not key[1] or prefix.startswith(f"{key[1]}/")):
                        del _PLY_CACHE[key]
        for root_text, prefix in jobs:
            root = _resolve_root(root_text)
            pending = [prefix]
            visited: set[Path] = set()
            while pending:
                relative_path = pending.pop()
                try:
                    directory = _resolve_directory(root, relative_path)
                except HTTPException as exc:
                    if exc.status_code == 404 and relative_path != prefix:
                        continue
                    raise
                if directory in visited:
                    continue
                visited.add(directory)
                try:
                    records, _, _ = _directory_records(root_text, relative_path, refresh=True)
                except HTTPException as exc:
                    if exc.status_code == 404 and relative_path != prefix:
                        continue
                    raise
                directory_count += 1
                pending.extend(record.path for record in records if record.type == "directory")
            ply_records = _scan_ply_tree(_resolve_directory(root, prefix), prefix)
            with _CACHE_LOCK:
                _PLY_CACHE[(root, prefix)] = (time.time(), ply_records)
    return {"targets": list(dict.fromkeys(selected)), "directory_count": directory_count,
            "synced_at": time.time(), "cache_ttl_seconds": CACHE_TTL_SECONDS}
