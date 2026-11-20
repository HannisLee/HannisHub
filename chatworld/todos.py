"""工位待办：每个账号自己的上班待办清单，存入 SQLite（core/database.py 的 todos 表），按 owner 隔离。

字段：
- title 标题（必填，最多 200 字）、note 备注（最多 4000 字）、list 所属清单（最多 24 字，空为「未分类」）
- priority 优先级 0 无 / 1 低 / 2 中 / 3 高；due_date 截止日期 YYYY-MM-DD（空为不设）
- my_day 加入「今天」的日期 YYYY-MM-DD（由浏览器按本地日期给出；未完成时过了这一天仍顺延显示在「今天」，前端标注「昨天加入」等）
- done 是否完成、done_at 完成时间；status 执行状态（not_started 待开始 / in_progress 进行中 / blocked 阻塞中，与 done 独立）
- subtasks 子任务 [{id, title, done}]（最多 50 个）
- progress 进度记录 [{id, text, created_at}]，按添加顺序从旧到新保存
- sort 手动排序值（越小越靠前），新建的排在最后
- space 所属分区编号（todo_spaces 表）；分区之间的待办互相独立，新建未指定分区时放入第一个分区

分区（todo_spaces）：每个账号至少一个，首次读取时自动创建默认分区「工作」，并把没有分区或分区已不存在的待办归入第一个分区。
分区名最多 12 字、同一账号内不重名，最多 20 个；删除分区时需指定把其中的待办移到哪个分区，或明确一并删除。
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
MAX_PROGRESS_TEXT = 1000
MAX_TODOS = 2000
DEFAULT_STATUS = "not_started"
VALID_STATUSES = ("not_started", "in_progress", "blocked")
SUBTASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
TODO_ID = re.compile(r"^[a-f0-9]{16}$")
SPACE_ID = re.compile(r"^[a-f0-9]{12}$")
MAX_SPACE_NAME = 12
MAX_SPACES = 20
DEFAULT_SPACE_NAME = "工作"
FIELDS = ("title", "note", "list", "priority", "due_date", "my_day", "done", "status", "subtasks", "sort", "space")


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


def _status(value: object) -> str:
    if not isinstance(value, str) or value not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="执行状态应为待开始、进行中或阻塞中")
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
    if "status" in payload:
        columns["status"] = _status(payload["status"])
    if "subtasks" in payload:
        columns["subtasks"] = _subtasks(payload["subtasks"])
    if "sort" in payload:
        columns["sort"] = _sort(payload["sort"])
    if "space" in payload:
        # 是否属于当前账号在写入前由 _check_space 校验
        if not isinstance(payload["space"], str) or not SPACE_ID.match(payload["space"]):
            raise HTTPException(status_code=400, detail="分区不存在")
        columns["space"] = payload["space"]
    return columns


def _public(row: Any) -> dict[str, Any]:
    raw_status = row["status"] if "status" in row.keys() else DEFAULT_STATUS
    status = raw_status if raw_status in VALID_STATUSES else DEFAULT_STATUS
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
        "status": status,
        "subtasks": json.loads(row["subtasks"] or "[]"),
        "progress": json.loads(row["progress"]),
        "sort": row["sort"],
        "space": row["space"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _check_id(todo_id: str) -> None:
    if not TODO_ID.match(todo_id or ""):
        raise HTTPException(status_code=404, detail="待办不存在")


def _space_public(row: Any) -> dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "sort": row["sort"], "created_at": row["created_at"]}


def _ensure_spaces(conn: Any, owner: str) -> list[Any]:
    """保证账号至少有一个分区，并把无分区或分区已失效的待办归入第一个分区；返回按顺序排列的分区行。
    需在 transaction() 中调用。"""
    spaces = conn.execute("SELECT * FROM todo_spaces WHERE owner = ? ORDER BY sort, created_at", (owner,)).fetchall()
    if not spaces:
        now = time.time()
        conn.execute(
            "INSERT INTO todo_spaces(id, owner, name, sort, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
            (secrets.token_hex(6), owner, DEFAULT_SPACE_NAME, now, now),
        )
        spaces = conn.execute("SELECT * FROM todo_spaces WHERE owner = ? ORDER BY sort, created_at", (owner,)).fetchall()
    orphan = conn.execute(
        "SELECT 1 FROM todos WHERE owner = ? AND space NOT IN (SELECT id FROM todo_spaces WHERE owner = ?) LIMIT 1",
        (owner, owner),
    ).fetchone()
    if orphan:
        conn.execute(
            "UPDATE todos SET space = ? WHERE owner = ? AND space NOT IN (SELECT id FROM todo_spaces WHERE owner = ?)",
            (spaces[0]["id"], owner, owner),
        )
    return spaces


def _check_space(conn: Any, owner: str, space_id: str) -> None:
    if not conn.execute("SELECT 1 FROM todo_spaces WHERE id = ? AND owner = ?", (space_id, owner)).fetchone():
        raise HTTPException(status_code=400, detail="分区不存在")


def list_spaces(owner: str) -> list[dict[str, Any]]:
    """当前账号的分区（按顺序），没有时自动创建默认分区。"""
    with transaction() as conn:
        return [_space_public(row) for row in _ensure_spaces(conn, owner)]


def overview(owner: str) -> dict[str, Any]:
    """待办页面加载：分区与全部待办在同一事务中读取，保证每条待办的分区都存在。"""
    with transaction() as conn:
        spaces = _ensure_spaces(conn, owner)
        rows = conn.execute("SELECT * FROM todos WHERE owner = ? ORDER BY sort, created_at", (owner,)).fetchall()
    return {"spaces": [_space_public(row) for row in spaces], "todos": [_public(row) for row in rows]}


def list_todos(owner: str) -> list[dict[str, Any]]:
    """当前账号的全部待办，按手动排序、创建时间排列（筛选、分区与分组在前端完成）。"""
    return overview(owner)["todos"]


def create_todo(owner: str, payload: dict[str, Any]) -> dict[str, Any]:
    columns = _normalize(payload)
    if "title" not in columns:
        raise HTTPException(status_code=400, detail="请填写待办内容")
    now = time.time()
    todo_id = secrets.token_hex(8)
    done = columns.get("done", 0)
    with transaction() as conn:
        spaces = _ensure_spaces(conn, owner)
        if "space" in columns:
            _check_space(conn, owner, columns["space"])
        count, last = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(sort), 0) FROM todos WHERE owner = ?", (owner,),
        ).fetchone()
        if count >= MAX_TODOS:
            raise HTTPException(status_code=400, detail=f"待办最多 {MAX_TODOS} 条，请先清理已完成的待办")
        row = {
            "id": todo_id, "owner": owner, "title": columns["title"], "note": columns.get("note", ""),
            "list": columns.get("list", ""), "priority": columns.get("priority", 0),
            "due_date": columns.get("due_date", ""), "my_day": columns.get("my_day", ""), "done": done,
            "done_at": now if done else None, "status": columns.get("status", DEFAULT_STATUS),
            "subtasks": columns.get("subtasks", "[]"), "space": columns.get("space", spaces[0]["id"]),
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
        if "space" in columns:
            _check_space(conn, owner, columns["space"])
        if "done" in columns and bool(columns["done"]) != bool(row["done"]):
            columns["done_at"] = time.time() if columns["done"] else None
        if columns:
            columns["updated_at"] = time.time()
            assignments = ", ".join(f"{key} = ?" for key in columns)
            conn.execute(f"UPDATE todos SET {assignments} WHERE id = ? AND owner = ?", (*columns.values(), todo_id, owner))
        saved = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    return _public(saved)


def add_progress_with_status(
    owner: str,
    todo_id: str,
    text: object,
    status: object = None,
    done: object = None,
) -> dict[str, Any]:
    """追加进度记录（可选同时修改执行状态或完成状态），由服务端记录时间并返回最新状态。"""
    _check_id(todo_id)
    next_status = _status(status) if status is not None else None
    if done is not None and not isinstance(done, bool):
        raise HTTPException(status_code=400, detail="完成状态应为布尔值")
    cleaned = _clean(text, MAX_PROGRESS_TEXT, multiline=True) if isinstance(text, str) else ""
    if not cleaned:
        raise HTTPException(status_code=400, detail="请填写进度内容")
    with transaction() as conn:
        row = conn.execute(
            "SELECT progress, status, done, done_at FROM todos WHERE id = ? AND owner = ?",
            (todo_id, owner),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="待办不存在")
        now = time.time()
        entry = {"id": secrets.token_hex(8), "text": cleaned, "created_at": now}
        progress = json.loads(row["progress"])
        progress.append(entry)
        saved_status = next_status if next_status is not None else (row["status"] if row["status"] in VALID_STATUSES else DEFAULT_STATUS)
        saved_done = bool(row["done"]) if done is None else done
        if done is None:
            saved_done_at = row["done_at"]
        elif saved_done != bool(row["done"]):
            saved_done_at = now if saved_done else None
        else:
            saved_done_at = row["done_at"]
        conn.execute(
            "UPDATE todos SET progress = ?, status = ?, done = ?, done_at = ?, updated_at = ? WHERE id = ? AND owner = ?",
            (json.dumps(progress, ensure_ascii=False), saved_status, int(saved_done), saved_done_at, now, todo_id, owner),
        )
    return {**entry, "status": saved_status, "done": saved_done, "done_at": saved_done_at}


def add_progress(owner: str, todo_id: str, text: object) -> dict[str, Any]:
    """追加进度记录，由服务端记录时间。"""
    result = add_progress_with_status(owner, todo_id, text)
    return {"id": result["id"], "text": result["text"], "created_at": result["created_at"]}


def delete_todo(owner: str, todo_id: str) -> None:
    _check_id(todo_id)
    with connect() as conn:
        cursor = conn.execute("DELETE FROM todos WHERE id = ? AND owner = ?", (todo_id, owner))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="待办不存在")


def clear_completed(owner: str, list_name: str | None = None, space: str | None = None) -> int:
    """删除已完成的待办；给出 list_name 时只清理该清单，给出 space 时只清理该分区。返回删除条数。"""
    sql = "DELETE FROM todos WHERE owner = ? AND done = 1"
    params: list[Any] = [owner]
    if list_name is not None:
        sql += " AND list = ?"
        params.append(_clean(list_name, MAX_LIST))
    if space is not None:
        sql += " AND space = ?"
        params.append(space)
    with connect() as conn:
        cursor = conn.execute(sql, params)
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


def _space_name(value: object) -> str:
    name = _clean(value, MAX_SPACE_NAME)
    if not name:
        raise HTTPException(status_code=400, detail="请填写分区名称")
    return name


def _check_space_id(space_id: str) -> None:
    if not SPACE_ID.match(space_id or ""):
        raise HTTPException(status_code=404, detail="分区不存在")


def _ensure_unique_name(conn: Any, owner: str, name: str, exclude: str = "") -> None:
    rows = conn.execute("SELECT id, name FROM todo_spaces WHERE owner = ?", (owner,)).fetchall()
    if any(row["id"] != exclude and row["name"].casefold() == name.casefold() for row in rows):
        raise HTTPException(status_code=400, detail=f"已有名为「{name}」的分区")


def create_space(owner: str, payload: dict[str, Any]) -> dict[str, Any]:
    """新建分区，排在最后。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    name = _space_name(payload.get("name"))
    with transaction() as conn:
        spaces = _ensure_spaces(conn, owner)
        if len(spaces) >= MAX_SPACES:
            raise HTTPException(status_code=400, detail=f"分区最多 {MAX_SPACES} 个")
        _ensure_unique_name(conn, owner, name)
        now = time.time()
        space_id = secrets.token_hex(6)
        conn.execute(
            "INSERT INTO todo_spaces(id, owner, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (space_id, owner, name, max(row["sort"] for row in spaces) + 1, now, now),
        )
        saved = conn.execute("SELECT * FROM todo_spaces WHERE id = ?", (space_id,)).fetchone()
    return _space_public(saved)


def rename_space(owner: str, space_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    _check_space_id(space_id)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    name = _space_name(payload.get("name"))
    with transaction() as conn:
        if not conn.execute("SELECT 1 FROM todo_spaces WHERE id = ? AND owner = ?", (space_id, owner)).fetchone():
            raise HTTPException(status_code=404, detail="分区不存在")
        _ensure_unique_name(conn, owner, name, exclude=space_id)
        conn.execute(
            "UPDATE todo_spaces SET name = ?, updated_at = ? WHERE id = ? AND owner = ?", (name, time.time(), space_id, owner),
        )
        saved = conn.execute("SELECT * FROM todo_spaces WHERE id = ?", (space_id,)).fetchone()
    return _space_public(saved)


def reorder_spaces(owner: str, ids: object) -> list[dict[str, Any]]:
    """按给定顺序排列分区；未列出的分区保持相对顺序排在后面。"""
    if not isinstance(ids, list) or len(ids) > MAX_SPACES or not all(isinstance(i, str) and SPACE_ID.match(i) for i in ids):
        raise HTTPException(status_code=400, detail="分区排序列表不正确")
    with transaction() as conn:
        spaces = _ensure_spaces(conn, owner)
        mine = [row["id"] for row in spaces]
        listed = [i for i in dict.fromkeys(ids) if i in mine]
        ordered = listed + [i for i in mine if i not in listed]
        now = time.time()
        for index, space_id in enumerate(ordered, start=1):
            conn.execute("UPDATE todo_spaces SET sort = ?, updated_at = ? WHERE id = ? AND owner = ?", (index, now, space_id, owner))
        rows = conn.execute("SELECT * FROM todo_spaces WHERE owner = ? ORDER BY sort, created_at", (owner,)).fetchall()
    return [_space_public(row) for row in rows]


def delete_space(owner: str, space_id: str, move_to: str | None = None, delete_todos: bool = False) -> dict[str, Any]:
    """删除分区。分区里还有待办时必须给出 move_to（移到另一个分区）或 delete_todos=True（一并删除）。
    至少保留一个分区。返回剩余分区与移动、删除的条数。"""
    _check_space_id(space_id)
    with transaction() as conn:
        spaces = _ensure_spaces(conn, owner)
        if space_id not in {row["id"] for row in spaces}:
            raise HTTPException(status_code=404, detail="分区不存在")
        if len(spaces) <= 1:
            raise HTTPException(status_code=400, detail="至少保留一个分区")
        count = conn.execute("SELECT COUNT(*) FROM todos WHERE owner = ? AND space = ?", (owner, space_id)).fetchone()[0]
        moved = deleted = 0
        if count and move_to:
            if move_to == space_id or not SPACE_ID.match(move_to):
                raise HTTPException(status_code=400, detail="请选择另一个分区")
            _check_space(conn, owner, move_to)
            moved = conn.execute(
                "UPDATE todos SET space = ?, updated_at = ? WHERE owner = ? AND space = ?", (move_to, time.time(), owner, space_id),
            ).rowcount
        elif count and delete_todos:
            deleted = conn.execute("DELETE FROM todos WHERE owner = ? AND space = ?", (owner, space_id)).rowcount
        elif count:
            raise HTTPException(status_code=400, detail=f"分区里还有 {count} 条待办，请选择移到哪个分区或一并删除")
        conn.execute("DELETE FROM todo_spaces WHERE id = ? AND owner = ?", (space_id, owner))
        rows = conn.execute("SELECT * FROM todo_spaces WHERE owner = ? ORDER BY sort, created_at", (owner,)).fetchall()
    return {"spaces": [_space_public(row) for row in rows], "moved": moved, "deleted": deleted}


def purge_user(owner: str) -> None:
    """删除账号时清理其全部待办与分区。"""
    with connect() as conn:
        conn.execute("DELETE FROM todos WHERE owner = ?", (owner,))
        conn.execute("DELETE FROM todo_spaces WHERE owner = ?", (owner,))
