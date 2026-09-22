"""LlamaManager Hub：综合管理站入口与登录网关。"""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
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
import llama_manager.app as llama_manager_app
import prompt_service.app as prompt_service_app
import server.app as server_manager_app

ROOT_DIR = Path(__file__).resolve().parent
SERVICES: list[dict[str, str]] = [
    {
        "id": "llama-manager",
        "name": "LlamaManager",
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
        "id": "prompt",
        "name": "在线提示词输入",
        "description": "大输入框快速编辑、复制并归档提示词",
        "path": "/prompt/",
        "icon": "✍️",
    },
]


@asynccontextmanager
async def lifespan(_: FastAPI):
    """由 Hub 统一管理子服务生命周期。"""
    await server_manager_app.start_scheduler()
    yield
    await server_manager_app.stop_scheduler()


app = FastAPI(title="LlamaManager Hub", lifespan=lifespan)

# 先添加 AuthMiddleware，再添加 SessionMiddleware，
# Starlette 会把最后添加的中间件放在最外层，因此 AuthMiddleware 可以读取已解析的会话。
app.add_middleware(AuthMiddleware)
_auth_settings = ensure_auth_settings().get("auth", {})
app.add_middleware(
    SessionMiddleware,
    secret_key=str(_auth_settings.get("session_secret")),
    session_cookie="llamamanager_session",
    max_age=int(_auth_settings.get("session_max_age_seconds", 12 * 60 * 60)),
    same_site="strict",
    https_only=False,
)

app.mount("/llama-manager", llama_manager_app.app)
app.mount("/server", server_manager_app.app)
app.mount("/prompt", prompt_service_app.app)


@app.get("/", include_in_schema=False)
async def index():
    """返回综合管理站服务列表页面。"""
    return FileResponse(ROOT_DIR / "index.html")


@app.get("/login", include_in_schema=False)
async def login_page():
    """返回登录 / 首次初始化页面。"""
    return FileResponse(ROOT_DIR / "login.html")


@app.get("/icon.png", include_in_schema=False)
async def icon():
    """返回综合管理站图标，同时兼容 LlamaManager 子页面引用。"""
    return FileResponse(ROOT_DIR / "llama_manager" / "icon.png", media_type="image/png")


@app.get("/api/health")
async def health():
    """Hub 健康检查。"""
    return JSONResponse({"ok": True, "service": "hub"})


@app.get("/api/services")
async def services():
    """返回当前可用的子服务列表。"""
    return JSONResponse({"services": SERVICES})


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
