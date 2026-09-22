# HannisHub

一个本地综合管理站，当前包含三个子服务：

- **模型管理**：本机模型、GPU、受管进程与 ASR 服务管理
- **Server**：SSH 服务器连接、远端时间与定时任务管理
- **在线提示词输入**：大输入框编辑、复制并归档提示词

## 功能

- 单管理员登录，首次启动自动进入初始化页面
- 服务列表首页，集中进入各个子服务
- 模型管理：
  - 扫描指定目录下的 GGUF 模型文件
  - 从 Hugging Face 下载模型
  - 注册并管理本机服务进程
  - 查看 GPU 状态、历史与进程日志
- Server：
  - 管理 SSH 服务器连接
  - 读取远端时间与时区
  - 创建并调度远端终端命令任务
- 在线提示词输入：
  - 大型提示词输入框，支持一键复制
  - 归档历史提示词，可折叠查看、恢复或删除

## 环境搭建

```bash
conda create -n llama-manager python=3.12 -y
conda activate llama-manager
pip install -r requirements.txt
```

## 启动

```bash
conda activate llama-manager
bash run.sh
```

访问地址：<http://localhost:8081>

首次启动会要求初始化管理员账号；之后使用该账号登录。

## 目录结构

```text
HannisHub/
├── app.py              # Hub 入口，负责登录、会话与子服务挂载
├── auth.py             # 登录、密码哈希与会话中间件
├── index.html          # Hub 服务列表页面
├── login.html          # 登录 / 首次初始化页面
├── llama_manager/      # 模型管理子服务
├── server/             # Server 子服务
├── prompt_service/     # 在线提示词输入子服务
├── requirements.txt    # Python 依赖
└── run.sh              # 启动脚本
```

## 配置

- 根目录 `settings.json`：Hub 登录与会话配置
- `llama_manager/settings.json`：模型管理子服务配置
- `server/settings.json`：Server 子服务配置
- `prompt_service/settings.json`：在线提示词归档数据

所有配置均使用 JSON 文件，不引入数据库。

## 安全提示

- 管理后台默认绑定 `0.0.0.0:8081`，可被同一网络内其他设备访问
- 登录会话使用 HttpOnly Cookie，密码使用 Argon2id 哈希存储
- 登录接口内置简单防暴力破解限制
- 如需公网部署，建议继续在前置反向代理上启用 HTTPS
