"""提示词语音输入：原音频落盘、转码归档和外部 ASR，任务状态以 JSON 持久化。"""

import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

MAX_AUDIO_BYTES = 512 * 1024 * 1024
MIME_EXTENSIONS = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3"}
DEFAULT_ASR = {"api_url": "", "api_key": "", "model": "", "language": "", "archive_dir": "", "timeout_seconds": 300}


def resolve_asr_endpoint(config):
    """兼容基础地址与完整端点，自动识别 MiMo 的音频聊天协议。"""
    parsed = urlsplit(config["api_url"])
    path = parsed.path.rstrip("/")
    mimo = config.get("model", "").lower().startswith("mimo-") or (parsed.hostname or "").endswith(".xiaomimimo.com")
    protocol = "chat_audio" if mimo or path.endswith("/chat/completions") else "openai"
    if path in ("", "/v1"):
        path = "/v1/chat/completions" if protocol == "chat_audio" else "/v1/audio/transcriptions"
    elif mimo and path.endswith("/audio/transcriptions"):
        path = path.removesuffix("/audio/transcriptions") + "/chat/completions"
    return protocol, urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))


class AudioService:
    def __init__(self, app_dir, read_settings, write_settings, settings_lock):
        self.app_dir = Path(app_dir)
        self.read_settings = read_settings
        self.write_settings = write_settings
        self.settings_lock = settings_lock
        self.task = None
        self.wake = asyncio.Event()
        self.upload_lock = asyncio.Lock()
        self.router = APIRouter()
        self.router.add_api_route("/asr-settings", self.settings, methods=["GET"])
        self.router.add_api_route("/asr-settings", self.save_settings, methods=["PUT"])
        self.router.add_api_route("/recordings", self.list_recordings, methods=["GET"])
        self.router.add_api_route("/recordings/{recording_id}", self.upload, methods=["POST"])
        self.router.add_api_route("/recordings/{recording_id}", self.delete, methods=["DELETE"])
        self.router.add_api_route("/recordings/{recording_id}/retry", self.retry, methods=["POST"])
        self.router.add_api_route("/recordings/{recording_id}/audio", self.audio, methods=["GET"])

    def config(self):
        return {**DEFAULT_ASR, **self.read_settings().get("external_asr", {})}

    async def settings(self):
        config = self.config()
        protocol, endpoint = resolve_asr_endpoint(config)
        directory = Path(config["archive_dir"] or self.app_dir / "data" / "recordings").expanduser().resolve()
        return {**config, "ffmpeg_available": bool(shutil.which("ffmpeg")), "protocol": protocol,
                "resolved_api_url": endpoint if config["api_url"] else "", "resolved_archive_dir": str(directory)}

    async def save_settings(self, request: Request):
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(400, "请求体必须是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(400, "请求体必须是 JSON 对象")
        current = self.config()
        config = {}
        for field in ("api_url", "api_key", "model", "language", "archive_dir"):
            value = payload.get(field, current[field])
            if not isinstance(value, str) or len(value) > 4096 or "\n" in value or "\r" in value:
                raise HTTPException(400, f"{field} 必须是单行字符串，最长 4096 字符")
            config[field] = value.strip()
        parsed = urlsplit(config["api_url"])
        if config["api_url"] and (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment):
            raise HTTPException(400, "API 地址必须是完整的 HTTP 或 HTTPS 转写端点")
        timeout = payload.get("timeout_seconds", self.config()["timeout_seconds"])
        if type(timeout) is not int or not 10 <= timeout <= 3600:
            raise HTTPException(400, "超时必须为 10 至 3600 秒的整数")
        config["timeout_seconds"] = timeout
        with self.settings_lock:
            data = self.read_settings()
            data["external_asr"] = config
            self.write_settings(data)
        # 原归档目录保存在每条记录中，修改目录不会影响历史音频。
        for item in self.records():
            if item["status"] == "waiting_config":
                self.update(item["id"], status="queued", error="")
        await self.start()
        self.wake.set()
        return await self.settings()

    def records(self):
        return list(self.read_settings().get("recordings", []))

    def find(self, recording_id):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", recording_id):
            raise HTTPException(400, "录音 ID 格式无效")
        item = next((item for item in self.records() if item["id"] == recording_id), None)
        if item is None:
            raise HTTPException(404, "录音不存在")
        return item

    def update(self, recording_id, **changes):
        with self.settings_lock:
            data = self.read_settings()
            for item in data.get("recordings", []):
                if item["id"] == recording_id:
                    item.update(changes)
                    self.write_settings(data)
                    return dict(item)
        raise HTTPException(404, "录音不存在")

    def public(self, item):
        return {key: value for key, value in item.items() if key not in ("raw_path", "converted_path", "sha256")}

    async def list_recordings(self):
        return {"recordings": [self.public(item) for item in reversed(self.records())],
                "deleted_recordings": self.read_settings().get("deleted_recordings", [])}

    async def upload(self, recording_id: str, request: Request):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", recording_id):
            raise HTTPException(400, "录音 ID 格式无效")
        mime = request.headers.get("content-type", "").split(";")[0].strip()
        if mime not in MIME_EXTENSIONS:
            raise HTTPException(415, "不支持的录音格式")
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError as exc:
            raise HTTPException(400, "Content-Length 无效") from exc
        if length < 0 or length > MAX_AUDIO_BYTES:
            raise HTTPException(413, "录音最大为 512 MB")
        # 串行写入和不可变 ID 避免重试、多标签页同时上传覆盖原音频。
        async with self.upload_lock:
            if recording_id in self.read_settings().get("deleted_recordings", []):
                raise HTTPException(410, "录音已删除，不能重新上传")
            existing = next((item for item in self.records() if item["id"] == recording_id), None)
            directory = Path(self.config()["archive_dir"] or self.app_dir / "data" / "recordings").expanduser().resolve()
            directory.mkdir(parents=True, exist_ok=True)
            temp = directory / f".{recording_id}.{uuid.uuid4().hex}.part"
            digest = hashlib.sha256()
            size = 0
            try:
                with temp.open("xb") as output:
                    async for chunk in request.stream():
                        size += len(chunk)
                        if size > MAX_AUDIO_BYTES:
                            raise HTTPException(413, "录音最大为 512 MB")
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if not size or (length and size != length):
                    raise HTTPException(400, "音频为空或上传不完整")
                if existing:
                    if digest.hexdigest() != existing["sha256"]:
                        raise HTTPException(409, "相同 ID 已保存不同音频，请保留本地副本")
                    return self.public(existing)
                raw_path = directory / f"{recording_id}.{MIME_EXTENSIONS[mime]}"
                os.replace(temp, raw_path)
                item = {
                    "id": recording_id, "created_at": datetime.now(timezone.utc).isoformat(),
                    "size": size, "mime_type": mime, "sha256": digest.hexdigest(),
                    "raw_path": str(raw_path), "converted_path": "", "status": "queued",
                    "text": "", "error": "", "archive_dir": str(directory),
                }
                with self.settings_lock:
                    data = self.read_settings()
                    data.setdefault("recordings", []).append(item)
                    self.write_settings(data)
            finally:
                temp.unlink(missing_ok=True)
        await self.start()
        self.wake.set()
        return self.public(item)

    async def delete(self, recording_id: str):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", recording_id):
            raise HTTPException(400, "录音 ID 格式无效")
        # 等待上传落盘后再删除；处理中的任务由用户在完成后删除，避免后台重建文件。
        async with self.upload_lock:
            with self.settings_lock:
                data = self.read_settings()
                item = next((item for item in data.get("recordings", []) if item["id"] == recording_id), None)
                if item and item["status"] == "processing":
                    raise HTTPException(409, "录音正在处理，请完成后再删除")
                if item:
                    raw = Path(item["raw_path"])
                    paths = {raw, raw.with_name(f"{recording_id}.archive.mp3"), raw.with_name(f"{recording_id}.txt")}
                    if item.get("converted_path"):
                        paths.add(Path(item["converted_path"]))
                    for path in paths:
                        path.unlink(missing_ok=True)
                data["recordings"] = [item for item in data.get("recordings", []) if item["id"] != recording_id]
                # 保留删除标记，阻止断网重试或另一个标签页把已删除的录音重新上传。
                deleted = data.setdefault("deleted_recordings", [])
                if recording_id not in deleted:
                    deleted.append(recording_id)
                self.write_settings(data)
        return {"ok": True}

    async def retry(self, recording_id: str):
        item = self.find(recording_id)
        if item["status"] not in ("queued", "processing", "done"):
            item = self.update(recording_id, status="queued", error="")
        await self.start()
        self.wake.set()
        return self.public(item)

    async def audio(self, recording_id: str, converted: bool = False):
        item = self.find(recording_id)
        path = Path(item["converted_path"] if converted else item["raw_path"])
        if not path.is_file():
            raise HTTPException(404, "音频文件不存在")
        return FileResponse(path, filename=path.name, media_type="audio/mpeg" if converted else item["mime_type"])

    async def start(self):
        if self.task is None or self.task.done():
            for item in self.records():
                if item["status"] == "processing":
                    self.update(item["id"], status="queued", error="")
            self.task = asyncio.create_task(self.worker())
            self.wake.set()

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    async def transcode(self, source: Path, target: Path):
        if not shutil.which("ffmpeg"):
            raise RuntimeError("服务器未安装 ffmpeg，原音频已归档；安装后可重试")
        temp = target.with_suffix(".tmp.mp3")
        spawning = asyncio.create_task(asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source),
            "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "64k", str(temp),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        ))
        try:
            process = await asyncio.shield(spawning)
        except asyncio.CancelledError:
            # 创建子进程期间重启服务也必须回收 ffmpeg，避免遗留后台进程。
            process = await spawning
            if process.returncode is None:
                process.kill()
                await process.wait()
            temp.unlink(missing_ok=True)
            raise
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), timeout=600)
            if process.returncode or not temp.is_file() or not temp.stat().st_size:
                raise RuntimeError("转码失败，原音频已保留：" + stderr.decode(errors="replace")[-500:])
            os.replace(temp, target)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            temp.unlink(missing_ok=True)

    async def process(self, item):
        recording_id = item["id"]
        self.update(recording_id, status="processing", error="")
        try:
            raw = Path(item["raw_path"])
            target = raw.with_name(f"{recording_id}.archive.mp3")
            if not target.is_file():
                await self.transcode(raw, target)
            self.update(recording_id, converted_path=str(target))
            config = self.config()
            if not config["api_url"]:
                self.update(recording_id, status="waiting_config", error="原音频与转码音频已归档，请配置外部 ASR")
                return
            fields = {"response_format": "json"}
            if config["model"]:
                fields["model"] = config["model"]
            if config["language"]:
                fields["language"] = config["language"]
            headers = {"Authorization": f"Bearer {config['api_key']}"} if config["api_key"] else {}
            protocol, endpoint = resolve_asr_endpoint(config)
            async with httpx.AsyncClient(timeout=config["timeout_seconds"]) as client:
                if protocol == "chat_audio":
                    payload = {
                        "model": config["model"] or "mimo-v2.5-asr",
                        "messages": [{"role": "user", "content": [{"type": "input_audio", "input_audio": {
                            "data": "data:audio/mpeg;base64," + base64.b64encode(target.read_bytes()).decode("ascii"),
                        }}]}],
                        "asr_options": {"language": config["language"] or "auto"},
                        "stream": False,
                    }
                    response = await client.post(endpoint, headers=headers, json=payload)
                else:
                    with target.open("rb") as audio:
                        response = await client.post(endpoint, headers=headers, data=fields, files={"file": (target.name, audio, "audio/mpeg")})
            if not response.is_success:
                # 避免第三方错误页回显请求密钥，仅保存状态码。
                raise RuntimeError(f"外部 ASR 返回 HTTP {response.status_code}，请检查地址、Key、模型和服务音频限制")
            result = response.json()
            text = None
            if isinstance(result, dict):
                if protocol == "chat_audio":
                    choices = result.get("choices")
                    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                        message = choices[0].get("message")
                        text = message.get("content") if isinstance(message, dict) else None
                else:
                    text = result.get("text")
            if not isinstance(text, str) or not text.strip():
                raise RuntimeError("外部 ASR 未返回有效的转写文本")
            text_path = raw.with_name(f"{recording_id}.txt")
            text_path.write_text(text, encoding="utf-8")
            self.update(recording_id, status="done", text=text, error="")
        except asyncio.CancelledError:
            self.update(recording_id, status="queued", error="服务重启后继续处理")
            raise
        except (httpx.HTTPError, json.JSONDecodeError):
            self.update(recording_id, status="failed", error="外部 ASR 网络异常、超时或响应不是 JSON；原音频和转码归档均保留，可重试")
        except Exception as exc:
            self.update(recording_id, status="failed", error=str(exc)[:600])

    async def worker(self):
        while True:
            await self.wake.wait()
            self.wake.clear()
            for item in self.records():
                # 上一条任务等待期间，后续排队记录可能已被删除。
                current = next((current for current in self.records() if current["id"] == item["id"]), None)
                if current and current["status"] == "queued":
                    await self.process(current)
