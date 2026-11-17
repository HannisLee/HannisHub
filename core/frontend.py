"""统一前端的版本切换与静态资源兼容。"""

from pathlib import Path

from starlette.datastructures import MutableHeaders
from starlette.staticfiles import StaticFiles


class FrontendStaticFiles(StaticFiles):
    """优先读取当前构建，更新期间及旧标签页缺失的资源从保留区读取。"""

    def __init__(self, current: Path, retained: Path):
        retained.mkdir(parents=True, exist_ok=True)
        super().__init__(directory=retained)
        self.current = StaticFiles(directory=current, check_dir=False)

    def lookup_path(self, path):
        full_path, stat_result = self.current.lookup_path(path)
        if stat_result is not None:
            return full_path, stat_result
        return super().lookup_path(path)


class FrontendCacheMiddleware:
    """页面与导航数据不可跨构建缓存，带哈希的脚本和样式继续正常缓存。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)

        async def send_response(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                path = scope.get("path", "")
                if headers.get("content-type", "").startswith("text/html") or (
                    message["status"] == 304 and (not Path(path).suffix or path.endswith(".html"))
                ) or (
                    path.endswith(".txt") and Path(path).name.startswith(("index.", "__next."))
                ):
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_response)
