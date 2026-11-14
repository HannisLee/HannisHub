"""工位待办：每个账号自己的上班待办清单，存入 SQLite（core/database.py 的 todos 表），按 owner 隔离。

字段：
- title 标题（必填，最多 200 字）、note 备注（最多 4000 字）、list 所属清单（最多 24 字，空为「未分类」）
- priority 优先级 0 无 / 1 低 / 2 中 / 3 高；due_date 截止日期 YYYY-MM-DD（空为不设）
- my_day 加入「今天」的日期 YYYY-MM-DD（由浏览器按本地日期给出，过了这一天自动不再算「今天」）
- done 是否完成、done_at 完成时间；subtasks 子任务 [{id, title, done}]（最多 50 个）
- sort 手动排序值（越小越靠前），新建的排在最后
"""

from __future__ import annotations

import json
import re
import secrets
import time
from datetime import date
from typing import Any

from fastapi import HTTPException

from core.database import connect, transaction

MAX_TITLE = 200
MAX_NOTE = 4000
MAX_LIST = 24
MAX_SUBTASKS = 50
MAX_TODOS = 2000
SUBTASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
TODO_ID = re.compile(r"^[a-f0-9]{16}$")
FIELDS = ("title", "note", "list", "priority", "due_date", "my_day", "done", "subtasks", "sort")


def _clean(value: object, limit: int, *, multiline: bool = False) -> str:
    """去掉控制字符（备注保留换行与制表符）并截断首尾空白。"""
    text = str(value if value is not None else "")
    allowed = "\n\t" if multiline else ""
    text = "".join(ch for ch in text if ch.isprintable() or ch in allowed)
    if not multiline:
        text = " ".join(text.split())
    return text.strip()[:limit]


def _title(value: object) -> str:
    title = _clean(value, MAX_TITLE)
    if not title:
        raise HTTPException(status_code=400, detail="请填写待办内容")
    return title


def _date(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field} 日期格式应为 YYYY-MM-DD") from exc


def _priority(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 3:
        raise HTTPException(status_code=400, detail="优先级应为 0–3")
    return value


def _subtasks(value: object) -> str:
    if not isinstance(value, list) or len(value) > MAX_SUBTASKS:
        raise HTTPException(status_code=400, detail=f"子任务最多 {MAX_SUBTASKS} 个")
    items = []
    for raw in value:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="子任务格式不正确")
        sid = str(raw.get("id") or "")
        if not SUBTASK_ID.match(sid):
            raise HTTPException(status_code=400, detail="子任务编号不正确")
        items.append({"id": sid, "title": _title(raw.get("title")), "done": raw.get("done") is True})
    return json.dumps(items, ensure_ascii=False)


def _sort(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or abs(value) > 1e12:
        raise HTTPException(status_code=400, detail="排序值不正确")
    return float(value)


def _normalize(payload: dict[str, Any]) -> dict[str, Any]:
    """只处理请求中出现的字段，返回要写入数据库的列。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    columns: dict[str, Any] = {}
    if "title" in payload:
        columns["title"] = _title(payload["title"])
    if "note" in payload:
        columns["note"] = _clean(payload["note"], MAX_NOTE, multiline=True)
    if "list" in payload:
        columns["list"] = _clean(payload["list"], MAX_LIST)
    if "priority" in payload:
        columns["priority"] = _priority(payload["priority"])
    if "due_date" in payload:
        columns["due_date"] = _date(payload["due_date"], "截止日期")
    if "my_day" in payload:
        columns["my_day"] = _date(payload["my_day"], "今天")
    if "done" in payload:
        if not isinstance(payload["done"], bool):
            raise HTTPException(status_code=400, detail="完成状态应为布尔值")
        columns["done"] = int(payload["done"])
    if "subtasks" in payload:
        columns["subtasks"] = _subtasks(payload["subtasks"])
    if "sort" in payload:
        columns["sort"] = _sort(payload["sort"])
    return columns


def _public(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "note": row["note"],
        "list": row["list"],
        "priority": row["priority"],
        "due_date": row["due_date"],
        "my_day": row["my_day"],
        "done": bool(row["done"]),
        "done_at": row["done_at"],
        "subtasks": json.loads(row["subtasks"] or "[]"),
        "sort": row["sort"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _check_id(todo_id: str) -> None:
    if not TODO_ID.match(todo_id or ""):
        raise HTTPException(status_code=404, detail="待办不存在")


def list_todos(owner: str) -> list[dict[str, Any]]:
    """当前账号的全部待办，按手动排序、创建时间排列（筛选与分组在前端完成）。"""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM todos WHERE owner = ? ORDER BY sort, created_at", (owner,),
        ).fetchall()
    return [_public(row) for row in rows]


def create_todo(owner: str, payload: dict[str, Any]) -> dict[str, Any]:
    columns = _normalize(payload)
    if "title" not in columns:
        raise HTTPException(status_code=400, detail="请填写待办内容")
    now = time.time()
    todo_id = secrets.token_hex(8)
    done = columns.get("done", 0)
    with transaction() as conn:
        count, last = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(sort), 0) FROM todos WHERE owner = ?", (owner,),
        ).fetchone()
        if count >= MAX_TODOS:
            raise HTTPException(status_code=400, detail=f"待办最多 {MAX_TODOS} 条，请先清理已完成的待办")
        row = {
            "id": todo_id, "owner": owner, "title": columns["title"], "note": columns.get("note", ""),
            "list": columns.get("list", ""), "priority": columns.get("priority", 0),
            "due_date": columns.get("due_date", ""), "my_day": columns.get("my_day", ""), "done": done,
            "done_at": now if done else None, "subtasks": columns.get("subtasks", "[]"),
            "sort": columns.get("sort", float(last) + 1), "created_at": now, "updated_at": now,
        }
        conn.execute(
            f"INSERT INTO todos({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})", tuple(row.values()),
        )
        saved = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    return _public(saved)


def update_todo(owner: str, todo_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """修改待办的部分字段；完成状态变化时记录或清除完成时间。"""
    _check_id(todo_id)
    columns = _normalize(payload)
    with transaction() as conn:
        row = conn.execute("SELECT * FROM todos WHERE id = ? AND owner = ?", (todo_id, owner)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="待办不存在")
        if "done" in columns and bool(columns["done"]) != bool(row["done"]):
            columns["done_at"] = time.time() if columns["done"] else None
        if columns:
            columns["updated_at"] = time.time()
            assignments = ", ".join(f"{key} = ?" for key in columns)
            conn.execute(f"UPDATE todos SET {assignments} WHERE id = ? AND owner = ?", (*columns.values(), todo_id, owner))
        saved = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    return _public(saved)


def delete_todo(owner: str, todo_id: str) -> None:
    _check_id(todo_id)
    with connect() as conn:
        cursor = conn.execute("DELETE FROM todos WHERE id = ? AND owner = ?", (todo_id, owner))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="待办不存在")


def clear_completed(owner: str, list_name: str | None = None) -> int:
    """删除已完成的待办；给出 list_name 时只清理该清单。返回删除条数。"""
    with connect() as conn:
        if list_name is None:
            cursor = conn.execute("DELETE FROM todos WHERE owner = ? AND done = 1", (owner,))
        else:
            cursor = conn.execute(
                "DELETE FROM todos WHERE owner = ? AND done = 1 AND list = ?", (owner, _clean(list_name, MAX_LIST)),
            )
    return cursor.rowcount


def reorder(owner: str, ids: object) -> list[dict[str, Any]]:
    """按给定顺序重排（只重排列出的、属于自己的待办），返回全部待办。"""
    if not isinstance(ids, list) or len(ids) > MAX_TODOS or not all(isinstance(i, str) and TODO_ID.match(i) for i in ids):
        raise HTTPException(status_code=400, detail="排序列表不正确")
    with transaction() as conn:
        mine = {row["id"]: row["sort"] for row in conn.execute("SELECT id, sort FROM todos WHERE owner = ?", (owner,))}
        listed = [i for i in dict.fromkeys(ids) if i in mine]
        # 被重排的条目复用它们原来占据的排序值，未列出的条目位置不变
        slots = sorted(mine[i] for i in listed)
        now = time.time()
        for todo_id, value in zip(listed, slots):
            conn.execute("UPDATE todos SET sort = ?, updated_at = ? WHERE id = ? AND owner = ?", (value, now, todo_id, owner))
    return list_todos(owner)


def purge_user(owner: str) -> None:
    """删除账号时清理其全部待办。"""
    with connect() as conn:
        conn.execute("DELETE FROM todos WHERE owner = ?", (owner,))
