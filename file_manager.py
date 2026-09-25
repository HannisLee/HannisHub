"""文件管理组件：受限目录配置、目录缓存、浏览与下载。"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException

from auth import get_settings_section, update_settings_section


DEFAULT_ROOT = "~/reproduce"
MAX_ROOTS = 24
MAX_DIRECTORY_ENTRIES = 1_000
MAX_FAVORITES = 100
MAX_DATE_SEARCH_FOLDERS = 24
CACHE_TTL_SECONDS = 60 * 60
SYNC_DIRECTORIES = {
    "RadioGS-perlight": Path("/home/lihan/reproduce/RadioGS-perlight"),
    "RadioGS-stage1": Path("/home/lihan/reproduce/RadioGS-stage1"),
}
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
_PLY_CACHE: dict[tuple[Path, str], tuple[float, list[DirectoryRecord]]] = {}
_CACHE_LOCK = threading.RLock()
_SYNC_LOCK = threading.Lock()
_FAVORITES_LOCK = threading.RLock()
_DATE_SEARCH_DEFAULTS = (
    "~/reproduce/RadioGS-perlight",
    "~/reproduce/RadioGS-stage1",
    "~/reproduce/LumiMotion",
    "~/reproduce/LumiMotion-perlight",
)


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


def _resolve_directory(root: Path, relative_path: str) -> Path:
    """解析受限目录，并阻止中间路径通过符号链接越界。"""
    directory = (root / relative_path).resolve()
    try:
        directory.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="目录不在允许的顶层目录内") from exc
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
    """递归读取 PLY 文件，忽略符号链接与不相关的普通文件。"""
    records: list[DirectoryRecord] = []
    pending = [(directory, relative_path)]
    while pending:
        current, current_path = pending.pop()
        try:
            with os.scandir(current) as iterator:
                for item in iterator:
                    try:
                        child_path = f"{current_path}/{item.name}" if current_path else item.name
                        if len(child_path) > 4_096:
                            continue
                        if item.is_dir(follow_symlinks=False):
                            if item.name not in IGNORED_DIRECTORY_NAMES:
                                pending.append((Path(item.path), child_path))
                        elif item.name.lower().endswith(".ply") and item.is_file(follow_symlinks=False):
                            stat = item.stat(follow_symlinks=False)
                            records.append(DirectoryRecord(item.name, child_path, "file", stat.st_size, stat.st_mtime, "ply"))
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
        _PLY_CACHE[(root, safe_path)] = (generated_at, records)
    prefix = f"{safe_path}/" if safe_path else ""
    return {"entries": [{**_entry_payload(record, root_index), "relative_path": record.path[len(prefix):]} for record in records],
            "cached": False, "generated_at": generated_at, "expires_at": generated_at + CACHE_TTL_SECONDS}


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


def _favorite_name(value: object) -> str:
    """校验收藏名称，避免空白或控制字符进入界面。"""
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="收藏名称必须是字符串")
    name = value.strip()
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise HTTPException(status_code=422, detail="收藏名称需为 1 到 80 个可见字符")
    return name


def _stored_favorites() -> list[dict[str, str]]:
    """读取独立配置区段中的有效收藏记录。"""
    value = get_settings_section("file_favorites")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ("id", "name", "root_path", "path"))]


def list_favorites() -> list[dict[str, str]]:
    """展示仍属于开放范围的收藏，并兼容顶层目录路径写法变化。"""
    roots = configured_roots()
    with _FAVORITES_LOCK:
        visible = []
        for item in _stored_favorites():
            directory = (Path(item["root_path"]).expanduser() / item["path"]).resolve()
            for root_text in roots:
                root = Path(root_text).expanduser().resolve()
                if directory.is_dir() and directory.is_relative_to(root):
                    visible.append({**item, "root_path": root_text, "path": directory.relative_to(root).as_posix() if directory != root else ""})
                    break
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


def clear_directory_cache() -> None:
    """清空目录缓存，下一次访问会重新同步磁盘状态。"""
    with _CACHE_LOCK:
        _DIRECTORY_CACHE.clear()
        _PLY_CACHE.clear()


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
            pending = [prefix]
            while pending:
                relative_path = pending.pop()
                try:
                    records, _, _ = _directory_records(root_text, relative_path, refresh=True)
                except HTTPException as exc:
                    if exc.status_code == 404 and relative_path != prefix:
                        continue
                    raise
                directory_count += 1
                pending.extend(record.path for record in records if record.type == "directory")
            root = _resolve_root(root_text)
            ply_records = _scan_ply_tree(_resolve_directory(root, prefix), prefix)
            with _CACHE_LOCK:
                _PLY_CACHE[(root, prefix)] = (time.time(), ply_records)
    return {"targets": list(dict.fromkeys(selected)), "directory_count": directory_count,
            "synced_at": time.time(), "cache_ttl_seconds": CACHE_TTL_SECONDS}
