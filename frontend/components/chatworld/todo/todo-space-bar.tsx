"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { TODO_SPACE_MAX, TODO_SPACE_NAME_MAX, type TodoSpace } from "../../../lib/todos";
import { Button } from "../../ui/primitives";

interface DeleteOptions {
  moveTo?: string;
  deleteTodos?: boolean;
}

interface TodoSpaceBarProps {
  spaces: TodoSpace[];
  activeId: string;
  /** 每个分区「今天」待完成的条数，显示在分区名后（0 不显示） */
  todayCounts: Record<string, number>;
  /** 每个分区的待办总数（含已完成），删除分区时用来决定是否需要选择去向 */
  totals: Record<string, number>;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onReorder: (ids: string[]) => void;
  onDelete: (id: string, options: DeleteOptions) => Promise<boolean>;
}

/** 下一帧把焦点放回某个分区标签（重命名框等卸载之后） */
function focusTab(id: string) {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>(`[data-space-tab="${id}"]`)?.focus();
  });
}

interface SpaceDrop {
  id: string;
  position: "before" | "after";
}

/** 分区切换条：点击切换，双击或 F2 重命名，「⋯」菜单里重命名、移动与删除；
 *  鼠标可直接左右拖动分区调整顺序，触屏用菜单里的「左移 / 右移」。 */
export function TodoSpaceBar({
  spaces, activeId, todayCounts, totals, onSelect, onCreate, onRename, onReorder, onDelete,
}: TodoSpaceBarProps) {
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState<"move" | "delete">("move");
  const [moveTo, setMoveTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ id: string; target: SpaceDrop | null } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const committingRef = useRef(false);
  const suppressClickRef = useRef(false);

  const deleting = spaces.find(space => space.id === deletingId) ?? null;
  const menuIndex = spaces.findIndex(space => space.id === menuId);
  const menuSpace = menuIndex >= 0 ? spaces[menuIndex] : null;
  const deletingTotal = deleting ? totals[deleting.id] ?? 0 : 0;
  const moveTargets = spaces.filter(space => space.id !== deletingId);

  // 菜单打开时：点外面或按 Esc 关闭，并把焦点放到第一项
  useEffect(() => {
    if (!menuId) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // 点「⋯」由按钮自己切换，点菜单内部不关闭
      if (menuRef.current?.contains(target) || target?.closest?.(".todo-space-more")) return;
      setMenuId(null);
    };
    // 标签条横向滚动后菜单位置会错开，直接关闭
    const tabs = tabsRef.current;
    const onScroll = () => setMenuId(null);
    tabs?.addEventListener("scroll", onScroll, { passive: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const id = menuId;
      setMenuId(null);
      focusTab(id);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      tabs?.removeEventListener("scroll", onScroll);
    };
  }, [menuId]);

  function toggleMenu(button: HTMLElement, id: string) {
    if (menuId === id) {
      setMenuId(null);
      return;
    }
    // 菜单放在标签条外（标签条可横向滚动，会裁掉弹出层），按「⋯」按钮的位置定位
    const root = rootRef.current?.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (root) {
      const width = 140;
      setMenuPos({ top: rect.bottom - root.top + 4, left: Math.max(0, Math.min(rect.left - root.left, root.width - width)) });
    }
    setMenuId(id);
  }

  function startRename(space: TodoSpace) {
    setMenuId(null);
    setRenamingId(space.id);
    setRenameDraft(space.name);
  }

  async function commitRename(space: TodoSpace) {
    if (committingRef.current) return;
    const name = renameDraft.trim();
    if (!name || name === space.name) {
      setRenamingId(null);
      focusTab(space.id);
      return;
    }
    committingRef.current = true;
    const ok = await onRename(space.id, name);
    committingRef.current = false;
    if (ok) {
      setRenamingId(null);
      focusTab(space.id);
    }
  }

  async function commitCreate() {
    if (committingRef.current) return;
    const name = createDraft.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    committingRef.current = true;
    const ok = await onCreate(name);
    committingRef.current = false;
    if (ok) {
      setCreating(false);
      setCreateDraft("");
    }
  }

  function move(space: TodoSpace, delta: number) {
    const ids = spaces.map(item => item.id);
    const index = ids.indexOf(space.id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(next, 0, space.id);
    onReorder(ids);
    setMenuId(null);
    focusTab(space.id);
  }

  function openDelete(space: TodoSpace) {
    setMenuId(null);
    setDeletingId(space.id);
    setDeleteMode("move");
    setMoveTo(spaces.find(item => item.id !== space.id)?.id ?? "");
  }

  async function confirmDelete() {
    if (!deleting || busy) return;
    setBusy(true);
    const options: DeleteOptions = deletingTotal === 0 ? {} : deleteMode === "move" ? { moveTo } : { deleteTodos: true };
    const ok = await onDelete(deleting.id, options);
    setBusy(false);
    if (ok) setDeletingId(null);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, space: TodoSpace) {
    const index = spaces.findIndex(item => item.id === space.id);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % spaces.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + spaces.length) % spaces.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = spaces.length - 1;
    else if (event.key === "F2") {
      event.preventDefault();
      startRename(space);
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    onSelect(spaces[next].id);
    // 目标标签已在页面上，立即移动焦点，连续按键时不会落后一帧
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-space-tab="${spaces[next].id}"]`)?.focus();
  }

  /** 鼠标 / 触控笔拖动排序：按下后横向移动超过 6px 才开始拖动，松开落到指示线位置，Esc 取消 */
  function onTabPointerDown(event: ReactPointerEvent<HTMLButtonElement>, space: TodoSpace) {
    if (event.button !== 0 || event.pointerType === "touch" || spaces.length < 2 || drag) return;
    const item = event.currentTarget.closest<HTMLElement>(".todo-space-item");
    const bar = tabsRef.current;
    if (!item || !bar) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const order = spaces.map(entry => entry.id);
    const fromIndex = order.indexOf(space.id);
    let started = false;
    let target: SpaceDrop | null = null;

    const compute = (x: number): SpaceDrop | null => {
      const others = [...bar.querySelectorAll<HTMLElement>(".todo-space-item[data-space-id]")]
        .filter(el => el.dataset.spaceId !== space.id);
      if (!others.length) return null;
      let next: SpaceDrop = { id: others[others.length - 1].dataset.spaceId!, position: "after" };
      for (const el of others) {
        const rect = el.getBoundingClientRect();
        if (x < rect.left + rect.width / 2) {
          next = { id: el.dataset.spaceId!, position: "before" };
          break;
        }
      }
      const rest = order.filter(id => id !== space.id);
      const insertAt = rest.indexOf(next.id) + (next.position === "after" ? 1 : 0);
      return insertAt === fromIndex ? null : next;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < 6) return;
        started = true;
        document.documentElement.classList.add("todo-is-dragging");
        setDrag({ id: space.id, target: null });
      }
      item.style.transform = `translateX(${dx}px)`;
      const next = compute(e.clientX);
      if (next?.id !== target?.id || next?.position !== target?.position) {
        target = next;
        setDrag({ id: space.id, target: next });
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (!started) return;
      item.style.transform = "";
      document.documentElement.classList.remove("todo-is-dragging");
      setDrag(null);
      // 拖动结束后浏览器仍会派发一次 click，忽略它，避免误切换分区
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (!commit || !target) return;
      const rest = order.filter(id => id !== space.id);
      rest.splice(rest.indexOf(target.id) + (target.position === "after" ? 1 : 0), 0, space.id);
      onReorder(rest);
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(true); };
    const onCancel = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(false); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !started) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  return (
    <div className="todo-spaces" ref={rootRef}>
      <div className="todo-space-tabs" ref={tabsRef} role="tablist" aria-label="待办分区">
        {spaces.map(space => {
          const active = space.id === activeId;
          const count = todayCounts[space.id] ?? 0;
          const dropClass = drag?.target?.id === space.id ? ` is-drop-${drag.target.position}` : "";
          if (renamingId === space.id) {
            return (
              <div key={space.id} className="todo-space-item is-editing" data-space-id={space.id}>
                <input
                  className="todo-space-input"
                  autoFocus
                  value={renameDraft}
                  maxLength={TODO_SPACE_NAME_MAX}
                  size={Math.max(4, Array.from(renameDraft).length + 1)}
                  aria-label={`重命名分区「${space.name}」`}
                  onChange={event => setRenameDraft(event.target.value)}
                  onFocus={event => event.currentTarget.select()}
                  onBlur={() => void commitRename(space)}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename(space);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                      focusTab(space.id);
                    }
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={space.id}
              className={`todo-space-item${active ? " is-active" : ""}${drag?.id === space.id ? " is-dragging" : ""}${dropClass}`}
              data-space-id={space.id}
            >
              <button
                type="button"
                role="tab"
                id={`todo-space-tab-${space.id}`}
                data-space-tab={space.id}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="todo-space-tab"
                title={`${space.name}${count ? ` · 今天待完成 ${count} 条` : ""}（双击重命名${spaces.length > 1 ? "，拖动调整顺序" : ""}）`}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  onSelect(space.id);
                }}
                onDoubleClick={() => startRename(space)}
                onKeyDown={event => onTabKeyDown(event, space)}
                onPointerDown={event => onTabPointerDown(event, space)}
              >
                <span className="todo-space-name">{space.name}</span>
                {count > 0 ? <span className="todo-space-count" aria-label={`今天待完成 ${count} 条`}>{count}</span> : null}
              </button>
              {active ? (
                <button
                  type="button"
                  className={`todo-space-more${menuId === space.id ? " is-open" : ""}`}
                  aria-label={`管理分区「${space.name}」`}
                  aria-haspopup="menu"
                  aria-expanded={menuId === space.id}
                  onClick={event => toggleMenu(event.currentTarget, space.id)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
                </button>
              ) : null}
            </div>
          );
        })}
        {creating ? (
          <div className="todo-space-item is-editing">
            <input
              className="todo-space-input"
              autoFocus
              value={createDraft}
              maxLength={TODO_SPACE_NAME_MAX}
              size={Math.max(6, Array.from(createDraft).length + 1)}
              placeholder="分区名称"
              aria-label="新分区名称"
              onChange={event => setCreateDraft(event.target.value)}
              onBlur={() => void commitCreate()}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitCreate();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                  setCreateDraft("");
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="todo-space-add"
            disabled={spaces.length >= TODO_SPACE_MAX}
            title={spaces.length >= TODO_SPACE_MAX ? `分区最多 ${TODO_SPACE_MAX} 个` : "新建分区，例如「学习」「生活」"}
            onClick={() => { setCreating(true); setCreateDraft(""); }}
          >
            <span aria-hidden="true">+</span> 新分区
          </button>
        )}
      </div>

      {menuSpace ? (
        <div
          className="todo-space-menu"
          role="menu"
          ref={menuRef}
          aria-label={`分区「${menuSpace.name}」`}
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button type="button" role="menuitem" onClick={() => startRename(menuSpace)}>重命名</button>
          <button type="button" role="menuitem" disabled={menuIndex === 0} onClick={() => move(menuSpace, -1)}>左移</button>
          <button type="button" role="menuitem" disabled={menuIndex === spaces.length - 1} onClick={() => move(menuSpace, 1)}>右移</button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={spaces.length <= 1}
            title={spaces.length <= 1 ? "至少保留一个分区" : undefined}
            onClick={() => openDelete(menuSpace)}
          >
            删除分区
          </button>
        </div>
      ) : null}

      {deleting ? (
        <div className="todo-space-delete" role="group" aria-label={`删除分区「${deleting.name}」`}>
          {deletingTotal === 0 ? (
            <p>删除空分区「{deleting.name}」？</p>
          ) : (
            <>
              <p>「{deleting.name}」里还有 {deletingTotal} 条待办（含已完成），删除前请选择它们的去向：</p>
              <label className="todo-space-choice">
                <input type="radio" name="todo-space-delete" checked={deleteMode === "move"} onChange={() => setDeleteMode("move")} />
                <span>移到</span>
                <select
                  className="select-compact"
                  value={moveTo}
                  aria-label="移到哪个分区"
                  onChange={event => { setMoveTo(event.target.value); setDeleteMode("move"); }}
                >
                  {moveTargets.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                </select>
              </label>
              <label className="todo-space-choice">
                <input type="radio" name="todo-space-delete" checked={deleteMode === "delete"} onChange={() => setDeleteMode("delete")} />
                <span>连同待办一起删除（无法撤销）</span>
              </label>
            </>
          )}
          <div className="todo-space-delete-actions">
            <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => setDeletingId(null)}>取消</Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || (deletingTotal > 0 && deleteMode === "move" && !moveTo)}
              onClick={() => void confirmDelete()}
            >
              {busy ? "删除中…" : deletingTotal && deleteMode === "delete" ? `删除分区和 ${deletingTotal} 条待办` : "删除分区"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
