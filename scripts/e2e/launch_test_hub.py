"""测试用 Hub 实例：临时 settings 与临时数据库，关闭 lifespan（不迁移、不拉起服务），只用于浏览器端到端测试。

用法：python scripts/e2e/launch_test_hub.py <临时工作目录> <端口>
会创建测试账号 lihan / guest（密码 e2e-test-pass-123），只监听 127.0.0.1；HUB_ROOT 可指向其他代码目录做新旧对比。
"""
import os, sys
import json
import socket
import subprocess
from pathlib import Path

work = Path(sys.argv[1]); port = int(sys.argv[2])
work.mkdir(parents=True, exist_ok=True)
os.environ["HANNISHUB_DB_PATH"] = str(work / "test.db")
sys.path.insert(0, os.environ.get("HUB_ROOT", str(Path(__file__).resolve().parents[2])))
from core import auth
auth.SETTINGS_PATH = work / "settings.json"
os.environ["HANNISHUB_TERMINAL_SETTINGS_PATH"] = str(auth.SETTINGS_PATH)
if not auth.SETTINGS_PATH.exists():
    auth.configure_admin("lihan", "e2e-test-pass-123")
    auth.create_user("guest", "e2e-test-pass-123")
from chatworld import lobby_profile
lobby_profile.PROFILES_PATH = work / "profiles.json"
terminal_process = None
if os.environ.get("HANNISHUB_TEST_EXTERNAL_TERMINAL") != "1":
    # 测试后台使用随机端口和同一临时配置，不接触线上终端。
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        terminal_port = sock.getsockname()[1]
    config = json.loads(auth.SETTINGS_PATH.read_text())
    config.setdefault("terminal", {})["backend_port"] = terminal_port
    auth.SETTINGS_PATH.write_text(json.dumps(config))
    terminal_process = subprocess.Popen([sys.executable, "-m", "server.terminal_service"], cwd=Path(__file__).resolve().parents[2])
import app as hub
import uvicorn
try:
    uvicorn.run(hub.app, host="127.0.0.1", port=port, lifespan="off", log_level="warning")
finally:
    if terminal_process is not None:
        terminal_process.terminate()
        try:
            terminal_process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            terminal_process.kill()
            terminal_process.wait()
