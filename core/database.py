"""SQLite 数据库：保存按登录账号隔离的业务记录（ASR 转写、OCR 识别、个人偏好、工位待办）与聊天大厅工位认领。

- 数据库文件位于根目录 data/hannishub.db（不入库），可用环境变量 HANNISHUB_DB_PATH 覆盖（测试用临时库）。
- 每条记录带 owner 列（登录用户名），查询时按 owner 过滤，因此 data/ 下的文件不再需要按用户分目录。
- 只使用 Python 标准库 sqlite3；WAL 模式允许后台任务写入时页面并发读取。
- 表结构通过 PRAGMA user_version 递增迁移，_MIGRATIONS 只追加不修改。
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

# 模块位于子目录，ROOT_DIR 指向项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = ROOT_DIR / "data" / "hannishub.db"

# 第 N 项把库从版本 N 升级到 N+1
_MIGRATIONS: list[str] = [
    """
    CREATE TABLE asr_records (
        id                TEXT PRIMARY KEY,
        owner             TEXT NOT NULL,
        name              TEXT NOT NULL,
        original_filename TEXT NOT NULL DEFAULT '',
        uploaded_at       REAL NOT NULL,
        duration          REAL,
        chunks            INTEGER,
        text_length       INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL,
        progress          REAL NOT NULL DEFAULT 0,
        progress_detail   TEXT NOT NULL DEFAULT '',
        error             TEXT,
        transcript        TEXT,
        extraction        TEXT
    );
    CREATE INDEX asr_records_owner ON asr_records(owner, uploaded_at DESC);

    CREATE TABLE ocr_records (
        id              TEXT PRIMARY KEY,
        owner           TEXT NOT NULL,
        name            TEXT NOT NULL,
        filename        TEXT NOT NULL,
        extension       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        size            INTEGER NOT NULL DEFAULT 0,
        task            TEXT NOT NULL,
        fields          TEXT NOT NULL DEFAULT '',
        question        TEXT NOT NULL DEFAULT '',
        pipeline        TEXT NOT NULL DEFAULT 'ocr',
        status          TEXT NOT NULL,
        progress        REAL NOT NULL DEFAULT 0,
        progress_detail TEXT NOT NULL DEFAULT '',
        error           TEXT,
        warning         TEXT,
        chars           INTEGER NOT NULL DEFAULT 0,
        latency_ms      INTEGER,
        pages           INTEGER,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        result          TEXT,
        parsed          TEXT
    );
    CREATE INDEX ocr_records_owner ON ocr_records(owner, created_at DESC);

    CREATE TABLE user_settings (
        owner      TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (owner, key)
    );
    """,
    # v2：工位待办（按账号隔离）与聊天大厅工位认领（每个工位最多一人、每人最多一个工位）
    """
    CREATE TABLE todos (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        title      TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        list       TEXT NOT NULL DEFAULT '',
        priority   INTEGER NOT NULL DEFAULT 0,
        due_date   TEXT NOT NULL DEFAULT '',
        my_day     TEXT NOT NULL DEFAULT '',
        done       INTEGER NOT NULL DEFAULT 0,
        done_at    REAL,
        subtasks   TEXT NOT NULL DEFAULT '[]',
        sort       REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE INDEX todos_owner ON todos(owner, done, sort);

    CREATE TABLE lobby_desks (
        desk       TEXT PRIMARY KEY,
        owner      TEXT NOT NULL UNIQUE,
        claimed_at REAL NOT NULL
    );
    """,
]

_init_lock = threading.Lock()
_initialized_path: Path | None = None


def db_path() -> Path:
    """当前使用的数据库路径；每次读取环境变量，便于测试切换临时库。"""
    override = os.environ.get("HANNISHUB_DB_PATH")
    return Path(override).expanduser() if override else DEFAULT_DB_PATH


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for index in range(version, len(_MIGRATIONS)):
        # executescript 会自动提交，因此版本号与表结构放在同一脚本中原子生效
        conn.executescript(f"BEGIN;\n{_MIGRATIONS[index]}\nPRAGMA user_version = {index + 1};\nCOMMIT;")


def _ensure_schema(path: Path) -> None:
    global _initialized_path
    if _initialized_path == path:
        return
    with _init_lock:
        if _initialized_path == path:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = _open(path)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            _migrate(conn)
        finally:
            conn.close()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        _initialized_path = path


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """打开一个连接（自动建表），退出时关闭；连接为自动提交模式，多语句写入请用 transaction()。"""
    path = db_path()
    _ensure_schema(path)
    conn = _open(path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """在 IMMEDIATE 事务中执行多条语句，异常时整体回滚。"""
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def row_dict(row: sqlite3.Row | None, exclude: tuple[str, ...] = ()) -> dict[str, Any] | None:
    """把一行转换为普通字典，可排除大字段（如全文）。"""
    if row is None:
        return None
    return {key: row[key] for key in row.keys() if key not in exclude}


def get_user_setting(owner: str, key: str) -> str | None:
    """读取某个账号的个人偏好，未设置时返回 None。"""
    with connect() as conn:
        row = conn.execute("SELECT value FROM user_settings WHERE owner = ? AND key = ?", (owner, key)).fetchone()
    return None if row is None else str(row["value"])


def set_user_setting(owner: str, key: str, value: str) -> None:
    """写入某个账号的个人偏好。"""
    with connect() as conn:
        conn.execute(
            "INSERT INTO user_settings(owner, key, value, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (owner, key, value, time.time()),
        )


def purge_owner_settings(owner: str) -> None:
    """删除账号时清理其个人偏好。"""
    with connect() as conn:
        conn.execute("DELETE FROM user_settings WHERE owner = ?", (owner,))
