# LlamaManager Server

独立的 SSH 服务器连接和定时任务管理子项目。它不依赖外层 LlamaManager 的 API、页面或配置，所有运行数据保存在本目录自动生成的 `settings.json` 中。

## 启动

```bash
cd server
pip install -r requirements.txt
bash run.sh
```

单独运行时默认访问地址为 <http://localhost:8082/server>。在外层 LlamaManager 已运行的部署中，`server` 会自动挂载到外层的 `/server` 路由，因此外网直接访问外层地址的 `/server` 即可，例如 `https://models.lihan.online/server`，不需要额外暴露 8082 端口。可以通过 `SERVER_PORT` 修改独立运行端口，例如 `SERVER_PORT=8081 bash run.sh`。

## 功能

- 添加、编辑、删除和测试 SSH 服务器连接；支持指定私钥路径、密码和 SSH Agent。私钥路径留空时自动使用系统默认私钥（如 `~/.ssh/id_ed25519`、`~/.ssh/id_rsa`）或 Agent。
- 密码连接支持「添加公钥」：使用当前密码将项目生成的 Ed25519 公钥写入远端 `~/.ssh/authorized_keys`，验证免密登录成功后自动切换连接状态并清除保存的密码。
- 测试连接时读取远端时间和 IANA 时区，任务按每台服务器的时区计算。
- 创建立刻发射或单次任务，在目标服务器终端执行任意命令；立刻发射任务保存后立即发送，单次任务按指定日期和时间发送一次。
- 定时任务支持 Codex CLI 参数化方式，可分别填写项目目录、`codex`/`codexc`、模型、推理强度、提示词来源和输出日志路径；也保留完整终端命令方式。
- 创建任务时可手动填写远程日志文件路径；任务发送到远端后台后可查看该文件末尾 100 行。
- 查看下一次执行时间和最近发送状态，也可以立即发送任务。

密码只会保存到本地 `settings.json`，API 和页面不会返回原始密码。首次连接未知主机时 Paramiko 会自动接受主机密钥，建议仅在可信网络中使用并限制管理页面访问范围。
