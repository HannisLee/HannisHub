#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

mkdir -p llama_manager/logs

exec uvicorn app:app --host 0.0.0.0 --port 8081
