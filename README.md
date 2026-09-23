# HannisHub

HannisHub 是本机模型、远程服务器和提示词资产的统一管理工作台。后端继续使用 FastAPI；前端集中在根目录唯一的 Next.js + React + TypeScript 工程中，并由 FastAPI 在生产环境直接托管静态导出结果。

## 功能

- 单管理员登录、首次初始化、会话和退出管理
- 模型管理：GGUF 与仓库浏览、受管进程、GPU 监控、下载、ASR 转写和设置
- Server：SSH 服务器连接、远端时间、Codex CLI 或终端任务调度
- 提示词工作区：本地暂存、原文/润色编辑、分组归档、复制、恢复和删除
- 文件管理：默认暴露 `~/reproduce`，支持目录浏览、服务端缓存、手动同步、文件下载与点云预览

## 架构

```text
浏览器
  └─ Next.js 静态 Dashboard（frontend/out）
       └─ 同源 API 请求
            └─ FastAPI Hub（8081）
                 ├─ /llama-manager/api
                 ├─ /server/api
                 ├─ /prompt/api
                 └─ /api/file-manager
```

`frontend/` 是唯一的新前端工程：App Router 页面放在 `app/`，共享布局和 UI 放在 `components/`，模型、服务器、提示词等业务组件各自使用独立子目录，API 类型与请求封装放在 `lib/`。所有视觉实现遵守根目录 [`design.md`](design.md)。

## 环境搭建

```bash
conda create -n llama-manager python=3.12 -y
conda activate llama-manager
pip install -r requirements.txt

cd frontend
npm install
```

## 开发模式

终端一启动 FastAPI：

```bash
conda activate llama-manager
bash run.sh
```

终端二启动 Next.js 开发服务：

```bash
cd frontend
npm run dev
```

访问 <http://localhost:3000>。开发服务器会把 `/api/*`、`/llama-manager/api/*`、`/server/api/*`、`/prompt/api/*` 及模型代理请求转发给 `http://127.0.0.1:8081`。如后端地址不同，可在启动前设置 `HANNISHUB_BACKEND_ORIGIN`。

## 生产模式

```bash
cd frontend
npm run build

cd ..
conda activate llama-manager
bash run.sh
```

`npm run build` 会生成 `frontend/out/`。FastAPI 在启动时检测该目录并托管 Dashboard、`/_next/` 资源和所有已导出的页面，因此访问 <http://localhost:8081> 即可同时使用 Web UI 与 API。重新构建后需要重启 FastAPI，以重新挂载静态目录。

## 页面

| 页面 | 地址 | 后端 API 前缀 |
|---|---|---|
| 总览 | `/` | `/api`、各模块只读接口 |
| 模型与仓库 | `/llama/models` | `/llama-manager/api` |
| 受管进程 | `/llama/processes` | `/llama-manager/api` |
| GPU 监控 | `/llama/gpu` | `/llama-manager/api` |
| 下载 | `/llama/downloads` | `/llama-manager/api` |
| ASR | `/llama/asr` | `/llama-manager/api` |
| 模型设置 | `/llama/settings` | `/llama-manager/api` |
| 服务器连接 | `/server/connections` | `/server/api` |
| 远程任务 | `/server/tasks` | `/server/api` |
| 提示词工作区 | `/prompts` | `/prompt/api` |
| 文件浏览 | `/files` | `/api/file-manager` |
| 点云查看器 | `/files/point-clouds` | `/api/file-manager`、`/api/point-clouds` |

## 目录结构

```text
HannisHub/
├── app.py                    # Hub、认证、子服务挂载与前端静态托管
├── auth.py                   # 登录、密码哈希与会话中间件
├── file_manager.py           # 受限文件浏览、目录缓存与下载
├── frontend/                 # 唯一的 Next.js 前端工程
│   ├── app/                  # App Router 页面与全局设计 tokens
│   ├── components/           # layout、ui、llama、server、prompts、file-manager、overview
│   ├── lib/                  # API 客户端、类型、格式化与导航
│   └── public/               # 静态前端资源
├── llama_manager/            # 模型管理 FastAPI 子服务与旧版页面
├── server/                   # SSH/任务 FastAPI 子服务与旧版页面
├── prompt_service/           # 提示词 FastAPI 子服务与旧版页面
├── design.md                 # 强制前端设计规范
├── spec.md                   # 架构文档
└── run.sh                    # 固定监听 0.0.0.0:8081
```

## 配置与安全

- 根目录 `settings.json`：Hub 登录与会话配置，以及默认 `~/reproduce` 的文件管理暴露范围
- `llama_manager/settings.json`：模型管理配置和运行状态
- `server/settings.json`：Server 配置
- `prompt_service/settings.json`：提示词分组与归档数据
- 所有配置均使用 JSON 文件，不引入数据库
- 管理后台默认绑定 `0.0.0.0:8081`；如通过公网访问，应在前置反向代理启用 HTTPS

## 旧版页面

旧版 `index.html` 暂时保留，便于迁移验证和兼容既有入口：`/llama-manager/`、`/server/`、`/prompt/`。新的日常入口是上表中的统一 Dashboard 路径。
