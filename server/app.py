"""LlamaManager Server：独立的 SSH 服务器连接和定时任务管理服务。"""

import asyncio
import json
import os
import re
import shlex
import subprocess
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

try:
    import paramiko
except ImportError:  # 保留系统 ssh 降级路径，方便临时使用
    paramiko = None


APP_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = APP_DIR / "settings.json"
DEFAULT_SETTINGS = {"connections": {}, "tasks": {}}
SETTINGS_LOCK = threading.RLock()
TASK_LOCK = threading.RLock()
TASK_RUNS: set[str] = set()
SCHEDULER_TASK: Optional[asyncio.Task] = None


def _read_settings() -> dict:
    """读取本地 JSON 配置，损坏或不存在时使用空配置。"""
    with SETTINGS_LOCK:
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {
                    "connections": data.get("connections", {}) if isinstance(data.get("connections", {}), dict) else {},
                    "tasks": data.get("tasks", {}) if isinstance(data.get("tasks", {}), dict) else {},
                }
        except (OSError, json.JSONDecodeError):
            pass
        return {"connections": {}, "tasks": {}}


def _write_settings(data: dict):
    """原子写入本地 JSON 配置。"""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SETTINGS_PATH.with_suffix(".json.tmp")
    with SETTINGS_LOCK:
        temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp_path, SETTINGS_PATH)


def _now_iso(value: Optional[datetime] = None) -> str:
    value = value or datetime.now(timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso(value: str) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _safe_timezone(value: str) -> str:
    """验证 IANA 时区，未知时区统一回退 UTC。"""
    candidate = str(value or "").strip() or "UTC"
    try:
        ZoneInfo(candidate)
        return candidate
    except ZoneInfoNotFoundError:
        return "UTC"


def _connection_public(item: dict) -> dict:
    """生成不包含密码和私钥内容的连接响应。"""
    result = dict(item)
    result.pop("password", None)
    result["password_configured"] = bool(item.get("password"))
    result["private_key_configured"] = bool(item.get("private_key_path"))
    return result


def _normalize_connection(payload: dict, old: Optional[dict] = None) -> dict:
    old = old or {}
    data = {**old, **(payload or {})}
    name = str(data.get("name") or "").strip()
    host = str(data.get("host") or "").strip()
    username = str(data.get("username") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="服务器名称不能为空")
    if not host or len(host) > 253 or any(char in host for char in "\r\n "):
        raise HTTPException(status_code=400, detail="服务器地址无效")
    if not username or any(char in username for char in "\r\n "):
        raise HTTPException(status_code=400, detail="用户名不能为空")
    try:
        port = int(data.get("port", 22))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="SSH 端口必须是数字")
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=400, detail="SSH 端口范围必须是 1-65535")
    auth_type = str(data.get("auth_type") or "key").strip().lower()
    if auth_type not in {"key", "password", "agent"}:
        raise HTTPException(status_code=400, detail="认证方式只能是私钥、密码或 SSH Agent")
    password = data.get("password")
    if password is None:
        password = old.get("password", "")
    key_path = str(data.get("private_key_path") or old.get("private_key_path") or "").strip()
    if auth_type == "password" and not str(password or "").strip():
        raise HTTPException(status_code=400, detail="密码认证需要填写密码")
    return {
        "id": str(old.get("id") or data.get("id") or f"conn_{uuid.uuid4().hex[:12]}"),
        "name": name[:120],
        "host": host,
        "port": port,
        "username": username[:120],
        "auth_type": auth_type,
        "password": str(password or ""),
        "private_key_path": key_path,
        "timezone": str(data.get("timezone") or "").strip(),
        "timezone_auto": not bool(str(data.get("timezone") or "").strip()),
        "created_at": old.get("created_at") or time.time(),
        "updated_at": time.time(),
        "last_test_at": old.get("last_test_at"),
        "last_test_ok": old.get("last_test_ok"),
        "last_test_message": old.get("last_test_message"),
        "server_time": old.get("server_time"),
        "server_epoch": old.get("server_epoch"),
    }


def _connection(connection_id: str) -> dict:
    item = _read_settings()["connections"].get(connection_id)
    if not isinstance(item, dict):
        raise HTTPException(status_code=404, detail="服务器连接不存在")
    return item


def _key_path(item: dict) -> str:
    return str(Path(str(item.get("private_key_path") or "")).expanduser())


def _run_with_paramiko(item: dict, command: str) -> tuple[int, str, str]:
    """通过 Paramiko 建立 SSH 连接并执行命令。"""
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = {
        "hostname": item["host"],
        "port": item["port"],
        "username": item["username"],
        "timeout": 12,
        "auth_timeout": 12,
        "banner_timeout": 12,
        "allow_agent": item["auth_type"] == "agent",
        "look_for_keys": item["auth_type"] == "agent",
    }
    if item["auth_type"] == "password":
        kwargs["password"] = item.get("password", "")
        kwargs["allow_agent"] = False
        kwargs["look_for_keys"] = False
    elif item["auth_type"] == "key":
        key_path = _key_path(item)
        if key_path:
            kwargs["key_filename"] = key_path
            kwargs["allow_agent"] = False
            kwargs["look_for_keys"] = False
        else:
            # 留空时沿用 OpenSSH/Paramiko 的默认私钥搜索规则。
            kwargs["allow_agent"] = True
            kwargs["look_for_keys"] = True
    try:
        client.connect(**kwargs)
        stdin, stdout, stderr = client.exec_command(command, timeout=30)
        output = stdout.read().decode("utf-8", errors="replace")
        error = stderr.read().decode("utf-8", errors="replace")
        return stdout.channel.recv_exit_status(), output, error
    finally:
        client.close()


def _run_with_system_ssh(item: dict, command: str) -> tuple[int, str, str]:
    """Paramiko 不可用时调用系统 ssh；密码认证需要 sshpass。"""
    target = f"{item['username']}@{item['host']}"
    args = [
        "ssh", "-p", str(item["port"]), "-o", "ConnectTimeout=12",
        "-o", "StrictHostKeyChecking=accept-new",
    ]
    if item["auth_type"] == "key":
        args += ["-i", _key_path(item)]
    if item["auth_type"] == "password":
        if not shutil_which("sshpass"):
            raise RuntimeError("当前环境没有 Paramiko 或 sshpass，无法使用密码认证")
        args = ["sshpass", "-e"] + args
    args += [target, command]
    env = os.environ.copy()
    if item["auth_type"] == "password":
        env["SSHPASS"] = item.get("password", "")
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, env=env)
    return result.returncode, result.stdout, result.stderr


def shutil_which(name: str) -> Optional[str]:
    """避免为独立子项目引入额外工具函数依赖。"""
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _run_remote(item: dict, command: str) -> tuple[int, str, str]:
    if paramiko is not None:
        return _run_with_paramiko(item, command)
    return _run_with_system_ssh(item, command)


def _remote_time(item: dict) -> dict:
    """读取远端 Unix 时间、格式化时间和时区。"""
    command = (
        "printf '__LM_EPOCH__%s\\n' \"$(date +%s)\"; "
        "printf '__LM_LOCAL__%s\\n' \"$(date '+%Y-%m-%d %H:%M:%S %Z %z')\"; "
        "printf '__LM_TZ__%s\\n' \"$(timedatectl show -p Timezone --value 2>/dev/null || "
        "cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null || true)\""
    )
    code, output, error = _run_remote(item, command)
    if code != 0:
        raise RuntimeError((error or output or f"远端命令退出码 {code}").strip()[-1000:])
    values = {}
    for line in output.splitlines():
        match = re.match(r"^(__LM_[A-Z]+__)(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2)
    try:
        epoch = float(values["__LM_EPOCH__"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("无法解析服务器时间")
    raw_timezone = str(values.get("__LM_TZ__") or "").strip()
    if raw_timezone.startswith("/usr/share/zoneinfo/"):
        raw_timezone = raw_timezone.removeprefix("/usr/share/zoneinfo/")
    if raw_timezone in {"", "/etc/localtime"}:
        raw_timezone = item.get("timezone") or "UTC"
    timezone_name = _safe_timezone(raw_timezone)
    local_dt = datetime.fromtimestamp(epoch, timezone.utc).astimezone(ZoneInfo(timezone_name))
    return {
        "server_epoch": epoch,
        "server_time": values.get("__LM_LOCAL__") or local_dt.strftime("%Y-%m-%d %H:%M:%S %Z %z"),
        "timezone": timezone_name,
    }


def _test_connection_sync(connection_id: str) -> dict:
    item = _connection(connection_id)
    info = _remote_time(item)
    settings = _read_settings()
    saved = dict(settings["connections"][connection_id])
    if saved.get("timezone_auto", True) or not saved.get("timezone"):
        saved["timezone"] = info["timezone"]
    saved.update(info)
    saved["last_test_at"] = _now_iso()
    saved["last_test_ok"] = True
    saved["last_test_message"] = f"连接成功，服务器时间：{info['server_time']}"
    settings["connections"][connection_id] = saved
    _write_settings(settings)
    return {"ok": True, "connection": _connection_public(saved), "time": info}


def _validate_task(payload: dict, old: Optional[dict] = None) -> dict:
    old = old or {}
    data = {**old, **(payload or {})}
    name = str(data.get("name") or "").strip()
    command = str(data.get("command") or "").strip()
    connection_id = str(data.get("connection_id") or "").strip()
    schedule_type = str(data.get("schedule_type") or "daily").strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="任务名称不能为空")
    if not command:
        raise HTTPException(status_code=400, detail="执行命令不能为空")
    if len(command) > 12000:
        raise HTTPException(status_code=400, detail="执行命令不能超过 12000 个字符")
    if connection_id not in _read_settings()["connections"]:
        raise HTTPException(status_code=400, detail="任务关联的服务器不存在")
    if schedule_type not in {"daily", "weekly", "once"}:
        raise HTTPException(status_code=400, detail="任务类型只能是每天、每周或单次")
    run_time = str(data.get("run_time") or "").strip()
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", run_time):
        raise HTTPException(status_code=400, detail="执行时间格式必须为 HH:MM")
    weekdays = sorted({int(day) for day in (data.get("weekdays") or []) if str(day).isdigit() and 0 <= int(day) <= 6})
    run_date = str(data.get("run_date") or "").strip()
    if schedule_type == "weekly" and not weekdays:
        raise HTTPException(status_code=400, detail="每周任务至少选择一天")
    if schedule_type == "once":
        try:
            date.fromisoformat(run_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="单次任务需要有效的执行日期")
    result = {
        "id": str(old.get("id") or data.get("id") or f"task_{uuid.uuid4().hex[:12]}"),
        "name": name[:120],
        "connection_id": connection_id,
        "command": command,
        "schedule_type": schedule_type,
        "run_time": run_time,
        "run_date": run_date if schedule_type == "once" else "",
        "weekdays": weekdays if schedule_type == "weekly" else [],
        "enabled": bool(data.get("enabled", True)),
        "created_at": old.get("created_at") or time.time(),
        "updated_at": time.time(),
        "last_run_at": old.get("last_run_at"),
        "last_status": old.get("last_status") or "idle",
        "last_message": old.get("last_message") or "",
        "last_output": old.get("last_output") or "",
        "last_exit_code": old.get("last_exit_code"),
        "next_run_at": old.get("next_run_at"),
    }
    if not old or any(key in (payload or {}) for key in ("connection_id", "schedule_type", "run_time", "run_date", "weekdays", "enabled")):
        result["next_run_at"] = None
    return result


def _task_public(task: dict, connections: Optional[dict] = None) -> dict:
    result = dict(task)
    connection = (connections or _read_settings()["connections"]).get(task.get("connection_id"), {})
    result["connection_name"] = connection.get("name", "已删除服务器")
    result["timezone"] = _safe_timezone(connection.get("timezone") or "UTC")
    result["running"] = task.get("id") in TASK_RUNS
    return result


def _task_timezone(task: dict, connection: dict) -> ZoneInfo:
    return ZoneInfo(_safe_timezone(connection.get("timezone") or "UTC"))


def _scheduled_local(task: dict, connection: dict, after: datetime) -> Optional[datetime]:
    """计算 after 之后的下一次服务器本地时间。"""
    tz = _task_timezone(task, connection)
    local_after = after.astimezone(tz)
    hour, minute = (int(part) for part in task["run_time"].split(":"))
    if task["schedule_type"] == "once":
        target = datetime.combine(date.fromisoformat(task["run_date"]), dt_time(hour, minute), tzinfo=tz)
        return target if target > after.astimezone(tz) else None
    for offset in range(0, 8):
        current_date = local_after.date() + timedelta(days=offset)
        if task["schedule_type"] == "weekly" and current_date.weekday() not in task["weekdays"]:
            continue
        candidate = datetime.combine(current_date, dt_time(hour, minute), tzinfo=tz)
        if candidate > local_after:
            return candidate
    return None


def _refresh_next_run(task: dict, connection: dict, now: Optional[datetime] = None):
    now = now or datetime.now(timezone.utc)
    next_local = _scheduled_local(task, connection, now)
    task["next_run_at"] = next_local.astimezone(timezone.utc).isoformat() if next_local else None


def _save_task(task: dict):
    settings = _read_settings()
    settings["tasks"][task["id"]] = task
    _write_settings(settings)


def _execute_task_sync(task_id: str, connection_id: str) -> tuple[int, str, str]:
    task = _read_settings()["tasks"].get(task_id)
    connection = _read_settings()["connections"].get(connection_id)
    if not task or not connection:
        raise RuntimeError("任务或服务器连接不存在")
    return _run_remote(connection, task["command"])


async def _execute_task(task_id: str, connection_id: str, scheduled_at: Optional[str] = None):
    try:
        code, output, error = await asyncio.to_thread(_execute_task_sync, task_id, connection_id)
        message = "执行成功" if code == 0 else f"远端命令退出码 {code}"
        if error.strip():
            message += f"：{error.strip()[-1000:]}"
        status = "success" if code == 0 else "error"
        task = _read_settings()["tasks"].get(task_id)
        if task:
            task.update({
                "last_run_at": _now_iso(), "last_status": status, "last_message": message,
                "last_output": (output + ("\n" + error if error else "")).strip()[-6000:],
                "last_exit_code": code,
            })
            _save_task(task)
    except Exception as exc:
        task = _read_settings()["tasks"].get(task_id)
        if task:
            task.update({"last_run_at": _now_iso(), "last_status": "error", "last_message": str(exc)[:1200], "last_output": "", "last_exit_code": None})
            _save_task(task)
    finally:
        TASK_RUNS.discard(task_id)


def _launch_task(task: dict, manual: bool = False) -> bool:
    task_id = task["id"]
    if task_id in TASK_RUNS:
        return False
    TASK_RUNS.add(task_id)
    task["last_status"] = "running"
    task["last_message"] = "任务已派发，正在连接服务器"
    _save_task(task)
    asyncio.create_task(_execute_task(task_id, task["connection_id"]))
    return True


async def _scheduler_loop():
    """每 15 秒检查一次任务，按服务器时区派发到 SSH 终端。"""
    while True:
        try:
            settings = _read_settings()
            now = datetime.now(timezone.utc)
            changed = False
            for task_id, raw_task in settings["tasks"].items():
                task = dict(raw_task)
                connection = settings["connections"].get(task.get("connection_id"))
                if not connection or not task.get("enabled"):
                    continue
                if not task.get("next_run_at"):
                    _refresh_next_run(task, connection, now)
                    settings["tasks"][task_id] = task
                    changed = True
                due_at = _parse_iso(task.get("next_run_at"))
                if due_at and due_at <= now and task_id not in TASK_RUNS:
                    scheduled_at = task.get("next_run_at")
                    if task["schedule_type"] == "once":
                        task["next_run_at"] = None
                    else:
                        next_local = _scheduled_local(task, connection, due_at + timedelta(seconds=1))
                        task["next_run_at"] = next_local.astimezone(timezone.utc).isoformat() if next_local else None
                    settings["tasks"][task_id] = task
                    TASK_RUNS.add(task_id)
                    task["last_status"] = "running"
                    task["last_message"] = f"已按计划派发（{scheduled_at}）"
                    changed = True
                    asyncio.create_task(_execute_task(task_id, task["connection_id"], scheduled_at))
            if changed:
                _write_settings(settings)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(15)


async def start_scheduler():
    """启动定时任务调度器，供独立运行和外层应用挂载时共同使用。"""
    global SCHEDULER_TASK
    if SCHEDULER_TASK is None or SCHEDULER_TASK.done():
        SCHEDULER_TASK = asyncio.create_task(_scheduler_loop())


async def stop_scheduler():
    """停止定时任务调度器。"""
    global SCHEDULER_TASK
    if SCHEDULER_TASK is not None:
        SCHEDULER_TASK.cancel()
        await asyncio.gather(SCHEDULER_TASK, return_exceptions=True)
        SCHEDULER_TASK = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    await start_scheduler()
    yield
    await stop_scheduler()


app = FastAPI(title="LlamaManager Server", lifespan=lifespan)


@app.middleware("http")
async def standalone_api_prefix(request: Request, call_next):
    """让独立运行时的 /server/api 请求也能复用挂载模式的页面脚本。"""
    path = request.scope.get("path", "")
    if path == "/server/api" or path.startswith("/server/api/"):
        request.scope["path"] = path.removeprefix("/server")
        request.scope["raw_path"] = request.scope["path"].encode("utf-8")
    return await call_next(request)


@app.get("/")
async def home(request: Request):
    if request.scope.get("root_path") == "/server":
        return FileResponse(APP_DIR / "index.html")
    return RedirectResponse(url="/server")


@app.get("/server")
@app.get("/server/")
async def server_page():
    return FileResponse(APP_DIR / "index.html")


@app.get("/api/health")
async def health():
    return JSONResponse({"ok": True, "service": "server"})


@app.get("/api/connections")
async def list_connections():
    settings = _read_settings()
    items = sorted(settings["connections"].values(), key=lambda item: item.get("created_at", 0))
    return JSONResponse({"connections": [_connection_public(item) for item in items]})


@app.post("/api/connections")
async def create_connection(body: dict):
    item = _normalize_connection(body)
    settings = _read_settings()
    settings["connections"][item["id"]] = item
    _write_settings(settings)
    return JSONResponse({"ok": True, "connection": _connection_public(item)})


@app.put("/api/connections/{connection_id}")
async def update_connection(connection_id: str, body: dict):
    old = _connection(connection_id)
    item = _normalize_connection(body, old)
    settings = _read_settings()
    settings["connections"][connection_id] = item
    _write_settings(settings)
    return JSONResponse({"ok": True, "connection": _connection_public(item)})


@app.delete("/api/connections/{connection_id}")
async def delete_connection(connection_id: str):
    settings = _read_settings()
    if connection_id not in settings["connections"]:
        raise HTTPException(status_code=404, detail="服务器连接不存在")
    related = [task for task in settings["tasks"].values() if task.get("connection_id") == connection_id]
    if related:
        raise HTTPException(status_code=409, detail="该服务器仍有定时任务，请先删除任务")
    deleted = settings["connections"].pop(connection_id)
    _write_settings(settings)
    return JSONResponse({"ok": True, "connection": _connection_public(deleted)})


@app.post("/api/connections/{connection_id}/test")
async def test_connection(connection_id: str):
    _connection(connection_id)
    try:
        return JSONResponse(await asyncio.to_thread(_test_connection_sync, connection_id))
    except Exception as exc:
        settings = _read_settings()
        item = settings["connections"].get(connection_id)
        if item:
            item["last_test_at"] = _now_iso()
            item["last_test_ok"] = False
            item["last_test_message"] = str(exc)[:1200]
            settings["connections"][connection_id] = item
            _write_settings(settings)
        raise HTTPException(status_code=502, detail=f"连接失败：{str(exc)[:1000]}") from exc


@app.get("/api/connections/{connection_id}/time")
async def get_connection_time(connection_id: str):
    _connection(connection_id)
    try:
        result = await asyncio.to_thread(_test_connection_sync, connection_id)
        return JSONResponse({"ok": True, "time": result["time"], "connection": result["connection"]})
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取服务器时间失败：{str(exc)[:1000]}") from exc


@app.get("/api/tasks")
async def list_tasks():
    settings = _read_settings()
    tasks = sorted(settings["tasks"].values(), key=lambda item: item.get("created_at", 0), reverse=True)
    return JSONResponse({"tasks": [_task_public(item, settings["connections"]) for item in tasks]})


@app.post("/api/tasks")
async def create_task(body: dict):
    task = _validate_task(body)
    settings = _read_settings()
    _refresh_next_run(task, settings["connections"][task["connection_id"]])
    settings["tasks"][task["id"]] = task
    _write_settings(settings)
    return JSONResponse({"ok": True, "task": _task_public(task, settings["connections"])})


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: str, body: dict):
    settings = _read_settings()
    old = settings["tasks"].get(task_id)
    if not isinstance(old, dict):
        raise HTTPException(status_code=404, detail="定时任务不存在")
    if task_id in TASK_RUNS:
        raise HTTPException(status_code=409, detail="任务正在执行，暂时不能修改")
    task = _validate_task(body, old)
    _refresh_next_run(task, settings["connections"][task["connection_id"]])
    settings["tasks"][task_id] = task
    _write_settings(settings)
    return JSONResponse({"ok": True, "task": _task_public(task, settings["connections"])})


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    settings = _read_settings()
    if task_id in TASK_RUNS:
        raise HTTPException(status_code=409, detail="任务正在执行，暂时不能删除")
    task = settings["tasks"].pop(task_id, None)
    if not task:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    _write_settings(settings)
    return JSONResponse({"ok": True, "task": _task_public(task, settings["connections"])})


@app.post("/api/tasks/{task_id}/run")
async def run_task_now(task_id: str):
    settings = _read_settings()
    task = settings["tasks"].get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    if not _launch_task(task, manual=True):
        raise HTTPException(status_code=409, detail="任务已经在执行")
    return JSONResponse({"ok": True, "message": "任务已立即派发", "task": _task_public(task, settings["connections"])})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=int(os.environ.get("SERVER_PORT", "8082")), reload=False)
