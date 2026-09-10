#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
mkdir -p data
exec uvicorn app:app --host "${SERVER_HOST:-0.0.0.0}" --port "${SERVER_PORT:-8082}"
