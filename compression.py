"""响应压缩：只对长度已知的文本类响应做 gzip，避免影响二进制下载与实时流。

Starlette 自带的 GZipMiddleware 会压缩所有响应，本项目中以下情况不适合压缩：
- 点云、音频、远端下载等二进制文件：压缩收益很小，白白占用 CPU；
- Range 请求与 206 响应：压缩后与请求的字节范围不再对应；
- 推理服务代理等实时流：gzip 会缓冲数据，导致流式输出卡顿。

因此这里只在同时满足以下条件时压缩：
请求声明支持 gzip、不是 Range 请求、状态码不是 206、响应未自带编码、
内容类型属于文本类、并且带有不小于阈值的 Content-Length（真正的流式响应没有长度）。
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# 低于该字节数的响应压缩收益很小
MINIMUM_SIZE = 1024
# 压缩级别 6 在压缩率与 CPU 开销之间取平衡（默认 9 明显更慢，体积只小一点）
COMPRESS_LEVEL = 6

COMPRESSIBLE_PREFIXES = ("text/",)
COMPRESSIBLE_TYPES = {
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/manifest+json",
    "application/xml",
    "image/svg+xml",
}
EXCLUDED_TYPES = {"text/event-stream"}


def is_compressible(status: int, headers: Headers) -> bool:
    """判断一个响应是否应当压缩。"""
    if status == 206 or "content-encoding" in headers or "content-range" in headers:
        return False
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type in EXCLUDED_TYPES:
        return False
    if not (content_type.startswith(COMPRESSIBLE_PREFIXES) or content_type in COMPRESSIBLE_TYPES):
        return False
    try:
        return int(headers.get("content-length", "")) >= MINIMUM_SIZE
    except ValueError:
        # 没有长度的是流式响应，保持原样以免缓冲卡顿
        return False


class _SelectiveGZipResponder(GZipResponder):
    """复用 Starlette 的 gzip 实现，只在响应头确定后决定是否跳过压缩。"""

    async def send_with_compression(self, message: Message) -> None:
        await super().send_with_compression(message)
        if message["type"] == "http.response.start":
            # 父类此时只缓存了响应头尚未发送；标记为排除后会原样透传正文
            if not is_compressible(message.get("status", 200), Headers(raw=message["headers"])):
                self.content_type_is_excluded = True


class SelectiveGZipMiddleware:
    """只压缩长度已知的文本类响应的 gzip 中间件。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if scope.get("method") == "HEAD" or "gzip" not in headers.get("accept-encoding", "") or "range" in headers:
            await self.app(scope, receive, send)
            return
        # minimum_size 置 0：大小判断已由 is_compressible 按 Content-Length 完成
        responder = _SelectiveGZipResponder(self.app, minimum_size=0, compresslevel=COMPRESS_LEVEL)
        await responder(scope, receive, send)
