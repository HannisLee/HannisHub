#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
exec uvicorn app:app --host "${PROMPT_HOST:-0.0.0.0}" --port "${PROMPT_PORT:-8084}"
