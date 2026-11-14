"""测试用 Hub 实例：临时 settings 与临时数据库，关闭 lifespan（不迁移、不拉起服务），只用于浏览器端到端测试。

用法：python scripts/e2e/launch_test_hub.py <临时工作目录> <端口>
会创建测试账号 lihan / guest（密码 e2e-test-pass-123），只监听 127.0.0.1；HUB_ROOT 可指向其他代码目录做新旧对比。
"""
import os, sys
from pathlib import Path

work = Path(sys.argv[1]); port = int(sys.argv[2])
work.mkdir(parents=True, exist_ok=True)
os.environ["HANNISHUB_DB_PATH"] = str(work / "test.db")
sys.path.insert(0, os.environ.get("HUB_ROOT", str(Path(__file__).resolve().parents[2])))
from core import auth
auth.SETTINGS_PATH = work / "settings.json"
if not auth.SETTINGS_PATH.exists():
    auth.configure_admin("lihan", "e2e-test-pass-123")
    auth.create_user("guest", "e2e-test-pass-123")
import app as hub
import uvicorn
uvicorn.run(hub.app, host="127.0.0.1", port=port, lifespan="off", log_level="warning")
