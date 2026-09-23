"""HannisHub 的 AI 能力配置：集中保存 API 连接信息与任务提示词。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException


ROOT_DIR = Path(__file__).resolve().parent
AI_SETTINGS_PATH = ROOT_DIR / "ai_settings.json"
LEGACY_LLAMA_SETTINGS_PATH = ROOT_DIR / "llama_manager" / "settings.json"

OPENAI_API_BASE_URL_KEY = "openai_api_base_url"
OPENAI_API_MODEL_KEY = "openai_api_model"
OPENAI_API_KEY_KEY = "openai_api_key"
ASR_EXTRACTION_PROMPT_KEY = "asr_extraction_prompt"
DEFAULT_ASR_EXTRACTION_PROMPT = (
    "以下内容是一个抖音视频的音频转写。请去除口头禅、重复、无关寒暄和其他冗余内容，"
    "准确提炼视频真正要传达的关键信息。请用清晰、简洁的中文输出；保留必要的事实、观点、"
    "步骤、数字和结论，不要编造或补充原文没有的信息。"
)

_SETTINGS_LOCK = threading.RLock()


def _read_json(path: Path) -> dict[str, Any]:
    """读取 JSON 对象；文件不存在或损坏时返回空对象。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    """原子写入 JSON，避免半写入导致配置损坏。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _load_ai_settings() -> dict[str, Any]:
    """读取本地 AI 配置，并从模型管理旧配置中无损迁移已保存的值。"""
    with _SETTINGS_LOCK:
        data = _read_json(AI_SETTINGS_PATH)
        legacy = _read_json(LEGACY_LLAMA_SETTINGS_PATH)
        changed = not AI_SETTINGS_PATH.is_file()
        for key in (
            OPENAI_API_BASE_URL_KEY,
            OPENAI_API_MODEL_KEY,
            OPENAI_API_KEY_KEY,
            ASR_EXTRACTION_PROMPT_KEY,
        ):
            value = legacy.get(key)
            if not data.get(key) and isinstance(value, str) and value.strip():
                data[key] = value.strip()
                changed = True
        if changed:
            _write_json(AI_SETTINGS_PATH, data)
        return data


def get_ai_config() -> dict[str, str]:
    """供后端任务使用的完整 AI 配置；密钥不会返回给前端。"""
    data = _load_ai_settings()
    return {
        OPENAI_API_BASE_URL_KEY: str(data.get(OPENAI_API_BASE_URL_KEY) or "").strip().rstrip("/"),
        OPENAI_API_MODEL_KEY: str(data.get(OPENAI_API_MODEL_KEY) or "").strip(),
        OPENAI_API_KEY_KEY: str(data.get(OPENAI_API_KEY_KEY) or "").strip(),
        ASR_EXTRACTION_PROMPT_KEY: get_asr_extraction_prompt(),
    }


def get_public_ai_settings() -> dict[str, Any]:
    """返回前端设置页可展示的 AI 配置；只暴露密钥是否已配置。"""
    data = _load_ai_settings()
    return {
        OPENAI_API_BASE_URL_KEY: str(data.get(OPENAI_API_BASE_URL_KEY) or "").strip().rstrip("/"),
        OPENAI_API_MODEL_KEY: str(data.get(OPENAI_API_MODEL_KEY) or "").strip(),
        "openai_api_key_configured": bool(str(data.get(OPENAI_API_KEY_KEY) or "").strip()),
        ASR_EXTRACTION_PROMPT_KEY: get_asr_extraction_prompt(),
    }


def _validate_base_url(value: str) -> str:
    """校验 OpenAI 兼容 API 基地址。"""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="AI API 地址必须是有效的 http 或 https 地址")
    return value


def save_ai_settings(payload: object) -> dict[str, Any]:
    """保存 AI API 与提示词配置；密钥留空表示保持不变。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="AI 设置必须是 JSON 对象")
    with _SETTINGS_LOCK:
        data = _load_ai_settings()

        if OPENAI_API_BASE_URL_KEY in payload:
            base_url = str(payload.get(OPENAI_API_BASE_URL_KEY) or "").strip().rstrip("/")
            if base_url:
                base_url = _validate_base_url(base_url)
            data[OPENAI_API_BASE_URL_KEY] = base_url

        if OPENAI_API_MODEL_KEY in payload:
            model = str(payload.get(OPENAI_API_MODEL_KEY) or "").strip()
            if len(model) > 240:
                raise HTTPException(status_code=400, detail="AI 模型名称不能超过 240 个字符")
            data[OPENAI_API_MODEL_KEY] = model

        if payload.get("clear_openai_api_key"):
            data.pop(OPENAI_API_KEY_KEY, None)
        else:
            api_key = payload.get(OPENAI_API_KEY_KEY)
            if isinstance(api_key, str) and api_key.strip():
                data[OPENAI_API_KEY_KEY] = api_key.strip()

        if ASR_EXTRACTION_PROMPT_KEY in payload:
            data[ASR_EXTRACTION_PROMPT_KEY] = normalize_asr_extraction_prompt(
                payload.get(ASR_EXTRACTION_PROMPT_KEY),
            )

        _write_json(AI_SETTINGS_PATH, data)
    return get_public_ai_settings()


def get_asr_extraction_prompt() -> str:
    """读取 ASR 提炼提示词，未设置时使用默认提示词。"""
    prompt = str(_load_ai_settings().get(ASR_EXTRACTION_PROMPT_KEY) or "").strip()
    return prompt or DEFAULT_ASR_EXTRACTION_PROMPT


def normalize_asr_extraction_prompt(value: object) -> str:
    """校验并规范化 ASR 提炼提示词。"""
    prompt = str(value or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="ASR 提炼提示词不能为空")
    if len(prompt) > 4000:
        raise HTTPException(status_code=400, detail="ASR 提炼提示词不能超过 4000 个字符")
    return prompt


def save_asr_extraction_prompt(prompt: object) -> str:
    """单独保存 ASR 提炼提示词并返回规范化结果。"""
    value = normalize_asr_extraction_prompt(prompt)
    save_ai_settings({ASR_EXTRACTION_PROMPT_KEY: value})
    return value
