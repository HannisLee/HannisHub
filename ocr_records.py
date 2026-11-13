"""OCR 识别记录：按登录用户隔离保存上传文件与识别结果，后台调用受管小米 OCR 服务。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote
from uuid import uuid4

import httpx
from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect

import ai_settings
from auth import current_username


ROOT_DIR = Path(__file__).resolve().parent
OCR_DATA_DIR = ROOT_DIR / "data" / "ocr_records"
# 小米 OCR 服务以 base64 JSON 接收文件且请求体上限 80 MB，原始文件需留出编码膨胀空间。
MAX_OCR_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_RECORDS_PER_USER = 500
MAX_FIELDS_LENGTH = 500
MAX_QUESTION_LENGTH = 2_000
MAX_NAME_LENGTH = 160
OCR_MAX_TOKENS = 4096
OCR_REQUEST_TIMEOUT_SECONDS = 600
PDF_POLL_SECONDS = 2
PDF_MAX_WAIT_SECONDS = 6 * 60 * 60
OCR_CONCURRENCY = 2

IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "bmp": "image/bmp"}
SUPPORTED_EXTENSIONS = (*IMAGE_TYPES, "pdf")
TASKS = {"document": "文档解析", "kie": "字段提取", "vqa": "图像问答"}
# PDF 的字段提取 / 问答：先整页解析为 Markdown，再交给 AI 能力设置中的模型处理文本。
MAX_TEXT_TASK_CHARS = 200_000
TEXT_KIE_PROMPT = (
    "你是文档信息提取助手。用户会提供一份由 OCR 识别得到的文档 Markdown（可能含 HTML 表格与 LaTeX 公式）。"
    "请只输出一个 JSON 对象，不要输出解释、前后缀或代码块标记。"
)
TEXT_VQA_PROMPT = (
    "你是文档问答助手。用户会提供一份由 OCR 识别得到的文档 Markdown（可能含 HTML 表格与 LaTeX 公式）和一个问题。"
    "请只依据文档内容简洁准确地回答；文档中没有相关信息时回答「文档中未提及」。"
)

logger = logging.getLogger("uvicorn.error")
_lock = threading.RLock()
_semaphore: asyncio.Semaphore | None = None
_tasks: set[asyncio.Task] = set()
# 由 app.py 注入：返回运行中 OCR 实例的 {"pid", "port"}，未运行时抛出 HTTPException。
_service_resolver: Callable[[], dict] | None = None


def configure(service_resolver: Callable[[], dict]) -> None:
    """注入受管 OCR 服务查找函数，避免本模块直接依赖模型管理内部状态。"""
    global _service_resolver
    _service_resolver = service_resolver


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def request_username(request: Request) -> str:
    """读取当前登录用户；中间件已拦截未登录请求，这里仍做兜底。"""
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return username


def _user_dir(username: str) -> Path:
    """用户名可能含任意字符，目录名使用哈希避免路径注入。"""
    return OCR_DATA_DIR / hashlib.sha256(username.encode("utf-8")).hexdigest()[:32]


def _index_path(username: str) -> Path:
    return _user_dir(username) / "records.json"


def _record_dir(username: str, record_id: str) -> Path:
    if not record_id.isalnum() or len(record_id) != 32:
        raise HTTPException(status_code=404, detail="识别记录不存在")
    return _user_dir(username) / record_id


def _load(username: str) -> list[dict[str, Any]]:
    path = _index_path(username)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        logger.exception("OCR 记录索引损坏 user=%s", username)
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def _write(username: str, records: list[dict[str, Any]]) -> None:
    directory = _user_dir(username)
    directory.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(directory), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(records, output, ensure_ascii=False, indent=2)
        os.replace(temp_path, _index_path(username))
    except BaseException:
        Path(temp_path).unlink(missing_ok=True)
        raise


def _update(username: str, record_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    with _lock:
        records = _load(username)
        for record in records:
            if record.get("id") == record_id:
                record.update(changes, updated_at=_now())
                _write(username, records)
                return dict(record)
    return None


def _find(username: str, record_id: str) -> dict[str, Any]:
    with _lock:
        for record in _load(username):
            if record.get("id") == record_id:
                return record
    raise HTTPException(status_code=404, detail="识别记录不存在")


def list_records(username: str) -> list[dict[str, Any]]:
    """按创建时间倒序返回当前用户的记录摘要。"""
    with _lock:
        return list(reversed(_load(username)))


def _validate_options(task: str, fields: str, question: str, extension: str) -> tuple[str, str, str]:
    task = (task or "document").strip().lower()
    if task not in TASKS:
        raise HTTPException(status_code=422, detail="识别任务只能是文档解析、字段提取或图像问答")
    fields = (fields or "").strip()
    question = (question or "").strip()
    if len(fields) > MAX_FIELDS_LENGTH:
        raise HTTPException(status_code=422, detail=f"提取字段不能超过 {MAX_FIELDS_LENGTH} 个字符")
    if len(question) > MAX_QUESTION_LENGTH:
        raise HTTPException(status_code=422, detail=f"问题不能超过 {MAX_QUESTION_LENGTH} 个字符")
    if task == "vqa" and not question:
        raise HTTPException(status_code=422, detail="图像问答需要填写问题")
    return task, fields if task == "kie" else "", question if task == "vqa" else ""


async def create_record(request: Request, task: str, fields: str, question: str) -> dict[str, Any]:
    """接收原始请求体文件，保存后排入后台识别队列。"""
    username = request_username(request)
    filename = Path(unquote(request.headers.get("x-file-name", ""))).name.strip()[:MAX_NAME_LENGTH]
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"仅支持 {' / '.join(ext.upper() for ext in SUPPORTED_EXTENSIONS)} 文件")
    task, fields, question = _validate_options(task, fields, question, extension)
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="上传长度格式无效") from exc
    if declared > MAX_OCR_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="单个文件不能超过 50 MB")

    with _lock:
        if len(_load(username)) >= MAX_RECORDS_PER_USER:
            raise HTTPException(status_code=409, detail=f"识别记录已达 {MAX_RECORDS_PER_USER} 条上限，请先删除旧记录")

    record_id = uuid4().hex
    directory = _record_dir(username, record_id)
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / f"source.{extension}"
    received = 0
    try:
        with source.open("wb") as output:
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_OCR_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="单个文件不能超过 50 MB")
                output.write(chunk)
        if not received:
            raise HTTPException(status_code=422, detail="上传文件为空")
    except (HTTPException, ClientDisconnect, OSError) as exc:
        shutil.rmtree(directory, ignore_errors=True)
        logger.warning("OCR 上传失败 user=%s file=%r 已接收 %s 字节 error=%s", username, filename, received, getattr(exc, "detail", exc))
        if isinstance(exc, OSError):
            raise HTTPException(status_code=500, detail=f"保存上传文件失败：{exc}") from exc
        raise

    now = _now()
    record = {
        "id": record_id, "name": filename, "filename": filename, "extension": extension,
        "kind": "pdf" if extension == "pdf" else "image", "size": received,
        "task": task, "fields": fields, "question": question,
        # PDF 的字段提取与问答走「OCR 解析 → 文本模型」两段链路。
        "pipeline": "pdf_text" if extension == "pdf" and task != "document" else "ocr",
        "status": "queued", "progress": 0, "progress_detail": "等待识别", "error": None,
        "chars": 0, "latency_ms": None, "created_at": now, "updated_at": now,
    }
    with _lock:
        records = _load(username)
        records.append(record)
        _write(username, records)
    logger.info("OCR 任务创建 user=%s id=%s file=%r size=%s task=%s", username, record_id, filename, received, task)
    task_handle = asyncio.create_task(_run(username, record_id))
    _tasks.add(task_handle)
    task_handle.add_done_callback(_tasks.discard)
    return record


def _service_base() -> str:
    if _service_resolver is None:
        raise RuntimeError("OCR 服务查找函数未配置")
    item = _service_resolver()
    return f"http://127.0.0.1:{item['port']}"


def _error_text(response: httpx.Response) -> str:
    try:
        payload = response.json()
        return str(payload.get("error") or payload.get("detail") or payload)[:500]
    except ValueError:
        return response.text[:500] or f"HTTP {response.status_code}"


async def _run(username: str, record_id: str) -> None:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(OCR_CONCURRENCY)
    async with _semaphore:
        started = time.monotonic()
        try:
            record = _find(username, record_id)
            _update(username, record_id, {"status": "running", "progress_detail": "正在识别"})
            source = _record_dir(username, record_id) / f"source.{record['extension']}"
            encoded = base64.b64encode(await asyncio.to_thread(source.read_bytes)).decode("ascii")
            base = _service_base()
            async with httpx.AsyncClient(timeout=httpx.Timeout(OCR_REQUEST_TIMEOUT_SECONDS, connect=5.0)) as client:
                if record["kind"] == "pdf":
                    text = await _run_pdf(client, base, username, record_id, record, encoded)
                    if record["task"] != "document":
                        text = await _run_text_task(username, record_id, record, text)
                else:
                    response = await client.post(f"{base}/api/ocr", json={
                        "task": record["task"], "fields": record["fields"], "question": record["question"],
                        "image_base64": encoded, "image_mime": IMAGE_TYPES[record["extension"]], "max_tokens": OCR_MAX_TOKENS,
                    })
                    if not response.is_success:
                        raise RuntimeError(_error_text(response))
                    text = str(response.json().get("content") or "")
            (_record_dir(username, record_id) / "result.md").write_text(text, encoding="utf-8")
            latency = int((time.monotonic() - started) * 1000)
            _update(username, record_id, {"status": "completed", "progress": 100, "progress_detail": "识别完成",
                                          "chars": len(text), "latency_ms": latency, "error": None})
            logger.info("OCR 任务完成 user=%s id=%s chars=%s 耗时 %.1fs", username, record_id, len(text), latency / 1000)
        except HTTPException as exc:
            _fail(username, record_id, str(exc.detail))
        except httpx.HTTPError as exc:
            _fail(username, record_id, f"无法连接 OCR 服务：{exc}")
        except Exception as exc:  # noqa: BLE001 - 任何失败都要落到记录上
            _fail(username, record_id, str(exc) or exc.__class__.__name__)


async def _run_pdf(client: httpx.AsyncClient, base: str, username: str, record_id: str, record: dict, encoded: str) -> str:
    """PDF 走官方逐页任务接口，轮询页进度后读取合并后的 Markdown。"""
    response = await client.post(f"{base}/api/book", json={"pdf_base64": encoded, "pdf_name": record["filename"], "max_tokens": OCR_MAX_TOKENS})
    if not response.is_success:
        raise RuntimeError(_error_text(response))
    job_id = str(response.json().get("id") or "")
    if not job_id:
        raise RuntimeError("OCR 服务未返回 PDF 任务编号")
    deadline = time.monotonic() + PDF_MAX_WAIT_SECONDS
    while True:
        await asyncio.sleep(PDF_POLL_SECONDS)
        if time.monotonic() > deadline:
            await client.post(f"{base}/api/book/{job_id}/cancel")
            raise RuntimeError("PDF 识别超时")
        status = await client.get(f"{base}/api/book/{job_id}")
        if not status.is_success:
            raise RuntimeError(_error_text(status))
        job = status.json()
        total, done = int(job.get("total") or 0), int(job.get("done") or 0)
        state = job.get("status")
        if state in ("queued", "running"):
            progress = round(done / total * 100) if total and job.get("phase") == "ocr" else 0
            if record["task"] != "document":
                progress = round(progress * 0.9)  # 留出最后 10% 给文本模型阶段
            _update(username, record_id, {"progress": progress, "progress_detail": job.get("phase_label") or "正在识别", "pages": total or None})
            continue
        if state == "cancelled":
            raise RuntimeError("PDF 任务已被取消")
        raw = await client.get(f"{base}/api/book/{job_id}/raw")
        markdown = str(raw.json().get("markdown") or "") if raw.is_success else ""
        if state == "error" and not markdown:
            raise RuntimeError(str(job.get("error") or "PDF 识别失败"))
        if state == "error":
            pages = [item for item in job.get("page_log") or [] if isinstance(item, dict)]
            failed = [item for item in pages if not item.get("ok")]
            if pages and len(failed) == len(pages):
                # 全部页面失败时结果只有错误注释，直接标记失败并给出首个原因。
                raise RuntimeError(f"全部 {len(pages)} 页识别失败：{failed[0].get('error') or '未知错误'}")
            # 部分页失败时保留已有结果，并在记录中提示失败页码。
            numbers = "、".join(str(item.get("page")) for item in failed[:20])
            _update(username, record_id, {"warning": f"第 {numbers} 页识别失败，其余页面已保留" if failed else str(job.get("error") or "部分页面识别失败")})
        return markdown


def _strip_code_fence(text: str) -> str:
    """部分模型会把 JSON 包在 ``` 代码块里，去掉外层标记。"""
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()


async def _run_text_task(username: str, record_id: str, record: dict, markdown: str) -> str:
    """PDF 解析完成后，用 AI 能力设置中的模型对 Markdown 做字段提取或问答。"""
    directory = _record_dir(username, record_id)
    # 保留中间解析结果，便于排查文本模型的回答依据。
    (directory / "parsed.md").write_text(markdown, encoding="utf-8")
    body = markdown.strip()
    if not body:
        raise RuntimeError("PDF 解析结果为空，无法继续提取")
    if len(body) > MAX_TEXT_TASK_CHARS:
        raise RuntimeError(f"PDF 解析结果超过 {MAX_TEXT_TASK_CHARS} 个字符，暂不支持对其做字段提取或问答")
    if record["task"] == "kie":
        names = [item.strip() for item in record["fields"].replace("，", ",").replace("、", ",").split(",") if item.strip()]
        requirement = (f"请提取以下字段，键名与字段名完全一致，文档中找不到的字段值为 null：{json.dumps(names, ensure_ascii=False)}"
                       if names else "请自动提取文档中的主要关键信息（如标题、日期、当事方、编号、金额、期限等），键名使用简洁的中文。")
        messages = [{"role": "system", "content": TEXT_KIE_PROMPT},
                    {"role": "user", "content": f"{requirement}\n\n文档 Markdown：\n\n{body}"}]
        detail = "PDF 已解析，正在提取字段"
    else:
        messages = [{"role": "system", "content": TEXT_VQA_PROMPT},
                    {"role": "user", "content": f"问题：{record['question']}\n\n文档 Markdown：\n\n{body}"}]
        detail = "PDF 已解析，正在回答问题"
    _update(username, record_id, {"progress": 90, "progress_detail": detail})
    try:
        result = await ai_settings.chat_completion(messages, temperature=0.1)
    except HTTPException as exc:
        raise RuntimeError(f"PDF 已解析，但文本模型调用失败：{exc.detail}（可在设置 · AI 能力中检查当前配置）") from exc
    text = str(result.get("content") or "")
    return _strip_code_fence(text) if record["task"] == "kie" else text.strip()


def _fail(username: str, record_id: str, message: str) -> None:
    _update(username, record_id, {"status": "error", "progress_detail": "识别失败", "error": message[:500]})
    logger.warning("OCR 任务失败 user=%s id=%s error=%s", username, record_id, message[:500])


def recover_interrupted() -> None:
    """服务重启后，未完成的任务无法继续，统一标记为失败。"""
    if not OCR_DATA_DIR.is_dir():
        return
    with _lock:
        for index_path in OCR_DATA_DIR.glob("*/records.json"):
            try:
                records = json.loads(index_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            changed = False
            for record in records if isinstance(records, list) else []:
                if isinstance(record, dict) and record.get("status") in ("queued", "running"):
                    record.update(status="error", progress_detail="识别中断", error="服务重启导致任务中断，请重新上传", updated_at=_now())
                    changed = True
            if changed:
                fd, temp_path = tempfile.mkstemp(dir=str(index_path.parent), suffix=".json.tmp")
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    json.dump(records, output, ensure_ascii=False, indent=2)
                os.replace(temp_path, index_path)


def read_text(username: str, record_id: str) -> dict[str, Any]:
    record = _find(username, record_id)
    path = _record_dir(username, record_id) / "result.md"
    if record.get("status") != "completed" or not path.is_file():
        raise HTTPException(status_code=409, detail="识别尚未完成")
    return {"record": record, "text": path.read_text(encoding="utf-8")}


def source_path(username: str, record_id: str) -> tuple[Path, str, str]:
    record = _find(username, record_id)
    path = _record_dir(username, record_id) / f"source.{record['extension']}"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="原始文件不存在")
    media_type = "application/pdf" if record["extension"] == "pdf" else IMAGE_TYPES[record["extension"]]
    return path, media_type, record["filename"]


def rename_record(username: str, record_id: str, name: object) -> dict[str, Any]:
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=422, detail="记录名称不能为空")
    if len(name.strip()) > MAX_NAME_LENGTH:
        raise HTTPException(status_code=422, detail=f"记录名称不能超过 {MAX_NAME_LENGTH} 个字符")
    _find(username, record_id)
    return _update(username, record_id, {"name": name.strip()}) or {}


def delete_record(username: str, record_id: str) -> dict[str, Any]:
    with _lock:
        records = _load(username)
        record = next((item for item in records if item.get("id") == record_id), None)
        if record is None:
            raise HTTPException(status_code=404, detail="识别记录不存在")
        if record.get("status") in ("queued", "running"):
            raise HTTPException(status_code=409, detail="识别进行中，完成后才能删除")
        _write(username, [item for item in records if item.get("id") != record_id])
    shutil.rmtree(_record_dir(username, record_id), ignore_errors=True)
    return record
