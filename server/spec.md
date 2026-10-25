# HannisHub Server 架构说明

## 项目边界

`server/` 是可独立运行、也可挂载到外层 HannisHub 的 FastAPI 子项目，不依赖外层的进程管理或配置。挂载后统一 Dashboard 通过 `/server/connections` 与 `/server/tasks` 提供页面，并使用 `/server/api` 接口；单独启动时也兼容 `/server` 地址。原生 `index.html` 继续保留用于兼容，连接与任务配置写入本目录的 `settings.json`，远端文件下载缓存与任务状态写入 `data/remote-downloads/`。

## 连接与远程执行

- 服务器连接保存名称、主机、SSH 端口、用户名、认证方式、可选私钥路径和可选密码；私钥路径留空时使用 Paramiko/OpenSSH 默认私钥搜索规则。
- 优先使用 Paramiko；缺少 Paramiko 时，私钥/Agent 使用系统 `ssh`，密码使用系统 `sshpass`。
- 首次遇到未知主机时自动接受主机密钥，管理页面应只在可信网络或受保护的反向代理后使用。
- 测试连接和读取时间会在远端执行 `date`、`timedatectl` 等只读命令，保存远端 Unix 时间、格式化时间和 IANA 时区。密码和私钥内容不会出现在 API 响应中。

## 远端文件浏览与下载

- 文件浏览和下载复用已保存的服务器连接，优先通过 Paramiko SFTP 读取目录与文件元信息；缺少 Paramiko 时降级为固定参数 `ssh` + `find/stat/cat`，远端路径均经过 Shell 引用。空路径表示 SSH 登录用户主目录。
- 远端目录单次最多返回 1,000 个直接子项；软链接会标记，并按目标类型判断是否可进入或下载。
- 下载分为两段：Hub 先通过内网 SSH 把远端普通文件拉取到 `data/remote-downloads/<job_id>/payload`，浏览器再从 Hub 下载该缓存文件。拉取任务串行执行，状态写入同目录 `job.json`，服务重启后未完成任务会重新排队，已完成任务在缓存文件存在时可继续下载。
- 单个远端文件上限 4 GB；同一连接同一文件的未完成任务会去重。页面显示字节数、百分比、速度、失败原因，并允许删除已完成、失败或取消任务的 Hub 缓存。

## 定时任务

新增任务目前提供“立刻发射”和“单次”两种类型，包含目标连接、服务器本地时间、执行日期、命令、手动指定的远程日志路径和启用状态。任务支持“Codex CLI 参数化”和“完整终端命令”两种执行方式；参数化方式保存项目目录、执行端（`codex`/`codexc`）、模型、推理强度、直接输入或文件路径提示词、输出日志路径，并自动生成对应的完整终端命令，输出日志路径同时作为任务日志路径。完整终端方式保留用户输入的命令和手动日志路径，兼容已有任务。立刻发射任务保存后立即通过 SSH 派发一次，不进入后续调度；单次任务按目标服务器时区的指定日期和时间派发一次。页面选择服务器后会读取远端当前时间，自动填充服务器时区下的日期和执行时间。后台调度器每 15 秒检查一次，以连接记录中的时区计算下一次执行时间，并通过 SSH 将原始命令以后台进程形式发送到远端；SSH 返回发送确认后立即记录为“已成功发送”，不等待命令实际完成。命令中的空行和反斜杠续行原样保留。任务执行结果通过手动指定的远程日志文件查看，页面默认读取文件末尾 100 行；发送状态、发送返回码和时间会持久化，服务重启后继续读取任务。服务端仍兼容配置中已有的每天/每周任务，但页面不再提供新增入口。

## API

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/connections` | 获取连接列表，不返回原始密码 |
| POST | `/api/connections` | 新增 SSH 连接 |
| PUT | `/api/connections/{connection_id}` | 修改 SSH 连接 |
| DELETE | `/api/connections/{connection_id}` | 删除连接；仍有关联任务时拒绝 |
| POST | `/api/connections/{connection_id}/test` | 测试 SSH 连接并读取服务器时间/时区 |
| POST | `/api/connections/{connection_id}/install-key` | 使用当前密码安装本机公钥，验证成功后切换为免密连接 |
| GET | `/api/connections/{connection_id}/time` | 读取并更新服务器时间/时区 |
| GET | `/api/files/{connection_id}?path=<remote_path>` | 浏览远端目录，返回直接子项与元信息；优先 SFTP，缺失 Paramiko 时使用固定参数 SSH 命令 |
| POST | `/api/files/{connection_id}/download` | 提交远端普通文件路径，创建 Hub 后台拉取任务 |
| GET | `/api/files/downloads?connection_id=<id>` | 查询远端文件拉取任务列表，可按连接过滤 |
| GET | `/api/files/downloads/{job_id}` | 查询单个拉取任务进度 |
| GET | `/api/files/downloads/{job_id}/content` | 下载已经拉取到 Hub 的缓存文件 |
| DELETE | `/api/files/downloads/{job_id}` | 删除拉取任务及 Hub 缓存文件 |
| GET | `/api/tasks` | 获取定时任务和最近执行结果 |
| POST | `/api/tasks` | 新增立刻发射或单次任务；立刻发射任务保存后立即派发，单次任务按日期和时间派发一次 |
| PUT | `/api/tasks/{task_id}` | 修改定时任务 |
| DELETE | `/api/tasks/{task_id}` | 删除定时任务 |
| POST | `/api/tasks/{task_id}/run` | 立即派发一次任务 |
| GET | `/api/tasks/{task_id}/log` | 读取手动指定的远程日志文件最后 100 行 |

## 配置结构

`settings.json` 顶层包含 `connections` 和 `tasks` 两个对象。连接中的 `password` 只供后端使用；任务中的 `next_run_at` 统一保存为 UTC ISO 时间，展示和计算时转换为目标服务器时区。连接测试更新时区后，关联任务会立即重算 `next_run_at`；调度器还会通过任务的 `scheduled_timezone` 字段检测时区变化。
