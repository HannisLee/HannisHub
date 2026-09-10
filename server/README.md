# LlamaManager Server

独立的 SSH 服务器连接和定时任务管理子项目。它不依赖外层 LlamaManager 的 API、页面或配置，所有运行数据保存在本目录自动生成的 `settings.json` 中。

## 启动

```bash
cd server
pip install -r requirements.txt
bash run.sh
```

默认访问地址为 <http://localhost:8082/server>。可以通过 `SERVER_PORT` 修改端口，例如 `SERVER_PORT=8081 bash run.sh`。

## 功能

- 添加、编辑、删除和测试 SSH 服务器连接；支持私钥路径、密码和 SSH Agent。
- 测试连接时读取远端时间和 IANA 时区，任务按每台服务器的时区计算。
- 创建每天、每周或单次定时任务，在目标服务器终端执行任意命令。
- 查看下一次执行时间、最近执行状态和输出，也可以立即执行任务。

密码只会保存到本地 `settings.json`，API 和页面不会返回原始密码。首次连接未知主机时 Paramiko 会自动接受主机密钥，建议仅在可信网络中使用并限制管理页面访问范围。
