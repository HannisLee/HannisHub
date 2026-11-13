#!/usr/bin/env bash
# 同时管理本机推理后端与官方浏览器工作台。
set -eu
port=8787
if [[ "${1:-}" == "--port" ]]; then port="$2"; fi
python3 - "$port" <<'PY'
import socket, sys
for port in (8080, int(sys.argv[1])):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            raise SystemExit(f"端口 {port} 不可用: {exc}")
PY
server_pid=""
demo_pid=""
cleanup() {
  trap - EXIT TERM INT
  [[ -z "$demo_pid" ]] || kill "$demo_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT TERM INT
/home/lihan/run/llama.cpp/build/bin/llama-server -m /home/lihan/models/Xiaomi-OCR-0/Xiaomi-OCR-0.BF16.gguf --mmproj /home/lihan/models/Xiaomi-OCR-0/Xiaomi-OCR-0.mmproj-bf16.gguf --host 127.0.0.1 --port 8080 --alias xiaomi-ocr-0 -ngl 99 -c 65536 &
server_pid=$!
for ((i=0; i<120; i++)); do
  if curl -fsS http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then break; fi
  kill -0 "$server_pid" 2>/dev/null || { echo '推理服务启动失败'; exit 1; }
  sleep 1
done
kill -0 "$server_pid" 2>/dev/null || exit 1
curl -fsS http://127.0.0.1:8080/v1/models >/dev/null || { echo '推理服务就绪超时'; exit 1; }
cd /home/lihan/run/Xiaomi-OCR-0
XIAOMI_OCR_BACKEND=openai XIAOMI_OCR_MODEL=xiaomi-ocr-0 XIAOMI_OCR_LOCAL_URL=http://127.0.0.1:8080/v1 .venv/bin/python demo/server.py --host 127.0.0.1 --port "$port" &
demo_pid=$!
wait -n "$server_pid" "$demo_pid"
