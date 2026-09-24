# HannisHub 架构文档

## 项目概述

HannisHub 是一个本地综合管理站。根应用负责统一登录、会话管理、子服务挂载和统一前端静态托管；当前包含模型管理、Server、提示词与文件管理模块。模型管理子服务管理任意本机启动命令、Hugging Face 模型下载、多 GPU 监控、ASR 转写和进程日志；Server 子服务管理 SSH 服务器连接、远端时间与定时任务；文件管理可在受限的本机目录范围内浏览、下载并交互预览点云。日常界面由统一的 Next.js Dashboard 提供。

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Python 3.12 + FastAPI |
| 前端 | Next.js 16 + React 19 + TypeScript，App Router，静态导出 |
| UI 规范 | 根目录 `design.md` 的 CSS Variables、暖黑编辑风格、统一组件 |
| 进程管理 | subprocess + psutil |
| GPU 监控 | nvidia-smi + psutil |
| 模型下载 | huggingface_hub Python API（`hf_hub_download` 单文件 / `snapshot_download` 全量） |
| 配置存储 | 根目录与各子服务分别使用 settings.json（无数据库） |
| 运行环境 | conda 环境 `llama-manager` |

## 项目结构

```
HannisHub/
├── app.py                    # Hub 入口：登录、会话、服务挂载与生命周期
├── auth.py                   # 登录配置、Argon2 密码哈希、会话中间件
├── ai_settings.py            # AI 能力设置：API、密钥与提示词的本地 JSON 配置
├── file_manager.py           # 文件管理组件：受限目录、缓存、浏览与下载
├── point_cloud.py            # 旧版点云文件读取接口兼容层
├── index.html                # Hub 旧版服务列表页，迁移验证期保留
├── login.html                # Hub 旧版登录页，迁移验证期保留
├── frontend/                 # 统一 Next.js Dashboard
│   ├── app/                  # 总览、登录、模型、Server、提示词 App Router 页面
│   ├── components/           # layout、ui 与各业务模块组件
│   ├── lib/                  # API 请求、显式类型、格式化与导航
│   ├── public/               # 前端静态资源
│   └── out/                  # npm run build 生成的静态导出（不入库）
├── settings.json             # Hub 登录与会话配置
├── requirements.txt          # Python 依赖
├── run.sh                    # 启动脚本
├── llama_manager/            # 模型管理子服务
│   ├── app.py                # 子服务 FastAPI 后端
│   ├── index.html            # 子服务旧版 WebUI，迁移验证期保留
│   ├── settings.json         # 子服务配置与运行状态
│   ├── data/                 # ASR 历史与任务数据
│   └── logs/                 # 子服务运行日志
├── server/                   # Server 子服务
│   ├── app.py                # SSH 与定时任务后端
│   ├── index.html            # Server 旧版 WebUI，迁移验证期保留
│   ├── settings.json         # Server 子服务配置
│   └── data/ssh/             # 项目生成的 SSH 私钥
├── prompt_service/           # 在线提示词输入子服务
│   ├── app.py                # 提示词复制与归档后端
│   ├── index.html            # 提示词旧版 WebUI，迁移验证期保留
│   ├── settings.json         # 提示词归档数据（不入库 git）
│   └── run.sh                # 独立启动脚本（默认 8084）
├── spec.md                   # 本文件，架构文档
├── version.md                # 版本变更记录
├── MEMORY.md                 # 项目长期运行与兼容性记忆
├── AGENTS.md / CLAUDE.md     # 项目指令
└── README.md                 # 使用说明
```

## 综合管理站架构（Hub）

根应用 `app.py` 是综合管理站入口，负责：

- 挂载模型管理子服务到 `/llama-manager`
- 挂载 Server 子服务到 `/server`
- 挂载在线提示词输入子服务到 `/prompt`
- 统一拦截未登录请求，保护 Hub 页面、子服务页面和所有子服务 API
- 统一管理 Server 子服务的调度器生命周期
- 提供服务列表、登录、登出和密码修改 API

### Hub 页面

- `/`：统一 Dashboard 总览，展示受管进程、GPU、服务器连接、远程任务与提示词资产
- `/login`：管理员登录页；首次启动且未初始化时切换为管理员初始化表单
- `/llama/models`、`/llama/processes`、`/llama/gpu`、`/llama/downloads`、`/llama/asr`、`/llama/settings`：模型管理模块页面
- `/server/connections`、`/server/tasks`：远程服务器模块页面
- `/prompts`：提示词工作区
- `/settings`：统一 AI 设置模块，配置 OpenAI 兼容 API 与模型；ASR 提炼提示词在 ASR 页面单独配置
- `/files`：文件游览页，浏览已开放目录；点击可预览的点云文件会打开点云预览页
- `/files/point-clouds`：点云预览页，依次展示固定尺寸预览、目录收藏和当前目录；`/point-clouds` 为兼容入口

### 统一前端静态托管

`frontend/next.config.ts` 使用 `output: "export"` 与 `trailingSlash: true`。执行 `cd frontend && npm run build` 后，Next.js 将页面导出到 `frontend/out/`。Hub 启动时如果该目录存在，会在全部 API 与子服务挂载之后通过 `StaticFiles` 挂载根路径，以提供 `/_next/` 资源和其他静态文件；已导出的业务页面则在 `/server`、`/prompt` 等旧子服务挂载之前显式注册，避免被子应用的根路径抢先匹配。

未构建时，`/` 与 `/login` 继续回退到根目录旧页面；新的 Dashboard 子路径会返回构建提示。旧版子服务页面仍可通过 `/llama-manager/`、`/server/`、`/prompt/` 访问。

`AuthMiddleware` 对 `/_next/` 静态资源开放读取，以便未登录用户加载登录页；业务页面和全部业务 API 仍需要有效会话。

## 统一 Dashboard 前端架构（frontend/）

前端使用根目录唯一的 Next.js + React + TypeScript 工程，不为每个子服务建立独立 React 应用。所有界面使用 `app/globals.css` 中从 `design.md` 落地的 CSS tokens：暖黑背景、暖白文字、衬线 display 标题、无阴影低对比边框卡片、浅色主按钮、8px 间距网格和响应式侧栏。

| 目录 | 职责 |
|---|---|
| `frontend/app/` | App Router 页面、全局样式、登录与 404 页面 |
| `frontend/components/layout/` | 会话检查、桌面/移动侧栏、Topbar 与统一 App Shell |
| `frontend/components/ui/` | 按钮、卡片、表单、状态、进度条与细线 SVG 图标 |
| `frontend/components/llama/` | 模型、进程、GPU、下载、ASR、设置页面业务组件 |
| `frontend/components/server/` | SSH 连接与远程任务页面业务组件 |
| `frontend/components/prompts/` | 提示词编辑、分组和归档组件 |
| `frontend/components/settings/` | AI 能力集中设置组件 |
| `frontend/components/overview/` | 跨服务总览组件 |
| `frontend/components/file-manager/` | 文件浏览下载与 Three.js 点云交互预览组件 |
| `frontend/lib/` | 集中 API 客户端、路径常量、显式 TypeScript 类型、格式化与导航 |

API 客户端统一使用同源相对路径并携带 Cookie：Hub 为 `/api`，模型管理为 `/llama-manager/api`，Server 为 `/server/api`，提示词为 `/prompt/api`。开发模式下 `next.config.ts` 将这些路径重写到 `HANNISHUB_BACKEND_ORIGIN`（默认 `http://127.0.0.1:8081`）；生产环境直接由同一个 FastAPI 源站处理。请求返回 `401` 时客户端携带当前路径跳转到 `/login`。

页面复现原有的实时行为：GPU 与进程状态每 5 秒刷新，下载状态每 3 秒刷新且日志每 5 秒刷新，ASR 历史每 3 秒刷新，Server 任务每 15 秒刷新。所有页面均对加载、错误和空数据提供明确状态。

GPU 页面同时绘制 API 返回的真实利用率历史；受管 LLM 的“聊天”入口继续指向兼容保留的 `/llama-manager/chat/{pid}`，ASR 的入口则回到新的 `/llama/asr` 页面，从而在完整聊天迁移前不丢失原有交互能力。

### Hub API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/health` | Hub 健康检查 |
| GET | `/api/services` | 返回当前可用子服务列表 |
| GET | `/api/auth/status` | 查询登录状态与管理员初始化状态 |
| POST | `/api/auth/setup` | 首次启动时初始化管理员账号 |
| POST | `/api/auth/login` | 管理员登录并写入签名 Cookie 会话 |
| POST | `/api/auth/logout` | 退出登录并清空会话 |
| POST | `/api/auth/password` | 修改管理员密码 |
| GET | `/api/ai-settings` | 读取 AI 能力配置；API 密钥只返回是否已配置，不回显明文 |
| PUT | `/api/ai-settings` | 保存 OpenAI 兼容 API 地址、模型与密钥到本地 `ai_settings.json` |
| POST | `/api/ai-settings/test` | 使用已保存配置请求 OpenAI 兼容 API 的 `/models`，测试连接并返回模型列表 |
| POST | `/api/ai-settings/models` | 探查 OpenAI 兼容接口的可用模型列表，供前端模型下拉选择 |
| POST | `/api/ai-settings/model-test` | 使用当前或指定模型发送一次最小对话请求，验证模型可用性 |
| GET | `/api/file-manager/settings` | 读取文件管理组件已暴露的顶层目录；未显式配置时默认仅返回 `~/reproduce` |
| PUT | `/api/file-manager/settings` | 保存顶层目录数组；仅接受存在的绝对路径或以 `~/` 开头的路径，保存后清空缓存 |
| GET | `/api/file-manager/directory?root=<index>&path=<relative_path>&refresh=<bool>` | 返回受限目录的直接子项；默认使用 15 秒服务端缓存，`refresh=true` 强制同步 |
| POST | `/api/file-manager/sync` | 清空目录缓存，下一次访问重新读取磁盘 |
| GET | `/api/file-manager/favorites` | 读取当前仍在已开放顶层目录下的目录收藏 |
| POST | `/api/file-manager/favorites` | 收藏目录，提交 `root` 顶层目录索引、`path` 相对路径和可选 `name`；验证目录存在且不能越界 |
| PATCH | `/api/file-manager/favorites/{favorite_id}` | 修改收藏显示名称，提交 `name`；长度为 1 到 80 个可见字符 |
| DELETE | `/api/file-manager/favorites/{favorite_id}` | 移除目录收藏 |
| GET | `/api/file-manager/download?root=<index>&path=<relative_path>` | 流式下载受限目录内的普通文件；拒绝越界路径 |
| GET | `/api/point-clouds/file?root=<index>&path=<relative_path>` | 兼容旧版点云文件地址；新预览器直接使用文件管理下载接口，仍拒绝越界路径 |

### AI 能力设置

- AI 能力集中在根目录 `ai_settings.py` 与本地 `ai_settings.json` 中管理；配置包含 OpenAI 兼容 API 地址、模型名称、API 密钥和各业务提示词。API 与模型在 `/settings` 统一配置，提示词放在对应业务页面。
- `ai_settings.json` 和写入用的 `ai_settings.json.tmp` 已加入 `.gitignore`，不会进入 GitHub；读取接口永不返回密钥明文，仅返回 `openai_api_key_configured`。
- 首次读取时会从旧版 `llama_manager/settings.json` 无损迁移已存在的 AI 配置；迁移只复制，不删除旧字段，便于回滚。
- `/settings` 提供“测试链接”“探查模型列表”和“测试模型”三类操作；模型输入框关联探查结果下拉，同时允许直接输入自定义模型名。
- ASR 提炼通过同一份配置调用 OpenAI 兼容接口；ASR 提炼提示词的编辑入口位于 `/llama/asr`，但实际仍保存在本地 `ai_settings.json`。后续需要 AI 能力的模块也应复用该模块，而不是各自保存密钥。
- API 地址支持 http/https，模型名与提示词长度有限制；JSON 采用临时文件加原子替换写入，避免半写入损坏。

### 登录与会话

- 管理员用户名与密码哈希保存在根目录 `settings.json.auth`
- 密码使用 `pwdlib[argon2]` 的 Argon2id 哈希
- 会话使用 Starlette `SessionMiddleware` 与 `itsdangerous` 签名 Cookie
- Cookie 名称为 `hannishub_session`，默认有效期 12 小时
- `AuthMiddleware` 统一保护除登录、健康检查和图标以外的请求
- 登录接口内置简单防暴力破解：同一客户端 5 分钟内最多 5 次失败
- 浏览器页面未登录时重定向到 `/login?next=...`，API 请求返回 `401` JSON

### 文件管理组件

- `file_manager.py` 是文件浏览、下载和目录复用的基础模块；顶层目录保存在根目录 `settings.json.file_manager.roots`，未显式配置时默认仅暴露 `~/reproduce`，保存空数组会暂停文件暴露。
- 浏览接口只返回某个受限顶层目录的直接子项，单目录最多返回 1,000 条；文件夹与文件按稳定顺序排列，文件提供独立下载 URL。
- 服务端对目录列表维护 15 秒线程安全缓存。目录缓存同时记录目录 mtime，顶层子项变化时立即失效；`POST /api/file-manager/sync` 会强制清空缓存。
- 下载与浏览都只接收顶层目录索引与相对路径；后端解析真实路径并验证仍位于顶层目录内，阻止 `..` 与符号链接越界读取。当前暂不提供上传能力。
- 目录收藏单独保存在 `settings.json.file_favorites`，最多 100 个；记录顶层目录文本、相对目录、显示名称和 ID。新增时验证目录仍属于已开放顶层目录，重名路径拒绝重复收藏；目录配置被移除时暂不展示对应收藏。

### 点云预览

- 文件管理导航分为“文件游览”和“点云预览”两个入口，两页复用目录浏览组件。文件游览页点击可预览文件会带着顶层目录索引与相对路径进入点云页；点云页不显示页面标题，预览、收藏目录和当前目录自上而下排列。文件条目将名称、大小与时间排在单行。预览直接读取文件管理下载接口，不发起全目录点云扫描；页面不显示文件下载按钮。
- 预览器是独立的 `PointCloudViewer` 组件，复用 Three.js 的 `PLYLoader`、`PCDLoader` 和 `OrbitControls`，支持 0.2 起的点大小调整、文件颜色与主题单色切换、旋转、缩放和平移。
- `PLY`、`PCD`、`XYZ`、`XYZN`、`XYZRGB`、`PTS` 支持直接加载；`LAS`、`LAZ` 暂不支持直接预览。
- 点云页暂时默认打开 `~/reproduce/RadioGS-stage1/output/0921-05-cv3-d4rt-48clip-depth-normal/point_cloud/iteration_40000/point_cloud.ply`；移除页面内的暴露范围编辑窗口，仍由服务端的受限目录配置控制访问。
- 浏览器端在目录缓存有效期内直接复用已读目录；点云文件下载显示进度。预览画布桌面端固定为 720px 高、窄屏固定为 520px 高，并提供大屏按钮；浏览其他目录时保留当前点云，不改变预览高度。
- Gaussian PLY 会读取颜色系数、透明度与尺度；预览默认使用二维画布按点中心绘制小方点，避免大面积涂抹。普通点云使用 WebGL，浏览器不支持 WebGL 或上下文丢失时自动用二维画布显示。

## 模型管理子服务后端架构（llama_manager/app.py）

### 全局状态

后端使用模块级全局变量管理运行时状态，通过 `threading.Lock` 保证线程安全。

**llama-server 进程状态：**

```python
_managed_processes  # {pid: {process, command, model, host, port, gpu_indexes, started_at}}
_managed_process_records # {pid: record}，持久化到 settings.json.managed_processes
_current_process    # 最新存活 subprocess.Popen 实例，兼容旧状态接口
_current_command    # 最新实例启动命令列表
_current_model      # 最新实例模型路径
_current_port       # 最新实例端口
_current_host       # 最新实例绑定地址
_process_lock       # 进程操作互斥锁
```

**GPU 历史状态：**

```python
_gpu_history_lock            # 历史文件读写锁
_last_gpu_sample_ts          # 上次写入采样时间
GPU_SAMPLE_INTERVAL_SECONDS  # 采样最小间隔，当前为 5 秒
```

**下载任务状态：**

```python
_download_tasks  # {task_id: {repo, filename, target_dir, running, done, progress_n, progress_total, log_file}}
_download_lock   # 下载任务状态读写锁
```

### 工具函数

| 函数 | 功能 |
|------|------|
| `_load_settings()` | 读取 settings.json，自动展开 `~` 路径 |
| `_get_asr_extraction_prompt()` | 读取根目录 ai_settings.json 中的 ASR 提炼提示词 |
| `_load_settings_raw()` | 读取 settings.json 原始内容，不展开路径 |
| `_save_settings(data)` | 原子写入 settings.json（先写临时文件再 rename） |
| `_save_settings_state(key, value)` | 保存 settings.json 中的内部状态字段 |
| `_migrate_legacy_state_files()` | 将旧版分散 JSON 状态迁移到 settings.json 并删除旧文件 |
| `_command_tokens(command)` | 校验命令引号并提取 token，用于识别模型名和可选端口 |
| `_load_custom_services()` | 从 settings.json 读取并迁移通用命令服务注册表 |
| `_normalize_custom_service(data)` | 校验并标准化服务名、完整启动命令和 GPU 选择 |
| `_load_managed_process_records_file()` | 从 settings.json 读取受管进程记录 |
| `_save_managed_process_records_file()` | 保存受管进程记录到 settings.json |
| `_restore_managed_process_records()` | 后端重启后按 PID 和进程创建时间恢复仍存活的受管进程 |
| `_collect_gpu_status()` | 调用 nvidia-smi 采集 GPU 与进程信息 |
| `_infer_model_name(cmdline)` | 从进程命令行推断模型名 |
| `_append_gpu_history_sample(gpus, history_hours)` | 将 GPU util 采样写入 settings.json.gpu_history |
| `_history_by_gpu(history_hours)` | 按 GPU index 读取最近 X 小时历史 |
| `_managed_process_snapshot()` | 获取当前存活受管实例快照 |
| `_managed_process_records_snapshot()` | 获取当前运行期已知进程日志记录 |
| `_managed_process_pid_map(managed)` | 将受管父进程及其子进程 PID 映射到受管根 PID |
| `_make_download_tqdm(task_id)` | 创建绑定指定下载任务的 tqdm 类，按任务写入字节进度 |
| `_download_task_snapshot(task)` | 生成下载任务 API 快照 |
| `_stop_process_internal(pid, clear_log)` | 停止指定或全部受管命令服务进程 |

### API 端点

以下路径为 `llama_manager/app.py` 子应用内部路径；通过 Hub 访问时需要在路径前加上 `/llama-manager` 前缀，例如 `/api/settings` 对应 `/llama-manager/api/settings`。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 返回 index.html |
| GET | `/icon.png` | 返回网站图标 |
| GET | `/api/settings` | 读取配置 |
| POST | `/api/settings` | 保存配置 |
| POST | `/api/openai/test` | （兼容入口）使用统一 AI 设置测试 OpenAI 兼容 API |
| GET | `/api/models` | 递归扫描 model_dir 下 .gguf 文件 |
| GET | `/api/model-repositories` | 扫描 model_dir 下全量下载的仓库目录 |
| GET | `/api/custom-services` | 读取已注册的通用命令服务列表 |
| POST | `/api/custom-services` | 注册或更新服务（服务名、服务类型、完整启动命令、GPU 选择） |
| DELETE | `/api/custom-services/{service_id}` | 删除已注册服务 |
| GET | `/api/status` | 当前 llama-server 进程状态 |
| GET | `/api/gpus` | 当前 GPU 状态、每卡 util 历史和受管进程列表 |
| GET | `/api/managed-processes` | 当前运行期已知受管进程和日志记录 |
| GET | `/asr` | 返回固定地址的 ASR 专用音频转写页 |
| GET | `/chat/{pid}` | 返回指定标准 LLM 服务的通用 OpenAI 兼容聊天页 |
| GET | `/api/asr/history` | 返回本地 ASR 历史记录摘要（不含全文） |
| GET | `/api/asr/history/{record_id}/text` | 读取指定本地 ASR 历史的全文 |
| GET | `/api/asr/history/{record_id}/extraction` | 读取指定 ASR 历史已保存的信息提取结果 |
| POST | `/api/asr/history/{record_id}/extraction` | 使用统一 AI 设置中的模型与提示词提取指定转写的关键信息 |
| PATCH | `/api/asr/history/{record_id}` | 修改指定 ASR 历史记录的自定义名称 |
| DELETE | `/api/asr/history/{record_id}` | 删除已结束的 ASR 历史记录及其保存的全文 |
| GET | `/api/asr/extraction-settings` | （兼容入口）读取统一 AI 设置中的 ASR 提炼提示词 |
| PUT | `/api/asr/extraction-settings` | （兼容入口）保存统一 AI 设置中的 ASR 提炼提示词 |
| GET | `/api/asr` | 获取唯一运行中的 ASR 实例信息 |
| POST | `/api/asr/transcriptions` | 上传一个音频，创建历史 item 并在后台队列中转写，立即返回 `202` |
| POST | `/api/start` | 启动已注册服务（model 为 `custom:<id>` 启 vLLM，或 `llama:<id>` 启 llama.cpp） |
| POST | `/api/stop` | 停止指定 PID 或全部受管实例 |
| POST | `/api/restart` | 重启指定 PID 或最新受管实例 |
| GET | `/api/model-params` | （已废弃）旧版按模型记忆参数，现统一由注册服务管理，返回空 |
| GET | `/api/logs?pid=<pid>` | 读取指定受管进程日志；不传 pid 时读取最新受管进程或默认日志 |
| POST | `/api/download` | 新增一个 Hugging Face 下载任务（指定文件名下单个文件，留空全量下载整个仓库；支持 `force_download`） |
| GET | `/api/download/status` | 查询下载任务列表（含每个任务的进度信息和 `target_dir`） |
| GET | `/api/download/logs?task_id=<id>` | 读取指定下载任务日志尾部 100 行；不传时读取最新任务 |
| POST | `/api/download/cancel` | 标记取消指定下载任务（`task_id`） |
| GET/POST/... | `/llama-process/{pid}/{path}` | 反向代理到指定受管 llama-server |
| GET/POST/... | `/llama/{path}` | 反向代理到 llama-server |

### `/api/gpus` 返回结构

```json
{
  "ok": true,
  "error": null,
  "history_hours": 2,
  "managed_processes": [
    {
      "pid": 12345,
      "model_name": "Qwen3-ASR-1.7B.gguf",
      "port": 8083,
      "gpu_indexes": [0],
      "proxy_url": "/llama-process/12345/",
      "gpu": 0,
      "used_mem": 6326
    }
  ],
  "gpus": [
    {
      "index": 0,
      "name": "NVIDIA A100-PCIE-40GB",
      "driver_version": "535.129.03",
      "uuid": "GPU-...",
      "bus_id": "00000000:01:00.0",
      "gpu_util": 0,
      "used_mem": 6339,
      "total_mem": 40960,
      "temperature": 51,
      "process_count": 1,
      "users": ["user"],
      "history": [
        {"timestamp": 1717480000.0, "gpu_util": 20}
      ],
      "processes": [
        {
          "pid": 12345,
          "used_mem": 6326,
          "process_name": "python",
          "username": "user",
          "command": "python ...",
          "model_name": "Qwen3-ASR-1.7B"
        }
      ]
    }
  ]
}
```

### 核心流程

**统一服务管理（注册 + 启动）：**

所有本地模型服务统一在「服务管理」卡片中，先注册后启动。每个服务保存服务类型（`asr` 或 `llm`）、完整终端启动命令及可选的 GPU 选择，配置保存在 `settings.json.custom_services`。

**注册服务：**
1. 注册表单只包含服务名、服务类型（ASR / 标准 LLM）、完整启动命令和 GPU 选择；服务名留空时从 `--model` 等参数推断
2. POST `/api/custom-services` 校验命令引号，保存原始命令与 GPU 索引；若命令含合法 `--port`，仅被动记录该端口以支持 Open 与 Qwen ASR 页面，不作为必填项
3. 注册项 upsert 到 `custom_services`，编辑时复用原 service_id 覆盖
4. 旧 llama.cpp / vLLM 注册项会迁移为完整命令，保留原有服务与 GPU 配置

**启动已注册服务：**
1. POST `/api/start` 只接收 `service_id`，从注册表读取完整命令和 GPU 选择
2. 后端以 `nohup bash -lc <命令>` 创建独立会话；命令以 `conda` 开头时自动解析本机 Conda 绝对路径，`stdout/stderr` 全部重定向到 `logs/services/command-<name>-<port或process>-<timestamp>.log`
3. 勾选 GPU 时，进程环境注入 `CUDA_VISIBLE_DEVICES=<索引列表>`；未勾选则沿用系统可见 GPU
4. 不再自动清理占用端口、不再有增量启动开关，也不要求命令包含端口；端口冲突由服务自身写入日志报告
5. 写入 `_managed_processes[pid]` 和 `settings.json.managed_processes`，记录 `service_id` 与 `process_create_time`，支持后台重启后恢复管理
6. 「已注册服务」列表按 service_id 匹配受管进程：未运行显示「启动」，运行中提供停止/重启；只有命令识别到端口时才显示 Open

**后台重启后的受管进程恢复：**
- 每次启动、停止、状态同步时，后端将受管进程元数据写入 `settings.json.managed_processes`
- 后台服务器重启后首次读取状态/GPU/日志/代理时，加载 `settings.json.managed_processes`
- 仅当记录中的 PID 仍存在且 `process_create_time` 与当前进程匹配时恢复为受管进程，避免 PID 复用导致误识别
- 恢复后的进程使用 `psutil.Process` 句柄，继续支持 Open / Stop / Restart、日志查看和 GPU 子进程归属

**服务日志：**
- 每个受管进程都有独立 `log_file`
- `/api/logs?pid=<pid>` 读取指定进程日志尾部 200 行
- 不传 pid 时读取最新受管进程日志；没有受管进程时回退到 `settings.log_file`

**ASR 专用转写：**
1. 服务注册时明确选择 ASR 或标准 LLM。ASR 服务的 Open 固定跳转到 `/asr`；标准 LLM 服务的 Open 打开 `/chat/{pid}` 通用聊天页
2. 专用页将服务与批量拖放/点击上传区置顶，转写历史放在下方；可一次选择或拖入多个音频，支持 M4S 及所有可被 FFmpeg 解码的常见音视频格式，单文件最多 4 GB。后端不再按扩展名拒绝文件，而是以文件内容交给 FFmpeg 探测
3. 后端自动使用唯一运行中的 ASR 受管实例；未运行时返回 404，存在多个实例时返回 409。音频写入系统临时目录，并由 FFmpeg 解码、静音检测和导出为 FLAC 后再转写；初始单片最长 600 秒，若导出后的 FLAC 超过 16 MB 安全阈值则自动继续切分。未安装 FFmpeg 时会返回安装提示；没有初始化信息的独立 DASH M4S 片段无法单独解码，需提供完整 MP4/M4A 或合并后的媒体文件
4. 后端按顺序向该实例本机地址的 `/v1/audio/transcriptions` 发送 multipart 请求，自动从 `qwen-asr-serve` 命令读取模型路径，兼容 `text` 和 OpenAI `choices` 返回格式并去除 `<asr_text>` 标记；服务端仍返回“文件过大”时会再切分后重试该片段
5. 浏览器通过 XMLHttpRequest 上传，逐文件显示真实的已上传字节数和百分比。服务端为每个上传文件立即创建历史 item，并把上传、排队、FFmpeg 分析、转写、完成或失败状态及对应阶段百分比写入历史索引；页面每 3 秒刷新，因此刷新页面后仍可查看后台任务进度
6. 后台队列默认同时只运行 1 个任务，以避免单卡 vLLM 争抢资源。FFmpeg 静音分析从 `-progress pipe:2` 读取已处理音频时长并显示处理进度；转写阶段按已完成片段数显示进度，同时明确显示当前是在 FFmpeg 转码片段还是等待 ASR 返回
7. 所有临时音频和 FLAC 切片在任务结束后删除；成功转写的全文保存到 `data/asr_history/<记录 ID>.txt`，信息提取结果保存到 `data/asr_history/<记录 ID>.extracted.txt`，元数据保存到 `data/asr_history/records.json`，临时任务目录为 `data/asr_jobs/`，三者均不纳入 Git
8. 专用页以最新上传在前的时间倒序展示可展开 item，列表保存自定义名称、原始文件名、上传时间、时长、片段数、状态、阶段进度和是否已提取；已完成条目可在原文与信息提取结果间切换，并可修改记录名称或删除已结束的记录
9. 历史列表下方提供可保存的信息提取提示词。默认提示词用于去除抖音音频转写的口头禅和冗余内容，保留关键事实、观点、步骤、数字和结论，且禁止编造原文未提供的信息

**下载模型：**
1. 校验仓库名（`owner/repo`）；指定文件名时校验 `.gguf` 结尾，留空则全量下载
2. 每次提交创建独立 `task_id`，允许多个仓库或文件同时下载
3. 计算目标目录：单文件 → `model_dir`；全量 → `model_dir/owner--repo`（`/` 替换为 `--`）
4. 预获取远程文件总大小：单文件用 `model_info()` 取该文件 size，全量用 `repo_info(files_metadata=True)` 求 siblings size 之和
5. 后台线程按分支下载：单文件用 `hf_hub_download()`，全量用 `snapshot_download()`，均传按 `task_id` 绑定的 tqdm 类追踪进度
6. `force_download=False`（默认）时，HF 通过 ETag 校验已有文件，命中缓存则跳过
7. 每个任务日志写入 `logs/downloads/<task_id>.log`
8. 前端轮询 `/api/download/status` 获取任务列表、进度、百分比和 `target_dir`

**停止服务：**
1. 表格行 Stop 传入 PID，只停止对应受管实例，不清空日志
2. 不传 PID 时停止全部受管实例，并清空服务日志文件
3. 停止时递归处理受管父进程及其所有子进程，兼容 `conda run` / vLLM wrapper
4. terminate 进程树 → 等待 3 秒 → kill 仍存活的进程

**GPU 监控：**
1. 调用 `nvidia-smi --query-gpu=index,name,driver_version,uuid,pci.bus_id,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`
2. 调用 `nvidia-smi --query-compute-apps=gpu_uuid,gpu_bus_id,pid,used_memory,process_name --format=csv,noheader,nounits`
3. 进程归属优先按 `gpu_uuid` 映射到 GPU，失败时按 `gpu_bus_id` 映射；仍无法映射的进程行会被忽略
4. GPU 进程 PID 会先通过 `_managed_process_pid_map()` 归属到模型管理模块启动的父服务 PID，兼容 `conda run` / vLLM 启动器由子进程实际占用 GPU 的情况
5. GPU 进程表只保留 `_managed_processes` 中仍存活的服务，系统或其他用户进程不进入前端进程表
6. 同一服务占用多张 GPU 时，GPU index/name 汇总展示，进程显存累加，总显存累加，GPU util/温度取最大值
7. 如果 `nvidia-smi` 暂时没有返回该服务的 compute-apps 行，但启动时选择了 GPU，则用所选 GPU 回填 GPU name/util/total mem/temp，进程显存保持空值
8. 每次 `/api/gpus` 采集时最多每 5 秒写入一条 GPU util 样本到 `settings.json.gpu_history`
9. 按 `settings.json.gpu_history_hours` 返回每张 GPU 最近 X 小时的 `history`，默认 2 小时
10. `nvidia-smi` 不存在、驱动不可用或查询超时时，优先从 `settings.json.gpu_history` 恢复 GPU 列表和波形，返回 `stale: true`
11. 本地历史也为空时，接口返回 JSON：`{"ok": false, "error": "...", "gpus": []}`

**端口冲突处理：**
- 使用 `psutil.net_connections(kind="inet")` 查找 LISTEN 状态连接
- `protected_ports`（默认 `[22]`）中的端口不会被 kill
- PID 1（init）不会被 kill
- terminate → 等待 3 秒 → kill

## 模型管理子服务旧版前端架构（llama_manager/index.html）

以下内容记录迁移前页面的行为。旧文件仍被保留用于兼容与功能对照，不再作为日常入口或新增功能承载位置。

### 页面布局

单页面，暗色主题，max-width 1200px 居中。六个卡片区块纵向排列：

1. **GPU 监控区** — 每张 GPU 的 util 波形图、多 GPU 卡片、受管进程表
2. **服务管理区** — 顶部「已注册服务」列表采用纵向对齐布局：服务名首行，服务类型、GPU、启动命令各占独立标签行；按运行状态显示启动或停止/重启/可选 Open，另可编辑/删除。下方为服务名、服务类型、GPU 选择和完整启动命令的注册表单
3. **服务日志** — 下拉框仅展示当前仍在运行的受管任务，readonly textarea 显示对应实时日志尾部
4. **下载区** — HF 仓库ID、文件名（留空则全量下载整个仓库）、Download 按钮、强制重新下载复选框；可连续新增多个下载任务
5. **下载任务区** — 多任务进度列表、每任务 Cancel/Logs 操作、下载日志任务下拉、Refresh 按钮、readonly textarea
6. **设置区** — 模型下载目录、GPU 历史小时数。OpenAI 兼容 API 地址、模型名称和密钥已迁移到统一前端 `/settings` 与本地 `ai_settings.json`

ASR 服务的 Open 会复用同一个 `index.html`，并固定通过 `/asr` 呈现独立转写页，不加载管理后台的轮询逻辑。标准 LLM 服务的 Open 则进入 `/chat/{pid}`；该通用聊天页采用接近 llama.cpp 原版 WebUI 的沉浸式布局，左侧提供按服务 PID 隔离并保存于浏览器 `localStorage` 的对话管理（新建、切换、重命名、删除），每条消息可单独复制。它优先通过受管服务的反向代理调用 OpenAI 兼容的 `/v1/models` 和 `/v1/chat/completions`，若请求失败或未返回可显示文字则自动回退到 llama.cpp 原生的 `/apply-template` 和 `/completion` 接口，支持模型选择、系统提示词、多轮对话和流式输出，不依赖框架自带 WebUI。ASR 页自动使用唯一运行中的 ASR 实例；顶部为服务与批量拖放/点击上传区，下方为按时间倒序自动刷新的历史记录；轮询仅在记录摘要变化时重绘，且会保留页面及展开文字框的滚动位置。仅在点击已完成条目时显示全文，并支持名称修改。原文和已提取操作右侧提供复制按钮，复制当前显示的文字。历史标题和名称编辑框均支持两行展示，状态徽章固定单行。

GPU 监控区使用 CSS Grid 横向展示 GPU 卡片：
- `Auto`：`repeat(auto-fit, minmax(240px, 1fr))`
- `2 / 3 / 4`：固定每排 GPU 卡片数
- 页面最大宽度限制为 1200px，因此每排最多 4 张 GPU；8 卡服务器显示为 2 排
- 窄屏下自动退化为单列
- 设置保存到 `localStorage.gpu_cards_per_row`

GPU 波形图区位于 GPU 卡片上方：
- 每张 GPU 单独一张 canvas 波形图
- 左侧纵轴固定显示 0 / 50 / 100
- 横轴显示过去 X 小时的起止时间
- X 小时来自 `settings.json.gpu_history_hours`，默认 2
- 当前硬件查询失败时，波形图仍可基于本地历史文件显示，并在页面顶部提示当前状态不可用

GPU 进程表只展示模型管理模块当前运行期启动的受管实例，字段为 GPU、GPU Name、GPU Util、PID、Used Mem、Total Mem、Temp、Model Name、Actions。Model Name 显示注册服务名（display_name，回退 model_name）；Actions 包含 Open、Stop、Restart。

### JavaScript 架构

所有 JS 内联在 `<script>` 标签中，无模块化。

**核心函数：**

| 函数 | 功能 |
|------|------|
| `api(method, path, body)` | 通用 API 调用封装，统一错误处理 |
| `showError(msg)` | 显示顶部错误横幅（5 秒自动消失） |
| `loadSettings()` | 加载配置并填充表单 |
| `detectLlamaCpp()` | 调用 `/api/detect-llama-cpp` 检测环境变量和 PATH，成功时填充 llama-server 路径 |
| `loadModels()` | 扫描 GGUF 模型并填充注册表单下拉框，刷新时保留当前已选模型 |
| `loadVllmRepositories()` | 扫描全量仓库目录并填充 vLLM 注册下拉框 |
| `onVllmRepositoryChange()` | vLLM 仓库目录切换时显示路径并更新命令模板 |
| `onServiceTypeChange()` | 注册表单 llama.cpp / vLLM 类型切换，显隐对应字段集 |
| `loadCustomServices()` | 加载已注册服务列表，刷新注册列表与启动列表 |
| `saveService()` | 按当前类型注册或更新服务（llama / vllm） |
| `editService(id)` | 回填注册表单并切到对应类型 |
| `deleteService(id)` | 删除已注册服务 |
| `resetServiceForm()` | 清空注册表单 |
| `renderRegisteredServices()` | 渲染「已注册服务」列表，按 service_id 匹配运行状态显示 启动/停止/重启/打开，另可编辑/删除 |
| `startRegisteredService(id, kind)` | 启动已注册服务（custom:<id> / llama:<id>） |
| `loadGpuStatus()` | 获取 GPU 状态、波形历史和受管进程列表并更新 UI |
| `drawGpuWaveform()` | 绘制单张 GPU util 波形图 |
| `loadManagedProcesses()` | 刷新受管进程并更新启动列表运行状态与日志选择器 |
| `stopManagedProcess(pid)` | 停止指定受管实例 |
| `restartManagedProcess(pid)` | 重启指定受管实例 |
| `openManagedWebUI(pid)` | ASR 服务打开固定转写页，标准 LLM 服务打开通用聊天页 |
| `initGenericChatPage(pid)` | 初始化标准 LLM 的通用 OpenAI 兼容聊天页 |
| `initAsrPage()` | 初始化固定 ASR 页的批量拖放上传、后台任务状态和历史自动刷新 |
| `loadAsrHistory()` | 加载本地转写历史摘要并渲染可展开列表 |
| `toggleAsrHistoryItem(id)` | 展开或收起一条历史记录，展开时按需读取全文 |
| `saveAsrHistoryName(id)` | 保存历史记录的自定义名称 |
| `startDownload()` | 调用 /api/download 新增下载任务（含 force_download，filename 可留空触发全量下载） |
| `cancelDownload(taskId)` | 调用 /api/download/cancel 标记取消指定任务 |
| `loadDownloadStatus()` | 轮询下载任务列表，更新多任务进度和 UI |
| `loadDownloadLogs()` | 按下载任务下拉读取对应日志 |

**自动刷新：**
- GPU 监控：每 5 秒
- 日志：每 5 秒
- 下载状态：每 3 秒
- 下载完成时自动刷新模型列表

## 配置文件

### 根目录 settings.json

根目录 `settings.json` 保存 Hub 登录与会话配置，以及文件管理组件的受限目录配置：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `auth.username` | string | `""` | 管理员用户名；为空表示尚未初始化 |
| `auth.password_hash` | string | `""` | Argon2id 密码哈希；永不通过 API 返回 |
| `auth.session_secret` | string | 自动生成 | Cookie 会话签名密钥；永不通过 API 返回 |
| `auth.session_max_age_seconds` | number | `43200` | 会话有效期，默认 12 小时 |
| `file_manager.roots` | array | `["~/reproduce"]` | 文件管理组件允许浏览与下载的顶层目录数组；路径保留 `~`，读取时展开 |
| `file_favorites` | array | `[]` | 目录收藏，包含 `id`、`name`、`root_path` 和相对目录 `path` |

### 根目录 ai_settings.json（不入 Git）

该文件由 AI 设置模块维护，包含给其他模块提供 AI 能力的敏感配置；文件本身与 `ai_settings.json.tmp` 均在 `.gitignore` 中：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openai_api_base_url` | string | `""` | OpenAI 兼容 API 基地址，例如 `https://api.openai.com/v1` |
| `openai_api_model` | string | `""` | AI 任务使用的模型名称 |
| `openai_api_key` | string | `""` | OpenAI 兼容 API 密钥；仅后端保存，API 读取时只返回是否已配置 |
| `asr_extraction_prompt` | string | 默认提炼提示词 | ASR 转写提炼使用的 system 提示词 |

### llama_manager/settings.json

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model_dir` | string | `~/models` | GGUF 模型目录（递归扫描） |
| `gpu_history_hours` | number | `2` | GPU util 波形显示的历史小时数 |
| `model_params` | object | `{}` | （已废弃）按模型路径保存的启动参数，启动时迁移为 llama 注册项后清空 |
| `custom_services` | object | `{}` | 用户注册的通用命令服务 |
| `managed_processes` | object | `{"processes":[]}` | 模型管理模块启动过的受管进程记录 |
| `gpu_history` | object | `{"samples":[]}` | GPU util 历史采样 |

### 内部状态结构

`llama_manager/settings.json.model_params`（已废弃，启动时自动迁移为 llama 注册项后清空）曾按模型路径独立存储启动参数：

```json
{
  "/home/lihan/models/Qwen3-ASR-1.7B-Q8_0.gguf": {
    "port": 8083,
    "extra_args": "--jinja -ngl 99"
  }
}
```

`llama_manager/settings.json.custom_services` 保存用户注册的服务，按 `service_type` 区分 llama.cpp 与 vLLM（字段为两类超集，无关项为 null）：

```json
{
  "svc_aaa": {
    "id": "svc_aaa",
    "name": "Qwen3-ASR-1.7B",
    "service_category": "asr",
    "service_type": "llama",
    "model": "/home/lihan/models/Qwen3-ASR-1.7B-Q8_0.gguf",
    "port": 8083,
    "extra_args": "--jinja -ngl 99",
    "gpu_indexes": [],
    "command": null,
    "created_at": 1781070614.24
  },
  "svc_bbb": {
    "id": "svc_bbb",
    "name": "[vLLM]Qwen3-ASR-1.7B",
    "service_category": "asr",
    "service_type": "vllm",
    "model": null,
    "port": 8085,
    "extra_args": null,
    "gpu_indexes": null,
    "command": "conda run -n qwen3-asr qwen-asr-serve /home/lihan/models/Qwen3-ASR-1.7B --host 0.0.0.0 --port 8085",
    "created_at": 1781069153.0
  }
}
```

`llama_manager/settings.json.managed_processes` 保存模型管理模块启动过的受管进程记录：

```json
{
  "processes": [
    {
      "pid": 12345,
      "model": "/home/lihan/models/model.gguf",
      "display_name": "model.gguf",
      "host": "0.0.0.0",
      "port": 8083,
      "command": "llama-server -m /home/lihan/models/model.gguf --host 0.0.0.0 --port 8083",
      "command_tokens": ["llama-server", "-m", "/home/lihan/models/model.gguf", "--host", "0.0.0.0", "--port", "8083"],
      "log_file": "/home/lihan/run/HannisHub/llama_manager/logs/services/llama-model.gguf-8083-20260615-120000.log",
      "process_create_time": 1781496000.0,
      "running": true
    }
  ]
}
```

`llama_manager/settings.json.gpu_history` 保存 GPU util 采样：

```json
{
  "samples": [
    {
      "timestamp": 1717480000.0,
      "gpus": [
        {"index": 0, "name": "NVIDIA A100-PCIE-40GB", "gpu_util": 42}
      ]
    }
  ]
}
```

旧版 `model_params.json`、`last_launch.json`、`custom_services.json`、`managed_processes.json`、`gpu_history.json` 会在应用启动时自动迁移到 `settings.json` 并删除。

此外，旧版按模型路径记忆的 `llama_manager/settings.json.model_params` 会在应用启动时自动迁移为 `custom_services` 中的 llama.cpp 注册项（name 取模型文件名；幂等：同 model 路径已存在则跳过），迁移完成后清空 `model_params`。

## 安全设计

- extra_args 经过 shlex 解析和危险字符过滤（`|><;&`$()#`）
- protected_ports 防止误杀 SSH（端口 22）
- PID 1 永远不会被 kill
- 子服务与 Hub 的 settings.json 均使用原子写入防止损坏
- Hub 使用 Argon2id 保存管理员密码，不保存明文
- Hub 使用 HttpOnly 签名 Cookie 保存会话，`AuthMiddleware` 统一保护页面和 API
- 管理后台绑定 `0.0.0.0:8081`，README 中提醒公网暴露风险

## 独立服务器管理子项目

`server/` 是与本地模型管理页面相互独立的 FastAPI 子项目，提供 `/server` 页面和单独的 `server/settings.json`。它使用 Paramiko（缺少时可降级到系统 `ssh`/`sshpass`）管理 SSH 服务器连接，在测试连接时读取远端时间和 IANA 时区，并按目标服务器时区执行立刻发射或单次任务。定时任务支持 Codex CLI 参数化方式和完整终端命令方式，前者自动生成完整命令并将输出路径绑定到日志读取路径；立刻发射任务保存后立即派发一次，不进入后续调度，单次任务按指定日期和时间派发一次。服务端兼容已有的每天/每周任务配置，但页面不再提供新增入口。新增接口如下：

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/health` | 服务器管理子项目健康检查 |
| GET/POST | `/api/connections` | 查询/新增 SSH 服务器连接 |
| PUT/DELETE | `/api/connections/{connection_id}` | 修改/删除 SSH 服务器连接 |
| POST | `/api/connections/{connection_id}/test` | 测试连接并读取远端时间和时区 |
| POST | `/api/connections/{connection_id}/install-key` | 使用密码连接安装本机公钥，验证成功后切换为免密连接 |
| GET | `/api/connections/{connection_id}/time` | 读取服务器时间 |
| GET/POST | `/api/tasks` | 查询/新增任务；新增任务支持立刻发射或单次周期 |
| PUT/DELETE | `/api/tasks/{task_id}` | 修改/删除定时任务 |
| POST | `/api/tasks/{task_id}/run` | 立即执行一次定时任务 |
| GET | `/api/tasks/{task_id}/log` | 读取任务手动指定的远程日志文件最后 100 行；任务发送确认后不等待远程命令结束 |

外层服务会自动挂载 `server.app`。日常使用统一 Dashboard 的 `/server/connections` 和 `/server/tasks`，页面 API 使用 `/server/api/...`；旧版 `/server/` 页面仍保留用于兼容，不需要另行暴露服务器管理端口。详细字段、调度规则和独立启动方式见 [`server/spec.md`](server/spec.md) 与 [`server/README.md`](server/README.md)。

## 在线提示词输入子服务（prompt_service）

`prompt_service/` 是与模型管理、Server 同级别的轻量 FastAPI 子服务。日常入口由统一 Dashboard 的 `/prompts` 提供，使用 `/prompt/api/...`；它保留浏览器本地草稿、原文/润色编辑、分组归档、复制、恢复和删除。旧版 `/prompt/` 页面仍保留用于兼容。归档内容保存到 `prompt_service/settings.json`，数据结构：

```json
{
  "prompts": [
    {
      "id": "prompt_xxxxxxxxxxxx",
      "content": "提示词全文",
      "created_at": "2026-09-22T00:00:00+00:00",
      "updated_at": "2026-09-22T00:00:00+00:00"
    }
  ]
}
```

以下路径为 `prompt_service/app.py` 子应用内部路径；通过 Hub 访问时需要加上 `/prompt` 前缀，例如 `/api/prompts` 对应 `/prompt/api/prompts`。

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 独立运行时跳转到 `/prompt`；Hub 挂载场景直接返回页面 |
| GET | `/prompt`、`/prompt/` | 返回在线提示词输入页面 |
| GET | `/api/health` | 子服务健康检查 |
| GET | `/api/prompts` | 读取归档提示词列表（按更新时间倒序） |
| POST | `/api/prompts` | 归档新提示词，请求体 `{ "content": string }` |
| PUT | `/api/prompts/{prompt_id}` | 更新指定归档提示词内容 |
| DELETE | `/api/prompts/{prompt_id}` | 删除指定归档提示词 |

服务端限制：提示词最长 200 万字符，最多保留 500 条归档，超出时自动删除最早记录。独立启动方式为进入 `prompt_service/` 后执行 `bash run.sh`，默认监听 `0.0.0.0:8084`；常规部署时由 Hub 挂载到 8081 的 `/prompt` 路径，不需要单独暴露端口。为兼容两种运行方式，后端将同一组 API 同时注册到 `/api` 与 `/prompt/api` 两个前缀。
