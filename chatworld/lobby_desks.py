"""聊天大厅工位认领：大厅里的工位可以被账号认领，认领者坐到自己的工位上打开待办清单。

- 认领关系存入 SQLite（core/database.py 的 lobby_desks 表）：每个工位最多一人、每人最多一个工位
- 认领新工位时自动退还原来的工位；工位已被别人认领时返回 409
- 对外只返回认领者在聊天大厅中的显示名字，不暴露登录用户名
- 工位编号形如 desk-1 … desk-N，N 必须与 scripts/build_chat_lobby_assets.py 的 DESK_COUNT 一致
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from fastapi import HTTPException

from chatworld import lobby_profile
from core.database import connect, transaction

DESK_COUNT = 6
DESK_IDS = frozenset(f"desk-{n}" for n in range(1, DESK_COUNT + 1))


def desk_state(username: str) -> dict[str, Any]:
    """全部已认领的工位（显示名字与是否为自己的）以及自己的工位编号。"""
    with connect() as conn:
        rows = conn.execute("SELECT desk, owner FROM lobby_desks ORDER BY desk").fetchall()
    desks: dict[str, dict[str, Any]] = {}
    mine = None
    for row in rows:
        if row["desk"] not in DESK_IDS:
            continue
        owner = row["owner"]
        desks[row["desk"]] = {"name": lobby_profile.get_profile(owner)["name"], "mine": owner == username}
        if owner == username:
            mine = row["desk"]
    return {"desks": desks, "mine": mine}


def claim(username: str, desk: object) -> dict[str, Any]:
    """认领工位；已有工位时换到新工位。"""
    if not isinstance(desk, str) or desk not in DESK_IDS:
        raise HTTPException(status_code=400, detail="工位不存在")
    try:
        with transaction() as conn:
            row = conn.execute("SELECT owner FROM lobby_desks WHERE desk = ?", (desk,)).fetchone()
            if row is not None and row["owner"] != username:
                raise HTTPException(status_code=409, detail="这个工位刚被别人认领了")
            conn.execute("DELETE FROM lobby_desks WHERE owner = ?", (username,))
            conn.execute("INSERT INTO lobby_desks(desk, owner, claimed_at) VALUES (?, ?, ?)", (desk, username, time.time()))
    except sqlite3.IntegrityError as exc:
        # 并发认领同一工位：唯一约束兜底
        raise HTTPException(status_code=409, detail="这个工位刚被别人认领了") from exc
    return desk_state(username)


def release(username: str) -> dict[str, Any]:
    """退还自己的工位（没有工位时不报错）。"""
    with connect() as conn:
        conn.execute("DELETE FROM lobby_desks WHERE owner = ?", (username,))
    return desk_state(username)


def purge_user(username: str) -> None:
    """删除账号时退还其工位。"""
    with connect() as conn:
        conn.execute("DELETE FROM lobby_desks WHERE owner = ?", (username,))
