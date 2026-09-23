"""HannisHub：综合管理站入口与登录网关。"""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from auth import (
    AuthMiddleware,
    authenticate,
    change_password,
    clear_login_failures,
    configure_admin,
    current_username,
    ensure_auth_settings,
    is_configured,
    is_login_allowed,
    record_login_failure,
)
import ai_settings
import llama_manager.app as llama_manager_app
from file_manager import (
    configured_roots,
    list_directory,
    resolve_file,
    save_roots,
    sync_roots,
)
from point_cloud import clear_scan_cache, resolve_cloud_file, scan_datasets
import prompt_service.app as prompt_service_app
import server.app as server_manager_app

ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_OUT_DIR = ROOT_DIR / "frontend" / "out"
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
        "description": "浏览并下载本机 reproduce 目录，同时提供点云预览",
        "path": "/files/",
        "icon": "🗂",
    },
]


@asynccontextmanager
async def lifespan(_: FastAPI):
    """由 Hub 统一管理子服务生命周期。"""
    await server_manager_app.start_scheduler()
    yield
    await server_manager_app.stop_scheduler()


app = FastAPI(title="HannisHub", lifespan=lifespan)

# 先添加 AuthMiddleware，再添加 SessionMiddleware，
# Starlette 会把最后添加的中间件放在最外层，因此 AuthMiddleware 可以读取已解析的会话。
app.add_middleware(AuthMiddleware)
_auth_settings = ensure_auth_settings().get("auth", {})
app.add_middleware(
    SessionMiddleware,
    secret_key=str(_auth_settings.get("session_secret")),
    session_cookie="hannishub_session",
    max_age=int(_auth_settings.get("session_max_age_seconds", 12 * 60 * 60)),
    same_site="strict",
    https_only=False,
)

def _frontend_page(route: str) -> FileResponse | None:
    """返回静态导出的统一前端页面；尚未构建时交由旧页面兼容。"""
    page_path = FRONTEND_OUT_DIR / route.strip("/") / "index.html" if route.strip("/") else FRONTEND_OUT_DIR / "index.html"
    if page_path.is_file():
        return FileResponse(page_path)
    return None


@app.get("/", include_in_schema=False)
async def index():
    """返回综合管理站服务列表页面。"""
    return _frontend_page("") or FileResponse(ROOT_DIR / "index.html")


@app.get("/login", include_in_schema=False)
async def login_page():
    """返回登录 / 首次初始化页面。"""
    return _frontend_page("login") or FileResponse(ROOT_DIR / "login.html")


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


@app.get("/files/point-clouds", include_in_schema=False)
@app.get("/files/point-clouds/", include_in_schema=False)
async def files_point_clouds_page():
    return await _new_frontend_route("files/point-clouds")


@app.get("/point-clouds", include_in_schema=False)
@app.get("/point-clouds/", include_in_schema=False)
async def point_clouds_page():
    return await _new_frontend_route("point-clouds")


@app.get("/icon.png", include_in_schema=False)
async def icon():
    """返回 HannisHub 图标，同时兼容各子页面引用。"""
    return FileResponse(ROOT_DIR / "llama_manager" / "icon.png", media_type="image/png")


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
    """读取 AI 能力配置；密钥只返回是否已配置。"""
    return JSONResponse(ai_settings.get_public_ai_settings())


@app.put("/api/ai-settings")
async def update_ai_settings(payload: dict[str, Any] = Body(...)):
    """保存 AI 能力配置到本地 ai_settings.json。"""
    return JSONResponse(ai_settings.save_ai_settings(payload))


@app.post("/api/ai-settings/test")
async def test_ai_settings_api():
    """使用已保存配置测试 OpenAI 兼容接口。"""
    return await llama_manager_app.test_openai_compatible_api()


@app.get("/api/file-manager/settings")
async def file_manager_settings():
    """返回文件管理组件已暴露的顶层目录。"""
    return JSONResponse({"roots": configured_roots()})


@app.put("/api/file-manager/settings")
async def update_file_manager_settings(payload: dict[str, Any] = Body(...)):
    """保存文件管理顶层目录；目录必须存在且仅允许绝对路径或 ~/。"""
    clear_scan_cache()
    return JSONResponse({"roots": save_roots(payload.get("roots"))})


@app.get("/api/file-manager/directory")
async def file_manager_directory(
    root: int = Query(..., ge=0),
    path: str = Query("", max_length=4_096),
    refresh: bool = Query(False),
):
    """返回受限目录的直接子项；默认使用服务端目录缓存。"""
    return JSONResponse(await run_in_threadpool(list_directory, root, path, refresh=refresh))


@app.get("/api/file-manager/directories")
async def file_manager_directories(
    root: int = Query(..., ge=0),
    refresh: bool = Query(False),
):
    """返回某个顶层目录内的文件夹选项，供点云扫描范围选择。"""
    return JSONResponse(await run_in_threadpool(directory_options, root, refresh=refresh))


@app.post("/api/file-manager/sync")
async def file_manager_sync():
    """清空目录与点云扫描缓存，下一次访问将重新同步磁盘状态。"""
    clear_scan_cache()
    return JSONResponse(await run_in_threadpool(sync_roots))


@app.get("/api/file-manager/download")
async def file_manager_download(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """流式下载受限目录内的普通文件。"""
    file_path = resolve_file(root, path)
    return FileResponse(file_path, filename=file_path.name, headers={"Cache-Control": "no-store"})


@app.get("/api/point-clouds/settings")
async def point_cloud_settings():
    """兼容返回点云查看器可用的文件管理顶层目录。"""
    return JSONResponse({"roots": configured_roots()})


@app.get("/api/point-clouds/datasets")
async def point_cloud_datasets(
    root: int = Query(0, ge=0),
    scope: str = Query("", max_length=4_096),
    refresh: bool = Query(False),
):
    """扫描指定文件夹，并将常见迭代层级归并成实验/结果目录。"""
    return JSONResponse(await run_in_threadpool(scan_datasets, root, scope, refresh=refresh))


@app.get("/api/point-clouds/file")
async def point_cloud_file(
    root: int = Query(..., ge=0),
    path: str = Query(..., min_length=1, max_length=4_096),
):
    """流式返回受限目录内的点云原始文件，供浏览器解析器加载。"""
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
        }
    )


@app.post("/api/auth/login")
async def login(request: Request):
    """管理员登录，成功后写入签名 Cookie 会话。"""
    body = await request.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    client_ip = request.client.host if request.client else ""
    if not is_configured():
        raise HTTPException(status_code=400, detail="请先初始化管理员账号")
    if not is_login_allowed(client_ip):
        raise HTTPException(status_code=429, detail="尝试次数过多，请稍后再试")
    if not authenticate(username, password):
        record_login_failure(client_ip)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    clear_login_failures(client_ip)
    request.session.clear()
    request.session["user"] = username
    return JSONResponse({"ok": True, "username": username})


@app.post("/api/auth/setup")
async def setup(request: Request):
    """首次启动时初始化管理员账号。"""
    if is_configured():
        raise HTTPException(status_code=400, detail="管理员已经初始化")
    body = await request.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not (3 <= len(username) <= 64) or any(char.isspace() for char in username):
        raise HTTPException(status_code=400, detail="用户名需为 3-64 位，且不能包含空白字符")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="密码至少需要 8 位")
    configure_admin(username, password)
    request.session.clear()
    request.session["user"] = username
    return JSONResponse({"ok": True, "username": username})


@app.post("/api/auth/logout")
async def logout(request: Request):
    """退出登录并清空会话。"""
    request.session.clear()
    return JSONResponse({"ok": True})


@app.post("/api/auth/password")
async def update_password(request: Request):
    """修改管理员密码。"""
    username = current_username(request.session)
    if not username:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    body = await request.json()
    current_password = str(body.get("current_password") or "")
    new_password = str(body.get("new_password") or "")
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="新密码至少需要 8 位")
    try:
        change_password(current_password, new_password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"ok": True})


# 统一前端页面在挂载的旧子服务之前注册，避免 /server/connections 等路由
# 被 /server 子应用的根挂载抢先匹配。旧页面与 API 继续完整保留。
app.mount("/llama-manager", llama_manager_app.app)
app.mount("/server", server_manager_app.app)
app.mount("/prompt", prompt_service_app.app)

# 静态文件挂载必须在全部 API 与子服务之后，防止根路径覆盖业务路由。
if FRONTEND_OUT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_OUT_DIR, html=True), name="frontend")
