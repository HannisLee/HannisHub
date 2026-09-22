"""在线提示词输入服务：大输入框、复制与归档历史管理。"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

APP_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = APP_DIR / "settings.json"
PROMPT_MAX_CHARS = 2_000_000
PROMPT_MAX_COUNT = 500
_SETTINGS_LOCK = threading.RLock()
DEFAULT_SETTINGS = {"prompts": []}

app = FastAPI(title="LlamaManager Prompt")


def _now_iso() -> str:
    """生成 UTC ISO 时间，用于排序和页面展示。"""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _read_settings() -> dict:
    """读取本地 JSON 配置；损坏时返回空配置。"""
    with _SETTINGS_LOCK:
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                prompts = data.get("prompts", [])
                if not isinstance(prompts, list):
                    prompts = []
                return {"prompts": [item for item in prompts if isinstance(item, dict)]}
        except (OSError, json.JSONDecodeError):
            pass
        return {"prompts": []}


def _write_settings(data: dict) -> None:
    """原子写入本地 JSON 配置。"""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SETTINGS_PATH.with_suffix(".json.tmp")
    with _SETTINGS_LOCK:
        temp_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temp_path, SETTINGS_PATH)


def _public_prompt(item: dict) -> dict:
    """返回前端需要的提示词字段。"""
    return {
        "id": str(item.get("id") or ""),
        "content": str(item.get("content") or ""),
        "created_at": item.get("created_at") or _now_iso(),
        "updated_at": item.get("updated_at") or item.get("created_at") or _now_iso(),
    }


def _sorted_prompts() -> list[dict]:
    """按更新时间倒序返回提示词。"""
    return sorted(
        (_public_prompt(item) for item in _read_settings()["prompts"]),
        key=lambda item: str(item["updated_at"]),
        reverse=True,
    )


def _normalize_content(payload: dict) -> str:
    """校验请求内容并返回纯文本字符串。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    content = str(payload.get("content") or "")
    if not content.strip():
        raise HTTPException(status_code=400, detail="提示词内容不能为空")
    if len(content) > PROMPT_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"提示词过长，最多 {PROMPT_MAX_CHARS} 个字符",
        )
    return content


def _find_prompt(prompts: list[dict], prompt_id: str) -> Optional[dict]:
    """按 ID 查找提示词。"""
    return next((item for item in prompts if str(item.get("id")) == prompt_id), None)


@app.get("/")
async def root(request: Request):
    """独立运行时跳转到 /prompt，Hub 挂载时返回页面。"""
    if request.url.path.rstrip("/").endswith("/prompt"):
        return FileResponse(APP_DIR / "index.html")
    return RedirectResponse(url="/prompt")


@app.get("/prompt")
@app.get("/prompt/")
async def index():
    """返回在线提示词输入页面。"""
    return FileResponse(APP_DIR / "index.html")


@app.get("/api/health")
async def health():
    """健康检查。"""
    return JSONResponse({"ok": True, "service": "prompt"})


@app.get("/api/prompts")
async def list_prompts():
    """读取归档提示词列表。"""
    return JSONResponse({"prompts": _sorted_prompts(), "max_count": PROMPT_MAX_COUNT})


@app.post("/api/prompts")
async def create_prompt(request: Request):
    """归档当前提示词。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    content = _normalize_content(payload)
    now = _now_iso()
    item = {
        "id": f"prompt_{uuid.uuid4().hex[:12]}",
        "content": content,
        "created_at": now,
        "updated_at": now,
    }
    with _SETTINGS_LOCK:
        data = _read_settings()
        data["prompts"].append(item)
        if len(data["prompts"]) > PROMPT_MAX_COUNT:
            # 保留最新条目，删除最早的记录
            data["prompts"] = data["prompts"][-PROMPT_MAX_COUNT:]
        _write_settings(data)
    return JSONResponse(_public_prompt(item), status_code=201)


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, request: Request):
    """更新归档提示词内容。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    content = _normalize_content(payload)
    with _SETTINGS_LOCK:
        data = _read_settings()
        item = _find_prompt(data["prompts"], prompt_id)
        if item is None:
            raise HTTPException(status_code=404, detail="提示词不存在")
        item["content"] = content
        item["updated_at"] = _now_iso()
        _write_settings(data)
        updated = dict(item)
    return JSONResponse(_public_prompt(updated))


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str):
    """删除归档提示词。"""
    with _SETTINGS_LOCK:
        data = _read_settings()
        item = _find_prompt(data["prompts"], prompt_id)
        if item is None:
            raise HTTPException(status_code=404, detail="提示词不存在")
        data["prompts"] = [
            current for current in data["prompts"]
            if str(current.get("id")) != prompt_id
        ]
        _write_settings(data)
    return JSONResponse({"ok": True})
