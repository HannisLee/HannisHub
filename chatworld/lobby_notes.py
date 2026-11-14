"""聊天大厅留言板：大厅中间的便签墙，所有登录账号共享、都能看到。

- 便签存入 SQLite（core/database.py 的 lobby_notes 表）：作者账号 owner、贴出时的显示名字、内容与颜色
- 内容去控制字符（保留换行）、最多 140 字；颜色限定六种
- 每人最多同时贴 20 张，10 秒内只能贴一张；整面墙最多保留 300 张，超出时撕掉最旧的
- 自己贴的可以撕掉，管理员可以撕掉任何一张；对外不暴露作者登录用户名
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from fastapi import HTTPException

from chatworld import lobby_profile
from core.auth import ADMIN_USERNAME
from core.database import connect, transaction

MAX_TEXT = 140
MAX_PER_USER = 20
MAX_NOTES = 300
POST_INTERVAL_SECONDS = 10.0
COLORS = ("yellow", "pink", "blue", "green", "orange", "purple")


def _clean(value: object) -> str:
    text = str(value if value is not None else "").replace("\r\n", "\n")
    text = "".join(ch for ch in text if ch.isprintable() or ch == "\n")
    # 连续空行最多保留一个
    lines = [" ".join(line.split()) for line in text.split("\n")]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()[:MAX_TEXT].strip()


def _public(row: Any, username: str) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "text": row["text"], "color": row["color"],
        "mine": row["owner"] == username, "created_at": row["created_at"],
    }


def list_notes(username: str) -> dict[str, Any]:
    """整面留言板，最新的在前。"""
    with connect() as conn:
        rows = conn.execute("SELECT * FROM lobby_notes ORDER BY created_at DESC LIMIT ?", (MAX_NOTES,)).fetchall()
    return {"notes": [_public(row, username) for row in rows], "can_moderate": username == ADMIN_USERNAME}


def post_note(username: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    text = _clean(payload.get("text"))
    if not text:
        raise HTTPException(status_code=400, detail="便签不能是空的")
    color = payload.get("color")
    if color not in COLORS:
        color = "yellow"
    name = lobby_profile.get_profile(username)["name"]
    now = time.time()
    note_id = secrets.token_hex(8)
    with transaction() as conn:
        mine = conn.execute(
            "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM lobby_notes WHERE owner = ?", (username,),
        ).fetchone()
        if mine["last"] is not None and now - mine["last"] < POST_INTERVAL_SECONDS:
            raise HTTPException(status_code=429, detail="贴得太快了，稍等几秒再贴")
        if mine["n"] >= MAX_PER_USER:
            raise HTTPException(status_code=400, detail=f"每人最多同时贴 {MAX_PER_USER} 张，先撕掉一些旧的吧")
        conn.execute(
            "INSERT INTO lobby_notes(id, owner, name, text, color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, username, name, text, color, now),
        )
        # 墙贴满了：撕掉最旧的
        conn.execute(
            "DELETE FROM lobby_notes WHERE id NOT IN (SELECT id FROM lobby_notes ORDER BY created_at DESC LIMIT ?)",
            (MAX_NOTES,),
        )
        row = conn.execute("SELECT * FROM lobby_notes WHERE id = ?", (note_id,)).fetchone()
    return _public(row, username)


def delete_note(username: str, note_id: str) -> None:
    with connect() as conn:
        if username == ADMIN_USERNAME:
            cursor = conn.execute("DELETE FROM lobby_notes WHERE id = ?", (note_id,))
        else:
            cursor = conn.execute("DELETE FROM lobby_notes WHERE id = ? AND owner = ?", (note_id, username))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="便签不存在或不是你贴的")


def purge_user(username: str) -> None:
    """删除账号时撕掉其全部便签。"""
    with connect() as conn:
        conn.execute("DELETE FROM lobby_notes WHERE owner = ?", (username,))
