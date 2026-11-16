# CLAUDE.md — HannisHub 项目指令

## 项目信息

- **项目名**: HannisHub
- **仓库**: https://github.com/HannisLee/HannisHub
- **架构文档**: 参见 [spec.md](spec.md)
- **变更记录**: 参见 [version.md](version.md)
- **环境**: conda 环境 `llama-manager`，Python 3.12
- **后端启动**: `conda activate llama-manager && bash run.sh`（管理后台 `0.0.0.0:8081`）
- **统一前端**: `frontend/`，生产环境执行 `npm run build` 后由 FastAPI 托管 `frontend/out/`

## 代码规范

- 后端：Python + FastAPI，所有 API 返回 JSON
- 前端：根目录唯一的 Next.js + React + TypeScript App Router 工程，位于 `frontend/`
- 前端设计：所有新增网页页面必须严格遵守根目录 `design.md`；使用其中的 CSS Variables、暖黑配色、衬线标题和无阴影卡片规范
- 前端组织：页面放在 `frontend/app/`，通用组件放在 `frontend/components/layout/` 与 `frontend/components/ui/`，业务组件按模块放在对应文件夹，API 客户端放在 `frontend/lib/`
- 旧版 `index.html` 页面（Hub 级位于 `legacy/`）在迁移验证期保留，不新增旧版页面功能
- 配置：settings.json 存储所有配置
- 业务数据：按账号隔离的数据（ASR 转写、OCR 识别、个人偏好）存入 SQLite `data/hannishub.db`，统一经 `core/database.py` 访问；每行带 `owner` 并按当前会话账号过滤，不再按用户分目录；表结构变更只能在 `_MIGRATIONS` 末尾追加
- 语言：代码注释和文档全部使用中文

## 工作流程

**每次对话如果涉及代码修改，必须执行以下步骤：**

1. **更新 version.md**：在文件末尾追加本次修改内容，格式为 `### v版本号 — 日期`，列出具体变更点。版本号规则：每次修改只递增最后一位（如 `0.0.0 → 0.0.1`），中间位和大版本号由用户手动指定时才跃进
2. **本地 git 提交**：`git add . && git commit -m "简短中文描述"`
3. **推送到远程**：`git push origin main`

不得跳过任何步骤。

## 关键约束

- 数据库固定使用 Python 标准库 sqlite3，不要引入其他数据库、ORM、额外前端框架或不必要的大型依赖；统一前端固定使用既有 Next.js 工程
- 测试不得读写线上 `data/`：使用 `HANNISHUB_DB_PATH` 指向临时库，浏览器端到端测试用 `scripts/e2e/launch_test_hub.py` 启动临时测试 Hub，不连接 8081
- 不要修改 run.sh 中的端口号（8081）和绑定地址（0.0.0.0），除非用户明确要求
- settings.json 中的路径使用 `~` 时，后端需要 `Path.expanduser()` 展开
- extra_args 必须经过 `_validate_extra_args()` 校验
- 所有新增 API 端点必须在 spec.md 中同步更新

## 独立终端后台：部署与维护必读

- 网页终端已拆分为独立进程：Hub（`llamamanager.service`，8081）只负责页面、登录鉴权与代理；PTY、运行中的任务和输出缓冲属于 `hannishub-terminal.service`。浏览器入口仍是 HannisHub 的 `/terminal`，不要增加独立对外入口或绕过 Hub 鉴权。
- **普通代码更新、前端构建、游戏功能修改后，只重启 Hub**：`systemctl --user restart llamamanager.service`。不要同时重启、停止或杀掉 `hannishub-terminal.service`，也不要用批量结束 Python / uvicorn 进程的方式部署。Hub 重启仅短暂断连，恢复后自动接回原会话。
- **终端后台自身重启会结束全部终端及其中任务**。只有确实修改了终端后台且需要加载新代码时才安排重启；执行前检查活动会话，若有会话且用户尚未明确允许中断，先说明影响并确认。不得把终端清理逻辑重新放回 Hub 生命周期，不得让两个服务联动重启，不使用多 worker 或自动重载运行 PTY 后台。
- 状态检查：`systemctl --user is-active llamamanager.service hannishub-terminal.service`；后台日志：`journalctl --user -u hannishub-terminal.service -n 50 --no-pager`。后台默认仅监听 `127.0.0.1:18082`，端口配置为根 `settings.json` 的 `terminal.backend_port`；所有内部 HTTP / WebSocket 接口要求专用派生密钥，不打印或向前端暴露密钥。
- 手动启动后台：`conda activate llama-manager && bash scripts/run_terminal.sh`。systemd 模板为 `scripts/systemd/hannishub-terminal.service`；本机已安装并启用，Hub 的用户服务 drop-in 配置了 `Wants` / `After`，无停止或重启绑定。部署到新机器需单独安装并启动后台，`run.sh` 本身只启动 Hub。
- 终端默认 15 小时无操作回收；服务器或终端后台重启后的会话恢复不受保证。提示词浮窗仍依赖 Hub 归档，Hub 重启期间允许短暂归档失败，保留草稿与复制功能；不要为了终端拆分另建提示词存储。
- 回归测试：在 `llama-manager` 环境运行 `python -m unittest tests.test_terminal_restart tests.test_terminal_commands -v`。测试使用临时配置和数据库，不用线上终端做破坏性测试；详细内部接口与部署说明见 `spec.md`「独立终端后台」。
