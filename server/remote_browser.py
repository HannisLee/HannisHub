"""把管理员页面和画面流转发给本机独立的 Chrome 容器。"""

import asyncio
from contextlib import suppress
from urllib.parse import quote, urljoin, urlsplit

import httpx
from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from core.auth import get_settings_section

PREFIX = "/browser/session/"
REQUEST_HEADERS = {"accept", "accept-encoding", "accept-language", "range"}
RESPONSE_HEADERS = {
    "accept-ranges", "content-disposition", "content-encoding", "content-length",
    "content-range", "content-security-policy", "content-type", "cross-origin-embedder-policy",
    "cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy",
    "x-content-type-options", "x-frame-options",
}


def _upstream(connection: Request | WebSocket, scheme: str) -> str:
    settings = get_settings_section("remote_browser")
    port = settings.get("backend_port", 18083) if isinstance(settings, dict) else 18083
    if type(port) is not int or not 1 <= port <= 65535:
        raise HTTPException(503, "远程浏览器后台端口配置无效")

    path = connection.scope["path"]
    if not path.startswith(PREFIX) or "\\" in path or any(part in {".", ".."} for part in path.split("/")):
        raise HTTPException(404, "远程浏览器资源路径无效")
    query = connection.scope["query_string"].decode("ascii", errors="replace")
    return f"{scheme}://127.0.0.1:{port}{quote(path)}" + (f"?{query}" if query else "")


async def resource(request: Request) -> StreamingResponse:
    url = _upstream(request, "http")
    headers = {name: value for name, value in request.headers.items() if name in REQUEST_HEADERS}
    client = httpx.AsyncClient(timeout=httpx.Timeout(30, connect=3), trust_env=False)
    try:
        upstream = await client.send(client.build_request(request.method, url, headers=headers), stream=True)
    except httpx.HTTPError as error:
        await client.aclose()
        raise HTTPException(503, "远程浏览器暂不可用，请稍后刷新") from error
    except BaseException:
        await client.aclose()
        raise

    result_headers = {name: value for name, value in upstream.headers.items() if name in RESPONSE_HEADERS}
    result_headers["cache-control"] = "no-store"
    result_headers["cross-origin-resource-policy"] = "same-origin"
    result_headers["x-content-type-options"] = "nosniff"
    result_headers["x-frame-options"] = "SAMEORIGIN"
    location = upstream.headers.get("location")
    if location and upstream.is_redirect:
        target = urlsplit(urljoin(url, location))
        if target.netloc != urlsplit(url).netloc or not target.path.startswith(PREFIX):
            await upstream.aclose()
            await client.aclose()
            raise HTTPException(502, "远程浏览器返回了无效跳转")
        result_headers["location"] = target._replace(scheme="", netloc="").geturl()

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, headers=result_headers)


async def stream(websocket: WebSocket) -> None:
    try:
        url = _upstream(websocket, "ws")
    except HTTPException:
        await websocket.close(code=4404)
        return

    tasks = []
    accepted = False
    try:
        subprotocols = websocket.scope.get("subprotocols") or None
        async with connect(url, proxy=None, subprotocols=subprotocols, max_size=16 * 1024 * 1024) as upstream:
            await websocket.accept(subprotocol=upstream.subprotocol)
            accepted = True

            async def to_backend():
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    await upstream.send(message["bytes"] if message.get("bytes") is not None else message["text"])

            async def to_browser():
                while True:
                    message = await upstream.recv()
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            tasks = [asyncio.create_task(to_backend()), asyncio.create_task(to_browser())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except ConnectionClosed as error:
        with suppress(RuntimeError, OSError):
            await websocket.close(code=1000 if error.rcvd and error.rcvd.code == 1000 else 1013)
    except (WebSocketException, OSError, TimeoutError, RuntimeError):
        with suppress(RuntimeError, OSError):
            if not accepted:
                await websocket.accept()
            await websocket.close(code=1013)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
