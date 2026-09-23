"""点云查看器的扫描、归并与受限文件读取，目录能力复用文件管理组件。"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from threading import RLock
from typing import Any
import time
from urllib.parse import urlencode

from fastapi import HTTPException

from file_manager import configured_roots, iter_root_files, resolve_root, save_roots


POINT_CLOUD_EXTENSIONS = {".ply", ".pcd", ".xyz", ".xyzn", ".xyzrgb", ".pts", ".las", ".laz"}
VIEWABLE_EXTENSIONS = {".ply", ".pcd", ".xyz", ".xyzn", ".xyzrgb", ".pts"}
MAX_SCANNED_FILES = 2_000
MAX_DATASETS = 800
SCAN_CACHE_TTL_SECONDS = 15
_SCAN_CACHE: dict[tuple[tuple[str, ...], int, str], tuple[float, dict[str, Any]]] = {}
_SCAN_CACHE_LOCK = RLock()

# 这些目录通常只是在描述点云类型或迭代层级；列表中应优先显示实际实验目录。
GENERIC_DATASET_DIRECTORY_NAMES = {"point_cloud", "pointcloud", "points", "model", "models", "world", "ply", "ply_dense", "sparse", "dense"}


def _is_generic_dataset_directory(name: str) -> bool:
    """判断目录名是否只是一层通用容器，而非用户应识别的实验名。"""
    lower_name = name.lower()
    return (
        lower_name in GENERIC_DATASET_DIRECTORY_NAMES
        or lower_name.startswith("iteration_")
        or lower_name.startswith("iter_")
        or lower_name.isdigit()
    )


def _dataset_directory(file_path: Path, root: Path) -> Path:
    """向上跨过常见的点云容器目录，得到可识别的实验/结果目录。"""
    directory = file_path.parent
    while directory != root and _is_generic_dataset_directory(directory.name):
        directory = directory.parent
    return directory


def _file_payload(file_path: Path, root: Path, root_index: int) -> dict[str, Any]:
    """生成前端加载与下载所需的受限文件信息。"""
    relative_path = file_path.relative_to(root).as_posix()
    suffix = file_path.suffix.lower()
    stat = file_path.stat()
    return {
        "name": file_path.name,
        "relative_path": relative_path,
        "size": stat.st_size,
        "modified": stat.st_mtime,
        "format": suffix.removeprefix("."),
        "viewable": suffix in VIEWABLE_EXTENSIONS,
        "url": f"/api/point-clouds/file?{urlencode({'root': root_index, 'path': relative_path})}",
    }


def clear_scan_cache() -> None:
    """清空点云扫描结果缓存。"""
    with _SCAN_CACHE_LOCK:
        _SCAN_CACHE.clear()


def scan_datasets(root_index: int | None = None, *, scope: str = "", refresh: bool = False) -> dict[str, Any]:
    """扫描已暴露目录，并可按顶层目录索引缩小点云扫描范围。"""
    roots = configured_roots()
    cache_key = (tuple(roots), -1 if root_index is None else root_index, scope)
    now = time.time()
    with _SCAN_CACHE_LOCK:
        cached = _SCAN_CACHE.get(cache_key)
        if not refresh and cached and now - cached[0] < SCAN_CACHE_TTL_SECONDS:
            payload = deepcopy(cached[1])
            payload["cached"] = True
            return payload
    if root_index is None:
        selected_roots = list(enumerate(roots))
    else:
        if root_index < 0 or root_index >= len(roots):
            raise HTTPException(status_code=404, detail="点云扫描范围不存在")
        selected_roots = [(root_index, roots[root_index])]

    grouped: dict[tuple[int, str], dict[str, Any]] = {}
    root_errors: list[dict[str, str]] = []
    scanned_count = 0
    truncated = False

    for current_root_index, root_text in selected_roots:
        remaining = MAX_SCANNED_FILES - scanned_count
        if remaining <= 0:
            truncated = True
            break
        try:
            root, files, walk_truncated = iter_root_files(
                root_text,
                {f".{extension}" for extension in ("ply", "pcd", "xyz", "xyzn", "xyzrgb", "pts", "las", "laz")},
                max_files=remaining,
                refresh=refresh,
                scope=scope,
            )
        except HTTPException as exc:
            root_errors.append({"path": root_text, "message": str(exc.detail)})
            continue

        scanned_count += len(files)
        truncated = truncated or walk_truncated
        for file_path in files:
            dataset_dir = _dataset_directory(file_path, root)
            dataset_relative_path = dataset_dir.relative_to(root).as_posix()
            if dataset_relative_path == ".":
                dataset_relative_path = ""
            key = (current_root_index, dataset_relative_path)
            dataset = grouped.get(key)
            if dataset is None:
                dataset = {
                    "id": f"{current_root_index}:{dataset_relative_path}",
                    "name": dataset_dir.name or root.name,
                    "relative_path": dataset_relative_path or ".",
                    "root_index": current_root_index,
                    "root_path": root_text,
                    "file_count": 0,
                    "total_size": 0,
                    "modified": 0.0,
                    "formats": set(),
                    "files": [],
                }
                grouped[key] = dataset
            file_data = _file_payload(file_path, root, current_root_index)
            dataset["file_count"] += 1
            dataset["total_size"] += file_data["size"]
            dataset["modified"] = max(dataset["modified"], file_data["modified"])
            dataset["formats"].add(file_data["format"])
            dataset["files"].append(file_data)

    ordered = sorted(grouped.values(), key=lambda item: (-item["modified"], item["name"].lower()))
    if len(ordered) > MAX_DATASETS:
        ordered = ordered[:MAX_DATASETS]
        truncated = True

    datasets: list[dict[str, Any]] = []
    for dataset in ordered:
        dataset["files"].sort(key=lambda item: (-item["modified"], item["name"].lower()))
        dataset["formats"] = sorted(dataset["formats"])
        datasets.append(dataset)

    payload = {
        "roots": [root_text for _, root_text in selected_roots],
        "scope": scope,
        "datasets": datasets,
        "root_errors": root_errors,
        "scan_truncated": truncated,
        "max_scanned_files": MAX_SCANNED_FILES,
        "scanned_file_count": scanned_count,
        "cached": False,
    }
    with _SCAN_CACHE_LOCK:
        _SCAN_CACHE[cache_key] = (time.time(), deepcopy(payload))
    return payload


def resolve_cloud_file(root_index: int, relative_path: str) -> Path:
    """只允许读取文件管理组件已暴露目录内部的已支持点云文件。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="点云顶层目录不存在")
    root = resolve_root(roots[root_index])
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="点云文件路径不在允许的顶层目录内") from exc
    if candidate.suffix.lower() not in POINT_CLOUD_EXTENSIONS or not candidate.is_file():
        raise HTTPException(status_code=404, detail="点云文件不存在或格式不受支持")
    return candidate
