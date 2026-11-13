"""聊天大厅个人资料：按登录账号保存场景中的名字与像素形象。

- 数据以本地 JSON 文件持久保存（data/chat_lobby_profiles.json），键为登录用户名
- 名字：多人同场时显示在其他人看到的角色头顶（自己看不到自己的名字）
- 形象：角色生成器的 5 个部件槽位（身体、眼睛、服装、发型、配饰），只保存部件编号，
  合成在前端完成；为 null 时使用场景默认角色
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException

# 模块位于子目录，ROOT_DIR 指向项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
PROFILES_PATH = ROOT_DIR / "data" / "chat_lobby_profiles.json"

MAX_NAME_CHARS = 16
MAX_PROFILES = 500
# 部件编号即素材文件名（如 Outfit_03_02、Accessory_15_Glasses_01），只做字符与长度校验
PART_ID_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,48}$")
REQUIRED_SLOTS = ("body", "eyes", "outfit")
OPTIONAL_SLOTS = ("hair", "accessory")

_LOCK = threading.RLock()


def _read_store() -> dict[str, Any]:
    """读取资料文件；缺失或损坏时返回空结构。"""
    try:
        data = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"profiles": {}}
    if not isinstance(data, dict) or not isinstance(data.get("profiles"), dict):
        return {"profiles": {}}
    return data


def _write_store(data: dict[str, Any]) -> None:
    """原子写入资料文件。"""
    PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(PROFILES_PATH.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temp_path, PROFILES_PATH)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _normalize_name(value: object) -> str:
    """去掉控制字符、合并空白并截断；不能为空。"""
    text = "".join(" " if ch.isspace() else ch for ch in str(value or "") if ch.isspace() or ch.isprintable())
    name = " ".join(text.split())[:MAX_NAME_CHARS]
    if not name:
        raise HTTPException(status_code=400, detail="请填写名字")
    return name


def _normalize_avatar(value: object) -> dict[str, str] | None:
    """形象为 null（使用默认角色），或包含 5 个槽位的对象；发型与配饰可为空字符串。"""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="形象数据格式不正确")
    avatar: dict[str, str] = {}
    for slot in REQUIRED_SLOTS + OPTIONAL_SLOTS:
        part = str(value.get(slot) or "").strip()
        if not part and slot in OPTIONAL_SLOTS:
            avatar[slot] = ""
            continue
        if not PART_ID_PATTERN.match(part):
            raise HTTPException(status_code=400, detail=f"形象部件无效：{slot}")
        avatar[slot] = part
    return avatar


def _public_profile(username: str, stored: dict[str, Any] | None) -> dict[str, Any]:
    stored = stored or {}
    return {
        "username": username,
        # 尚未设置名字时默认使用登录用户名
        "name": stored.get("name") or username,
        "avatar": stored.get("avatar"),
        "updated_at": stored.get("updated_at"),
    }


def get_profile(username: str) -> dict[str, Any]:
    """读取当前账号的场景资料；从未保存过时返回默认值。"""
    with _LOCK:
        stored = _read_store()["profiles"].get(username)
    return _public_profile(username, stored if isinstance(stored, dict) else None)


def save_profile(username: str, payload: dict[str, Any]) -> dict[str, Any]:
    """保存当前账号的名字与形象。"""
    profile = {
        "name": _normalize_name(payload.get("name")),
        "avatar": _normalize_avatar(payload.get("avatar")),
        "updated_at": time.time(),
    }
    with _LOCK:
        data = _read_store()
        if username not in data["profiles"] and len(data["profiles"]) >= MAX_PROFILES:
            raise HTTPException(status_code=400, detail="聊天大厅资料数量已达上限")
        data["profiles"][username] = profile
        _write_store(data)
    return _public_profile(username, profile)
