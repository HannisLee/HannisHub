"""兼容旧版点云原始文件接口，路径权限复用文件管理配置。"""

from pathlib import Path

from fastapi import HTTPException

from file_manager import configured_roots, resolve_root


POINT_CLOUD_EXTENSIONS = {".ply", ".pcd", ".xyz", ".xyzn", ".xyzrgb", ".pts", ".las", ".laz"}


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
