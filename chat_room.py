"""聊天室组件：单一公共聊天室，消息带昵称，记录以本地 JSON 文件持久保存。"""

from __future__ import annotations

import json
import os
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

_LOCK = threading.RLock()


def _read_store() -> dict[str, Any]:
    """读取聊天记录；文件缺失或损坏时返回空结构。"""
    try:
        data = json.loads(CHAT_ROOM_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"next_id": 1, "messages": []}
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return {"next_id": 1, "messages": []}
    data.setdefault("next_id", (data["messages"][-1]["id"] + 1) if data["messages"] else 1)
    return data


def _write_store(data: dict[str, Any]) -> None:
    """原子写入聊天记录。"""
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


def list_messages(after: int = 0, limit: int = 200) -> dict[str, Any]:
    """返回 id 大于 after 的消息；after 为 0 时返回最近 limit 条，用于首次加载。"""
    limit = max(1, min(int(limit), MAX_FETCH_MESSAGES))
    with _LOCK:
        messages = _read_store()["messages"]
    if after > 0:
        result = [item for item in messages if item["id"] > after][:limit]
    else:
        result = messages[-limit:]
    return {"messages": result, "total": len(messages)}


def post_message(payload: dict[str, Any]) -> dict[str, Any]:
    """追加一条消息并返回该消息。"""
    nickname = " ".join(str(payload.get("nickname") or "").split())[:MAX_NICKNAME_CHARS]
    content = str(payload.get("content") or "").strip()
    if not nickname:
        raise HTTPException(status_code=400, detail="请先填写昵称")
    if not content:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(content) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail=f"消息长度不能超过 {MAX_MESSAGE_CHARS} 字")
    with _LOCK:
        data = _read_store()
        message = {"id": data["next_id"], "nickname": nickname, "content": content, "created_at": time.time()}
        data["next_id"] += 1
        data["messages"].append(message)
        if len(data["messages"]) > MAX_STORED_MESSAGES:
            data["messages"] = data["messages"][-MAX_STORED_MESSAGES:]
        _write_store(data)
    return message


def clear_messages() -> dict[str, Any]:
    """清空聊天记录；消息 id 继续递增，避免客户端增量拉取错乱。"""
    with _LOCK:
        data = _read_store()
        data["messages"] = []
        _write_store(data)
    return {"ok": True}
