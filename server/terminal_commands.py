"""终端命令组：按账号保存可一键新建终端并执行的命令序列。"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

from fastapi import HTTPException

from core.database import connect, transaction

MAX_NAME_CHARS = 40
MAX_COMMAND_CHARS = 2_000
MAX_COMMANDS = 20
MAX_GROUPS = 50


def _clean_name(value: Any) -> str:
    """清理命令组名称，保留可见字符并压缩空白。"""
    name = " ".join(str(value or "").split())[:MAX_NAME_CHARS]
    if not name:
        raise HTTPException(status_code=400, detail="请填写命令组名称")
    return name


def _clean_commands(value: Any) -> list[str]:
    """整理命令列表：每项保留内部换行，去掉首尾空白并拒绝空命令。"""
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="命令必须是一个字符串数组")
    if not 1 <= len(value) <= MAX_COMMANDS:
        raise HTTPException(status_code=400, detail=f"命令数量应为 1–{MAX_COMMANDS} 条")
    commands: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            raise HTTPException(status_code=400, detail="每条命令都必须是字符串")
        command = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not command:
            raise HTTPException(status_code=400, detail="命令不能为空")
        if len(command) > MAX_COMMAND_CHARS:
            raise HTTPException(status_code=400, detail=f"单条命令最多 {MAX_COMMAND_CHARS} 字符")
        commands.append(command)
    return commands


def _public(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "commands": json.loads(row["commands"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_groups(owner: str) -> list[dict[str, Any]]:
    """按创建时间列出当前账号的终端命令组。"""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM terminal_command_groups WHERE owner = ? ORDER BY created_at, rowid",
            (owner,),
        ).fetchall()
    return [_public(row) for row in rows]


def create_group(owner: str, payload: dict[str, Any]) -> dict[str, Any]:
    """新建命令组，同账号最多 50 组。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    name = _clean_name(payload.get("name"))
    commands = _clean_commands(payload.get("commands"))
    now = time.time()
    group_id = f"tc_{secrets.token_hex(8)}"
    with transaction() as conn:
        count = conn.execute("SELECT COUNT(*) FROM terminal_command_groups WHERE owner = ?", (owner,)).fetchone()[0]
        if count >= MAX_GROUPS:
            raise HTTPException(status_code=409, detail=f"最多保存 {MAX_GROUPS} 组命令")
        conn.execute(
            "INSERT INTO terminal_command_groups(id, owner, name, commands, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (group_id, owner, name, json.dumps(commands, ensure_ascii=False), now, now),
        )
        row = conn.execute("SELECT * FROM terminal_command_groups WHERE id = ?", (group_id,)).fetchone()
    return _public(row)


def update_group(owner: str, group_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """修改自己的命令组名称或命令。"""
    if not isinstance(payload, dict) or not {"name", "commands"} & payload.keys():
        raise HTTPException(status_code=400, detail="没有可修改的字段")
    changes: dict[str, Any] = {}
    if "name" in payload:
        changes["name"] = _clean_name(payload["name"])
    if "commands" in payload:
        commands = _clean_commands(payload["commands"])
        changes["commands"] = json.dumps(commands, ensure_ascii=False)
    changes["updated_at"] = time.time()
    assignments = ", ".join(f"{key} = ?" for key in changes)
    with transaction() as conn:
        cursor = conn.execute(
            f"UPDATE terminal_command_groups SET {assignments} WHERE id = ? AND owner = ?",
            (*changes.values(), group_id, owner),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="命令组不存在")
        row = conn.execute("SELECT * FROM terminal_command_groups WHERE id = ?", (group_id,)).fetchone()
    return _public(row)


def get_group(owner: str, group_id: str) -> dict[str, Any]:
    """读取自己的命令组，执行接口使用。"""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM terminal_command_groups WHERE id = ? AND owner = ?",
            (group_id, owner),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="命令组不存在")
    return _public(row)


def delete_group(owner: str, group_id: str) -> None:
    """删除自己的命令组。"""
    with transaction() as conn:
        cursor = conn.execute(
            "DELETE FROM terminal_command_groups WHERE id = ? AND owner = ?",
            (group_id, owner),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="命令组不存在")


def purge_user(owner: str) -> None:
    """删除账号时清理其终端命令组。"""
    with connect() as conn:
        conn.execute("DELETE FROM terminal_command_groups WHERE owner = ?", (owner,))
