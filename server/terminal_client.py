"""Hub 到独立终端后台的代理；断开代理连接不会释放 PTY。"""
import asyncio
from contextlib import suppress

import httpx
from fastapi import HTTPException, WebSocket
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from server.terminal_backend import connection


async def request(method: str, path: str, payload: dict | None = None):
    try:
        origin, token = connection()
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            response = await client.request(method, origin + "/internal" + path, json=payload, headers={"Authorization": f"Bearer {token}"})
    except (OSError, ValueError, RuntimeError, httpx.HTTPError) as error:
        raise HTTPException(503, "终端后台暂不可用，请稍后重试；已有任务不会因此关闭") from error
    if response.status_code >= 400:
        if response.status_code in {401, 403}:
            raise HTTPException(503, "终端后台认证失败，请检查服务配置")
        raise HTTPException(response.status_code, response.json().get("detail", "终端后台请求失败"))
    return response.json()


async def attach(websocket: WebSocket, session_id: str):
    # 先接受浏览器连接，后台不可用时使用可重试关闭码。
    await websocket.accept()
    tasks = []
    try:
        origin, token = connection()
        async with connect(origin.replace("http://", "ws://") + f"/internal/sessions/{session_id}/ws", additional_headers={"Authorization": f"Bearer {token}"}, proxy=None, max_size=None) as upstream:
            async def to_backend():
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("text") is not None:
                        await upstream.send(message["text"])

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
        code = error.rcvd.code if error.rcvd else 1013
        with suppress(Exception):
            await websocket.close(code=code if code in {4000, 4404} else 1013)
    except InvalidStatus:
        # 内部鉴权失败或握手故障均可重试，不能误报为会话已丢失。
        code = 1013
        with suppress(Exception):
            await websocket.close(code=code)
    except Exception:
        with suppress(Exception):
            await websocket.close(code=1013)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
