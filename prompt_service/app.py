"""在线提示词输入服务：大输入框、原文/润色切换与分组归档历史管理。"""

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

APP_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = APP_DIR / "settings.json"
PROMPT_MAX_CHARS = 2_000_000
PROMPT_MAX_COUNT = 500
GROUP_MAX_COUNT = 100
GROUP_NAME_MAX_CHARS = 40
# 空字符串代表「无分组」，它是固定分组，始终排在自定义分组之前
UNGROUPED_ID = ""
_SETTINGS_LOCK = threading.RLock()
DEFAULT_SETTINGS = {"prompts": [], "groups": []}

app = FastAPI(title="HannisHub Prompt")
router = APIRouter()


def _now_iso() -> str:
    """生成 UTC ISO 时间，用于排序和页面展示。"""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _index_response() -> FileResponse:
    """返回页面文件，并禁用浏览器缓存，确保发布后立即使用新前端逻辑。"""
    return FileResponse(
        APP_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, max-age=0, must-revalidate",
        },
    )


def _read_settings() -> dict:
    """读取本地 JSON 配置；损坏时返回空配置。"""
    with _SETTINGS_LOCK:
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                prompts = data.get("prompts", [])
                groups = data.get("groups", [])
                return {
                    "prompts": [item for item in prompts if isinstance(item, dict)]
                    if isinstance(prompts, list)
                    else [],
                    "groups": [item for item in groups if isinstance(item, dict)]
                    if isinstance(groups, list)
                    else [],
                }
        except (OSError, json.JSONDecodeError):
            pass
        return {"prompts": [], "groups": []}


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


def _public_group(item: dict) -> dict:
    """返回前端需要的分组字段。"""
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or "") or "未命名分组",
        "created_at": item.get("created_at") or _now_iso(),
    }


def _public_prompt(item: dict) -> dict:
    """返回前端需要的提示词字段，group_id 为空字符串表示无分组。"""
    return {
        "id": str(item.get("id") or ""),
        "content": str(item.get("content") or ""),
        "group_id": str(item.get("group_id") or "") if item.get("group_id") else UNGROUPED_ID,
        "created_at": item.get("created_at") or _now_iso(),
        "updated_at": item.get("updated_at") or item.get("created_at") or _now_iso(),
    }


def _sorted_prompts() -> list[dict]:
    """按更新时间倒序返回提示词，保证每个分组内越新越靠上。"""
    data = _read_settings()
    known_groups = {str(item.get("id")) for item in data["groups"]}
    ordered: list[dict] = []
    # 先倒序再稳定排序：同一秒内写入的多条记录也能保持“最新的在最上面”
    for item in reversed(data["prompts"]):
        prompt = _public_prompt(item)
        if prompt["group_id"] and prompt["group_id"] not in known_groups:
            # 分组被删除或数据被手工修改时回落到无分组，避免条目在页面里消失
            prompt["group_id"] = UNGROUPED_ID
        ordered.append(prompt)
    ordered.sort(key=lambda item: str(item["updated_at"]), reverse=True)
    return ordered


def _group_list() -> list[dict]:
    """按存储顺序返回分组，顺序即页面上下关系。"""
    return [_public_group(item) for item in _read_settings()["groups"]]


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


def _normalize_group_name(payload: dict, existing: Optional[dict] = None) -> str:
    """校验分组名称。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    name = str(payload.get("name") or "").strip()
    if not name and existing is not None:
        name = str(existing.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")
    if len(name) > GROUP_NAME_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"分组名称最长 {GROUP_NAME_MAX_CHARS} 个字符",
        )
    return name


def _find_prompt(prompts: list[dict], prompt_id: str) -> Optional[dict]:
    """按 ID 查找提示词。"""
    return next((item for item in prompts if str(item.get("id")) == prompt_id), None)


def _find_group(groups: list[dict], group_id: str) -> Optional[dict]:
    """按 ID 查找分组，无分组返回 None。"""
    if not group_id:
        return None
    return next((item for item in groups if str(item.get("id")) == group_id), None)


def _resolve_group_id(groups: list[dict], value: object) -> str:
    """把请求里的 group_id 解析成合法分组，空值统一归入无分组。"""
    group_id = str(value or "").strip()
    if not group_id:
        return UNGROUPED_ID
    if _find_group(groups, group_id) is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    return group_id


@app.get("/")
async def root(request: Request):
    """独立运行时跳转到 /prompt，Hub 挂载时返回页面。"""
    if request.url.path.rstrip("/").endswith("/prompt"):
        return _index_response()
    return RedirectResponse(url="/prompt")


@app.get("/prompt")
@app.get("/prompt/")
async def index():
    """返回在线提示词输入页面。"""
    return _index_response()


# Hub 挂载时子应用收到 /api/...；独立运行时页面在 /prompt/ 下会请求 /prompt/api/...
# 因此同一组 API 在文件末尾同时注册两个前缀，前端统一使用相对路径。


@router.get("/health")
async def health():
    """健康检查。"""
    return JSONResponse({"ok": True, "service": "prompt"})


@router.get("/prompts")
async def list_prompts():
    """读取归档提示词列表与分组列表。"""
    return JSONResponse(
        {
            "prompts": _sorted_prompts(),
            "groups": _group_list(),
            "max_count": PROMPT_MAX_COUNT,
            "max_group_count": GROUP_MAX_COUNT,
        }
    )


@router.post("/prompts")
async def create_prompt(request: Request):
    """归档当前提示词到指定分组（默认无分组）。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    content = _normalize_content(payload)
    now = _now_iso()
    with _SETTINGS_LOCK:
        data = _read_settings()
        group_id = _resolve_group_id(data["groups"], payload.get("group_id"))
        item = {
            "id": f"prompt_{uuid.uuid4().hex[:12]}",
            "content": content,
            "group_id": group_id,
            "created_at": now,
            "updated_at": now,
        }
        data["prompts"].append(item)
        if len(data["prompts"]) > PROMPT_MAX_COUNT:
            # 保留最新条目，删除最早的记录
            data["prompts"] = data["prompts"][-PROMPT_MAX_COUNT:]
        _write_settings(data)
    return JSONResponse(_public_prompt(item), status_code=201)


@router.put("/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, request: Request):
    """更新归档提示词内容或所属分组。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    # content 与 group_id 至少传一个，只传分组时保留原内容
    content = _normalize_content(payload) if "content" in payload else None
    with _SETTINGS_LOCK:
        data = _read_settings()
        item = _find_prompt(data["prompts"], prompt_id)
        if item is None:
            raise HTTPException(status_code=404, detail="提示词不存在")
        if content is None and "group_id" not in payload:
            raise HTTPException(status_code=400, detail="没有需要更新的字段")
        if "group_id" in payload:
            item["group_id"] = _resolve_group_id(data["groups"], payload.get("group_id"))
        if content is not None:
            item["content"] = content
        # 更新时间用于每个分组内“越新越上面”的排序
        item["updated_at"] = _now_iso()
        _write_settings(data)
        updated = dict(item)
    return JSONResponse(_public_prompt(updated))


@router.delete("/prompts/{prompt_id}")
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


@router.get("/groups")
async def list_groups():
    """读取分组列表。"""
    return JSONResponse({"groups": _group_list(), "max_group_count": GROUP_MAX_COUNT})


@router.post("/groups")
async def create_group(request: Request):
    """新建分组，追加到分组顺序末尾。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    name = _normalize_group_name(payload)
    with _SETTINGS_LOCK:
        data = _read_settings()
        if len(data["groups"]) >= GROUP_MAX_COUNT:
            raise HTTPException(status_code=400, detail=f"分组数量已达上限 {GROUP_MAX_COUNT}")
        if any(str(item.get("name") or "").strip() == name for item in data["groups"]):
            raise HTTPException(status_code=400, detail="已存在同名分组")
        item = {
            "id": f"group_{uuid.uuid4().hex[:12]}",
            "name": name,
            "created_at": _now_iso(),
        }
        data["groups"].append(item)
        _write_settings(data)
    return JSONResponse(_public_group(item), status_code=201)


@router.put("/groups/order")
async def order_groups(request: Request):
    """按前端拖动结果重排分组上下顺序。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    order = payload.get("order") if isinstance(payload, dict) else None
    if not isinstance(order, list):
        raise HTTPException(status_code=400, detail="order 必须是分组 ID 数组")
    with _SETTINGS_LOCK:
        data = _read_settings()
        current = {str(item.get("id")): item for item in data["groups"]}
        new_order = [str(value) for value in order if str(value) in current]
        # 未出现在 order 中的分组按原顺序补在后面，避免前端漏传导致分组丢失
        new_order += [group_id for group_id in current if group_id not in new_order]
        data["groups"] = [current[group_id] for group_id in new_order]
        _write_settings(data)
    return JSONResponse({"groups": _group_list()})


@router.put("/groups/{group_id}")
async def rename_group(group_id: str, request: Request):
    """重命名分组。"""
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体必须是有效 JSON") from exc
    with _SETTINGS_LOCK:
        data = _read_settings()
        item = _find_group(data["groups"], group_id)
        if item is None:
            raise HTTPException(status_code=404, detail="分组不存在")
        name = _normalize_group_name(payload, existing=item)
        if any(
            str(current.get("id")) != group_id
            and str(current.get("name") or "").strip() == name
            for current in data["groups"]
        ):
            raise HTTPException(status_code=400, detail="已存在同名分组")
        item["name"] = name
        _write_settings(data)
        updated = dict(item)
    return JSONResponse(_public_group(updated))


@router.delete("/groups/{group_id}")
async def delete_group(group_id: str):
    """删除分组，组内提示词移动到无分组。"""
    with _SETTINGS_LOCK:
        data = _read_settings()
        item = _find_group(data["groups"], group_id)
        if item is None:
            raise HTTPException(status_code=404, detail="分组不存在")
        data["groups"] = [
            current for current in data["groups"]
            if str(current.get("id")) != group_id
        ]
        moved = 0
        for prompt in data["prompts"]:
            if str(prompt.get("group_id") or "") == group_id:
                prompt["group_id"] = UNGROUPED_ID
                moved += 1
        _write_settings(data)
    return JSONResponse({"ok": True, "moved": moved})


# 统一注册 API 路由：Hub 挂载模式和独立运行模式共用同一组处理函数
app.include_router(router, prefix="/api")
app.include_router(router, prefix="/prompt/api")
