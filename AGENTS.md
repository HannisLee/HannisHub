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
- 前端设计：所有新增页面必须严格遵守根目录 `design.md`；使用其中的 CSS Variables、暖黑配色、衬线标题和无阴影卡片规范
- 前端组织：页面放在 `frontend/app/`，通用组件放在 `frontend/components/layout/` 与 `frontend/components/ui/`，业务组件按模块放在对应文件夹，API 客户端放在 `frontend/lib/`
- 旧版 `index.html` 页面在迁移验证期保留，不新增旧版页面功能
- 配置：settings.json 存储所有配置，无数据库
- 语言：代码注释和文档全部使用中文

## 工作流程

**每次对话如果涉及代码修改，必须执行以下步骤：**

1. **更新 version.md**：在文件末尾追加本次修改内容，格式为 `### v版本号 — 日期`，列出具体变更点。版本号规则：每次修改只递增最后一位（如 `0.0.0 → 0.0.1`），中间位和大版本号由用户手动指定时才跃进
2. **本地 git 提交**：`git add . && git commit -m "简短中文描述"`
3. **推送到远程**：`git push origin main`

不得跳过任何步骤。

## 关键约束

- 不要引入数据库、额外前端框架或不必要的大型依赖；统一前端固定使用既有 Next.js 工程
- 不要修改 run.sh 中的端口号（8081）和绑定地址（0.0.0.0），除非用户明确要求
- settings.json 中的路径使用 `~` 时，后端需要 `Path.expanduser()` 展开
- extra_args 必须经过 `_validate_extra_args()` 校验
- 所有新增 API 端点必须在 spec.md 中同步更新
