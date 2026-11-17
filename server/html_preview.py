"""交互 HTML 预览：短期目录票据使无会话的独立沙箱可以读取配套资源。"""

from dataclasses import dataclass
from pathlib import PurePosixPath
import secrets
import stat
import threading
import time
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from core.auth import session_version
from server import file_manager, remote_files

PREFIX = "/api/file-manager/html-preview/"
TICKET_TTL_SECONDS = 4 * 60 * 60
MAX_TICKETS = 512
RESOURCE_EXTENSIONS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".wasm",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".vtt", ".pdf",
}
POLICY = "sandbox allow-scripts; object-src 'none'; form-action 'none'; frame-ancestors 'self'"
# 子页面仅上报退出全屏；父页面还会核对消息来源窗口。
ESCAPE_BRIDGE = (
    b"<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({type:'hannishub-html-escape'},'*')});"
    b"addEventListener('load',function(){requestAnimationFrame(function(){dispatchEvent(new Event('resize'))})})</script>"
)


@dataclass(frozen=True)
class PreviewTicket:
    owner: str
    version: int
    root: int
    connection_id: str
    directory: str
    expires: float


_tickets: dict[str, PreviewTicket] = {}
_lock = threading.Lock()


def issue_ticket(owner: str, root: int, connection_id: str, path: str) -> dict:
    """已登录管理员只能为存在的 HTML 签发所在目录的只读票据。"""
    version = session_version(owner)
    if owner != "lihan" or version is None:
        raise HTTPException(status_code=403, detail="仅管理员可预览服务器文档")
    safe_path = file_manager._normalize_relative_path(path)
    if PurePosixPath(safe_path).suffix.lower() not in {".html", ".htm"}:
        raise HTTPException(status_code=422, detail="只能预览 HTML 文件")
    if connection_id == "local":
        file_manager.resolve_file(root, safe_path)
    else:
        with remote_files.remote_sftp(connection_id) as (sftp, home):
            attr = remote_files._stat_or_none(sftp, remote_files._join(home, safe_path))
            if attr is None or not stat.S_ISREG(attr.st_mode or 0):
                raise HTTPException(status_code=404, detail="HTML 文件不存在")
    directory, _, filename = safe_path.rpartition("/")
    now = time.time()
    token = secrets.token_urlsafe(32)
    with _lock:
        for key in list(_tickets):
            if _tickets[key].expires <= now:
                del _tickets[key]
        if len(_tickets) >= MAX_TICKETS:
            del _tickets[next(iter(_tickets))]
        _tickets[token] = PreviewTicket(owner, version, root, connection_id, directory, now + TICKET_TTL_SECONDS)
    return {"url": f"{PREFIX}{token}/{quote(filename, safe='')}", "expires_at": now + TICKET_TTL_SECONDS}


def resolve_ticket(token: str, path: str) -> tuple[PreviewTicket, str]:
    """票据不授予 Hub 权限，仅允许读取该目录下已校验的相对路径。"""
    with _lock:
        ticket = _tickets.get(token)
    if ticket is None or ticket.expires <= time.time() or session_version(ticket.owner) != ticket.version:
        raise HTTPException(status_code=401, detail="预览已过期，请重新打开文档")
    safe_path = file_manager._normalize_relative_path(path)
    if not safe_path:
        raise HTTPException(status_code=404, detail="缺少资源路径")
    if any(part.startswith(".") for part in safe_path.split("/")) or PurePosixPath(safe_path).suffix.lower() not in RESOURCE_EXTENSIONS:
        raise HTTPException(status_code=403, detail="预览仅允许读取页面及配套静态资源")
    return ticket, f"{ticket.directory}/{safe_path}" if ticket.directory else safe_path


def authorize_scope(scope: dict) -> bool:
    """沙箱因不携带登录 Cookie，仅此 GET 路由接受有效的目录票据。"""
    if scope.get("method") != "GET" or not scope.get("path", "").startswith(PREFIX):
        return False
    suffix = scope.get("path", "")[len(PREFIX):]
    token, separator, path = suffix.partition("/")
    if not separator:
        return False
    try:
        resolve_ticket(token, path)
        return True
    except HTTPException:
        return False


def resource_response(token: str, path: str, range_header: str | None):
    """复用原资源读取与路径边界，HTML 额外附加 Esc 消息桥。"""
    ticket, full_path = resolve_ticket(token, path)
    is_html = PurePosixPath(full_path).suffix.lower() in {".html", ".htm"}
    if ticket.connection_id == "local":
        file = file_manager.resolve_file(ticket.root, full_path)
        if is_html:
            def body():
                with file.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        yield chunk
                yield ESCAPE_BRIDGE
            response = StreamingResponse(body(), media_type="text/html")
        else:
            response = FileResponse(file)
    else:
        response = remote_files.file_response(ticket.connection_id, full_path, None if is_html else range_header, inline=True)
        if is_html:
            original = response.body_iterator

            async def body():
                async for chunk in original:
                    yield chunk
                yield ESCAPE_BRIDGE
            headers = dict(response.headers)
            headers.pop("content-length", None)
            headers.pop("accept-ranges", None)
            response = StreamingResponse(body(), media_type="text/html", headers=headers)
    response.headers.update({
        "Content-Security-Policy": POLICY,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
    })
    return response
