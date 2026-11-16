"""独立 PTY 服务：只接收经过服务密钥认证的本机内部请求。"""
import asyncio
import hmac
from contextlib import asynccontextmanager, suppress

from fastapi import Body, FastAPI, HTTPException, WebSocket

from server import terminal_manager
from server.terminal_backend import connection, settings_path

terminal_manager.SETTINGS_PATH = settings_path()


@asynccontextmanager
async def lifespan(app: FastAPI):
    connection()  # 配置缺失时拒绝启动
    reaper = asyncio.create_task(terminal_manager.manager.reaper_loop())
    try:
        yield
    finally:
        reaper.cancel()
        with suppress(asyncio.CancelledError):
            await reaper
        await terminal_manager.manager.shutdown_all()


app = FastAPI(title="HannisHub 独立终端后台", lifespan=lifespan)


class InternalAuth:
    """内部接口也必须认证，避免本机其他网页利用后台执行命令。"""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            headers = dict(scope.get("headers", []))
            expected = f"Bearer {connection()[1]}".encode()
            if not hmac.compare_digest(headers.get(b"authorization", b""), expected):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403})
                else:
                    from fastapi.responses import JSONResponse
                    await JSONResponse({"detail": "内部认证失败"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(InternalAuth)


@app.get("/internal/health")
async def health():
    return {"ok": True}


@app.get("/internal/sessions")
async def sessions():
    return {"sessions": terminal_manager.manager.list(), "idle_timeout_seconds": int(terminal_manager.idle_timeout_seconds())}


@app.post("/internal/sessions")
async def create(payload: dict = Body(...)):
    return {"session": terminal_manager.manager.create(payload["owner"], payload.get("title"))}


@app.post("/internal/run")
async def run(payload: dict = Body(...)):
    return {"session": terminal_manager.manager.run(payload["owner"], payload["title"], payload["commands"])}


@app.patch("/internal/sessions/{session_id}")
async def rename(session_id: str, payload: dict = Body(...)):
    return {"session": terminal_manager.manager.rename(session_id, payload.get("title"))}


@app.delete("/internal/sessions/{session_id}")
async def close(session_id: str):
    if not await terminal_manager.manager.close(session_id, reason="closed"):
        raise HTTPException(404, "终端不存在或已释放")
    return {"ok": True}


@app.websocket("/internal/sessions/{session_id}/ws")
async def attach(websocket: WebSocket, session_id: str):
    if session_id not in terminal_manager.manager.sessions:
        await websocket.accept()
        await websocket.close(code=4404)
        return
    await terminal_manager.manager.attach(session_id, websocket)


if __name__ == "__main__":
    import uvicorn
    from urllib.parse import urlsplit
    uvicorn.run("server.terminal_service:app", host="127.0.0.1", port=urlsplit(connection()[0]).port)
