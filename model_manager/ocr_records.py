"""OCR 识别记录：记录保存在 SQLite（按登录账号 owner 隔离），上传文件平铺在 data/ocr_files/<记录 ID>/，后台调用受管小米 OCR 服务。"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote
from uuid import uuid4

import httpx
from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect

from core import database
from core.auth import ADMIN_USERNAME, current_username
from model_manager import ai_settings


# 模块位于子目录，ROOT_DIR 指向项目根目录
ROOT_DIR = Path(__file__).resolve().parent.parent
OCR_FILES_DIR = ROOT_DIR / "data" / "ocr_files"
# 旧版按用户哈希分目录的 JSON 存储，启动时一次性迁移进数据库
LEGACY_OCR_DATA_DIR = ROOT_DIR / "data" / "ocr_records"
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
# 记录摘要不返回大字段
_LARGE_COLUMNS = ("owner", "result", "parsed")
# 允许由业务代码更新的列，防止拼接 SQL 时混入任意列名
_UPDATABLE_COLUMNS = {
    "name", "status", "progress", "progress_detail", "error", "warning", "chars",
    "latency_ms", "pages", "result", "parsed",
}
_ACTIVE_STATUSES = ("queued", "running")

logger = logging.getLogger("uvicorn.error")
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


def _record_dir(record_id: str) -> Path:
    """记录 ID 是服务端生成的 32 位十六进制串，校验后才拼接路径。"""
    if not record_id.isalnum() or len(record_id) != 32:
        raise HTTPException(status_code=404, detail="识别记录不存在")
    return OCR_FILES_DIR / record_id


def _summary(row: Any) -> dict[str, Any] | None:
    return database.row_dict(row, _LARGE_COLUMNS)


def _update(record_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    """后台任务按记录 ID 更新状态；记录已被删除时返回 None。"""
    columns = [key for key in changes if key in _UPDATABLE_COLUMNS]
    assignments = ", ".join(f"{key} = ?" for key in columns)
    values = [changes[key] for key in columns]
    with database.connect() as conn:
        conn.execute(f"UPDATE ocr_records SET {assignments}, updated_at = ? WHERE id = ?", (*values, _now(), record_id))
        return _summary(conn.execute("SELECT * FROM ocr_records WHERE id = ?", (record_id,)).fetchone())


def _find(username: str, record_id: str) -> dict[str, Any]:
    """读取当前账号的一条记录（含大字段）；不属于该账号时与不存在一样返回 404。"""
    with database.connect() as conn:
        row = conn.execute("SELECT * FROM ocr_records WHERE id = ? AND owner = ?", (record_id, username)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="识别记录不存在")
    return database.row_dict(row) or {}


def list_records(username: str) -> list[dict[str, Any]]:
    """按创建时间倒序返回当前用户的记录摘要。"""
    with database.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM ocr_records WHERE owner = ? ORDER BY created_at DESC, rowid DESC", (username,),
        ).fetchall()
    return [_summary(row) or {} for row in rows]


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

    with database.connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM ocr_records WHERE owner = ?", (username,)).fetchone()[0]
    if count >= MAX_RECORDS_PER_USER:
        raise HTTPException(status_code=409, detail=f"识别记录已达 {MAX_RECORDS_PER_USER} 条上限，请先删除旧记录")

    record_id = uuid4().hex
    directory = _record_dir(record_id)
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
        "warning": None, "chars": 0, "latency_ms": None, "pages": None, "created_at": now, "updated_at": now,
    }
    columns = list(record)
    with database.connect() as conn:
        conn.execute(
            f"INSERT INTO ocr_records(owner, {', '.join(columns)}) VALUES (?, {', '.join('?' for _ in columns)})",
            (username, *record.values()),
        )
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
            _update(record_id, {"status": "running", "progress_detail": "正在识别"})
            source = _record_dir(record_id) / f"source.{record['extension']}"
            encoded = base64.b64encode(await asyncio.to_thread(source.read_bytes)).decode("ascii")
            base = _service_base()
            async with httpx.AsyncClient(timeout=httpx.Timeout(OCR_REQUEST_TIMEOUT_SECONDS, connect=5.0)) as client:
                if record["kind"] == "pdf":
                    text = await _run_pdf(client, base, record_id, record, encoded)
                    if record["task"] != "document":
                        text = await _run_text_task(record_id, record, text)
                else:
                    response = await client.post(f"{base}/api/ocr", json={
                        "task": record["task"], "fields": record["fields"], "question": record["question"],
                        "image_base64": encoded, "image_mime": IMAGE_TYPES[record["extension"]], "max_tokens": OCR_MAX_TOKENS,
                    })
                    if not response.is_success:
                        raise RuntimeError(_error_text(response))
                    text = str(response.json().get("content") or "")
            latency = int((time.monotonic() - started) * 1000)
            _update(record_id, {"status": "completed", "progress": 100, "progress_detail": "识别完成", "result": text,
                                "chars": len(text), "latency_ms": latency, "error": None})
            logger.info("OCR 任务完成 user=%s id=%s chars=%s 耗时 %.1fs", username, record_id, len(text), latency / 1000)
        except HTTPException as exc:
            _fail(record_id, str(exc.detail))
        except httpx.HTTPError as exc:
            _fail(record_id, f"无法连接 OCR 服务：{exc}")
        except Exception as exc:  # noqa: BLE001 - 任何失败都要落到记录上
            _fail(record_id, str(exc) or exc.__class__.__name__)


async def _run_pdf(client: httpx.AsyncClient, base: str, record_id: str, record: dict, encoded: str) -> str:
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
            _update(record_id, {"progress": progress, "progress_detail": job.get("phase_label") or "正在识别", "pages": total or None})
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
            _update(record_id, {"warning": f"第 {numbers} 页识别失败，其余页面已保留" if failed else str(job.get("error") or "部分页面识别失败")})
        return markdown


def _strip_code_fence(text: str) -> str:
    """部分模型会把 JSON 包在 ``` 代码块里，去掉外层标记。"""
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()


async def _run_text_task(record_id: str, record: dict, markdown: str) -> str:
    """PDF 解析完成后，用 AI 能力设置中的模型对 Markdown 做字段提取或问答。"""
    # 保留中间解析结果，便于排查文本模型的回答依据。
    _update(record_id, {"parsed": markdown})
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
    _update(record_id, {"progress": 90, "progress_detail": detail})
    try:
        result = await ai_settings.chat_completion(messages, temperature=0.1)
    except HTTPException as exc:
        raise RuntimeError(f"PDF 已解析，但文本模型调用失败：{exc.detail}（可在设置 · AI 能力中检查当前配置）") from exc
    text = str(result.get("content") or "")
    return _strip_code_fence(text) if record["task"] == "kie" else text.strip()


def _fail(record_id: str, message: str) -> None:
    _update(record_id, {"status": "error", "progress_detail": "识别失败", "error": message[:500]})
    logger.warning("OCR 任务失败 id=%s error=%s", record_id, message[:500])


def recover_interrupted() -> None:
    """服务重启后，未完成的任务无法继续，统一标记为失败。"""
    with database.connect() as conn:
        conn.execute(
            "UPDATE ocr_records SET status = 'error', progress_detail = '识别中断', "
            "error = '服务重启导致任务中断，请重新上传', updated_at = ? WHERE status IN (?, ?)",
            (_now(), *_ACTIVE_STATUSES),
        )


def migrate_legacy_storage() -> int:
    """把旧版 data/ocr_records/<用户哈希>/records.json 迁移进数据库，全部归属管理员账号。

    原始文件移动到 data/ocr_files/<记录 ID>/，识别结果写入数据库；迁移完成后旧目录改名为
    ocr_records.migrated 留作备份。重复执行是安全的（已存在的记录 ID 会跳过）。
    """
    if not LEGACY_OCR_DATA_DIR.is_dir():
        return 0
    migrated = 0
    for index_path in sorted(LEGACY_OCR_DATA_DIR.glob("*/records.json")):
        try:
            records = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.exception("OCR 旧记录索引无法读取，跳过 %s", index_path)
            continue
        for record in records if isinstance(records, list) else []:
            record_id = str(record.get("id") or "") if isinstance(record, dict) else ""
            if not record_id.isalnum() or len(record_id) != 32:
                continue
            legacy_dir = index_path.parent / record_id
            texts = {}
            for column, filename in (("result", "result.md"), ("parsed", "parsed.md")):
                try:
                    texts[column] = (legacy_dir / filename).read_text(encoding="utf-8")
                except OSError:
                    texts[column] = None
            extension = str(record.get("extension") or "")
            now = _now()
            values = {
                "id": record_id,
                "owner": ADMIN_USERNAME,
                "name": str(record.get("name") or record.get("filename") or "未命名记录")[:MAX_NAME_LENGTH],
                "filename": str(record.get("filename") or ""),
                "extension": extension,
                "kind": str(record.get("kind") or ("pdf" if extension == "pdf" else "image")),
                "size": int(record.get("size") or 0),
                "task": str(record.get("task") or "document"),
                "fields": str(record.get("fields") or ""),
                "question": str(record.get("question") or ""),
                "pipeline": str(record.get("pipeline") or "ocr"),
                "status": str(record.get("status") or "error"),
                "progress": float(record.get("progress") or 0),
                "progress_detail": str(record.get("progress_detail") or ""),
                "error": record.get("error"),
                "warning": record.get("warning"),
                "chars": int(record.get("chars") or 0),
                "latency_ms": record.get("latency_ms"),
                "pages": record.get("pages"),
                "created_at": str(record.get("created_at") or now),
                "updated_at": str(record.get("updated_at") or now),
                **texts,
            }
            if values["status"] in _ACTIVE_STATUSES:
                values.update(status="error", progress_detail="识别中断", error="服务重启导致任务中断，请重新上传")
            with database.connect() as conn:
                inserted = conn.execute(
                    f"INSERT OR IGNORE INTO ocr_records({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
                    tuple(values.values()),
                ).rowcount
            target = OCR_FILES_DIR / record_id
            if legacy_dir.is_dir() and not target.exists():
                OCR_FILES_DIR.mkdir(parents=True, exist_ok=True)
                for leftover in ("result.md", "parsed.md"):
                    (legacy_dir / leftover).unlink(missing_ok=True)
                shutil.move(str(legacy_dir), str(target))
            migrated += inserted
    backup = LEGACY_OCR_DATA_DIR.with_name("ocr_records.migrated")
    if not backup.exists():
        LEGACY_OCR_DATA_DIR.rename(backup)
    logger.info("OCR 旧记录已迁移进数据库：%s 条，归属 %s", migrated, ADMIN_USERNAME)
    return migrated


def read_text(username: str, record_id: str) -> dict[str, Any]:
    record = _find(username, record_id)
    text = record.get("result")
    if record.get("status") != "completed" or text is None:
        raise HTTPException(status_code=409, detail="识别尚未完成")
    return {"record": {key: value for key, value in record.items() if key not in _LARGE_COLUMNS}, "text": text}


def source_path(username: str, record_id: str) -> tuple[Path, str, str]:
    record = _find(username, record_id)
    path = _record_dir(record_id) / f"source.{record['extension']}"
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
    return _update(record_id, {"name": name.strip()}) or {}


def delete_record(username: str, record_id: str) -> dict[str, Any]:
    with database.transaction() as conn:
        row = conn.execute("SELECT * FROM ocr_records WHERE id = ? AND owner = ?", (record_id, username)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="识别记录不存在")
        if row["status"] in _ACTIVE_STATUSES:
            raise HTTPException(status_code=409, detail="识别进行中，完成后才能删除")
        conn.execute("DELETE FROM ocr_records WHERE id = ?", (record_id,))
    shutil.rmtree(_record_dir(record_id), ignore_errors=True)
    return _summary(row) or {}


def purge_user(username: str) -> int:
    """删除账号时清理其全部 OCR 记录与原始文件。"""
    with database.transaction() as conn:
        ids = [row["id"] for row in conn.execute("SELECT id FROM ocr_records WHERE owner = ?", (username,))]
        conn.execute("DELETE FROM ocr_records WHERE owner = ?", (username,))
    for record_id in ids:
        shutil.rmtree(OCR_FILES_DIR / record_id, ignore_errors=True)
    return len(ids)
