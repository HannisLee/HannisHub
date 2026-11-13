"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { errorMessage } from "../../lib/format";
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";

/**
 * 可拖动的浮动提示词：点击展开输入框，仅提供复制与归档。
 * 归档写入提示词模块同一后台（/prompt/api/prompts），会出现在「提示词」页的归档列表中。
 */

const POSITION_KEY = "hannishub_prompt_float_position";
const DRAFT_KEY = "hannishub_prompt_float_draft";
const BUBBLE = 44;
const EDGE = 8;
const GAP = 8;
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 260;
const DRAG_THRESHOLD = 4;

interface Point { x: number; y: number }

function clampPoint(point: Point): Point {
  return {
    x: Math.min(Math.max(point.x, EDGE), window.innerWidth - BUBBLE - EDGE),
    y: Math.min(Math.max(point.y, EDGE), window.innerHeight - BUBBLE - EDGE),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** 面板放在按钮左上方，空间不足时翻到右侧或下方，并始终保留在视口内。 */
function panelPlacement(bubble: Point): { left: number; top: number; width: number; height: number } {
  const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE * 2);
  const height = Math.min(PANEL_HEIGHT, window.innerHeight - BUBBLE - GAP - EDGE * 2);
  const preferLeft = bubble.x + BUBBLE - width;
  const left = Math.min(Math.max(preferLeft >= EDGE ? preferLeft : bubble.x, EDGE), window.innerWidth - width - EDGE);
  const above = bubble.y - GAP - height;
  const top = above >= EDGE ? above : Math.min(bubble.y + BUBBLE + GAP, window.innerHeight - height - EDGE);
  return { left, top, width, height };
}

export function PromptFloat() {
  const [position, setPosition] = useState<Point | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageTokenRef = useRef(0);

  // 首次挂载：恢复拖动位置（默认右下角）与草稿；延后一帧执行，避免在 effect 中同步 setState
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readJson<Point>(POSITION_KEY);
      const fallback = { x: window.innerWidth - BUBBLE - 24, y: window.innerHeight - BUBBLE - 56 };
      setPosition(clampPoint(stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : fallback));
      try {
        setText(window.localStorage.getItem(DRAFT_KEY) || "");
      } catch {
        return;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // 窗口缩放时把按钮收回视口
  useEffect(() => {
    const onResize = () => setPosition(current => (current ? clampPoint(current) : current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 草稿自动暂存
  useEffect(() => {
    const timer = window.setTimeout(() => writeStorage(DRAFT_KEY, text || null), 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const showMessage = useCallback((value: string, isError = false) => {
    const token = ++messageTokenRef.current;
    setMessage(value);
    setError(isError);
    window.setTimeout(() => {
      if (messageTokenRef.current === token) setMessage("");
    }, 2400);
  }, []);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!position || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y, moved: false };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    setPosition(clampPoint({ x: drag.originX + dx, y: drag.originY + dy }));
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if (drag.moved) {
      setPosition(current => {
        if (current) writeStorage(POSITION_KEY, JSON.stringify(current));
        return current;
      });
      return;
    }
    setOpen(value => !value);
  }

  function copy() {
    if (!text.trim()) {
      showMessage("当前提示词为空");
      return;
    }
    void copyToClipboard(text).then(copied => showMessage(copied ? "已复制" : "复制失败，请手动选择文本", !copied));
  }

  async function archive() {
    if (archiving) return;
    if (!text.trim()) {
      showMessage("提示词为空，不能归档");
      return;
    }
    const content = text;
    setArchiving(true);
    try {
      await apiFetch(`${API_PATHS.prompts}/prompts`, {
        method: "POST",
        body: jsonBody({ content, raw_content: content, polished_content: "" }),
      });
      // 归档期间若又输入了新内容则保留，避免误清
      setText(current => (current === content ? "" : current));
      showMessage("已归档到提示词");
    } catch (value) {
      showMessage(`归档失败：${errorMessage(value)}`, true);
    } finally {
      setArchiving(false);
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") setOpen(false);
  }

  if (!position) return null;
  const panel = open ? panelPlacement(position) : null;

  return (
    <>
      <button
        type="button"
        className={`prompt-float-bubble${open ? " is-open" : ""}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; }}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(value => !value); } }}
        aria-label={open ? "收起提示词" : "打开提示词"}
        aria-expanded={open}
        title="提示词（可拖动）"
      >
        <Icon name={open ? "close" : "prompts"} />
      </button>
      {panel ? (
        <div
          className="prompt-float-panel"
          style={{ left: panel.left, top: panel.top, width: panel.width, height: panel.height }}
          role="dialog"
          aria-label="提示词"
          onKeyDown={onPanelKeyDown}
        >
          <textarea
            ref={textareaRef}
            className="prompt-float-input"
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="在这里输入或粘贴提示词…"
            spellCheck={false}
          />
          <div className="prompt-float-actions">
            <span className={`prompt-float-status${error ? " is-error" : ""}`} role="status">{message}</span>
            <Button variant="secondary" size="sm" onClick={copy}>复制</Button>
            <Button size="sm" onClick={() => void archive()} disabled={archiving}>{archiving ? "归档中…" : "归档"}</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
