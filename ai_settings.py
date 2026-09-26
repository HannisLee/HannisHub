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

import httpx


ROOT_DIR = Path(__file__).resolve().parent
AI_SETTINGS_PATH = ROOT_DIR / "ai_settings.json"
LEGACY_LLAMA_SETTINGS_PATH = ROOT_DIR / "llama_manager" / "settings.json"

OPENAI_API_BASE_URL_KEY = "openai_api_base_url"
OPENAI_API_MODEL_KEY = "openai_api_model"
OPENAI_API_KEY_KEY = "openai_api_key"
ASR_EXTRACTION_PROMPT_KEY = "asr_extraction_prompt"
PROMPT_POLISH_PROMPTS_KEY = "prompt_polish_prompts"
DEFAULT_ASR_EXTRACTION_PROMPT = (
    "以下内容是一个抖音视频的音频转写。请去除口头禅、重复、无关寒暄和其他冗余内容，"
    "准确提炼视频真正要传达的关键信息。请用清晰、简洁的中文输出；保留必要的事实、观点、"
    "步骤、数字和结论，不要编造或补充原文没有的信息。"
)
DEFAULT_PROMPT_POLISH_PROMPTS = {
    "light": (
        "你是提示词文字编辑。请对用户的原始提示词做轻度润色：修正错别字、病句、标点和明显歧义，"
        "删去无意义重复，但尽量保留原有措辞、语气、结构和细节。不要扩写任务，不要添加原文没有的要求。"
        "只输出润色后的完整提示词，不要解释修改过程，不要使用代码围栏。"
    ),
    "standard": (
        "你是专业的提示词编辑器。请在完整保留用户意图、事实和必要细节的前提下，对原始提示词做标准润色："
        "梳理任务目标、背景、约束和期望输出，消除重复与歧义，按需要使用段落、标题或列表提升可执行性。"
        "不要臆造原文没有的业务事实；信息缺失时用清晰的待补充占位符，不要自行编造。"
        "只输出润色后的完整提示词，不要解释修改过程，不要使用代码围栏。"
    ),
    "deep": (
        "你是资深提示词工程师。请对用户的原始提示词做深度重构，使其成为可直接交给高能力 AI 执行的高质量提示词。"
        "先识别真正目标，再按任务需要组织角色、上下文、具体任务、执行步骤、约束、输出格式和验收标准；"
        "保留全部有效信息，删除冲突、噪声和重复表达，并明确容易误解的边界。不要添加未经用户提供的事实，"
        "必要但缺失的信息以简短占位符标记。避免为了形式而过度拉长简单任务。"
        "只输出重构后的完整提示词，不要分析、解释或使用代码围栏。"
    ),
}
PROMPT_POLISH_LEVELS = frozenset(DEFAULT_PROMPT_POLISH_PROMPTS)
PROMPT_POLISH_MAX_INSTRUCTION_CHARS = 8_000
PROMPT_POLISH_MAX_CONTENT_CHARS = 200_000

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
    }


def _normalize_prompt_polish_prompts(value: object) -> dict[str, str]:
    """校验三档提示词润色指令。"""
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="润色提示词设置必须是 JSON 对象")
    normalized: dict[str, str] = {}
    for level in DEFAULT_PROMPT_POLISH_PROMPTS:
        prompt = str(value.get(level) or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail=f"{level} 档润色提示词不能为空")
        if len(prompt) > PROMPT_POLISH_MAX_INSTRUCTION_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"{level} 档润色提示词不能超过 {PROMPT_POLISH_MAX_INSTRUCTION_CHARS} 个字符",
            )
        normalized[level] = prompt
    return normalized


def get_prompt_polish_prompts() -> dict[str, str]:
    """读取三档提示词润色指令，缺失或损坏的档位使用内置默认值。"""
    saved = _load_ai_settings().get(PROMPT_POLISH_PROMPTS_KEY)
    if not isinstance(saved, dict):
        return dict(DEFAULT_PROMPT_POLISH_PROMPTS)
    prompts: dict[str, str] = {}
    for level, default_prompt in DEFAULT_PROMPT_POLISH_PROMPTS.items():
        value = saved.get(level)
        prompts[level] = str(value).strip() if isinstance(value, str) and value.strip() else default_prompt
    return prompts


def get_public_prompt_polish_settings() -> dict[str, Any]:
    """返回提示词页面可编辑的三档指令和只读默认值。"""
    return {
        "prompts": get_prompt_polish_prompts(),
        "defaults": dict(DEFAULT_PROMPT_POLISH_PROMPTS),
    }


def save_prompt_polish_prompts(value: object) -> dict[str, Any]:
    """保存提示词工作区的三档润色指令。"""
    prompts = _normalize_prompt_polish_prompts(value)
    with _SETTINGS_LOCK:
        data = _load_ai_settings()
        data[PROMPT_POLISH_PROMPTS_KEY] = prompts
        _write_json(AI_SETTINGS_PATH, data)
    return get_public_prompt_polish_settings()


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


async def discover_models() -> dict[str, Any]:
    """请求 OpenAI 兼容接口的 /models，返回可选择的模型列表。"""
    config = get_ai_config()
    base_url = config[OPENAI_API_BASE_URL_KEY]
    api_key = config[OPENAI_API_KEY_KEY]
    if not base_url:
        raise HTTPException(status_code=400, detail="请先保存 AI API 地址")

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            response = await client.get(f"{base_url}/models", headers=headers)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"连接失败：{str(exc)[:300]}") from exc
    if response.is_error:
        raise HTTPException(status_code=502, detail=f"模型列表接口返回 HTTP {response.status_code}")

    try:
        payload = response.json()
        raw_models = payload.get("data", payload if isinstance(payload, list) else [])
        models = sorted(
            str(item.get("id"))
            for item in raw_models
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="模型列表接口返回格式不符合 OpenAI 兼容规范") from exc

    return {
        "ok": True,
        "message": f"连接成功，发现 {len(models)} 个模型",
        "models": models,
    }


async def test_connection() -> dict[str, Any]:
    """测试 AI API 连接，并返回模型列表供前端填充。"""
    return await discover_models()


async def test_model(model: object) -> dict[str, Any]:
    """使用指定模型发送一次最小对话请求，验证模型可用性。"""
    model_name = str(model or "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="请先选择或输入要测试的模型")
    config = get_ai_config()
    base_url = config[OPENAI_API_BASE_URL_KEY]
    api_key = config[OPENAI_API_KEY_KEY]
    if not base_url:
        raise HTTPException(status_code=400, detail="请先保存 AI API 地址")

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": "请只回复 OK。"}],
        "temperature": 0,
        "max_tokens": 16,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0)) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"模型测试请求失败：{str(exc)[:300]}") from exc
    if response.is_error:
        raise HTTPException(status_code=502, detail=f"模型测试返回 HTTP {response.status_code}")

    try:
        result = response.json()
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="模型测试返回格式不符合 OpenAI 兼容规范") from exc
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(status_code=502, detail="模型测试未返回有效文字")

    return {
        "ok": True,
        "message": "模型可用",
        "response": content.strip()[:500],
    }


async def polish_prompt(content: object, level: object) -> dict[str, str]:
    """使用统一 AI 配置按指定档位润色提示词。"""
    source = str(content or "").strip()
    polish_level = str(level or "").strip()
    if not source:
        raise HTTPException(status_code=400, detail="请先输入需要润色的提示词")
    if len(source) > PROMPT_POLISH_MAX_CONTENT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"单次 AI 润色最多支持 {PROMPT_POLISH_MAX_CONTENT_CHARS} 个字符",
        )
    if polish_level not in PROMPT_POLISH_LEVELS:
        raise HTTPException(status_code=400, detail="润色档位必须是 light、standard 或 deep")

    config = get_ai_config()
    base_url = config[OPENAI_API_BASE_URL_KEY]
    model = config[OPENAI_API_MODEL_KEY]
    api_key = config[OPENAI_API_KEY_KEY]
    if not base_url:
        raise HTTPException(status_code=400, detail="请先在项目设置中保存 AI API 地址")
    if not model:
        raise HTTPException(status_code=400, detail="请先在项目设置中选择 AI 模型")

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": get_prompt_polish_prompts()[polish_level]},
            {"role": "user", "content": source},
        ],
        "temperature": 0.2,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"润色请求失败：{str(exc)[:300]}") from exc
    if response.is_error:
        detail = ""
        try:
            error_payload = response.json()
            detail = str(error_payload.get("error", {}).get("message") or error_payload.get("detail") or "")
        except (AttributeError, TypeError, ValueError):
            detail = ""
        suffix = f"：{detail[:300]}" if detail else ""
        raise HTTPException(status_code=502, detail=f"润色接口返回 HTTP {response.status_code}{suffix}")

    try:
        result = response.json()
        polished = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="润色接口返回格式不符合 OpenAI 兼容规范") from exc
    if not isinstance(polished, str) or not polished.strip():
        raise HTTPException(status_code=502, detail="润色接口没有返回有效文字")
    return {"content": polished.strip(), "level": polish_level, "model": model}
