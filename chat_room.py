"""聊天室组件：基于统一 AI 配置的多会话对话，会话以本地 JSON 文件存储。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException

import ai_settings

ROOT_DIR = Path(__file__).resolve().parent
CHAT_ROOM_PATH = ROOT_DIR / "data" / "chat_room.json"

MAX_CONVERSATIONS = 200
MAX_MESSAGE_CHARS = 32_000
MAX_TITLE_CHARS = 80
# 发送给模型的上下文条数上限，避免长会话无限增长
MAX_CONTEXT_MESSAGES = 40
DEFAULT_TITLE = "新对话"

_LOCK = threading.RLock()


def _read_store() -> dict[str, Any]:
    """读取会话存储；文件缺失或损坏时返回空结构。"""
    try:
        data = json.loads(CHAT_ROOM_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"conversations": []}
    if not isinstance(data, dict) or not isinstance(data.get("conversations"), list):
        return {"conversations": []}
    return data


def _write_store(data: dict[str, Any]) -> None:
    """原子写入会话存储。"""
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


def _summary(conversation: dict[str, Any]) -> dict[str, Any]:
    """会话列表只返回摘要，不携带完整消息。"""
    messages = conversation.get("messages", [])
    last = messages[-1]["content"] if messages else ""
    return {
        "id": conversation["id"],
        "title": conversation.get("title") or DEFAULT_TITLE,
        "config_id": conversation.get("config_id", ""),
        "created_at": conversation.get("created_at", 0),
        "updated_at": conversation.get("updated_at", 0),
        "message_count": len(messages),
        "preview": last[:120],
    }


def _find(data: dict[str, Any], conversation_id: str) -> dict[str, Any]:
    for conversation in data["conversations"]:
        if conversation.get("id") == conversation_id:
            return conversation
    raise HTTPException(status_code=404, detail="会话不存在")


def _normalize_title(value: object) -> str:
    title = " ".join(str(value or "").split())[:MAX_TITLE_CHARS]
    return title or DEFAULT_TITLE


def list_conversations() -> dict[str, Any]:
    with _LOCK:
        data = _read_store()
    items = sorted(data["conversations"], key=lambda item: item.get("updated_at", 0), reverse=True)
    return {"conversations": [_summary(item) for item in items]}


def get_conversation(conversation_id: str) -> dict[str, Any]:
    with _LOCK:
        return _find(_read_store(), conversation_id)


def create_conversation(payload: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    conversation = {
        "id": uuid.uuid4().hex[:12],
        "title": _normalize_title(payload.get("title")),
        "config_id": str(payload.get("config_id") or ""),
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    with _LOCK:
        data = _read_store()
        if len(data["conversations"]) >= MAX_CONVERSATIONS:
            raise HTTPException(status_code=400, detail=f"会话数量已达上限 {MAX_CONVERSATIONS}，请先删除旧会话")
        data["conversations"].append(conversation)
        _write_store(data)
    return conversation


def update_conversation(conversation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        data = _read_store()
        conversation = _find(data, conversation_id)
        if "title" in payload:
            conversation["title"] = _normalize_title(payload.get("title"))
        if "config_id" in payload:
            conversation["config_id"] = str(payload.get("config_id") or "")
        conversation["updated_at"] = time.time()
        _write_store(data)
        return conversation


def delete_conversation(conversation_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _read_store()
        conversation = _find(data, conversation_id)
        data["conversations"].remove(conversation)
        _write_store(data)
    return {"ok": True}


async def send_message(conversation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """追加用户消息，调用 AI 生成回复并保存；AI 失败时保留用户消息并返回错误。"""
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(content) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail=f"消息长度不能超过 {MAX_MESSAGE_CHARS} 字")

    with _LOCK:
        data = _read_store()
        conversation = _find(data, conversation_id)
        conversation["messages"].append({"role": "user", "content": content, "created_at": time.time()})
        # 首条消息自动作为标题
        if conversation.get("title") in ("", DEFAULT_TITLE) and len(conversation["messages"]) == 1:
            conversation["title"] = _normalize_title(content[:30])
        conversation["updated_at"] = time.time()
        history = [
            {"role": item["role"], "content": item["content"]}
            for item in conversation["messages"][-MAX_CONTEXT_MESSAGES:]
        ]
        config_id = conversation.get("config_id") or None
        _write_store(data)

    result = await ai_settings.chat_completion(history, temperature=0.7, config_id=config_id)

    with _LOCK:
        data = _read_store()
        conversation = _find(data, conversation_id)
        conversation["messages"].append({
            "role": "assistant",
            "content": result["content"],
            "created_at": time.time(),
            "model": result.get("model", ""),
            "config_name": result.get("config_name", ""),
        })
        conversation["updated_at"] = time.time()
        _write_store(data)
        return conversation
