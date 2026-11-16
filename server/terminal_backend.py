"""独立终端后台的本机连接配置，不写入配置或启动进程。"""
import hashlib
import hmac
import json
import os
from pathlib import Path


def settings_path() -> Path:
    return Path(os.environ.get("HANNISHUB_TERMINAL_SETTINGS_PATH", Path(__file__).resolve().parents[1] / "settings.json")).expanduser()


def connection() -> tuple[str, str]:
    data = json.loads(settings_path().read_text(encoding="utf-8"))
    config = data.get("terminal", {})
    secret = str(data.get("auth", {}).get("session_secret") or "")
    if not secret:
        raise RuntimeError("请先初始化 Hub 登录配置")
    token = hmac.new(secret.encode(), b"hannishub-terminal-backend-v1", hashlib.sha256).hexdigest()
    port = int(config.get("backend_port", 18082))
    if not 1 <= port <= 65535:
        raise ValueError("终端后台端口无效")
    return f"http://127.0.0.1:{port}", token
