"""HannisHub：综合管理站入口与登录网关。"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote

from fastapi import Body, FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from core.auth import (
    AuthMiddleware,
    authenticate,
    change_password,
    clear_login_failures,
    configure_admin,
    create_user,
    current_username,
    delete_user,
    ensure_auth_settings,
    is_configured,
    is_login_allowed,
    is_terminal_admin,
    list_users,
    login_session,
    login_account_key,
    migrate_legacy_admin,
    record_login_failure,
    set_user_password,
    validate_password,
    validate_username,
)
from model_manager import ai_settings
from chatworld import private_chat, chat_room, lobby_desks, lobby_notes, lobby_presence, lobby_profile, todos
from model_manager import ocr_records
from server import terminal_commands, terminal_client
from core.compression import SelectiveGZipMiddleware
import model_manager.app as model_manager_app
from server.file_manager import (
    add_favorite,
    configured_roots,
    date_search_folders,
    delete_favorite,
    list_directory,
    list_markdown_files,
    list_favorites,
    list_ply_files,
    rename_favorite,
    resolve_file,
    download_response,
    read_markdown_file,
    save_roots,
    save_date_search_folders,
    search_ply_by_date,
    search_ply_by_range,
    pull_project_updates,
    upload_file as upload_file_to_directory,
    init_chunked_upload,
    upload_chunk,
    complete_chunked_upload,
    abort_chunked_upload,
    sync_roots,
)
from server.point_cloud import resolve_cloud_file
from server import remote_files
import prompt_service.app as prompt_service_app
import server.app as server_manager_app

USERNAME_LIMIT = 64
ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_OUT_DIR = ROOT_DIR / "frontend" / "out"
# 提示词语音输入与模型管理运行在同一 Hub 进程中，优先复用受管本机 ASR。
prompt_service_app.audio_service.configure_local_asr(
    model_manager_app.get_running_asr_service,
    model_manager_app.transcribe_with_managed_asr,
)
# OCR 识别记录由 Hub 后台调用受管小米 OCR 服务。
ocr_records.configure(model_manager_app.get_running_ocr_service)
SERVICES: list[dict[str, str]] = [
    {
        "id": "llama-manager",
        "name": "模型管理",
        "description": "本机模型、GPU、受管进程与 ASR 服务管理",
        "path": "/llama-manager/",
        "icon": "🦙",
    },
    {
        "id": "server",
        "name": "Server",
        "description": "SSH 服务器连接、远端时间与定时任务管理",
        "path": "/server/",
        "icon": "🧭",
    },
    {
        "id": "ai-settings",
        "name": "AI 设置",
        "description": "集中配置 OpenAI 兼容接口与各模块的 AI 提示词",
        "path": "/settings/",
        "icon": "✦",
    },
    {
        "id": "prompt",
        "name": "在线提示词输入",
        "description": "大输入框快速编辑、复制并归档提示词",
        "path": "/prompt/",
        "icon": "✍️",
    },
    {
        "id": "file-manager",
        "name": "文件管理",
        "description": "浏览并下载本机家目录，同时提供点云预览",
        "path": "/files/",
        "icon": "🗂",
    },
]


@asynccontextmanager
async def lifespan(_: FastAPI):
    """由 Hub 统一管理子服务生命周期。"""
    await server_manager_app.start_scheduler()
    await prompt_service_app.audio_service.start()
    # 旧版 JSON 存储的 ASR / OCR 记录一次性迁入 SQLite（归属管理员），之后再恢复中断任务
    await run_in_threadpool(model_manager_app.migrate_legacy_asr_storage)
    await run_in_threadpool(ocr_records.migrate_legacy_storage)
    await model_manager_app.recover_interrupted_asr_tasks()
    ocr_records.recover_interrupted()
    auto_start_task = asyncio.create_task(model_manager_app.auto_start_watchdog())
    try:
        yield
    finally:
        remote_files.close_all()
        auto_start_task.cancel()
        await prompt_service_app.audio_service.stop()
        await server_manager_app.stop_scheduler()


app = FastAPI(title="HannisHub", lifespan=lifespan)

# 先添加 AuthMiddleware，再添加 SessionMiddleware，
# Starlette 会把最后添加的中间件放在最外层，因此 AuthMiddleware 可以读取已解析的会话。
app.add_middleware(AuthMiddleware)
_auth_settings = ensure_auth_settings().get("auth", {})
migrate_legacy_admin()
app.add_middleware(
    SessionMiddleware,
    secret_key=str(_auth_settings.get("session_secret")),
    session_cookie="hannishub_session",
    max_age=int(_auth_settings.get("session_max_age_seconds", 7 * 24 * 60 * 60)),
    same_site="strict",
    https_only=os.environ.get("HANNISHUB_HTTPS_ONLY", "").lower() in {"1", "true", "yes"},
)
# 最后添加的中间件位于最外层：压缩在认证之后作用于最终响应，覆盖所有挂载的子服务
app.add_middleware(SelectiveGZipMiddleware)

def _frontend_page(route: str) -> FileResponse | None:
    """返回静态导出的统一前端页面；尚未构建时交由旧页面兼容。"""
    page_path = FRONTEND_OUT_DIR / route.strip("/") / "index.html" if route.strip("/") else FRONTEND_OUT_DIR / "index.html"
    if page_path.is_file():
        return FileResponse(page_path)
    return None


@app.get("/", include_in_schema=False)
async def index():
    """返回综合管理站服务列表页面。"""
    return _frontend_page("") or FileResponse(ROOT_DIR / "legacy" / "index.html")


@app.get("/login", include_in_schema=False)
async def login_page():
    """返回登录 / 首次初始化页面。"""
    return _frontend_page("login") or FileResponse(ROOT_DIR / "legacy" / "login.html")


async def _new_frontend_route(route: str) -> FileResponse:
    """返回已构建的 Next.js 页面，并给出可操作的未构建提示。"""
    page = _frontend_page(route)
    if page:
        return page
    raise HTTPException(status_code=503, detail="统一前端尚未构建，请在 frontend/ 中执行 npm run build 后重启服务")


@app.get("/llama/models", include_in_schema=False)
@app.get("/llama/models/", include_in_schema=False)
async def llama_models_page():
    return await _new_frontend_route("llama/models")


@app.get("/llama/processes", include_in_schema=False)
@app.get("/llama/processes/", include_in_schema=False)
async def llama_processes_page():
    return await _new_frontend_route("llama/processes")


@app.get("/llama/gpu", include_in_schema=False)
@app.get("/llama/gpu/", include_in_schema=False)
async def llama_gpu_page():
    return await _new_frontend_route("llama/gpu")


@app.get("/llama/downloads", include_in_schema=False)
@app.get("/llama/downloads/", include_in_schema=False)
async def llama_downloads_page():
    return await _new_frontend_route("llama/downloads")


@app.get("/llama/asr", include_in_schema=False)
@app.get("/llama/asr/", include_in_schema=False)
async def llama_asr_page():
    return await _new_frontend_route("llama/asr")


@app.get("/llama/ocr", include_in_schema=False)
@app.get("/llama/ocr/", include_in_schema=False)
async def llama_ocr_page():
    return await _new_frontend_route("llama/ocr")


@app.get("/llama/settings", include_in_schema=False)
@app.get("/llama/settings/", include_in_schema=False)
async def llama_settings_page():
    return await _new_frontend_route("llama/settings")


@app.get("/server/connections", include_in_schema=False)
@app.get("/server/connections/", include_in_schema=False)
async def server_connections_page():
    return await _new_frontend_route("server/connections")


@app.get("/server/tasks", include_in_schema=False)
@app.get("/server/tasks/", include_in_schema=False)
async def server_tasks_page():
    return await _new_frontend_route("server/tasks")


@app.get("/prompts", include_in_schema=False)
@app.get("/prompts/", include_in_schema=False)
async def prompts_page():
    return await _new_frontend_route("prompts")


@app.get("/settings", include_in_schema=False)
@app.get("/settings/", include_in_schema=False)
async def ai_settings_page():
    return await _new_frontend_route("settings")


@app.get("/files", include_in_schema=False)
@app.get("/files/", include_in_schema=False)
async def files_page():
    return await _new_frontend_route("files")


@app.get("/files/documents", include_in_schema=False)
@app.get("/files/documents/", include_in_schema=False)
async def files_documents_page():
    return await _new_frontend_route("files/documents")


@app.get("/files/server", include_in_schema=False)
@app.get("/files/server/", include_in_schema=False)
async def files_server_page():
    return await _new_frontend_route("files/server")


@app.get("/files/point-clouds", include_in_schema=False)
@app.get("/files/point-clouds/", include_in_schema=False)
async def files_point_clouds_page():
    return await _new_frontend_route("files/point-clouds")


@app.get("/settings/users", include_in_schema=False)
@app.get("/settings/users/", include_in_schema=False)
async def users_page():
    return await _new_frontend_route("settings/users")


@app.get("/chat", include_in_schema=False)
@app.get("/chat/", include_in_schema=False)
async def chat_page():
    return await _new_frontend_route("chat")


@app.get("/chat-lobby", include_in_schema=False)
@app.get("/chat-lobby/", include_in_schema=False)
async def chat_lobby_page():
    return await _new_frontend_route("chat-lobby")


@app.get("/todo", include_in_schema=False)
@app.get("/todo/", include_in_schema=False)
async def todo_page():
    return await _new_frontend_route("todo")


@app.get("/terminal", include_in_schema=False)
@app.get("/terminal/", include_in_schema=False)
async def terminal_page():
    return await _new_frontend_route("terminal")


@app.get("/point-clouds", include_in_schema=False)
@app.get("/point-clouds/", include_in_schema=False)
async def point_clouds_page():
    return await _new_frontend_route("point-clouds")


@app.get("/icon.png", include_in_schema=False)
async def icon():
    """返回 HannisHub 图标，同时兼容各子页面引用。"""
    return FileResponse(ROOT_DIR / "model_manager" / "icon.png", media_type="image/png")


@app.get("/icon.svg", include_in_schema=False)
async def unified_icon():
    """返回统一红黑浏览器标签页图标。"""
    return FileResponse(ROOT_DIR / "frontend" / "app" / "icon.svg", media_type="image/svg+xml")


@app.get("/api/health")
async def health():
    """Hub 健康检查。"""
    return JSONResponse({"ok": True, "service": "hub"})


@app.get("/api/services")
async def services():
    """返回当前可用的子服务列表。"""
    return JSONResponse({"services": SERVICES})


@app.get("/api/ai-settings")
async def read_ai_settings():
    """读取多 AI 配置；密钥只返回是否已配置。"""
    return JSONResponse(ai_settings.get_public_ai_settings())


@app.put("/api/ai-settings")
async def update_ai_settings(payload: dict[str, Any] = Body(...)):
    """保存多 AI 配置到本地 ai_settings.json。"""
    return JSONResponse(ai_settings.save_ai_settings(payload))


@app.post("/api/ai-settings/test")
async def test_ai_settings_api(payload: dict[str, Any] = Body(default={})):
    """测试指定 OpenAI 兼容接口连接。"""
    return JSONResponse(await ai_settings.test_connection(payload.get("config_id")))


@app.post("/api/ai-settings/models")
async def discover_ai_models(payload: dict[str, Any] = Body(default={})):
    """探查指定 OpenAI 兼容接口的可用模型列表。"""
    return JSONResponse(await ai_settings.discover_models(payload.get("config_id")))


@app.post("/api/ai-settings/model-test")
async def test_ai_model(payload: dict[str, Any] = Body(...)):
    """使用指定 API 与模型发送一次最小请求，验证模型可用。"""
    return JSONResponse(await ai_settings.test_model(payload.get("model"), payload.get("config_id")))


@app.get("/api/ai-settings/usage")
async def read_ai_usage(config_id: str | None = None):
    """查询 AI 配置的剩余用量；无用量接口的服务返回不支持说明。"""
    return JSONResponse(await ai_settings.get_ai_usage_summaries(config_id))


@app.get("/api/chat-room/messages")
async def chat_room_messages(
    after: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
    client_id: str = Query("", max_length=64),
    profiles_version: int = Query(-1),
    read_up_to: int = Query(0, ge=0),
    reads_version: Optional[int] = Query(None),
):
    """拉取聊天室消息与在线列表；携带 client_id 时同时作为在线心跳，并可上报已读位置、获取已读回执。"""
    return JSONResponse(await run_in_threadpool(
        chat_room.list_messages, after, limit, client_id, profiles_version, read_up_to, reads_version,
    ))


@app.put("/api/chat-room/profile")
async def chat_room_profile(request: Request, payload: dict[str, Any] = Body(...)):
    """登记当前浏览器的聊天室资料：已登录时绑定账号，名字与头像取自聊天大厅「我的房间」。"""
    username = current_username(request.session)
    return JSONResponse(await run_in_threadpool(chat_room.save_profile, payload, username))


@app.post("/api/chat-room/files")
async def chat_room_upload(request: Request):
    """以原始请求体上传聊天室附件（不超过 50 MB），文件名放在 x-file-name 头。"""
    return JSONResponse(await chat_room.save_upload(request))


@app.get("/api/chat-room/files/{file_id}")
async def chat_room_file(file_id: str, download: bool = Query(False)):
    """读取聊天室附件：常见位图内联显示，其余类型或 download=true 时强制下载。"""
    path, media_type, filename, disposition = chat_room.file_response_info(file_id, download)
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        content_disposition_type=disposition,
        headers={
            # 附件编号随机且内容不变，可长期缓存；禁止内容嗅探并以沙箱方式打开
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        },
    )


@app.post("/api/chat-room/messages")
async def chat_room_post(payload: dict[str, Any] = Body(...)):
    """以昵称发送一条聊天室消息。"""
    return JSONResponse(await run_in_threadpool(chat_room.post_message, payload))


@app.delete("/api/chat-room/messages")
async def chat_room_clear():
    """清空聊天室记录。"""
    return JSONResponse(await run_in_threadpool(chat_room.clear_messages))


@app.get("/api/file-manager/settings")
async def file_manager_settings():
    """返回文件管理组件已暴露的顶层目录。"""
    roots = configured_roots()
    return JSONResponse({"roots": roots, "resolved_roots": [str(Path(root).expanduser().resolve()) for root in roots], "home_dir": str(Path.home().resolve())})


@app.put("/api/file-manager/settings")
async def update_file_manager_settings(payload: dict[str, Any] = Body(...)):
    """保存文件管理顶层目录；目录必须存在且仅允许绝对路径或 ~/。"""
    return JSONResponse({"roots": save_roots(payload.get("roots"))})


@app.get("/api/file-manager/directory")
async def file_manager_directory(
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    refresh: bool = Query(False),
):
    """返回受限目录的直接子项；默认使用服务端目录缓存。"""
    return JSONResponse(await run_in_threadpool(list_directory, root, path, refresh=refresh))


@app.get("/api/file-manager/ply-files")
async def file_manager_ply_files(
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    refresh: bool = Query(False),
):
    """返回当前目录及其所有子目录中的 PLY 文件。"""
    return JSONResponse(await run_in_threadpool(list_ply_files, root, path, refresh=refresh))


@app.get("/api/file-manager/markdown-files")
async def file_manager_markdown_files(
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    refresh: bool = Query(False),
):
    """递归列出当前受限目录内的 Markdown 文档。"""
    return JSONResponse(await run_in_threadpool(list_markdown_files, root, path, refresh=refresh))


@app.get("/api/file-manager/markdown")
async def file_manager_markdown(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """读取单个受限 Markdown 文档的 UTF-8 内容。"""
    return JSONResponse(await run_in_threadpool(read_markdown_file, root, path))


@app.get("/api/file-manager/date-search-folders")
async def file_manager_date_search_folders():
    """返回按日期查找 PLY 的项目目录。"""
    return JSONResponse({"folders": await run_in_threadpool(date_search_folders)})


@app.put("/api/file-manager/date-search-folders")
async def update_file_manager_date_search_folders(payload: dict[str, Any] = Body(...)):
    """保存多个位于已开放范围内的项目目录。"""
    return JSONResponse({"folders": await run_in_threadpool(save_date_search_folders, payload.get("folders"))})


@app.post("/api/file-manager/ply-by-date")
async def file_manager_ply_by_date(payload: dict[str, Any] = Body(...)):
    """在已保存的项目目录中按日期范围与可选迭代规则查找 PLY。"""
    if "start_date" in payload or "end_date" in payload:
        return JSONResponse(await run_in_threadpool(search_ply_by_range, payload.get("start_date"),
                                                     payload.get("end_date"), payload.get("iteration_mode", "latest"),
                                                     payload.get("iteration"), payload.get("refresh", False)))
    return JSONResponse(await run_in_threadpool(search_ply_by_date, payload.get("date"), payload.get("iteration", 40000)))


@app.post("/api/file-manager/sync")
async def file_manager_sync(payload: dict[str, Any] = Body(default_factory=dict)):
    """递归预读所选项目的目录列表。"""
    return JSONResponse(await run_in_threadpool(sync_roots, payload.get("targets")))


@app.post("/api/file-manager/git-pull")
async def file_manager_git_pull(payload: dict[str, Any] = Body(...)):
    """拉取收藏项目目录的最新 Git 提交，并返回 LIHAN/DOC 检查结果。"""
    return JSONResponse(await run_in_threadpool(pull_project_updates, payload.get("root"), payload.get("path")))


@app.get("/api/file-manager/favorites")
async def file_manager_favorites():
    """读取当前已开放目录中的收藏。"""
    return JSONResponse({"favorites": await run_in_threadpool(list_favorites)})


@app.post("/api/file-manager/favorites")
async def create_file_manager_favorite(payload: dict[str, Any] = Body(...)):
    """收藏一个已开放目录。"""
    return JSONResponse({"favorites": await run_in_threadpool(add_favorite, payload.get("root"), payload.get("path"), payload.get("name"))})


@app.patch("/api/file-manager/favorites/{favorite_id}")
async def update_file_manager_favorite(favorite_id: str, payload: dict[str, Any] = Body(...)):
    """修改收藏的显示名称。"""
    return JSONResponse({"favorites": await run_in_threadpool(rename_favorite, favorite_id, payload.get("name"))})


@app.delete("/api/file-manager/favorites/{favorite_id}")
async def remove_file_manager_favorite(favorite_id: str):
    """删除指定收藏。"""
    return JSONResponse({"favorites": await run_in_threadpool(delete_favorite, favorite_id)})


@app.post("/api/file-manager/upload")
async def file_manager_upload(
    request: Request,
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    overwrite: bool = Query(False),
):
    """以原始请求体上传单个文件到当前受限目录，文件相对路径放在 x-file-path 头。"""
    file_path = unquote(request.headers.get("x-file-path", ""))
    return JSONResponse(await upload_file_to_directory(root, path, file_path, request, overwrite=overwrite))


@app.post("/api/file-manager/uploads")
async def file_manager_upload_init(
    request: Request,
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    payload: dict[str, Any] = Body(...),
):
    """创建分片上传会话，提交 file_path、size、chunk_size 与 overwrite。"""
    return JSONResponse(await run_in_threadpool(init_chunked_upload, root, path, payload, request))


@app.put("/api/file-manager/uploads/{upload_id}/chunks/{index}")
async def file_manager_upload_chunk(request: Request, upload_id: str, index: int):
    """以原始请求体写入指定序号的分片。"""
    return JSONResponse(await upload_chunk(upload_id, index, request))


@app.post("/api/file-manager/uploads/{upload_id}/complete")
async def file_manager_upload_complete(request: Request, upload_id: str):
    """校验分片完整并合并为目标文件。"""
    return JSONResponse(await run_in_threadpool(complete_chunked_upload, upload_id, request))


@app.delete("/api/file-manager/uploads/{upload_id}")
async def file_manager_upload_abort(request: Request, upload_id: str, reason: str = Query("", max_length=200)):
    """取消分片上传并删除临时文件。"""
    return JSONResponse(await run_in_threadpool(abort_chunked_upload, upload_id, request, reason))


@app.get("/api/ocr/records")
async def get_ocr_records(request: Request):
    """读取当前用户的 OCR 识别记录。"""
    username = ocr_records.request_username(request)
    return JSONResponse({"records": await run_in_threadpool(ocr_records.list_records, username)})


@app.post("/api/ocr/records")
async def create_ocr_record(
    request: Request,
    task: str = Query("document", max_length=16),
    fields: str = Query("", max_length=ocr_records.MAX_FIELDS_LENGTH),
    question: str = Query("", max_length=ocr_records.MAX_QUESTION_LENGTH),
):
    """以原始请求体上传图片或 PDF（文件名放在 x-file-name 头），创建记录并在后台识别。"""
    return JSONResponse({"record": await ocr_records.create_record(request, task, fields, question)})


@app.get("/api/ocr/records/{record_id}/text")
async def get_ocr_record_text(request: Request, record_id: str):
    """读取一条已完成记录的识别结果。"""
    username = ocr_records.request_username(request)
    return JSONResponse(await run_in_threadpool(ocr_records.read_text, username, record_id))


@app.get("/api/ocr/records/{record_id}/source")
async def get_ocr_record_source(request: Request, record_id: str):
    """内联返回记录的原始文件，供页面预览。"""
    username = ocr_records.request_username(request)
    path, media_type, filename = await run_in_threadpool(ocr_records.source_path, username, record_id)
    return FileResponse(path, media_type=media_type, filename=filename, content_disposition_type="inline")


@app.patch("/api/ocr/records/{record_id}")
async def rename_ocr_record(request: Request, record_id: str, payload: dict[str, Any] = Body(...)):
    """重命名当前用户的识别记录。"""
    username = ocr_records.request_username(request)
    return JSONResponse({"record": await run_in_threadpool(ocr_records.rename_record, username, record_id, payload.get("name"))})


@app.delete("/api/ocr/records/{record_id}")
async def delete_ocr_record(request: Request, record_id: str):
    """删除已结束的识别记录及其文件。"""
    username = ocr_records.request_username(request)
    return JSONResponse({"record": await run_in_threadpool(ocr_records.delete_record, username, record_id)})


@app.get("/api/file-manager/download")
async def file_manager_download(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """下载普通文件，或将文件夹打包为 ZIP 下载。"""
    return await run_in_threadpool(download_response, root, path)


@app.get("/api/file-manager/resource")
async def file_manager_resource(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """返回受限目录中的原始资源，供 Markdown 内的相对图片与链接引用。"""
    file_path = resolve_file(root, path)
    return FileResponse(file_path, filename=file_path.name, content_disposition_type="inline", headers={"Cache-Control": "no-store"})


@app.get("/api/file-manager/connections")
async def file_manager_connections():
    """返回文件管理可用的连接列表（包含本机与已保存的 SSH 服务器连接）。"""
    return JSONResponse({"connections": await run_in_threadpool(remote_files.list_file_connections)})


@app.get("/api/file-manager/common-directories")
async def file_manager_common_directories():
    """读取已保存的常用目录列表。"""
    return JSONResponse({"directories": await run_in_threadpool(remote_files.get_common_directories)})


@app.put("/api/file-manager/common-directories")
async def update_file_manager_common_directories(payload: dict[str, Any] = Body(...)):
    """保存常用目录列表。"""
    return JSONResponse({"directories": await run_in_threadpool(remote_files.save_common_directories, payload.get("directories"))})


@app.get("/api/file-manager/remote/{connection_id}/directory")
async def file_manager_remote_directory(
    connection_id: str,
    path: str = Query("", max_length=4_096),
):
    """返回远程服务器用户目录内指定路径的直接子项。"""
    return JSONResponse(await run_in_threadpool(remote_files.list_directory, connection_id, path))


@app.get("/api/file-manager/remote/{connection_id}/markdown")
async def file_manager_remote_markdown(
    connection_id: str,
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """读取远程服务器上的单个 Markdown 文档内容。"""
    return JSONResponse(await run_in_threadpool(remote_files.read_markdown, connection_id, path))


@app.get("/api/file-manager/remote/{connection_id}/download")
async def file_manager_remote_download(
    request: Request,
    connection_id: str,
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """经跳板流式下载远程服务器用户目录内的普通文件。"""
    return await run_in_threadpool(
        remote_files.file_response,
        connection_id,
        path,
        request.headers.get("range"),
        inline=False,
    )


@app.get("/api/file-manager/remote/{connection_id}/resource")
async def file_manager_remote_resource(
    request: Request,
    connection_id: str,
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """返回远程服务器中的原始资源（供 Markdown 内联图片等引用）。"""
    return await run_in_threadpool(
        remote_files.file_response,
        connection_id,
        path,
        request.headers.get("range"),
        inline=True,
    )


@app.post("/api/file-manager/remote/{connection_id}/upload")
async def file_manager_remote_upload(
    request: Request,
    connection_id: str,
    path: str = Query("", max_length=4_096),
    overwrite: bool = Query(False),
):
    """以原始请求体上传小文件到远程服务器目录，相对路径放在 x-file-path 头。"""
    file_path = unquote(request.headers.get("x-file-path", ""))
    return JSONResponse(await remote_files.upload_file(connection_id, path, file_path, request, overwrite=overwrite))


@app.post("/api/file-manager/remote/{connection_id}/uploads")
async def file_manager_remote_upload_init(
    request: Request,
    connection_id: str,
    path: str = Query("", max_length=4_096),
    payload: dict[str, Any] = Body(...),
):
    """在远程服务器上创建分片上传会话。"""
    return JSONResponse(await run_in_threadpool(remote_files.init_chunked_upload, connection_id, path, payload, request))


@app.put("/api/file-manager/remote/{connection_id}/uploads/{upload_id}/chunks/{index}")
async def file_manager_remote_upload_chunk(
    request: Request,
    connection_id: str,
    upload_id: str,
    index: int,
):
    """写入远程分片。"""
    return JSONResponse(await remote_files.upload_chunk(upload_id, index, request))


@app.post("/api/file-manager/remote/{connection_id}/uploads/{upload_id}/complete")
async def file_manager_remote_upload_complete(
    request: Request,
    connection_id: str,
    upload_id: str,
):
    """在远程服务器合并分片文件。"""
    return JSONResponse(await run_in_threadpool(remote_files.complete_chunked_upload, upload_id, request))


@app.delete("/api/file-manager/remote/{connection_id}/uploads/{upload_id}")
async def file_manager_remote_upload_abort(
    request: Request,
    connection_id: str,
    upload_id: str,
    reason: str = Query("", max_length=200),
):
    """取消远程分片上传并清理临时文件。"""
    return JSONResponse(await run_in_threadpool(remote_files.abort_chunked_upload, upload_id, request, reason))


@app.get("/api/chat-lobby/private-chat/contacts")
async def private_contacts(request: Request):
    """读取私聊联系人及未读数。"""
    return await run_in_threadpool(private_chat.contacts, _require_user(request))


@app.get("/api/chat-lobby/private-chat/{contact}/messages")
async def private_messages(contact: str, request: Request, before: int = 0):
    """分页读取当前账号的私聊。"""
    return await run_in_threadpool(private_chat.messages, _require_user(request), contact, before)


@app.post("/api/chat-lobby/private-chat/{contact}/open")
async def private_open(contact: str, request: Request, payload: dict[str, Any] = Body(...)):
    """验证当前能否向该联系人发消息：面对面、自己的工位电脑，或对方近期发来过消息（任意位置可回复）。"""
    owner = _require_user(request)
    peer = await run_in_threadpool(private_chat.peer_for, owner, contact)
    allowed = await run_in_threadpool(private_chat.available, owner, peer, payload.get("source"), payload.get("opening", False))
    return {"allowed": allowed}


@app.post("/api/chat-lobby/private-chat/{contact}/messages")
async def private_send(contact: str, request: Request, payload: dict[str, Any] = Body(...)):
    """私聊落库后定向通知双方。"""
    owner = _require_user(request)
    result = await run_in_threadpool(private_chat.send, owner, contact, payload)
    peer = await run_in_threadpool(private_chat.peer_for, owner, contact)
    lobby_presence.presence.notify_private({owner, peer})
    return result


@app.put("/api/chat-lobby/private-chat/{contact}/read")
async def private_read(contact: str, request: Request, payload: dict[str, Any] = Body(...)):
    """单调更新已读位置。"""
    owner = _require_user(request)
    seq = payload.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        raise HTTPException(400, "已读位置无效")
    await run_in_threadpool(private_chat.read, owner, contact, seq)
    lobby_presence.presence.notify_private({owner})
    return {"ok": True}


@app.get("/api/chat-lobby/profile")
async def chat_lobby_profile(request: Request):
    """读取当前账号在聊天大厅中的名字、像素形象与聊天头像。"""
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return JSONResponse(await run_in_threadpool(lobby_profile.get_profile, username))


@app.put("/api/chat-lobby/profile")
async def chat_lobby_profile_save(request: Request, payload: dict[str, Any] = Body(...)):
    """保存当前账号在聊天大厅中的名字、像素形象与聊天头像（photo 可省略以保留原头像）。"""
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    profile = await run_in_threadpool(lobby_profile.save_profile, username, payload)
    # 在线时通知同场的其他人刷新名字与形象；聊天室资料表随之换代，各窗口拉取新名字与头像
    lobby_presence.presence.update_profile(username, profile)
    await run_in_threadpool(chat_room.bump_profiles_version)
    return JSONResponse(profile)


def _require_user(request: Request) -> str:
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return username


@app.get("/api/chat-lobby/desks")
async def chat_lobby_desks(request: Request):
    """聊天大厅工位归属：已认领工位的显示名字、是否为自己的，以及自己的工位编号。"""
    username = _require_user(request)
    return JSONResponse(await run_in_threadpool(lobby_desks.desk_state, username))


@app.put("/api/chat-lobby/desks/mine")
async def chat_lobby_desk_claim(request: Request, payload: dict[str, Any] = Body(...)):
    """认领工位（已有工位时换到新工位）；工位已被别人认领时返回 409。"""
    username = _require_user(request)
    state = await run_in_threadpool(lobby_desks.claim, username, payload.get("desk"))
    lobby_presence.presence.notify_desks()
    return JSONResponse(state)


@app.delete("/api/chat-lobby/desks/mine")
async def chat_lobby_desk_release(request: Request):
    """退还自己的工位。"""
    username = _require_user(request)
    state = await run_in_threadpool(lobby_desks.release, username)
    lobby_presence.presence.notify_desks()
    return JSONResponse(state)


@app.get("/api/chat-lobby/notes")
async def chat_lobby_notes(request: Request):
    """聊天大厅留言板：全部便签（最新在前）与当前账号能否撕掉别人的便签。"""
    username = _require_user(request)
    return JSONResponse(await run_in_threadpool(lobby_notes.list_notes, username))


@app.post("/api/chat-lobby/notes")
async def chat_lobby_note_post(request: Request, payload: dict[str, Any] = Body(...)):
    """在留言板贴一张便签。"""
    username = _require_user(request)
    note = await run_in_threadpool(lobby_notes.post_note, username, payload)
    lobby_presence.presence.notify_all("notes")
    return JSONResponse(note)


@app.delete("/api/chat-lobby/notes/{note_id}")
async def chat_lobby_note_delete(note_id: str, request: Request):
    """撕掉自己的便签（管理员可撕掉任何一张）。"""
    username = _require_user(request)
    await run_in_threadpool(lobby_notes.delete_note, username, note_id)
    lobby_presence.presence.notify_all("notes")
    return JSONResponse({"ok": True})


@app.get("/api/todos")
async def todo_list(request: Request):
    """当前账号的全部工位待办。"""
    username = _require_user(request)
    return JSONResponse({"todos": await run_in_threadpool(todos.list_todos, username)})


@app.post("/api/todos")
async def todo_create(request: Request, payload: dict[str, Any] = Body(...)):
    """新建待办。"""
    username = _require_user(request)
    return JSONResponse(await run_in_threadpool(todos.create_todo, username, payload))


@app.post("/api/todos/reorder")
async def todo_reorder(request: Request, payload: dict[str, Any] = Body(...)):
    """按给定的待办编号顺序重排。"""
    username = _require_user(request)
    return JSONResponse({"todos": await run_in_threadpool(todos.reorder, username, payload.get("ids"))})


@app.post("/api/todos/clear-completed")
async def todo_clear_completed(request: Request, payload: dict[str, Any] = Body(default={})):
    """删除已完成的待办；可只清理某个清单（list）。"""
    username = _require_user(request)
    list_name = payload.get("list") if isinstance(payload, dict) and isinstance(payload.get("list"), str) else None
    return JSONResponse({"deleted": await run_in_threadpool(todos.clear_completed, username, list_name)})


@app.patch("/api/todos/{todo_id}")
async def todo_update(todo_id: str, request: Request, payload: dict[str, Any] = Body(...)):
    """修改待办的部分字段（标题、备注、清单、优先级、截止日期、今天、完成、子任务、排序）。"""
    username = _require_user(request)
    return JSONResponse(await run_in_threadpool(todos.update_todo, username, todo_id, payload))


@app.delete("/api/todos/{todo_id}")
async def todo_delete(todo_id: str, request: Request):
    """删除待办。"""
    username = _require_user(request)
    await run_in_threadpool(todos.delete_todo, username, todo_id)
    return JSONResponse({"ok": True})


@app.websocket("/api/chat-lobby/ws")
async def chat_lobby_socket(websocket: WebSocket):
    """聊天大厅多人同步通道：上报自己的位置，接收公共房间内其他人的位置、形象与上下线。"""
    username = current_username(websocket.session)
    if not username or not _websocket_origin_allowed(websocket):
        await websocket.close(code=lobby_presence.CLOSE_FORBIDDEN)
        return
    await lobby_presence.presence.serve(websocket, username)


@app.get("/api/point-clouds/file")
async def point_cloud_file(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """兼容旧版点云文件地址，返回受限目录内的原始文件。"""
    file_path = resolve_cloud_file(root, path)
    return FileResponse(file_path, filename=file_path.name, headers={"Cache-Control": "no-store"})


@app.get("/api/auth/status")
async def auth_status(request: Request):
    """查询登录状态和管理员初始化状态。"""
    username = current_username(request.session)
    return JSONResponse(
        {
            "authenticated": bool(username),
            "configured": is_configured(),
            "username": username,
            "terminal": is_terminal_admin(username),
        }
    )


# ---------- 网页终端（仅管理员） ----------

def _require_terminal_admin(session: dict[str, Any]) -> str:
    username = current_username(session)
    if not is_terminal_admin(username):
        raise HTTPException(status_code=403, detail="终端仅对管理员开放")
    return str(username)


def _websocket_origin_allowed(websocket: WebSocket) -> bool:
    """防止跨站 WebSocket 劫持：Origin 必须与 Host 一致，开发模式可额外放行。"""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    host = websocket.headers.get("host", "")
    allowed = {f"http://{host}", f"https://{host}"}
    allowed.update(item.strip() for item in os.environ.get("HANNISHUB_DEV_ORIGINS", "").split(",") if item.strip())
    return origin in allowed


@app.get("/api/terminal/sessions")
async def terminal_list(request: Request):
    _require_terminal_admin(request.session)
    return JSONResponse(await terminal_client.request("GET", "/sessions"))


@app.post("/api/terminal/sessions")
async def terminal_create(request: Request, payload: dict[str, Any] = Body(default_factory=dict)):
    username = _require_terminal_admin(request.session)
    return JSONResponse(await terminal_client.request("POST", "/sessions", {"owner": username, "title": payload.get("title")}))


@app.get("/api/terminal/commands")
async def terminal_command_list(request: Request):
    """列出当前账号保存的终端命令组。"""
    username = _require_terminal_admin(request.session)
    return JSONResponse({"commands": await run_in_threadpool(terminal_commands.list_groups, username)})


@app.post("/api/terminal/commands")
async def terminal_command_create(request: Request, payload: dict[str, Any] = Body(...)):
    """保存一组可一键执行的终端命令。"""
    username = _require_terminal_admin(request.session)
    return JSONResponse({"command": await run_in_threadpool(terminal_commands.create_group, username, payload)})


@app.patch("/api/terminal/commands/{command_id}")
async def terminal_command_update(command_id: str, request: Request, payload: dict[str, Any] = Body(...)):
    """修改自己的终端命令组。"""
    username = _require_terminal_admin(request.session)
    return JSONResponse({"command": await run_in_threadpool(terminal_commands.update_group, username, command_id, payload)})


@app.delete("/api/terminal/commands/{command_id}")
async def terminal_command_delete(command_id: str, request: Request):
    """删除自己的终端命令组。"""
    username = _require_terminal_admin(request.session)
    await run_in_threadpool(terminal_commands.delete_group, username, command_id)
    return JSONResponse({"ok": True})


@app.post("/api/terminal/commands/{command_id}/run")
async def terminal_command_run(command_id: str, request: Request):
    """一键新建终端并按顺序执行已保存命令。"""
    username = _require_terminal_admin(request.session)
    group = await run_in_threadpool(terminal_commands.get_group, username, command_id)
    return JSONResponse(await terminal_client.request("POST", "/run", {"owner": username, "title": group["name"], "commands": group["commands"]}))


@app.patch("/api/terminal/sessions/{session_id}")
async def terminal_rename(session_id: str, request: Request, payload: dict[str, Any] = Body(...)):
    _require_terminal_admin(request.session)
    return JSONResponse(await terminal_client.request("PATCH", f"/sessions/{session_id}", {"title": payload.get("title")}))


@app.delete("/api/terminal/sessions/{session_id}")
async def terminal_delete(session_id: str, request: Request):
    _require_terminal_admin(request.session)
    return JSONResponse(await terminal_client.request("DELETE", f"/sessions/{session_id}"))


@app.websocket("/api/terminal/sessions/{session_id}/ws")
async def terminal_socket(websocket: WebSocket, session_id: str):
    if not is_terminal_admin(current_username(websocket.session)) or not _websocket_origin_allowed(websocket):
        await websocket.close(code=4403)
        return
    await terminal_client.attach(websocket, session_id)


@app.post("/api/auth/login")
async def login(request: Request):
    """管理员登录，成功后写入签名 Cookie 会话。"""
    body = await request.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    client_ip = request.client.host if request.client else ""
    if not is_configured():
        raise HTTPException(status_code=400, detail="请先初始化管理员账号")
    account_key = login_account_key(username[:USERNAME_LIMIT])
    if not is_login_allowed(client_ip) or not is_login_allowed(account_key):
        raise HTTPException(status_code=429, detail="尝试次数过多，请稍后再试")
    if not authenticate(username, password):
        record_login_failure(client_ip)
        record_login_failure(account_key)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    clear_login_failures(client_ip)
    clear_login_failures(account_key)
    login_session(request.session, username)
    return JSONResponse({"ok": True, "username": username})


@app.post("/api/auth/setup")
async def setup(request: Request):
    """首次启动时初始化管理员账号。"""
    if is_configured():
        raise HTTPException(status_code=400, detail="管理员已经初始化")
    body = await request.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    try:
        username = validate_username(username)
        validate_password(password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    configure_admin(username, password)
    login_session(request.session, username)
    return JSONResponse({"ok": True, "username": username})


@app.post("/api/auth/logout")
async def logout(request: Request):
    """退出登录并清空会话。"""
    request.session.clear()
    return JSONResponse({"ok": True})


@app.post("/api/auth/password")
async def update_password(request: Request):
    """当前用户修改自己的密码；成功后刷新本会话，其他设备上的会话失效。"""
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    body = await request.json()
    current_password = str(body.get("current_password") or "")
    new_password = str(body.get("new_password") or "")
    try:
        change_password(username, current_password, new_password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    login_session(request.session, username)
    return JSONResponse({"ok": True})


@app.get("/api/users")
async def users_list(request: Request):
    """列出全部用户（不含密码哈希）。"""
    username = current_username(request.session)
    users = [{**user, "is_self": user["username"] == username} for user in list_users()]
    return JSONResponse({"users": users})


@app.post("/api/users")
async def users_create(payload: dict[str, Any] = Body(...)):
    """新增用户；仅管理员可用。"""
    try:
        user = create_user(str(payload.get("username") or ""), str(payload.get("password") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse(user)


@app.post("/api/users/{username}/password")
async def users_reset_password(username: str, request: Request, payload: dict[str, Any] = Body(...)):
    """重置指定用户密码，该用户已有会话全部失效；重置自己时保持本会话登录。"""
    try:
        set_user_password(username, str(payload.get("password") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if username == request.session.get("user"):
        login_session(request.session, username)
    return JSONResponse({"ok": True})


@app.delete("/api/users/{username}")
async def users_delete(username: str, request: Request):
    """删除用户；不能删除自己或最后一个用户，被删用户的会话立即失效。"""
    try:
        delete_user(username, current_username(request.session) or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # 账号删除后清理其按账号保存的数据，避免以后同名新账号继承旧记录
    await run_in_threadpool(model_manager_app.purge_asr_user, username)
    await run_in_threadpool(ocr_records.purge_user, username)
    await run_in_threadpool(todos.purge_user, username)
    await run_in_threadpool(terminal_commands.purge_user, username)
    await run_in_threadpool(lobby_desks.purge_user, username)
    await run_in_threadpool(lobby_notes.purge_user, username)
    await run_in_threadpool(private_chat.purge_user, username)
    lobby_presence.presence.notify_desks()
    lobby_presence.presence.notify_all("notes")
    return JSONResponse({"ok": True})


# 统一前端页面在挂载的旧子服务之前注册，避免 /server/connections 等路由
# 被 /server 子应用的根挂载抢先匹配。旧页面与 API 继续完整保留。
app.mount("/llama-manager", model_manager_app.app)
app.mount("/server", server_manager_app.app)
app.mount("/prompt", prompt_service_app.app)

# 静态文件挂载必须在全部 API 与子服务之后，防止根路径覆盖业务路由。
if FRONTEND_OUT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_OUT_DIR, html=True), name="frontend")
