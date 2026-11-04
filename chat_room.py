"""聊天室组件：单一公共聊天室。

- 消息与用户资料（昵称、头像）以本地 JSON 文件持久保存
- 每个浏览器生成一个 client_id 作为身份；在线状态只保存在内存中，按最近心跳判断
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

ROOT_DIR = Path(__file__).resolve().parent
CHAT_ROOM_PATH = ROOT_DIR / "data" / "chat_room.json"

# 最多保留的消息条数，超出后丢弃最早的记录
MAX_STORED_MESSAGES = 10_000
MAX_MESSAGE_CHARS = 4_000
MAX_NICKNAME_CHARS = 24
# 单次请求最多返回的消息条数
MAX_FETCH_MESSAGES = 500
MAX_PROFILES = 500
# 头像：emoji 文本或前端压缩后的 data URL 图片
MAX_AVATAR_TEXT_CHARS = 16
MAX_AVATAR_IMAGE_CHARS = 120_000
AVATAR_IMAGE_PATTERN = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# 超过该秒数未心跳即视为离线
ONLINE_TIMEOUT_SECONDS = 15

_LOCK = threading.RLock()
# client_id -> 最近心跳时间，仅保存在内存中
_presence: dict[str, float] = {}


def _empty_store() -> dict[str, Any]:
    return {"next_id": 1, "messages": [], "profiles": {}, "profiles_version": 0}


def _read_store() -> dict[str, Any]:
    """读取聊天数据；文件缺失或损坏时返回空结构，并补齐旧版本缺少的字段。"""
    try:
        data = json.loads(CHAT_ROOM_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_store()
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return _empty_store()
    data.setdefault("next_id", (data["messages"][-1]["id"] + 1) if data["messages"] else 1)
    if not isinstance(data.get("profiles"), dict):
        data["profiles"] = {}
    data.setdefault("profiles_version", 0)
    return data


def _write_store(data: dict[str, Any]) -> None:
    """原子写入聊天数据。"""
    CHAT_ROOM_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(CHAT_ROOM_PATH.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temp_path, CHAT_ROOM_PATH)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _validate_client_id(value: object) -> str:
    client_id = str(value or "").strip()
    if not CLIENT_ID_PATTERN.match(client_id):
        raise HTTPException(status_code=400, detail="客户端标识无效，请刷新页面")
    return client_id


def _normalize_nickname(value: object) -> str:
    nickname = " ".join(str(value or "").split())[:MAX_NICKNAME_CHARS]
    if not nickname:
        raise HTTPException(status_code=400, detail="请先填写昵称")
    return nickname


def _normalize_avatar(value: object) -> str:
    """头像为空、一段短 emoji 文本，或 png/jpeg/webp 的 base64 data URL。"""
    avatar = str(value or "").strip()
    if not avatar:
        return ""
    if avatar.startswith("data:"):
        if len(avatar) > MAX_AVATAR_IMAGE_CHARS or not AVATAR_IMAGE_PATTERN.match(avatar):
            raise HTTPException(status_code=400, detail="头像图片格式不支持或过大")
        return avatar
    if len(avatar) > MAX_AVATAR_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="头像文字过长")
    return avatar


def _online_ids(now: float) -> list[str]:
    """清理过期心跳并返回在线 client_id 列表。"""
    for client_id, seen in list(_presence.items()):
        if now - seen > ONLINE_TIMEOUT_SECONDS:
            _presence.pop(client_id, None)
    return list(_presence)


def list_messages(after: int = 0, limit: int = 200, client_id: str = "", profiles_version: int = -1) -> dict[str, Any]:
    """返回 id 大于 after 的消息；after 为 0 时返回最近 limit 条。

    携带 client_id 时同时记录心跳；资料版本变化时才返回完整资料表，减少轮询流量。
    """
    limit = max(1, min(int(limit), MAX_FETCH_MESSAGES))
    now = time.time()
    with _LOCK:
        if client_id and CLIENT_ID_PATTERN.match(client_id):
            _presence[client_id] = now
        online = _online_ids(now)
        data = _read_store()
    messages = data["messages"]
    if after > 0:
        result = [item for item in messages if item["id"] > after][:limit]
    else:
        result = messages[-limit:]
    response: dict[str, Any] = {
        "messages": result,
        "total": len(messages),
        "online": online,
        "profiles_version": data["profiles_version"],
    }
    if profiles_version != data["profiles_version"]:
        response["profiles"] = data["profiles"]
    return response


def save_profile(payload: dict[str, Any]) -> dict[str, Any]:
    """保存当前浏览器的昵称与头像。"""
    client_id = _validate_client_id(payload.get("client_id"))
    profile = {
        "nickname": _normalize_nickname(payload.get("nickname")),
        "avatar": _normalize_avatar(payload.get("avatar")),
        "updated_at": time.time(),
    }
    with _LOCK:
        data = _read_store()
        if client_id not in data["profiles"] and len(data["profiles"]) >= MAX_PROFILES:
            raise HTTPException(status_code=400, detail="聊天室用户资料数量已达上限")
        data["profiles"][client_id] = profile
        data["profiles_version"] += 1
        _write_store(data)
    return {"client_id": client_id, **profile}


def post_message(payload: dict[str, Any]) -> dict[str, Any]:
    """追加一条消息并返回该消息；昵称以已保存的资料为准。"""
    client_id = _validate_client_id(payload.get("client_id"))
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(content) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail=f"消息长度不能超过 {MAX_MESSAGE_CHARS} 字")
    with _LOCK:
        data = _read_store()
        profile = data["profiles"].get(client_id)
        nickname = profile["nickname"] if profile else _normalize_nickname(payload.get("nickname"))
        message = {
            "id": data["next_id"],
            "client_id": client_id,
            "nickname": nickname,
            "content": content,
            "created_at": time.time(),
        }
        data["next_id"] += 1
        data["messages"].append(message)
        if len(data["messages"]) > MAX_STORED_MESSAGES:
            data["messages"] = data["messages"][-MAX_STORED_MESSAGES:]
        _write_store(data)
        _presence[client_id] = time.time()
    return message


def clear_messages() -> dict[str, Any]:
    """清空聊天记录；消息 id 继续递增，避免客户端增量拉取错乱。"""
    with _LOCK:
        data = _read_store()
        data["messages"] = []
        _write_store(data)
    return {"ok": True}
