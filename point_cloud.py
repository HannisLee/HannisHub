"""点云查看器的数据目录配置、扫描与受限文件读取。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode

from fastapi import HTTPException

from auth import get_settings_section, update_settings_section


POINT_CLOUD_EXTENSIONS = {".ply", ".pcd", ".xyz", ".xyzn", ".xyzrgb", ".pts", ".las", ".laz"}
VIEWABLE_EXTENSIONS = {".ply", ".pcd", ".xyz", ".xyzn", ".xyzrgb", ".pts"}
MAX_ROOTS = 24
MAX_SCANNED_FILES = 2_000
MAX_DATASETS = 800
IGNORED_DIRECTORY_NAMES = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".venv", "venv"}

# 这些目录通常只是在描述点云类型或迭代层级；列表中应优先显示实际实验目录。
GENERIC_DATASET_DIRECTORY_NAMES = {"point_cloud", "pointcloud", "points", "model", "models", "world", "ply", "ply_dense", "sparse", "dense"}


def _default_roots() -> list[str]:
    """为当前用户已有的 reproduce 目录提供首开即用的默认范围。"""
    return ["~/reproduce"] if Path("~/reproduce").expanduser().is_dir() else []


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


def _resolve_root(root_text: str, *, require_existing: bool = True) -> Path:
    """展开并规范化顶层目录，确保它是可扫描的真实目录。"""
    root = Path(root_text).expanduser().resolve()
    if require_existing and (not root.exists() or not root.is_dir()):
        raise HTTPException(status_code=422, detail=f"顶层目录不存在或不是目录：{root_text}")
    return root


def configured_roots() -> list[str]:
    """读取已保存的顶层目录；未配置时仅提供存在的默认 reproduce 目录。"""
    value = get_settings_section("point_cloud")
    if not isinstance(value, dict) or not isinstance(value.get("roots"), list):
        return _default_roots()
    return [item for item in value["roots"] if isinstance(item, str)]


def save_roots(values: object) -> list[str]:
    """保存用户显式指定的顶层目录，拒绝无效或重复路径。"""
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

    update_settings_section("point_cloud", {"roots": roots})
    return roots


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
    """生成前端加载所需的受限文件信息。"""
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


def _iter_cloud_files(root: Path) -> Iterable[Path]:
    """按稳定顺序扫描点云后缀，跳过依赖、缓存和版本控制目录。"""
    for directory, child_directories, filenames in os.walk(root, topdown=True, onerror=lambda _: None):
        child_directories[:] = sorted(
            name for name in child_directories
            if name not in IGNORED_DIRECTORY_NAMES and not name.startswith(".")
        )
        for filename in sorted(filenames):
            file_path = Path(directory) / filename
            if file_path.suffix.lower() in POINT_CLOUD_EXTENSIONS:
                yield file_path


def scan_datasets(root_texts: list[str] | None = None) -> dict[str, Any]:
    """扫描配置目录并按更有意义的实验目录归并点云文件。"""
    raw_roots = configured_roots() if root_texts is None else root_texts
    grouped: dict[tuple[int, str], dict[str, Any]] = {}
    root_errors: list[dict[str, str]] = []
    scanned_count = 0
    truncated = False

    for root_index, root_text in enumerate(raw_roots):
        try:
            root = _resolve_root(root_text)
        except HTTPException as exc:
            root_errors.append({"path": root_text, "message": str(exc.detail)})
            continue

        for file_path in _iter_cloud_files(root):
            scanned_count += 1
            if scanned_count > MAX_SCANNED_FILES:
                truncated = True
                break

            dataset_dir = _dataset_directory(file_path, root)
            dataset_relative_path = dataset_dir.relative_to(root).as_posix()
            if dataset_relative_path == ".":
                dataset_relative_path = ""
            key = (root_index, dataset_relative_path)
            dataset = grouped.get(key)
            if dataset is None:
                dataset = {
                    "id": f"{root_index}:{dataset_relative_path}",
                    "name": dataset_dir.name or root.name,
                    "relative_path": dataset_relative_path or ".",
                    "root_index": root_index,
                    "root_path": root_text,
                    "file_count": 0,
                    "total_size": 0,
                    "modified": 0.0,
                    "formats": set(),
                    "files": [],
                }
                grouped[key] = dataset
            file_data = _file_payload(file_path, root, root_index)
            dataset["file_count"] += 1
            dataset["total_size"] += file_data["size"]
            dataset["modified"] = max(dataset["modified"], file_data["modified"])
            dataset["formats"].add(file_data["format"])
            dataset["files"].append(file_data)
        if truncated:
            break

    ordered = sorted(grouped.values(), key=lambda item: (-item["modified"], item["name"].lower()))
    if len(ordered) > MAX_DATASETS:
        ordered = ordered[:MAX_DATASETS]
        truncated = True

    datasets: list[dict[str, Any]] = []
    for dataset in ordered:
        dataset["files"].sort(key=lambda item: (-item["modified"], item["name"].lower()))
        dataset["formats"] = sorted(dataset["formats"])
        datasets.append(dataset)

    return {
        "roots": raw_roots,
        "datasets": datasets,
        "root_errors": root_errors,
        "scan_truncated": truncated,
        "max_scanned_files": MAX_SCANNED_FILES,
        "scanned_file_count": min(scanned_count, MAX_SCANNED_FILES),
    }


def resolve_cloud_file(root_index: int, relative_path: str) -> Path:
    """只允许读取已配置顶层目录内部的已支持点云文件。"""
    roots = configured_roots()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="点云顶层目录不存在")
    root = _resolve_root(roots[root_index])
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="点云文件路径不在允许的顶层目录内") from exc
    if candidate.suffix.lower() not in POINT_CLOUD_EXTENSIONS or not candidate.is_file():
        raise HTTPException(status_code=404, detail="点云文件不存在或格式不受支持")
    return candidate
