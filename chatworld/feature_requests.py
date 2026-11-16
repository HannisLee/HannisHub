"""功能改进建议板：聊天室右侧的共享建议列表，所有登录账号都能提、都能看到。

- 建议存入 SQLite（core/database.py 的 feature_requests 表）：提出人账号 owner、提出时的显示名字、内容、状态
- 内容去控制字符（保留换行）、最多 1000 字
- 状态：open 待处理 / accepted 已采纳 / done 已完成 / declined 暂不考虑，只有管理员可以修改
- 每人 10 秒内只能提一条、最多保留 50 条；整个板最多保留 500 条，超出时删除最旧的
- 自己提的可以删除，管理员可以删除任何一条；对外不暴露提出人登录用户名
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from fastapi import HTTPException

from chatworld import lobby_profile
from core.auth import ADMIN_USERNAME
from core.database import connect, transaction

MAX_TEXT = 1000
MAX_PER_USER = 50
MAX_ITEMS = 500
POST_INTERVAL_SECONDS = 10.0
STATUSES = ("open", "accepted", "done", "declined")


def _clean(value: object) -> str:
    text = str(value if value is not None else "").replace("\r\n", "\n")
    text = "".join(ch for ch in text if ch.isprintable() or ch == "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    out: list[str] = []
    for line in lines:
        # 连续空行最多保留一个
        if line.strip() or (out and out[-1].strip()):
            out.append(line)
    return "\n".join(out).strip()[:MAX_TEXT].strip()


def _public(row: Any, username: str) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "text": row["text"], "status": row["status"],
        "mine": row["owner"] == username, "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_requests(username: str) -> dict[str, Any]:
    """全部建议，最新的在前。"""
    with connect() as conn:
        rows = conn.execute("SELECT * FROM feature_requests ORDER BY created_at DESC LIMIT ?", (MAX_ITEMS,)).fetchall()
    return {"items": [_public(row, username) for row in rows], "can_moderate": username == ADMIN_USERNAME}


def post_request(username: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    text = _clean(payload.get("text"))
    if not text:
        raise HTTPException(status_code=400, detail="建议内容不能为空")
    name = lobby_profile.get_profile(username)["name"]
    now = time.time()
    item_id = secrets.token_hex(8)
    with transaction() as conn:
        mine = conn.execute(
            "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM feature_requests WHERE owner = ?", (username,),
        ).fetchone()
        if mine["last"] is not None and now - mine["last"] < POST_INTERVAL_SECONDS:
            raise HTTPException(status_code=429, detail="提交太快了，稍等几秒再提")
        if mine["n"] >= MAX_PER_USER:
            raise HTTPException(status_code=400, detail=f"每人最多保留 {MAX_PER_USER} 条建议，先删掉一些旧的吧")
        conn.execute(
            "INSERT INTO feature_requests(id, owner, name, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
            (item_id, username, name, text, now, now),
        )
        conn.execute(
            "DELETE FROM feature_requests WHERE id NOT IN (SELECT id FROM feature_requests ORDER BY created_at DESC LIMIT ?)",
            (MAX_ITEMS,),
        )
        row = conn.execute("SELECT * FROM feature_requests WHERE id = ?", (item_id,)).fetchone()
    return _public(row, username)


def set_status(username: str, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """管理员修改建议状态。"""
    if username != ADMIN_USERNAME:
        raise HTTPException(status_code=403, detail="只有管理员可以修改建议状态")
    status = payload.get("status") if isinstance(payload, dict) else None
    if status not in STATUSES:
        raise HTTPException(status_code=400, detail="状态无效")
    with transaction() as conn:
        cursor = conn.execute(
            "UPDATE feature_requests SET status = ?, updated_at = ? WHERE id = ?", (status, time.time(), item_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="建议不存在")
        row = conn.execute("SELECT * FROM feature_requests WHERE id = ?", (item_id,)).fetchone()
    return _public(row, username)


def delete_request(username: str, item_id: str) -> None:
    with connect() as conn:
        if username == ADMIN_USERNAME:
            cursor = conn.execute("DELETE FROM feature_requests WHERE id = ?", (item_id,))
        else:
            cursor = conn.execute("DELETE FROM feature_requests WHERE id = ? AND owner = ?", (item_id, username))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="建议不存在或不是你提的")


def purge_user(username: str) -> None:
    """删除账号时清理其全部建议。"""
    with connect() as conn:
        conn.execute("DELETE FROM feature_requests WHERE owner = ?", (username,))
