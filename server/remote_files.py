"""服务器文件组件：以本机为跳板，经 SSH/SFTP 浏览、上传、下载其他内网服务器用户目录（~）内的文件。

- 连接配置复用 Server 子服务保存的 SSH 连接（server/settings.json）。
- 每台服务器维护一个常驻 SSH 连接与若干 SFTP 通道组成的连接池，避免每次操作重新握手（集群 sshd 握手常需数秒）。
- 远端路径一律相对用户目录 ~，沿用本机文件游览的相对路径校验（拒绝 ..、空段与反斜杠）。
- 上传逻辑与本机一致：小文件单请求、大文件分片并发；分片直接按偏移写入远端临时文件，全部到齐后在远端原子改名。
"""

from __future__ import annotations

import math
import mimetypes
import socket
import stat as stat_module
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator
from urllib.parse import quote, urlencode
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

import server.app as server_app
from server.file_manager import (
    IGNORED_DIRECTORY_NAMES,
    MAX_DIRECTORY_ENTRIES,
    MAX_MARKDOWN_FILE_BYTES,
    MAX_UPLOAD_CHUNK_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MIN_UPLOAD_CHUNK_BYTES,
    UPLOAD_SESSION_TTL_SECONDS,
    _normalize_relative_path,
    _request_username,
    logger,
)

try:
    import paramiko
except ImportError:  # 未安装时所有远端接口返回明确错误
    paramiko = None


MAX_CHANNELS_PER_HOST = 6
CHANNEL_WAIT_SECONDS = 60
HOST_IDLE_SECONDS = 10 * 60
KEEPALIVE_SECONDS = 30
DOWNLOAD_WINDOW_BYTES = 4 * 1024 * 1024
SFTP_REQUEST_BYTES = 32 * 1024
MAX_COMMON_DIRECTORIES = 30
MARKDOWN_EXTENSIONS = {"md", "markdown", "mdown", "mkdn"}
REMOTE_API_PREFIX = "/api/file-manager/remote"


# ---------------------------------------------------------------------------
# 常用目录：本机与各服务器共用同一套相对用户目录的写法
# ---------------------------------------------------------------------------

def normalize_common_directories(values: object) -> list[str]:
    """校验常用目录列表：接受 ~/a/b、a/b 或 ~，统一保存为相对用户目录的路径（~ 本身保存为空串）。"""
    if values is None:
        return []
    if not isinstance(values, list):
        raise HTTPException(status_code=422, detail="常用目录必须是数组")
    result: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail="常用目录必须是字符串")
        text = value.strip()
        if not text:
            continue
        if text.startswith("/"):
            raise HTTPException(status_code=422, detail=f"常用目录只能位于用户目录内，请使用 ~/ 开头或相对路径：{text}")
        if text == "~":
            text = ""
        elif text.startswith("~/"):
            text = text[2:]
        text = text.strip("/")
        try:
            safe = _normalize_relative_path(text)
        except HTTPException as exc:
            raise HTTPException(status_code=422, detail=f"常用目录格式不受支持：{value.strip()}") from exc
        if safe not in result:
            result.append(safe)
    if len(result) > MAX_COMMON_DIRECTORIES:
        raise HTTPException(status_code=422, detail=f"最多保存 {MAX_COMMON_DIRECTORIES} 个常用目录")
    return result


def get_common_directories() -> list[str]:
    """读取保存的常用目录列表。"""
    from core.auth import get_settings_section

    value = get_settings_section("file_manager_common_directories")
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def save_common_directories(values: object) -> list[str]:
    """保存常用目录列表。"""
    from core.auth import update_settings_section

    normalized = normalize_common_directories(values)
    update_settings_section("file_manager_common_directories", normalized)
    return normalized


def list_file_connections() -> list[dict[str, Any]]:
    """返回文件管理可用的连接列表，包含本机和已配置的 SSH 连接。"""
    result: list[dict[str, Any]] = [
        {
            "id": "local",
            "name": "本机",
            "type": "local",
            "host": "localhost",
            "username": "local",
        }
    ]
    try:
        raw_conns = server_app._read_settings().get("connections", {})
        for cid, item in raw_conns.items():
            result.append({
                "id": cid,
                "name": item.get("name") or cid,
                "type": "ssh",
                "host": item.get("host") or "",
                "port": item.get("port") or 22,
                "username": item.get("username") or "",
                "auth_type": item.get("auth_type") or "key",
                "last_test_ok": item.get("last_test_ok"),
            })
    except Exception as exc:
        logger.warning("读取服务器连接列表失败: %s", exc)
    return result



# ---------------------------------------------------------------------------
# 连接池
# ---------------------------------------------------------------------------

def _describe(exc: BaseException) -> str:
    """把 Paramiko / socket 异常压缩成适合界面展示的一句话。"""
    text = str(exc).strip() or exc.__class__.__name__
    if paramiko is not None and isinstance(exc, paramiko.AuthenticationException):
        return f"认证失败（{text[:200]}）"
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "连接超时"
    return text[:300]


def _connection_signature(item: dict) -> tuple:
    """连接配置变化（地址、账号、认证）时需要重建连接。"""
    return (item.get("host"), item.get("port"), item.get("username"), item.get("auth_type"),
            item.get("password"), server_app._key_path(item))


@dataclass
class _Host:
    """单台服务器的常驻 SSH 连接与空闲 SFTP 通道。"""

    signature: tuple
    lock: threading.Lock = field(default_factory=threading.Lock)
    slots: threading.BoundedSemaphore = field(default_factory=lambda: threading.BoundedSemaphore(MAX_CHANNELS_PER_HOST))
    client: Any = None
    home: str = ""
    idle: list = field(default_factory=list)
    active: int = 0
    last_used: float = field(default_factory=time.time)

    def alive(self) -> bool:
        transport = self.client.get_transport() if self.client is not None else None
        return bool(transport is not None and transport.is_active())

    def close_unlocked(self) -> None:
        for sftp in self.idle:
            try:
                sftp.close()
            except Exception:
                pass
        self.idle = []
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
        self.client = None

    def ensure_unlocked(self, item: dict) -> None:
        """连接断开或尚未建立时重新握手，并解析远端用户目录。"""
        if self.alive():
            return
        self.close_unlocked()
        started = time.monotonic()
        try:
            client = server_app._open_ssh_client(item)
        except Exception as exc:
            logger.warning("服务器文件连接失败 conn=%s host=%s error=%s", item.get("id"), item.get("host"), _describe(exc))
            raise HTTPException(status_code=502, detail=f"连接服务器失败：{_describe(exc)}") from exc
        try:
            transport = client.get_transport()
            if transport is not None:
                transport.set_keepalive(KEEPALIVE_SECONDS)
            sftp = client.open_sftp()
            home = sftp.normalize(".")
        except Exception as exc:
            client.close()
            raise HTTPException(status_code=502, detail=f"打开 SFTP 失败：{_describe(exc)}") from exc
        self.client = client
        self.home = home
        self.idle = [sftp]
        logger.info("服务器文件连接建立 conn=%s host=%s home=%s 耗时 %.1fs", item.get("id"), item.get("host"), home, time.monotonic() - started)


_HOSTS: dict[str, _Host] = {}
_HOSTS_LOCK = threading.Lock()


def _sweep_idle_hosts() -> None:
    """关闭长时间无人使用的连接，避免占用远端会话。"""
    now = time.time()
    with _HOSTS_LOCK:
        stale = [key for key, host in _HOSTS.items() if host.active == 0 and now - host.last_used > HOST_IDLE_SECONDS]
        removed = [_HOSTS.pop(key) for key in stale]
    for host in removed:
        with host.lock:
            host.close_unlocked()


def _host_for(item: dict) -> _Host:
    _sweep_idle_hosts()
    signature = _connection_signature(item)
    with _HOSTS_LOCK:
        host = _HOSTS.get(item["id"])
        if host is None or host.signature != signature:
            old = host
            host = _Host(signature)
            _HOSTS[item["id"]] = host
        else:
            old = None
    if old is not None:
        with old.lock:
            old.close_unlocked()
    return host


def drop_connection(connection_id: str) -> None:
    """连接被删除或修改后关闭其常驻会话。"""
    with _HOSTS_LOCK:
        host = _HOSTS.pop(connection_id, None)
    if host is not None:
        with host.lock:
            host.close_unlocked()


def close_all() -> None:
    """Hub 退出时关闭全部常驻连接。"""
    with _HOSTS_LOCK:
        hosts = list(_HOSTS.values())
        _HOSTS.clear()
    for host in hosts:
        with host.lock:
            host.close_unlocked()


def _load_connection(connection_id: str) -> dict:
    if paramiko is None:
        raise HTTPException(status_code=503, detail="服务器文件需要安装 Paramiko：pip install 'paramiko>=3.4'")
    return server_app._connection(connection_id)


@contextmanager
def remote_sftp(connection_id: str) -> Iterator[tuple[Any, str]]:
    """借出一个 SFTP 通道与远端用户目录；SFTP 常见错误统一转成 HTTP 错误。"""
    item = _load_connection(connection_id)
    host = _host_for(item)
    if not host.slots.acquire(timeout=CHANNEL_WAIT_SECONDS):
        raise HTTPException(status_code=503, detail="该服务器同时进行的传输过多，请稍后重试")
    sftp = None
    client = None
    with host.lock:
        host.active += 1
    try:
        with host.lock:
            host.ensure_unlocked(item)
            client = host.client
            home = host.home
            sftp = host.idle.pop() if host.idle else None
        if sftp is None:
            try:
                sftp = client.open_sftp()
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"打开 SFTP 通道失败：{_describe(exc)}") from exc
        try:
            yield sftp, home
        except HTTPException:
            raise
        except (FileNotFoundError,) as exc:
            raise HTTPException(status_code=404, detail="远端路径不存在") from exc
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="没有权限访问远端路径") from exc
        except ClientDisconnect:
            raise
        except (OSError, EOFError) as exc:
            raise HTTPException(status_code=502, detail=f"远端操作失败：{_describe(exc)}") from exc
        except Exception as exc:
            if paramiko is not None and isinstance(exc, paramiko.SSHException):
                raise HTTPException(status_code=502, detail=f"SSH 连接异常：{_describe(exc)}") from exc
            raise
    finally:
        with host.lock:
            host.active -= 1
            host.last_used = time.time()
            reusable = (sftp is not None and client is not None and host.client is client and host.alive()
                        and not sftp.sock.closed and len(host.idle) < MAX_CHANNELS_PER_HOST)
            if reusable:
                host.idle.append(sftp)
        if sftp is not None and not reusable:
            try:
                sftp.close()
            except Exception:
                pass
        host.slots.release()


# ---------------------------------------------------------------------------
# 路径与目录
# ---------------------------------------------------------------------------

def _join(home: str, relative_path: str) -> str:
    if not relative_path:
        return home
    return f"{home.rstrip('/')}/{relative_path}" if home != "/" else f"/{relative_path}"


def _extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name.strip(".") else ""


def _stat_or_none(sftp, path: str):
    try:
        return sftp.stat(path)
    except FileNotFoundError:
        return None


def _download_url(connection_id: str, relative_path: str) -> str:
    return f"{REMOTE_API_PREFIX}/{quote(connection_id, safe='')}/download?{urlencode({'path': relative_path})}"


def list_directory(connection_id: str, relative_path: str) -> dict[str, Any]:
    """列出远端用户目录内某个目录的直接子项，结构与本机文件游览一致。"""
    safe_path = _normalize_relative_path(relative_path)
    with remote_sftp(connection_id) as (sftp, home):
        directory = _join(home, safe_path)
        attr = _stat_or_none(sftp, directory)
        if attr is None or not stat_module.S_ISDIR(attr.st_mode or 0):
            raise HTTPException(status_code=404, detail="远端目录不存在或无法读取")
        try:
            attrs = sftp.listdir_attr(directory)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail="没有权限读取远端目录") from exc
        entries: list[dict[str, Any]] = []
        truncated = False
        for child in attrs:
            name = child.filename or ""
            if not name or name in (".", ".."):
                continue
            mode = child.st_mode or 0
            symlink = stat_module.S_ISLNK(mode)
            target = child
            if symlink:
                try:
                    target = sftp.stat(_join(directory, name) if directory != "/" else f"/{name}")
                    mode = target.st_mode or 0
                except OSError:
                    mode = 0
            if stat_module.S_ISDIR(mode):
                if name in IGNORED_DIRECTORY_NAMES:
                    continue
                entry_type = "directory"
            elif stat_module.S_ISREG(mode):
                entry_type = "file"
            else:
                entry_type = "other"
            child_path = f"{safe_path}/{name}" if safe_path else name
            payload: dict[str, Any] = {
                "name": name,
                "path": child_path,
                "type": entry_type,
                "size": int(target.st_size or 0) if entry_type == "file" else 0,
                "modified": float(target.st_mtime or 0),
                "extension": _extension(name) if entry_type == "file" else "",
                "symlink": symlink,
            }
            if entry_type == "file":
                payload["download_url"] = _download_url(connection_id, child_path)
            entries.append(payload)
            if len(entries) >= MAX_DIRECTORY_ENTRIES:
                truncated = True
                break
    entries.sort(key=lambda entry: (entry["type"] != "directory", entry["name"].lower(), entry["name"]))
    now = time.time()
    return {
        "connection_id": connection_id,
        "root_index": 0,
        "root_path": home,
        "path": safe_path,
        "entries": entries,
        "cached": False,
        "generated_at": now,
        # 远端目录不在服务端缓存；前端短暂复用，避免来回切换时重复请求。
        "expires_at": now + 60,
        "cache_ttl_seconds": 60,
        "max_entries": MAX_DIRECTORY_ENTRIES,
        "truncated": truncated,
    }


def read_markdown(connection_id: str, relative_path: str) -> dict[str, Any]:
    """读取远端大小受限的 UTF-8 Markdown 文档。"""
    safe_path = _normalize_relative_path(relative_path)
    name = safe_path.rsplit("/", 1)[-1]
    if not safe_path or _extension(name) not in MARKDOWN_EXTENSIONS:
        raise HTTPException(status_code=422, detail="只能查看 Markdown 文件")
    with remote_sftp(connection_id) as (sftp, home):
        target = _join(home, safe_path)
        attr = _stat_or_none(sftp, target)
        if attr is None or not stat_module.S_ISREG(attr.st_mode or 0):
            raise HTTPException(status_code=404, detail="文件不存在或不是普通文件")
        if (attr.st_size or 0) > MAX_MARKDOWN_FILE_BYTES:
            raise HTTPException(status_code=413, detail=f"Markdown 文件不能超过 {MAX_MARKDOWN_FILE_BYTES // (1024 * 1024)} MB")
        with sftp.open(target, "rb") as handle:
            handle.prefetch(attr.st_size or 0)
            data = handle.read(MAX_MARKDOWN_FILE_BYTES + 1)
    return {
        "root_index": 0, "connection_id": connection_id, "path": safe_path, "name": name,
        "content": data.decode("utf-8-sig", errors="replace"), "size": int(attr.st_size or 0), "modified": float(attr.st_mtime or 0),
    }


# ---------------------------------------------------------------------------
# 下载：经跳板流式转发，支持单段 Range 以便浏览器续传
# ---------------------------------------------------------------------------

def _parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    start_text, _, end_text = header[6:].strip().partition("-")
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
        else:
            length = int(end_text)
            start, end = max(0, size - length), size - 1
    except ValueError:
        return None
    if start < 0 or start >= size or end < start:
        raise HTTPException(status_code=416, detail="请求的字节范围无效", headers={"Content-Range": f"bytes */{size}"})
    return start, min(end, size - 1)


def _stream_file(connection_id: str, target: str, start: int, length: int) -> Iterator[bytes]:
    """按窗口批量预读远端文件，内存占用不超过一个窗口。"""
    with remote_sftp(connection_id) as (sftp, _home):
        with sftp.open(target, "rb") as handle:
            offset, end = start, start + length
            while offset < end:
                window_end = min(end, offset + DOWNLOAD_WINDOW_BYTES)
                requests = [(position, min(SFTP_REQUEST_BYTES, window_end - position))
                            for position in range(offset, window_end, SFTP_REQUEST_BYTES)]
                for data in handle.readv(requests):
                    yield data
                offset = window_end


def file_response(connection_id: str, relative_path: str, range_header: str | None, *, inline: bool) -> StreamingResponse:
    """生成远端文件的流式响应；inline 用于 Markdown 内的图片等资源。"""
    safe_path = _normalize_relative_path(relative_path)
    if not safe_path:
        raise HTTPException(status_code=422, detail="缺少文件路径")
    with remote_sftp(connection_id) as (sftp, home):
        target = _join(home, safe_path)
        attr = _stat_or_none(sftp, target)
        if attr is None or not stat_module.S_ISREG(attr.st_mode or 0):
            raise HTTPException(status_code=404, detail="文件不存在或不是普通文件")
    size = int(attr.st_size or 0)
    name = safe_path.rsplit("/", 1)[-1]
    byte_range = _parse_range(range_header, size) if size else None
    start, end = byte_range if byte_range else (0, size - 1)
    length = max(0, end - start + 1)
    media_type = (mimetypes.guess_type(name)[0] if inline else None) or "application/octet-stream"
    disposition = "inline" if inline else "attachment"
    headers = {
        "Content-Length": str(length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": f"{disposition}; filename*=utf-8''{quote(name)}",
        "X-Content-Type-Options": "nosniff",
    }
    if inline:
        # 远端文件内容不可信：禁止脚本执行，避免同源页面被注入。
        headers["Content-Security-Policy"] = "sandbox"
    if byte_range:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    logger.info("服务器文件下载 conn=%s path=%r size=%s range=%s", connection_id, safe_path, size, range_header or "-")
    body = _stream_file(connection_id, target, start, length) if length else iter(())
    return StreamingResponse(body, status_code=206 if byte_range else 200, media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# 上传
# ---------------------------------------------------------------------------

def _ensure_parents(sftp, home: str, full_path: str) -> str:
    """逐段创建远端父目录，拒绝缓存目录和同名文件冲突，返回目标绝对路径。"""
    parts = full_path.split("/")
    if any(part in IGNORED_DIRECTORY_NAMES for part in parts[:-1]):
        raise HTTPException(status_code=422, detail="上传路径包含服务端忽略的目录")
    current = home
    for part in parts[:-1]:
        current = _join(current, part)
        attr = _stat_or_none(sftp, current)
        if attr is None:
            try:
                sftp.mkdir(current)
            except OSError:
                # 并发上传同一文件夹时可能已被其他请求创建。
                attr = _stat_or_none(sftp, current)
                if attr is None or not stat_module.S_ISDIR(attr.st_mode or 0):
                    raise
        elif not stat_module.S_ISDIR(attr.st_mode or 0):
            raise HTTPException(status_code=409, detail="上传目标路径中存在同名文件")
    return _join(current, parts[-1])


def _check_target(sftp, target: str, overwrite: bool) -> None:
    try:
        attr = sftp.lstat(target)
    except FileNotFoundError:
        return
    if stat_module.S_ISLNK(attr.st_mode or 0):
        raise HTTPException(status_code=422, detail="上传目标是指向其他位置的链接，已拒绝")
    if not stat_module.S_ISREG(attr.st_mode or 0):
        raise HTTPException(status_code=409, detail="上传目标已存在同名文件夹")
    if not overwrite:
        raise HTTPException(status_code=409, detail="目标已有同名文件，可勾选覆盖后重试")


def _prepare_target(sftp, home: str, directory: str, file_path: str, overwrite: bool) -> tuple[str, str, str]:
    """校验上传目录与文件相对路径，返回（目录, 完整相对路径, 远端绝对路径）。"""
    safe_directory = _normalize_relative_path(directory)
    base = _stat_or_none(sftp, _join(home, safe_directory))
    if base is None or not stat_module.S_ISDIR(base.st_mode or 0):
        raise HTTPException(status_code=404, detail="远端目录不存在或无法读取")
    if not file_path:
        raise HTTPException(status_code=422, detail="缺少上传文件相对路径")
    safe_file = _normalize_relative_path(file_path)
    full_path = _normalize_relative_path(f"{safe_directory}/{safe_file}" if safe_directory else safe_file)
    target = _ensure_parents(sftp, home, full_path)
    _check_target(sftp, target, overwrite)
    return safe_directory, full_path, target


def _temp_name(target: str, upload_id: str) -> str:
    parent, _, name = target.rpartition("/")
    return f"{parent}/.{name}.{upload_id}.upload"


def _replace(sftp, temp: str, target: str, overwrite: bool) -> None:
    """把临时文件替换为目标文件；优先使用 OpenSSH 的 posix-rename 原子覆盖。"""
    _check_target(sftp, target, overwrite)
    try:
        sftp.posix_rename(temp, target)
        return
    except OSError:
        if not overwrite:
            sftp.rename(temp, target)
            return
    if _stat_or_none(sftp, target) is not None:
        sftp.remove(target)
    sftp.rename(temp, target)


def _remove_quietly(connection_id: str, path: str) -> None:
    try:
        with remote_sftp(connection_id) as (sftp, _home):
            sftp.remove(path)
    except Exception:
        pass


async def _read_body(request: Request, limit: int) -> bytes:
    buffer = bytearray()
    async for chunk in request.stream():
        if not chunk:
            continue
        if len(buffer) + len(chunk) > limit:
            raise HTTPException(status_code=413, detail="请求体超过允许大小")
        buffer.extend(chunk)
    return bytes(buffer)


def _write_whole(connection_id: str, directory: str, file_path: str, data: bytes, overwrite: bool) -> dict[str, Any]:
    with remote_sftp(connection_id) as (sftp, home):
        safe_directory, full_path, target = _prepare_target(sftp, home, directory, file_path, overwrite)
        temp = _temp_name(target, uuid4().hex)
        try:
            with sftp.open(temp, "wb") as handle:
                handle.set_pipelined(True)
                handle.write(data)
            _replace(sftp, temp, target, overwrite)
        except BaseException:
            try:
                sftp.remove(temp)
            except Exception:
                pass
            raise
    return {"connection_id": connection_id, "directory": safe_directory, "path": full_path, "name": full_path.rsplit("/", 1)[-1],
            "size": len(data), "overwrite": overwrite, "modified": time.time()}


async def upload_file(connection_id: str, directory: str, file_path: str, request: Request, *, overwrite: bool) -> dict[str, Any]:
    """单请求上传小文件（前端超过分片阈值时改用分片接口）。"""
    username = _request_username(request)
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="上传长度格式无效") from exc
    if declared > MAX_UPLOAD_CHUNK_BYTES:
        raise HTTPException(status_code=413, detail="单请求上传不能超过 64 MB，请使用分片上传")
    started = time.monotonic()
    data = await _read_body(request, MAX_UPLOAD_CHUNK_BYTES)
    try:
        result = await run_in_threadpool(_write_whole, connection_id, directory, file_path, data, overwrite)
    except HTTPException as exc:
        logger.warning("服务器文件上传失败 user=%s conn=%s dir=%r file=%r status=%s detail=%s", username, connection_id, directory, file_path, exc.status_code, exc.detail)
        raise
    logger.info("服务器文件上传完成 user=%s conn=%s path=%r size=%s 耗时 %.1fs", username, connection_id, result["path"], len(data), time.monotonic() - started)
    return result


@dataclass
class RemoteUploadSession:
    """远端分片上传会话：临时文件位于目标同目录，分片按偏移并发写入。"""

    id: str
    username: str
    connection_id: str
    directory: str
    full_path: str
    target: str
    temp_path: str
    size: int
    chunk_size: int
    total_chunks: int
    overwrite: bool
    received: set[int]
    created: float
    updated: float


_UPLOADS: dict[str, RemoteUploadSession] = {}
_UPLOADS_LOCK = threading.Lock()


def _cleanup_expired_uploads() -> None:
    now = time.time()
    with _UPLOADS_LOCK:
        expired = [session for session in _UPLOADS.values() if now - session.updated > UPLOAD_SESSION_TTL_SECONDS]
        for session in expired:
            _UPLOADS.pop(session.id, None)
    for session in expired:
        _remove_quietly(session.connection_id, session.temp_path)
        logger.warning("服务器文件分片上传超时清理 user=%s conn=%s path=%r 已收到 %s/%s 片",
                       session.username, session.connection_id, session.full_path, len(session.received), session.total_chunks)


def _session(upload_id: str, username: str) -> RemoteUploadSession:
    with _UPLOADS_LOCK:
        session = _UPLOADS.get(upload_id)
    if session is None or session.username != username:
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期，请重新上传")
    return session


def init_chunked_upload(connection_id: str, directory: str, payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """创建远端分片上传会话：校验目标并在远端预分配临时文件。"""
    _cleanup_expired_uploads()
    username = _request_username(request)
    file_path = payload.get("file_path")
    size = payload.get("size")
    chunk_size = payload.get("chunk_size")
    overwrite = bool(payload.get("overwrite", False))
    if not isinstance(file_path, str):
        raise HTTPException(status_code=422, detail="缺少上传文件相对路径")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise HTTPException(status_code=422, detail="上传文件大小无效")
    if size > MAX_UPLOAD_FILE_BYTES:
        raise HTTPException(status_code=413, detail="单个上传文件不能超过 4 GB")
    if not isinstance(chunk_size, int) or isinstance(chunk_size, bool) or not MIN_UPLOAD_CHUNK_BYTES <= chunk_size <= MAX_UPLOAD_CHUNK_BYTES:
        raise HTTPException(status_code=422, detail="分片大小需在 1 MB 到 64 MB 之间")
    upload_id = uuid4().hex
    try:
        with remote_sftp(connection_id) as (sftp, home):
            safe_directory, full_path, target = _prepare_target(sftp, home, directory, file_path, overwrite)
            temp = _temp_name(target, upload_id)
            with sftp.open(temp, "wb") as handle:
                if size:
                    handle.truncate(size)
    except HTTPException as exc:
        logger.warning("服务器文件分片上传被拒绝 user=%s conn=%s dir=%r file=%r status=%s detail=%s", username, connection_id, directory, file_path, exc.status_code, exc.detail)
        raise
    now = time.time()
    session = RemoteUploadSession(upload_id, username, connection_id, safe_directory, full_path, target, temp, size, chunk_size,
                                  max(1, math.ceil(size / chunk_size)), overwrite, set(), now, now)
    with _UPLOADS_LOCK:
        _UPLOADS[upload_id] = session
    logger.info("服务器文件分片上传开始 user=%s id=%s conn=%s path=%r size=%s 共 %s 片", username, upload_id, connection_id, full_path, size, session.total_chunks)
    return {"upload_id": upload_id, "chunk_size": chunk_size, "total_chunks": session.total_chunks}


def _write_chunk(session: RemoteUploadSession, offset: int, data: bytes) -> None:
    with remote_sftp(session.connection_id) as (sftp, _home):
        with sftp.open(session.temp_path, "r+b") as handle:
            handle.set_pipelined(True)
            handle.seek(offset)
            handle.write(data)


async def upload_chunk(upload_id: str, index: int, request: Request) -> dict[str, Any]:
    """接收一个分片并写入远端临时文件对应偏移；重复上传同一片会覆盖，便于前端重试。"""
    session = _session(upload_id, _request_username(request))
    if index < 0 or index >= session.total_chunks:
        raise HTTPException(status_code=422, detail="分片序号超出范围")
    offset = index * session.chunk_size
    expected = min(session.chunk_size, session.size - offset)
    data = await _read_body(request, expected)
    if len(data) != expected:
        raise HTTPException(status_code=422, detail=f"分片长度不完整：{len(data)}/{expected} 字节")
    try:
        await run_in_threadpool(_write_chunk, session, offset, data)
    except HTTPException as exc:
        logger.warning("服务器文件分片写入失败 id=%s path=%r 第 %s 片 status=%s detail=%s", upload_id, session.full_path, index, exc.status_code, exc.detail)
        raise
    with _UPLOADS_LOCK:
        session.received.add(index)
        session.updated = time.time()
        received = len(session.received)
    return {"upload_id": upload_id, "index": index, "received": received, "total_chunks": session.total_chunks}


def complete_chunked_upload(upload_id: str, request: Request) -> dict[str, Any]:
    """确认全部分片到齐后，在远端把临时文件改名为目标文件。"""
    session = _session(upload_id, _request_username(request))
    with _UPLOADS_LOCK:
        missing = [index for index in range(session.total_chunks) if index not in session.received]
    if missing:
        raise HTTPException(status_code=409, detail=f"仍有 {len(missing)} 个分片未上传")
    try:
        with remote_sftp(session.connection_id) as (sftp, _home):
            _replace(sftp, session.temp_path, session.target, session.overwrite)
    except HTTPException as exc:
        _abort(session, f"合并失败：{exc.detail}")
        raise
    with _UPLOADS_LOCK:
        _UPLOADS.pop(upload_id, None)
    logger.info("服务器文件分片上传完成 user=%s id=%s conn=%s path=%r size=%s 耗时 %.1fs",
                session.username, upload_id, session.connection_id, session.full_path, session.size, time.time() - session.created)
    return {"connection_id": session.connection_id, "directory": session.directory, "path": session.full_path,
            "name": session.full_path.rsplit("/", 1)[-1], "size": session.size, "overwrite": session.overwrite, "modified": time.time()}


def _abort(session: RemoteUploadSession, reason: str) -> None:
    with _UPLOADS_LOCK:
        _UPLOADS.pop(session.id, None)
    _remove_quietly(session.connection_id, session.temp_path)
    logger.warning("服务器文件分片上传取消 user=%s id=%s path=%r 已收到 %s/%s 片 原因：%s",
                   session.username, session.id, session.full_path, len(session.received), session.total_chunks, reason)


def abort_chunked_upload(upload_id: str, request: Request, reason: str) -> dict[str, Any]:
    """前端放弃上传时调用，删除远端临时文件。"""
    _abort(_session(upload_id, _request_username(request)), reason[:200] or "前端取消")
    return {"upload_id": upload_id, "aborted": True}
