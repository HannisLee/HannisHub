"""聊天室组件：单一公共聊天室。

- 消息与用户资料（昵称、头像）以本地 JSON 文件持久保存
- 每个浏览器生成一个 client_id 作为身份；在线状态只保存在内存中，按最近心跳判断
- 图片与文件附件保存在 data/chat_room_files/，先上传取得文件编号，再随消息发送
- 已读回执：每个浏览器保存一个单调递增的「已读到的消息编号」游标（data/chat_room_reads.json）；
  消息发送时记录「最近 10 分钟内同时在线人数最多的那一刻」的在线人群作为应读人群快照，
  发送者据此看到 已读/未读 人数与名单
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import HTTPException, Request

ROOT_DIR = Path(__file__).resolve().parent
CHAT_ROOM_PATH = ROOT_DIR / "data" / "chat_room.json"
READS_PATH = ROOT_DIR / "data" / "chat_room_reads.json"
FILES_DIR = ROOT_DIR / "data" / "chat_room_files"

# 附件：单个文件上限 50 MB；只有常见位图会在页面内直接显示，
# SVG、HTML 等可能携带脚本的类型一律按普通文件强制下载
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
INLINE_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
FILE_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
MAX_FILE_NAME_CHARS = 200
MAX_IMAGE_SIDE = 20_000
# 上传后超过该时间仍未被任何消息引用的附件会被清理
ORPHAN_FILE_TTL_SECONDS = 24 * 60 * 60

# 最多保留的消息条数，超出后丢弃最早的记录
MAX_STORED_MESSAGES = 10_000
MAX_MESSAGE_CHARS = 4_000
MAX_NICKNAME_CHARS = 24
# 单次请求最多返回的消息条数
MAX_FETCH_MESSAGES = 500
MAX_PROFILES = 500
# 头像：emoji 文本或前端压缩后的 data URL 图片
MAX_AVATAR_TEXT_CHARS = 16
MAX_AVATAR_IMAGE_CHARS = 120_000
AVATAR_IMAGE_PATTERN = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# 客户端生成的消息编号，用于乐观发送的去重与幂等重试
NONCE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
# 超过该秒数未心跳即视为离线
ONLINE_TIMEOUT_SECONDS = 15

# 已读回执：应读人群取发送前该时间窗口内同时在线人数的峰值时刻；只回传最近这些条自己的消息的回执
AUDIENCE_WINDOW_SECONDS = 10 * 60
RECEIPT_MESSAGE_WINDOW = 200
MAX_READ_RECORDS = 1_000

_LOCK = threading.RLock()
# client_id -> 最近心跳时间，仅保存在内存中
_presence: dict[str, float] = {}
# 在线人群的变化记录 (时间, 当时的在线 client_id 集合)，只保存在内存中，用于求窗口内的在线峰值
_presence_log: deque[tuple[float, frozenset[str]]] = deque()
# client_id -> {"cursor": 已读到的最大消息编号, "updated_at": 时间}；首次使用时从磁盘载入
_reads: dict[str, dict[str, float]] | None = None
# 回执数据版本，随已读游标推进或新消息变化；以启动时间为起点，重启后必然与客户端手里的版本不同
_reads_version = int(time.time() * 1000)


def _empty_store() -> dict[str, Any]:
    return {"next_id": 1, "messages": [], "profiles": {}, "profiles_version": 0}


def _read_store() -> dict[str, Any]:
    """读取聊天数据；文件缺失或损坏时返回空结构，并补齐旧版本缺少的字段。"""
    try:
        data = json.loads(CHAT_ROOM_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_store()
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return _empty_store()
    data.setdefault("next_id", (data["messages"][-1]["id"] + 1) if data["messages"] else 1)
    if not isinstance(data.get("profiles"), dict):
        data["profiles"] = {}
    data.setdefault("profiles_version", 0)
    return data


def _write_store(data: dict[str, Any]) -> None:
    """原子写入聊天数据。"""
    CHAT_ROOM_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(CHAT_ROOM_PATH.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temp_path, CHAT_ROOM_PATH)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _validate_client_id(value: object) -> str:
    client_id = str(value or "").strip()
    if not CLIENT_ID_PATTERN.match(client_id):
        raise HTTPException(status_code=400, detail="客户端标识无效，请刷新页面")
    return client_id


def _normalize_nickname(value: object) -> str:
    nickname = " ".join(str(value or "").split())[:MAX_NICKNAME_CHARS]
    if not nickname:
        raise HTTPException(status_code=400, detail="请先填写昵称")
    return nickname


def _normalize_avatar(value: object) -> str:
    """头像为空、一段短 emoji 文本，或 png/jpeg/webp 的 base64 data URL。"""
    avatar = str(value or "").strip()
    if not avatar:
        return ""
    if avatar.startswith("data:"):
        if len(avatar) > MAX_AVATAR_IMAGE_CHARS or not AVATAR_IMAGE_PATTERN.match(avatar):
            raise HTTPException(status_code=400, detail="头像图片格式不支持或过大")
        return avatar
    if len(avatar) > MAX_AVATAR_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="头像文字过长")
    return avatar


def _online_ids(now: float) -> list[str]:
    """清理过期心跳并返回在线 client_id 列表。"""
    for client_id, seen in list(_presence.items()):
        if now - seen > ONLINE_TIMEOUT_SECONDS:
            _presence.pop(client_id, None)
    return list(_presence)


def _record_presence(now: float) -> frozenset[str]:
    """按当前心跳更新在线人群变化记录，返回当前在线集合。调用时须持有 _LOCK。"""
    current = frozenset(_online_ids(now))
    if not _presence_log or _presence_log[-1][1] != current:
        _presence_log.append((now, current))
    # 只保留窗口内的记录，以及窗口开始时仍有效的最后一条
    cutoff = now - AUDIENCE_WINDOW_SECONDS
    while len(_presence_log) > 1 and _presence_log[1][0] <= cutoff:
        _presence_log.popleft()
    return current


def _peak_audience(now: float) -> frozenset[str]:
    """最近窗口内同时在线人数最多的那一刻的在线人群；人数相同取最近的一次。"""
    best: frozenset[str] = frozenset()
    for _, members in _presence_log:
        if len(members) >= len(best):
            best = members
    return best


def _load_reads() -> dict[str, dict[str, float]]:
    """载入已读游标；文件缺失或损坏时视为空。调用时须持有 _LOCK。"""
    global _reads
    if _reads is None:
        try:
            data = json.loads(READS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        _reads = {
            key: {"cursor": int(value.get("cursor", 0)), "updated_at": float(value.get("updated_at", 0))}
            for key, value in (data.items() if isinstance(data, dict) else [])
            if CLIENT_ID_PATTERN.match(key) and isinstance(value, dict)
        }
    return _reads


def _save_reads() -> None:
    """原子写入已读游标；超过上限时丢弃最久未更新的记录。调用时须持有 _LOCK。"""
    reads = _load_reads()
    if len(reads) > MAX_READ_RECORDS:
        keep = sorted(reads.items(), key=lambda item: item[1]["updated_at"], reverse=True)[:MAX_READ_RECORDS]
        reads.clear()
        reads.update(keep)
    READS_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(READS_PATH.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(reads, output)
        os.replace(temp_path, READS_PATH)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _advance_read_cursor(client_id: str, message_id: int, latest_id: int) -> bool:
    """把某浏览器的已读游标推进到 message_id（只增不减，且不超过最新消息编号）。返回是否变化。"""
    global _reads_version
    message_id = min(int(message_id), latest_id)
    reads = _load_reads()
    if message_id <= reads.get(client_id, {}).get("cursor", 0):
        return False
    reads[client_id] = {"cursor": message_id, "updated_at": time.time()}
    _reads_version += 1
    _save_reads()
    return True


def _public_message(message: dict[str, Any]) -> dict[str, Any]:
    """返回给客户端的消息：去掉应读人群快照，避免每次轮询都带上名单。"""
    return {key: value for key, value in message.items() if key != "audience"}


def _build_receipts(messages: list[dict[str, Any]], client_id: str) -> dict[str, dict[str, list[str]]]:
    """为 client_id 自己发送的最近若干条消息计算回执：应读人群中已读与未读的 client_id。

    没有应读人群快照的旧消息、以及应读人群为空的消息不产生回执。
    """
    reads = _load_reads()
    receipts: dict[str, dict[str, list[str]]] = {}
    for message in messages[-RECEIPT_MESSAGE_WINDOW:]:
        audience = message.get("audience")
        if message.get("client_id") != client_id or not audience:
            continue
        read: list[str] = []
        unread: list[str] = []
        for member in audience:
            (read if reads.get(member, {}).get("cursor", 0) >= message["id"] else unread).append(member)
        receipts[str(message["id"])] = {"read": read, "unread": unread}
    return receipts


def list_messages(
    after: int = 0,
    limit: int = 200,
    client_id: str = "",
    profiles_version: int = -1,
    read_up_to: int = 0,
    reads_version: int | None = None,
) -> dict[str, Any]:
    """返回 id 大于 after 的消息；after 为 0 时返回最近 limit 条。

    携带 client_id 时同时记录心跳；资料版本变化时才返回完整资料表，减少轮询流量。
    read_up_to 是该浏览器当前实际看到的最后一条消息编号（页面可见且已滚动到该消息），用于推进已读游标；
    reads_version 与服务端不同（含首次）时，附带该浏览器自己消息的回执。
    """
    limit = max(1, min(int(limit), MAX_FETCH_MESSAGES))
    now = time.time()
    valid_client = bool(client_id and CLIENT_ID_PATTERN.match(client_id))
    with _LOCK:
        if valid_client:
            _presence[client_id] = now
        _record_presence(now)
        online = _online_ids(now)
        data = _read_store()
        messages = data["messages"]
        latest_id = messages[-1]["id"] if messages else 0
        if valid_client and read_up_to > 0:
            _advance_read_cursor(client_id, read_up_to, latest_id)
        receipts = _build_receipts(messages, client_id) if valid_client and reads_version is not None and reads_version != _reads_version else None
        current_reads_version = _reads_version
    if after > 0:
        result = [item for item in messages if item["id"] > after][:limit]
    else:
        result = messages[-limit:]
    response: dict[str, Any] = {
        "messages": [_public_message(item) for item in result],
        "total": len(messages),
        "online": online,
        "profiles_version": data["profiles_version"],
        "reads_version": current_reads_version,
    }
    if receipts is not None:
        response["receipts"] = receipts
    if profiles_version != data["profiles_version"]:
        response["profiles"] = data["profiles"]
    return response


def save_profile(payload: dict[str, Any]) -> dict[str, Any]:
    """保存当前浏览器的昵称与头像。"""
    client_id = _validate_client_id(payload.get("client_id"))
    profile = {
        "nickname": _normalize_nickname(payload.get("nickname")),
        "avatar": _normalize_avatar(payload.get("avatar")),
        "updated_at": time.time(),
    }
    with _LOCK:
        data = _read_store()
        if client_id not in data["profiles"] and len(data["profiles"]) >= MAX_PROFILES:
            raise HTTPException(status_code=400, detail="聊天室用户资料数量已达上限")
        data["profiles"][client_id] = profile
        data["profiles_version"] += 1
        _write_store(data)
    return {"client_id": client_id, **profile}


def post_message(payload: dict[str, Any]) -> dict[str, Any]:
    """追加一条消息并返回该消息；昵称以已保存的资料为准，携带 nonce 时幂等。"""
    global _reads_version
    client_id = _validate_client_id(payload.get("client_id"))
    content = str(payload.get("content") or "").strip()
    attachment_id = str(payload.get("attachment_id") or "").strip()
    attachment = _public_attachment(_read_file_meta(attachment_id)) if attachment_id else None
    if not content and not attachment:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(content) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail=f"消息长度不能超过 {MAX_MESSAGE_CHARS} 字")
    nonce = str(payload.get("nonce") or "").strip()
    if nonce and not NONCE_PATTERN.match(nonce):
        raise HTTPException(status_code=400, detail="消息编号无效")
    with _LOCK:
        data = _read_store()
        # 同一浏览器的同一消息编号只保存一次：超时重试时直接返回已有消息
        if nonce:
            for existing in reversed(data["messages"][-500:]):
                if existing.get("nonce") == nonce and existing.get("client_id") == client_id:
                    return _public_message(existing)
        profile = data["profiles"].get(client_id)
        nickname = profile["nickname"] if profile else _normalize_nickname(payload.get("nickname"))
        # 发送者此刻在线；应读人群 = 最近窗口内在线人数峰值时刻的人群，去掉发送者自己
        now = time.time()
        _presence[client_id] = now
        _record_presence(now)
        audience = sorted(_peak_audience(now) - {client_id})
        message = {
            "id": data["next_id"],
            "client_id": client_id,
            "nickname": nickname,
            "content": content,
            "created_at": now,
            "audience": audience,
        }
        if nonce:
            message["nonce"] = nonce
        if attachment:
            message["attachment"] = attachment
        data["next_id"] += 1
        data["messages"].append(message)
        if len(data["messages"]) > MAX_STORED_MESSAGES:
            data["messages"] = data["messages"][-MAX_STORED_MESSAGES:]
        _write_store(data)
        # 发送者发消息即视为已读到这条；新消息本身也会让回执发生变化
        _advance_read_cursor(client_id, message["id"], message["id"])
        _reads_version += 1
    return _public_message(message)


def clear_messages() -> dict[str, Any]:
    """清空聊天记录；消息 id 继续递增，避免客户端增量拉取错乱。"""
    with _LOCK:
        data = _read_store()
        data["messages"] = []
        _write_store(data)
    return {"ok": True}


# ---------- 附件 ----------


def _file_path(file_id: str) -> Path:
    return FILES_DIR / file_id


def _meta_path(file_id: str) -> Path:
    return FILES_DIR / f"{file_id}.json"


def _read_file_meta(file_id: str) -> dict[str, Any]:
    """读取附件元信息；编号非法或文件缺失时返回 404。"""
    if not FILE_ID_PATTERN.match(file_id):
        raise HTTPException(status_code=404, detail="附件不存在")
    try:
        meta = json.loads(_meta_path(file_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=404, detail="附件不存在") from exc
    if not _file_path(file_id).is_file():
        raise HTTPException(status_code=404, detail="附件不存在")
    return meta


def _public_attachment(meta: dict[str, Any]) -> dict[str, Any]:
    """随消息保存与返回的附件信息。"""
    result = {key: meta[key] for key in ("id", "name", "size", "mime", "kind") if key in meta}
    if meta.get("width") and meta.get("height"):
        result["width"] = meta["width"]
        result["height"] = meta["height"]
    return result


def _safe_file_name(value: str) -> str:
    """只保留文件名本身，去掉路径与控制字符。"""
    name = unquote(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(char for char in name if ord(char) >= 32 and char != "\x7f").strip()
    if len(name) > MAX_FILE_NAME_CHARS:
        stem, dot, suffix = name.rpartition(".")
        name = (stem[: MAX_FILE_NAME_CHARS - len(suffix) - 1] + dot + suffix) if dot and len(suffix) <= 16 else name[:MAX_FILE_NAME_CHARS]
    return name or "未命名文件"


def _image_side(value: str | None) -> int | None:
    try:
        side = int(value or "")
    except ValueError:
        return None
    return side if 0 < side <= MAX_IMAGE_SIDE else None


def cleanup_orphan_files() -> int:
    """删除超过保留时间仍未被任何消息引用的附件与残留的上传临时文件。"""
    if not FILES_DIR.is_dir():
        return 0
    with _LOCK:
        referenced = {
            message["attachment"]["id"]
            for message in _read_store()["messages"]
            if isinstance(message.get("attachment"), dict)
        }
    now = time.time()
    removed = 0
    for path in FILES_DIR.iterdir():
        try:
            age = now - path.stat().st_mtime
        except OSError:
            continue
        if age < ORPHAN_FILE_TTL_SECONDS:
            continue
        if path.suffix == ".part":
            path.unlink(missing_ok=True)
            continue
        if path.suffix == ".json" and path.stem not in referenced:
            _file_path(path.stem).unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            removed += 1
    return removed


async def save_upload(request: Request) -> dict[str, Any]:
    """以原始请求体流式保存一个附件，返回附件信息供随后发送消息。

    文件名放在 x-file-name 头（URL 编码），图片尺寸放在 x-image-width / x-image-height 头。
    """
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="上传长度格式无效") from exc
    if declared > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail=f"单个文件不能超过 {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")

    name = _safe_file_name(request.headers.get("x-file-name", ""))
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()[:100] or "application/octet-stream"
    kind = "image" if mime in INLINE_IMAGE_TYPES else "file"
    file_id = uuid.uuid4().hex
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_orphan_files()

    temp_path = FILES_DIR / f"{file_id}.part"
    size = 0
    try:
        with temp_path.open("wb") as output:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise HTTPException(status_code=413, detail=f"单个文件不能超过 {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="不能发送空文件")
        os.replace(temp_path, _file_path(file_id))
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    meta: dict[str, Any] = {
        "id": file_id,
        "name": name,
        "size": size,
        "mime": mime,
        "kind": kind,
        "uploaded_at": time.time(),
    }
    width = _image_side(request.headers.get("x-image-width"))
    height = _image_side(request.headers.get("x-image-height"))
    if kind == "image" and width and height:
        meta["width"] = width
        meta["height"] = height
    _meta_path(file_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return _public_attachment(meta)


def file_response_info(file_id: str, download: bool) -> tuple[Path, str, str, str]:
    """返回 (路径, 媒体类型, 文件名, 展示方式)。

    只有常见位图且未要求下载时才内联显示，其余一律以 application/octet-stream 强制下载。
    """
    meta = _read_file_meta(file_id)
    inline = meta.get("kind") == "image" and meta.get("mime") in INLINE_IMAGE_TYPES and not download
    media_type = str(meta["mime"]) if inline else "application/octet-stream"
    return _file_path(file_id), media_type, str(meta.get("name") or "file"), "inline" if inline else "attachment"
