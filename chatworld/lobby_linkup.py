"""大厅街机「连连看」排行榜：闯关最高分与每日挑战当日排行。

- 成绩存入 SQLite（core/database.py 的 linkup_scores 表），每个账号在每个模式（闯关 / 某一天的每日挑战）只保留最高分
- 闯关的 day 固定为空字符串；每日挑战的 day 为日期（YYYY-MM-DD），只接受服务器本地的今天或昨天（跨零点时还能提交）
- 分数做上限校验（按关卡数估算的理论最高分），防止明显异常的数据；游戏逻辑在前端，不做更严格的防作弊
- 排行榜显示提交时的大厅名字，不暴露登录用户名；同一账号 3 秒内只能提交一次
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException

from chatworld import lobby_profile
from core.database import connect, transaction

MODES = ("campaign", "daily")
TOP_N = 10
SUBMIT_INTERVAL_SECONDS = 3.0
# 理论上限：每关 56–72 对，每对基础 10 分 + 连击最多 50 分，过关剩余时间每秒 5 分（最多约 250 秒）
MAX_PER_LEVEL = 72 * 60 + 250 * 5
MAX_LEVEL = 999

_last_submit: dict[str, float] = {}


def _today() -> date:
    return date.today()


def _rows(conn: Any, mode: str, day: str, username: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT owner, name, score, level, cleared, plays, updated_at FROM linkup_scores "
        "WHERE mode = ? AND day = ? ORDER BY score DESC, updated_at ASC LIMIT ?",
        (mode, day, TOP_N),
    ).fetchall()
    return [
        {"name": row["name"], "score": row["score"], "level": row["level"], "cleared": bool(row["cleared"]),
         "plays": row["plays"], "mine": row["owner"] == username}
        for row in rows
    ]


def _mine(conn: Any, mode: str, day: str, username: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT score, level, cleared, plays FROM linkup_scores WHERE owner = ? AND mode = ? AND day = ?",
        (username, mode, day),
    ).fetchone()
    if row is None:
        return None
    rank = conn.execute(
        "SELECT COUNT(*) AS n FROM linkup_scores WHERE mode = ? AND day = ? AND score > ?", (mode, day, row["score"]),
    ).fetchone()["n"] + 1
    return {"score": row["score"], "level": row["level"], "cleared": bool(row["cleared"]), "plays": row["plays"], "rank": rank}


def board(username: str) -> dict[str, Any]:
    """排行榜：闯关总榜、今日挑战榜，以及自己的最好成绩与名次；day 为服务器的今天（前端用它生成每日挑战盘面）。"""
    today = _today().isoformat()
    with connect() as conn:
        return {
            "day": today,
            "campaign": _rows(conn, "campaign", "", username),
            "daily": _rows(conn, "daily", today, username),
            "mine": {"campaign": _mine(conn, "campaign", "", username), "daily": _mine(conn, "daily", today, username)},
        }


def _int(value: object, low: int, high: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise HTTPException(status_code=400, detail=f"{field} 无效")
    number = int(value)
    if number < low or number > high:
        raise HTTPException(status_code=400, detail=f"{field} 超出范围")
    return number


def submit(username: str, payload: dict[str, Any]) -> dict[str, Any]:
    """提交一局成绩：只在超过自己原有最高分时更新分数，局数总是加一。返回 {best, record, rank} 与最新排行榜。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求格式不正确")
    mode = payload.get("mode")
    if mode not in MODES:
        raise HTTPException(status_code=400, detail="模式无效")
    level = _int(payload.get("level", 1), 1, MAX_LEVEL, "关卡")
    if mode == "daily":
        level = 1
    score = _int(payload.get("score"), 0, MAX_PER_LEVEL * level, "分数")
    cleared = bool(payload.get("cleared"))
    day = ""
    if mode == "daily":
        day = str(payload.get("day") or "")
        today = _today()
        if day not in {today.isoformat(), (today - timedelta(days=1)).isoformat()}:
            raise HTTPException(status_code=400, detail="这一天的挑战已经结束")

    now = time.time()
    last = _last_submit.get(username)
    if last is not None and now - last < SUBMIT_INTERVAL_SECONDS:
        raise HTTPException(status_code=429, detail="提交太快了")
    _last_submit[username] = now

    name = lobby_profile.get_profile(username)["name"]
    with transaction() as conn:
        row = conn.execute(
            "SELECT score FROM linkup_scores WHERE owner = ? AND mode = ? AND day = ?", (username, mode, day),
        ).fetchone()
        previous = None if row is None else row["score"]
        record = previous is None or score > previous
        if row is None:
            conn.execute(
                "INSERT INTO linkup_scores(owner, mode, day, name, score, level, cleared, plays, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                (username, mode, day, name, score, level, int(cleared), now),
            )
        elif record:
            conn.execute(
                "UPDATE linkup_scores SET name = ?, score = ?, level = ?, cleared = ?, plays = plays + 1, updated_at = ? "
                "WHERE owner = ? AND mode = ? AND day = ?",
                (name, score, level, int(cleared), now, username, mode, day),
            )
        else:
            conn.execute(
                "UPDATE linkup_scores SET name = ?, plays = plays + 1 WHERE owner = ? AND mode = ? AND day = ?",
                (name, username, mode, day),
            )
    result = board(username)
    mine = result["mine"]["daily" if mode == "daily" else "campaign"] if day in ("", result["day"]) else None
    return {"record": record and score > 0, "previous": previous, "rank": mine["rank"] if mine else None, "board": result}


def purge_user(username: str) -> None:
    """删除账号时清理其全部成绩。"""
    _last_submit.pop(username, None)
    with connect() as conn:
        conn.execute("DELETE FROM linkup_scores WHERE owner = ?", (username,))
