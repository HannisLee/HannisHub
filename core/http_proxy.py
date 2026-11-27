"""轻量 HTTP/HTTPS 正向代理服务（基于标准库 asyncio，支持 Basic 认证与热启停）。"""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from core.auth import ROOT_DIR, get_settings_section, update_settings_section

SETTINGS_SECTION = "http_proxy"
TLS_DIR = ROOT_DIR / "data" / "http_proxy_tls"
ALLOWED_HOSTS = ("127.0.0.1", "0.0.0.0")
RESERVED_PORTS = frozenset({22, 8081, 18082, 18083})
DEFAULT_PORT = 18088
DEFAULT_USERNAME = "hannishub"
CONNECT_TIMEOUT_SECONDS = 15.0
HEADER_READ_TIMEOUT_SECONDS = 15.0
MAX_HEADER_BYTES = 64 * 1024
COPY_CHUNK_SIZE = 65536


def generate_password() -> str:
    """生成高熵随机代理密码。"""
    return secrets.token_urlsafe(15)


def _default_config() -> dict[str, Any]:
    return {
        "enabled": False,
        "tls_enabled": False,
        "host": "127.0.0.1",
        "port": DEFAULT_PORT,
        "username": DEFAULT_USERNAME,
        "password": generate_password(),
        "public_host": "",
        "public_port": 0,
    }


def normalize_config(raw: Any, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    """清洗并校验配置，确保关键字段类型与范围安全。"""
    base = dict(fallback) if fallback else _default_config()
    if not isinstance(raw, dict):
        return base

    enabled = bool(raw.get("enabled", base["enabled"]))
    tls_enabled = bool(raw.get("tls_enabled", base.get("tls_enabled", False)))
    host = str(raw.get("host", base["host"])).strip()
    if host not in ALLOWED_HOSTS:
        raise ValueError("监听地址仅支持 127.0.0.1 或 0.0.0.0")

    try:
        port = int(raw.get("port", base["port"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("监听端口必须为整数") from exc
    if port < 1024 or port > 65535:
        raise ValueError("监听端口需在 1024 到 65535 之间")
    if port in RESERVED_PORTS:
        raise ValueError(f"端口 {port} 为系统保留端口，请换用其他端口")

    username = str(raw.get("username", base["username"])).strip()
    password = str(raw.get("password", base["password"])).strip()
    if not username or ":" in username or any(c.isspace() for c in username):
        raise ValueError("用户名不能为空，且不能包含冒号或空白字符")
    if len(password) < 8 or any(c.isspace() for c in password):
        raise ValueError("密码至少需要 8 个字符，且不能包含空白字符")

    public_host = str(raw.get("public_host", base.get("public_host", ""))).strip()
    if any(c.isspace() for c in public_host) or len(public_host) > 255:
        raise ValueError("外网地址格式无效")

    raw_public_port = raw.get("public_port", base.get("public_port", 0))
    if raw_public_port in (None, ""):
        public_port = 0
    else:
        try:
            public_port = int(raw_public_port)
        except (TypeError, ValueError) as exc:
            raise ValueError("外网端口必须为整数") from exc
        if public_port != 0 and (public_port < 1 or public_port > 65535):
            raise ValueError("外网端口需在 1 到 65535 之间（留空或填 0 表示未填写）")

    return {
        "enabled": enabled,
        "tls_enabled": tls_enabled,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "public_host": public_host,
        "public_port": public_port,
    }


def _find_openssl() -> str:
    """优先使用当前 Python 环境同目录下的 openssl，再回退到 PATH。"""
    candidate = Path(sys.executable).resolve().parent / "openssl"
    if candidate.is_file():
        return str(candidate)
    found = shutil.which("openssl")
    if found:
        return found
    raise RuntimeError("未找到 openssl 命令，无法生成 TLS 证书")


def _build_san_entries(public_host: str) -> list[str]:
    entries = ["IP:127.0.0.1", "DNS:localhost"]
    cleaned = public_host.strip().strip("[]")
    if cleaned:
        try:
            ipaddress.ip_address(cleaned)
            entry = f"IP:{cleaned}"
        except ValueError:
            entry = f"DNS:{cleaned}"
        if entry not in entries:
            entries.insert(0, entry)
    return entries


def _run_openssl(args: list[str]) -> None:
    cmd = [_find_openssl(), *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"openssl 执行失败：{detail[:240]}")


def ensure_tls_certificates(public_host: str = "") -> tuple[Path, Path, Path, str]:
    """确保自签 CA 与针对 public_host 的服务器证书就绪，返回 (ca_crt, server_crt, server_key, san_text)。"""
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    ca_key = TLS_DIR / "ca.key"
    ca_crt = TLS_DIR / "ca.crt"
    srv_key = TLS_DIR / "server.key"
    srv_crt = TLS_DIR / "server.crt"
    san_file = TLS_DIR / "san.txt"

    if not ca_key.is_file() or not ca_crt.is_file():
        with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as fp:
            fp.write(
                "[req]\n"
                "distinguished_name = dn\n"
                "x509_extensions = v3_ca\n"
                "prompt = no\n"
                "[dn]\n"
                "CN = HannisHub Proxy Root CA\n"
                "O = HannisHub\n"
                "[v3_ca]\n"
                "subjectKeyIdentifier = hash\n"
                "authorityKeyIdentifier = keyid:always,issuer\n"
                "basicConstraints = critical, CA:true\n"
                "keyUsage = critical, digitalSignature, cRLSign, keyCertSign\n"
            )
            ca_cnf = Path(fp.name)
        try:
            _run_openssl([
                "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(ca_key),
                "-out", str(ca_crt),
                "-days", "3650",
                "-sha256",
                "-config", str(ca_cnf),
            ])
            ca_key.chmod(0o600)
        finally:
            ca_cnf.unlink(missing_ok=True)

    san_entries = _build_san_entries(public_host)
    san_text = ", ".join(san_entries)
    existing_san = san_file.read_text(encoding="utf-8").strip() if san_file.is_file() else ""

    if not srv_key.is_file() or not srv_crt.is_file() or existing_san != san_text:
        cn = public_host.strip() or "localhost"
        with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as fp:
            fp.write(
                "[req]\n"
                "distinguished_name = dn\n"
                "prompt = no\n"
                "[dn]\n"
                f"CN = {cn}\n"
                "[v3_ext]\n"
                "basicConstraints = CA:FALSE\n"
                "keyUsage = critical, digitalSignature, keyEncipherment\n"
                "extendedKeyUsage = serverAuth\n"
                f"subjectAltName = {san_text}\n"
            )
            ext_cnf = Path(fp.name)
        csr_path = TLS_DIR / "server.csr"
        try:
            _run_openssl([
                "req", "-new", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(srv_key),
                "-out", str(csr_path),
                "-config", str(ext_cnf),
            ])
            _run_openssl([
                "x509", "-req",
                "-in", str(csr_path),
                "-CA", str(ca_crt),
                "-CAkey", str(ca_key),
                "-CAcreateserial",
                "-out", str(srv_crt),
                "-days", "365",
                "-sha256",
                "-extfile", str(ext_cnf),
                "-extensions", "v3_ext",
            ])
            srv_key.chmod(0o600)
            san_file.write_text(san_text, encoding="utf-8")
        finally:
            ext_cnf.unlink(missing_ok=True)
            csr_path.unlink(missing_ok=True)

    return ca_crt, srv_crt, srv_key, san_text


def get_ca_cert_bytes(public_host: str = "") -> bytes:
    """获取 CA 根证书 PEM 字节，供 Windows 浏览器信任安装。"""
    ca_crt, _, _, _ = ensure_tls_certificates(public_host)
    return ca_crt.read_bytes()


def load_config() -> dict[str, Any]:
    """从根 settings.json 读取代理配置；首次读取时生成并持久化默认配置。"""
    raw = get_settings_section(SETTINGS_SECTION)
    if isinstance(raw, dict):
        try:
            return normalize_config(raw)
        except ValueError:
            pass
    cfg = _default_config()
    update_settings_section(SETTINGS_SECTION, cfg)
    return cfg


def is_forbidden_target(host: str) -> bool:
    """禁止通过正向代理访问本机回环地址，避免绕过本地回环服务隔离。"""
    cleaned = host.strip().lower().strip("[]")
    if not cleaned:
        return True
    if cleaned == "localhost" or cleaned.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(cleaned)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_unspecified


def parse_basic_auth(header_value: str | None) -> tuple[str, str] | None:
    """解析 Proxy-Authorization Basic 凭据。"""
    if not header_value:
        return None
    parts = header_value.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return None
    try:
        decoded = base64.b64decode(parts[1].strip(), validate=True).decode("utf-8")
    except Exception:
        return None
    if ":" not in decoded:
        return None
    user, pwd = decoded.split(":", 1)
    return user, pwd


def _parse_host_port(authority: str, default_port: int) -> tuple[str, int]:
    """解析 host:port 或 [ipv6]:port。"""
    authority = authority.strip()
    if not authority:
        raise ValueError("缺少目标主机")
    if authority.startswith("["):
        end = authority.find("]")
        if end == -1:
            raise ValueError("IPv6 地址缺少闭合括号")
        host = authority[1:end]
        rest = authority[end + 1:]
        if not rest:
            return host, default_port
        if not rest.startswith(":"):
            raise ValueError("目标端口格式无效")
        port = int(rest[1:])
    elif ":" in authority:
        host, port_str = authority.rsplit(":", 1)
        port = int(port_str)
    else:
        host, port = authority, default_port
    if not host or port < 1 or port > 65535:
        raise ValueError("目标主机或端口无效")
    return host, port


@dataclass
class _ProxyMetrics:
    active_connections: int = 0
    total_connections: int = 0
    auth_failures: int = 0
    bytes_up: int = 0
    bytes_down: int = 0


class HttpProxyService:
    """受 HannisHub 管理的异步 HTTP/HTTPS 正向代理服务。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._server: asyncio.AbstractServer | None = None
        self._config: dict[str, Any] | None = None
        self._started_at: str | None = None
        self._last_error: str | None = None
        self._metrics = _ProxyMetrics()
        self._tasks: set[asyncio.Task[None]] = set()

    def _ensure_config(self) -> dict[str, Any]:
        if self._config is None:
            self._config = load_config()
        return self._config

    @property
    def is_running(self) -> bool:
        return self._server is not None and self._server.is_serving()

    @property
    def bound_port(self) -> int | None:
        if not self._server or not self._server.sockets:
            return None
        return int(self._server.sockets[0].getsockname()[1])

    def status_snapshot(self) -> dict[str, Any]:
        cfg = self._ensure_config()
        san_file = TLS_DIR / "san.txt"
        tls_san = san_file.read_text(encoding="utf-8").strip() if san_file.is_file() else ""
        return {
            "config": dict(cfg),
            "running": self.is_running,
            "bound_port": self.bound_port,
            "started_at": self._started_at,
            "last_error": self._last_error,
            "tls_ready": (TLS_DIR / "ca.crt").is_file(),
            "tls_san": tls_san,
            "active_connections": self._metrics.active_connections,
            "total_connections": self._metrics.total_connections,
            "auth_failures": self._metrics.auth_failures,
            "bytes_up": self._metrics.bytes_up,
            "bytes_down": self._metrics.bytes_down,
        }

    async def start_if_enabled(self) -> None:
        """Hub 启动时根据持久化配置决定是否拉起代理监听。"""
        async with self._lock:
            cfg = self._ensure_config()
            if cfg["enabled"]:
                await self._start_unlocked(cfg)

    async def stop(self) -> None:
        """停止代理监听并取消活跃转发任务。"""
        async with self._lock:
            await self._stop_unlocked()

    async def apply_config(self, raw_update: dict[str, Any]) -> dict[str, Any]:
        """更新并持久化配置，按需热重启或停用代理服务。"""
        async with self._lock:
            current = self._ensure_config()
            merged = dict(current)
            merged.update({k: v for k, v in raw_update.items() if v is not None})
            new_cfg = normalize_config(merged, fallback=current)
            need_rebind = (
                not self.is_running
                or new_cfg["host"] != current["host"]
                or new_cfg["port"] != current["port"]
                or new_cfg["tls_enabled"] != current.get("tls_enabled", False)
                or (new_cfg["tls_enabled"] and new_cfg["public_host"] != current.get("public_host", ""))
            )

            self._config = new_cfg
            update_settings_section(SETTINGS_SECTION, new_cfg)

            if not new_cfg["enabled"]:
                await self._stop_unlocked()
                self._last_error = None
            elif need_rebind:
                await self._stop_unlocked()
                await self._start_unlocked(new_cfg)
            else:
                self._last_error = None

            return self.status_snapshot()

    async def rotate_password(self) -> dict[str, Any]:
        """重置随机强密码并立即对新连接生效。"""
        return await self.apply_config({"password": generate_password()})

    async def _start_unlocked(self, cfg: dict[str, Any]) -> None:
        ssl_ctx: ssl.SSLContext | None = None
        if cfg.get("tls_enabled"):
            try:
                _, srv_crt, srv_key, _ = await asyncio.to_thread(
                    ensure_tls_certificates,
                    cfg.get("public_host", ""),
                )
                ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ssl_ctx.load_cert_chain(certfile=str(srv_crt), keyfile=str(srv_key))
            except Exception as exc:
                self._server = None
                self._started_at = None
                self._last_error = f"初始化 TLS 证书失败：{exc}"
                return
        try:
            self._server = await asyncio.start_server(
                self._on_client,
                host=cfg["host"],
                port=cfg["port"],
                reuse_address=True,
                ssl=ssl_ctx,
            )
            self._started_at = datetime.now(timezone.utc).isoformat()
            self._last_error = None
        except OSError as exc:
            self._server = None
            self._started_at = None
            self._last_error = f"无法监听 {cfg['host']}:{cfg['port']}：{exc.strerror or exc}"

    async def _stop_unlocked(self) -> None:
        server = self._server
        self._server = None
        self._started_at = None
        if server is not None:
            server.close()
            with suppress(Exception):
                await server.wait_closed()
        if self._tasks:
            for task in list(self._tasks):
                task.cancel()
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
            self._tasks.clear()

    def _on_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.create_task(self._handle_client(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _verify_auth(self, header_value: str | None) -> bool:
        cfg = self._ensure_config()
        creds = parse_basic_auth(header_value)
        if creds is None:
            return False
        user, pwd = creds
        return hmac.compare_digest(user, cfg["username"]) and hmac.compare_digest(pwd, cfg["password"])

    async def _send_error(
        self,
        writer: asyncio.StreamWriter,
        status: str,
        body: str,
        extra_headers: list[str] | None = None,
    ) -> None:
        payload = body.encode("utf-8")
        lines = [
            f"HTTP/1.1 {status}",
            "Content-Type: text/plain; charset=utf-8",
            f"Content-Length: {len(payload)}",
            "Connection: close",
        ]
        if extra_headers:
            lines.extend(extra_headers)
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + payload
        writer.write(raw)
        with suppress(Exception):
            await writer.drain()

    async def _read_request_head(self, reader: asyncio.StreamReader) -> tuple[bytes, bytes] | None:
        buf = bytearray()
        while b"\r\n\r\n" not in buf:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=HEADER_READ_TIMEOUT_SECONDS)
            if not chunk:
                return None
            buf.extend(chunk)
            if len(buf) > MAX_HEADER_BYTES:
                raise ValueError("请求头过大")
        sep = buf.index(b"\r\n\r\n")
        return bytes(buf[:sep]), bytes(buf[sep + 4:])

    async def _pipe(
        self,
        src: asyncio.StreamReader,
        dst: asyncio.StreamWriter,
        is_upload: bool,
    ) -> None:
        try:
            while True:
                data = await src.read(COPY_CHUNK_SIZE)
                if not data:
                    break
                dst.write(data)
                await dst.drain()
                if is_upload:
                    self._metrics.bytes_up += len(data)
                else:
                    self._metrics.bytes_down += len(data)
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            with suppress(Exception):
                if dst.can_write_eof():
                    dst.write_eof()

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._metrics.active_connections += 1
        self._metrics.total_connections += 1
        remote_writer: asyncio.StreamWriter | None = None
        try:
            parsed_head = await self._read_request_head(reader)
            if parsed_head is None:
                return
            head_bytes, leftover = parsed_head
            lines = head_bytes.decode("latin-1").split("\r\n")
            if not lines or not lines[0]:
                return
            request_parts = lines[0].split()
            if len(request_parts) < 3:
                await self._send_error(writer, "400 Bad Request", "无效的代理请求行")
                return
            method, target, version = request_parts[0], request_parts[1], request_parts[2]

            headers: list[tuple[str, str]] = []
            proxy_auth: str | None = None
            for line in lines[1:]:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                key_clean = k.strip()
                val_clean = v.strip()
                headers.append((key_clean, val_clean))
                if key_clean.lower() == "proxy-authorization":
                    proxy_auth = val_clean

            if not self._verify_auth(proxy_auth):
                self._metrics.auth_failures += 1
                await self._send_error(
                    writer,
                    "407 Proxy Authentication Required",
                    "需要代理认证",
                    extra_headers=['Proxy-Authenticate: Basic realm="HannisHub Proxy"'],
                )
                return

            if method.upper() == "CONNECT":
                try:
                    host, port = _parse_host_port(target, 443)
                except ValueError as exc:
                    await self._send_error(writer, "400 Bad Request", str(exc))
                    return
                if is_forbidden_target(host):
                    await self._send_error(writer, "403 Forbidden", "禁止代理访问本机回环地址")
                    return
                try:
                    remote_reader, remote_writer = await asyncio.wait_for(
                        asyncio.open_connection(host, port),
                        timeout=CONNECT_TIMEOUT_SECONDS,
                    )
                except Exception:
                    await self._send_error(writer, "502 Bad Gateway", "无法连接目标服务器")
                    return

                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
                if leftover:
                    remote_writer.write(leftover)
                    await remote_writer.drain()
                    self._metrics.bytes_up += len(leftover)
                await asyncio.gather(
                    self._pipe(reader, remote_writer, True),
                    self._pipe(remote_reader, writer, False),
                )
                return

            # 普通 HTTP 正向代理请求
            split = urlsplit(target)
            if split.scheme.lower() == "http" and split.netloc:
                authority = split.netloc
                path = split.path or "/"
                if split.query:
                    path = f"{path}?{split.query}"
            else:
                host_header = next((v for k, v in headers if k.lower() == "host"), "")
                authority = host_header
                path = target if target.startswith("/") else "/"

            try:
                host, port = _parse_host_port(authority, 80)
            except ValueError as exc:
                await self._send_error(writer, "400 Bad Request", str(exc))
                return
            if is_forbidden_target(host):
                await self._send_error(writer, "403 Forbidden", "禁止代理访问本机回环地址")
                return

            try:
                remote_reader, remote_writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port),
                    timeout=CONNECT_TIMEOUT_SECONDS,
                )
            except Exception:
                await self._send_error(writer, "502 Bad Gateway", "无法连接目标服务器")
                return

            has_host = False
            out_headers: list[str] = [f"{method} {path} {version}"]
            for k, v in headers:
                lower = k.lower()
                if lower in ("proxy-authorization", "proxy-connection", "connection"):
                    continue
                if lower == "host":
                    has_host = True
                out_headers.append(f"{k}: {v}")
            if not has_host:
                out_headers.append(f"Host: {authority}")
            out_headers.append("Connection: close")
            outbound = ("\r\n".join(out_headers) + "\r\n\r\n").encode("latin-1") + leftover
            remote_writer.write(outbound)
            await remote_writer.drain()
            self._metrics.bytes_up += len(outbound)

            await asyncio.gather(
                self._pipe(reader, remote_writer, True),
                self._pipe(remote_reader, writer, False),
            )
        except (asyncio.TimeoutError, ValueError, ConnectionError, OSError):
            pass
        finally:
            self._metrics.active_connections = max(0, self._metrics.active_connections - 1)
            if remote_writer is not None:
                remote_writer.close()
                with suppress(Exception):
                    await remote_writer.wait_closed()
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()


proxy_service = HttpProxyService()
