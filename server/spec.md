# LlamaManager Server 架构说明

## 项目边界

`server/` 是独立运行的 FastAPI 子项目，不依赖外层 LlamaManager 的进程管理、配置或页面。启动后 `/` 重定向到 `/server`，页面使用原生 HTML/CSS/JavaScript，数据只写入本目录的 `settings.json`。

## 连接与远程执行

- 服务器连接保存名称、主机、SSH 端口、用户名、认证方式、私钥路径和可选密码。
- 优先使用 Paramiko；缺少 Paramiko 时，私钥/Agent 使用系统 `ssh`，密码使用系统 `sshpass`。
- 首次遇到未知主机时自动接受主机密钥，管理页面应只在可信网络或受保护的反向代理后使用。
- 测试连接和读取时间会在远端执行 `date`、`timedatectl` 等只读命令，保存远端 Unix 时间、格式化时间和 IANA 时区。密码和私钥内容不会出现在 API 响应中。

## 定时任务

任务是每天、每周或单次三种类型，包含目标连接、服务器本地时间、命令和启用状态。后台调度器每 15 秒检查一次，以连接记录中的时区计算下一次执行时间，并通过 SSH 在远端执行原始命令。执行输出、退出码、状态和时间会持久化，服务重启后继续读取任务。

## API

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/connections` | 获取连接列表，不返回原始密码 |
| POST | `/api/connections` | 新增 SSH 连接 |
| PUT | `/api/connections/{connection_id}` | 修改 SSH 连接 |
| DELETE | `/api/connections/{connection_id}` | 删除连接；仍有关联任务时拒绝 |
| POST | `/api/connections/{connection_id}/test` | 测试 SSH 连接并读取服务器时间/时区 |
| GET | `/api/connections/{connection_id}/time` | 读取并更新服务器时间/时区 |
| GET | `/api/tasks` | 获取定时任务和最近执行结果 |
| POST | `/api/tasks` | 新增每天、每周或单次任务 |
| PUT | `/api/tasks/{task_id}` | 修改定时任务 |
| DELETE | `/api/tasks/{task_id}` | 删除定时任务 |
| POST | `/api/tasks/{task_id}/run` | 立即派发一次任务 |

## 配置结构

`settings.json` 顶层包含 `connections` 和 `tasks` 两个对象。连接中的 `password` 只供后端使用；任务中的 `next_run_at` 统一保存为 UTC ISO 时间，展示和计算时转换为目标服务器时区。
