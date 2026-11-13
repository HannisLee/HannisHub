"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../../lib/api";
import { LOBBY_NAME_MAX, saveLobbyProfile, type LobbyProfile } from "../../../lib/chat-lobby";
import { errorMessage } from "../../../lib/format";
import {
  AVATAR_SLOTS, DEFAULT_AVATAR, FACING_ROW, FRAME_HEIGHT, FRAME_WIDTH, drawAvatarFrame, loadAvatarParts,
  normalizeAvatar, randomAvatar, type AvatarConfig, type AvatarParts, type AvatarSlot, type PartItem,
} from "./game/avatar";
import { ASSET_BASE, type Facing } from "./game/layout";

const SLOT_LABELS: Record<AvatarSlot, string> = {
  body: "肤色",
  eyes: "眼睛",
  outfit: "服装",
  hair: "发型",
  accessory: "配饰",
};

/** 配饰款式名（素材文件名中的英文）→ 中文 */
const ACCESSORY_NAMES: Record<string, string> = {
  Ladybug: "瓢虫", Bee: "小蜜蜂", Backpack: "背包", Snapback: "棒球帽", Dino_Snapback: "恐龙帽",
  Policeman_Hat: "警帽", Bataclava: "头套", Detective_Hat: "侦探帽", Zombie_Brain: "僵尸脑",
  Bolt: "螺栓", Beanie: "毛线帽", Mustache: "小胡子", Beard: "络腮胡", Gloves: "手套",
  Glasses: "眼镜", Monocle: "单片眼镜", Medical_Mask: "口罩", Chef: "厨师帽", Party_Cone: "派对帽",
};

/** 预览转身顺序（顺时针） */
const TURN: Facing[] = ["down", "left", "up", "right"];
const PREVIEW_SCALE = 6;
const THUMB_SCALE = 3;

interface StyleGroup {
  style: string;
  items: PartItem[];
}

function groupStyles(items: PartItem[]): StyleGroup[] {
  const groups: StyleGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.style === item.style) last.items.push(item);
    else groups.push({ style: item.style, items: [item] });
  }
  return groups;
}

function styleLabel(slot: AvatarSlot, style: string, index: number) {
  if (slot === "accessory") return ACCESSORY_NAMES[style.replace(/^\d+_/, "")] ?? style;
  return `${SLOT_LABELS[slot]} ${index + 1}`;
}

/** 换款式时尽量保留当前配色编号 */
function pickInStyle(group: StyleGroup, currentId: string, parts: PartItem[]): string {
  const variant = parts.find(item => item.id === currentId)?.variant;
  return (group.items.find(item => item.variant === variant) ?? group.items[0]).id;
}

/** 静态缩略图：画出「当前搭配 + 候选部件」的正面站立帧 */
function AvatarThumb({ parts, config }: { parts: AvatarParts; config: AvatarConfig }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, FRAME_WIDTH * THUMB_SCALE, FRAME_HEIGHT * THUMB_SCALE);
    drawAvatarFrame(ctx, parts, config, "down", false, 0, 0, 0, THUMB_SCALE);
  }, [parts, config]);
  return <canvas ref={ref} width={FRAME_WIDTH * THUMB_SCALE} height={FRAME_HEIGHT * THUMB_SCALE} aria-hidden="true" />;
}

interface AvatarDialogProps {
  profile: LobbyProfile;
  onClose: () => void;
  onSaved: (profile: LobbyProfile) => void;
}

/** 「我的房间」衣柜前按 E 打开：拼装像素形象（身体、眼睛、服装、发型、配饰）并设置名字。
 *  名字在多人同场时显示在其他人看到的角色头顶，自己在场景里看不到。 */
export function AvatarDialog({ profile, onClose, onSaved }: AvatarDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [parts, setParts] = useState<AvatarParts | null>(null);
  const [defaultSheet, setDefaultSheet] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState(profile.name);
  // 未自定义过形象时沿用场景默认角色；一旦挑选任何部件即切换为自定义
  const [useDefault, setUseDefault] = useState(profile.avatar === null);
  const [config, setConfig] = useState<AvatarConfig>(profile.avatar ?? DEFAULT_AVATAR);
  const [slot, setSlot] = useState<AvatarSlot>("outfit");
  const [facing, setFacing] = useState<Facing>("down");
  const [walking, setWalking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let alive = true;
    loadAvatarParts()
      .then(loaded => {
        if (!alive) return;
        setParts(loaded);
        setConfig(current => normalizeAvatar(loaded, current));
      })
      .catch(error => alive && setLoadError(errorMessage(error)));
    const image = new Image();
    image.onload = () => alive && setDefaultSheet(image);
    image.src = `${ASSET_BASE}/player.png`;
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  // 预览动画：8 帧/秒循环行走或呼吸
  useEffect(() => {
    const canvas = previewRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      if (useDefault) {
        if (!defaultSheet) return;
        const row = FACING_ROW[facing] + (walking ? 4 : 0);
        ctx.drawImage(
          defaultSheet, (frame % 6) * FRAME_WIDTH, row * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT,
          0, 0, FRAME_WIDTH * PREVIEW_SCALE, FRAME_HEIGHT * PREVIEW_SCALE,
        );
      } else if (parts) {
        drawAvatarFrame(ctx, parts, config, facing, walking, frame, 0, 0, PREVIEW_SCALE);
      }
    };
    draw();
    const timer = window.setInterval(() => {
      frame = (frame + 1) % 6;
      draw();
    }, walking ? 100 : 220);
    return () => window.clearInterval(timer);
  }, [parts, defaultSheet, config, useDefault, facing, walking]);

  const turn = (step: number) => setFacing(current => TURN[(TURN.indexOf(current) + step + TURN.length) % TURN.length]);

  const choose = useCallback((target: AvatarSlot, id: string) => {
    setUseDefault(false);
    setConfig(current => ({ ...current, [target]: id }));
  }, []);

  const randomize = () => {
    if (!parts) return;
    setUseDefault(false);
    setConfig(randomAvatar(parts));
  };

  const category = parts?.manifest.categories[slot];
  const groups = useMemo(() => (category ? groupStyles(category.items) : []), [category]);
  const currentId = config[slot];
  const currentGroup = groups.find(group => group.items.some(item => item.id === currentId)) ?? null;

  const trimmedName = name.trim();
  const save = async () => {
    if (!trimmedName || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const saved = await saveLobbyProfile(trimmedName, useDefault ? null : config);
      onSaved(saved);
    } catch (error) {
      // 404 / 405：后台进程还没有加载资料接口（请求落到了静态文件托管上），给出可操作的提示
      const outdated = error instanceof ApiError && (error.status === 404 || error.status === 405);
      setSaveError(outdated ? "后台服务尚未更新，请重启后台服务后再保存" : errorMessage(error));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="lobby-machine-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="lobby-machine lobby-avatar" role="dialog" aria-modal="true" aria-labelledby="lobby-avatar-title">
        <header className="lobby-machine-bar">
          <div className="lobby-machine-name">
            <span className="lobby-dot" aria-hidden="true" />
            <span id="lobby-avatar-title">形象与名字</span>
            <span className="lobby-machine-hint">换一身行头，再告诉大家你叫什么</span>
          </div>
          <div className="lobby-machine-actions">
            <button ref={closeRef} type="button" className="lobby-machine-close" onClick={onClose} aria-label="关闭面板，回到房间">
              <kbd>Esc</kbd>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </header>

        <div className="lobby-avatar-body">
          <aside className="lobby-avatar-side">
            <div className="lobby-avatar-stage">
              <span className="lobby-avatar-tag">{trimmedName || "未命名"}</span>
              <canvas
                ref={previewRef}
                className="lobby-avatar-preview"
                width={FRAME_WIDTH * PREVIEW_SCALE}
                height={FRAME_HEIGHT * PREVIEW_SCALE}
                role="img"
                aria-label="形象预览"
              />
              <div className="lobby-avatar-turn">
                <button type="button" className="button button-sm button-quiet" onClick={() => turn(-1)} aria-label="向左转">◀</button>
                <button type="button" className="button button-sm button-quiet" onClick={() => setWalking(w => !w)}>
                  {walking ? "走动中" : "站立"}
                </button>
                <button type="button" className="button button-sm button-quiet" onClick={() => turn(1)} aria-label="向右转">▶</button>
              </div>
            </div>

            <label className="field">
              <span className="field-label">名字</span>
              <input
                value={name}
                maxLength={LOBBY_NAME_MAX}
                placeholder="别人看到的名字"
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") void save(); }}
              />
              <span className="field-hint">多人同场时，其他人会在你头顶看到这个名字；你自己在场景里看不到。最多 {LOBBY_NAME_MAX} 个字。</span>
            </label>
          </aside>

          <div className="lobby-avatar-main">
            <div className="lobby-avatar-tabs" role="tablist" aria-label="部件分类">
              {AVATAR_SLOTS.map(item => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={slot === item}
                  className={`lobby-avatar-tab${slot === item ? " is-active" : ""}`}
                  onClick={() => setSlot(item)}
                >
                  {SLOT_LABELS[item]}
                </button>
              ))}
            </div>

            {loadError ? <p className="lobby-error-text">{loadError}</p> : null}
            {!parts && !loadError ? <div className="lobby-machine-loading"><span className="loading-line" /></div> : null}

            {parts && category ? (
              <>
                <div className="lobby-avatar-grid" role="listbox" aria-label={`${SLOT_LABELS[slot]}款式`}>
                  {category.optional ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={!useDefault && !currentId}
                      className={`lobby-avatar-option${!useDefault && !currentId ? " is-selected" : ""}`}
                      title="不戴"
                      onClick={() => choose(slot, "")}
                    >
                      <AvatarThumb parts={parts} config={{ ...config, [slot]: "" }} />
                      <span>不戴</span>
                    </button>
                  ) : null}
                  {groups.map((group, index) => {
                    const id = pickInStyle(group, currentId, category.items);
                    const selected = !useDefault && currentGroup === group;
                    const label = styleLabel(slot, group.style, index);
                    return (
                      <button
                        key={group.style}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`lobby-avatar-option${selected ? " is-selected" : ""}`}
                        title={label}
                        onClick={() => choose(slot, id)}
                      >
                        <AvatarThumb parts={parts} config={{ ...config, [slot]: id }} />
                        {slot === "accessory" ? <span>{label}</span> : null}
                      </button>
                    );
                  })}
                </div>

                {currentGroup && currentGroup.items.length > 1 && !useDefault ? (
                  <div className="lobby-avatar-variants">
                    <span className="field-label">配色</span>
                    <div className="lobby-avatar-variant-row">
                      {currentGroup.items.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          className={`lobby-avatar-option is-small${item.id === currentId ? " is-selected" : ""}`}
                          aria-label={`配色 ${item.variant}`}
                          aria-pressed={item.id === currentId}
                          onClick={() => choose(slot, item.id)}
                        >
                          <AvatarThumb parts={parts} config={{ ...config, [slot]: item.id }} />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <footer className="lobby-avatar-foot">
          <div className="lobby-avatar-foot-group">
            <button type="button" className="button button-sm button-secondary" onClick={randomize} disabled={!parts}>随机搭配</button>
            <button type="button" className="button button-sm button-quiet" onClick={() => setUseDefault(true)} disabled={useDefault}>
              恢复默认角色
            </button>
          </div>
          <div className="lobby-avatar-foot-group">
            {saveError ? <span className="lobby-error-text lobby-avatar-error">{saveError}</span> : null}
            <button type="button" className="button button-sm button-quiet" onClick={onClose}>取消</button>
            <button type="button" className="button button-sm button-primary" onClick={() => void save()} disabled={!trimmedName || saving}>
              {saving ? "正在保存…" : "保存"}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
