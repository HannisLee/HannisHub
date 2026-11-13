"use client";

import { useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import Link from "next/link";
import { Icon } from "../ui/icon";
import { canVisitPage, isActivePath, navigation } from "../../lib/navigation";
import {
  isNavGroupCollapsed,
  moveKeyBefore,
  orderNavGroups,
  orderNavItems,
  readNavLayout,
  subscribeNavLayout,
  updateNavLayout,
  type NavLayoutState,
} from "../../lib/nav-layout";

const EMPTY_LAYOUT: NavLayoutState = { groupOrder: [], itemOrder: {}, collapsedGroups: [] };
const serverSnapshot = () => EMPTY_LAYOUT;
const NAV_DRAG_MIME = "application/x-hannishub-nav";

type DragState = { kind: "group"; groupId: string } | { kind: "item"; groupId: string; href: string };

interface SidebarNavProps {
  pathname: string;
  username: string | null | undefined;
  unread: number;
  /** 侧栏整体收起为图标列时，忽略分组折叠并关闭拖动排序 */
  iconMode: boolean;
  onNavigate: () => void;
}

export function SidebarNav({ pathname, username, unread, iconMode, onNavigate }: SidebarNavProps) {
  const layout = useSyncExternalStore(subscribeNavLayout, readNavLayout, serverSnapshot);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [dropItemHref, setDropItemHref] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressToggleRef = useRef(false);

  const groups = useMemo(() => orderNavGroups(navigation, layout)
    .map(group => ({
      ...group,
      items: orderNavItems(group.items, group.id, layout).filter(item => canVisitPage(username, item.href)),
    }))
    .filter(group => group.items.length), [layout, username]);

  function toggleGroup(event: MouseEvent<HTMLButtonElement>, groupId: string) {
    event.stopPropagation();
    if (suppressToggleRef.current) {
      suppressToggleRef.current = false;
      return;
    }
    updateNavLayout(current => {
      const collapsed = new Set(current.collapsedGroups);
      if (collapsed.has(groupId)) collapsed.delete(groupId);
      else collapsed.add(groupId);
      return { ...current, collapsedGroups: [...collapsed] };
    });
  }

  function startGroupDrag(event: DragEvent<HTMLDivElement>, groupId: string) {
    const next: DragState = { kind: "group", groupId };
    dragRef.current = next;
    suppressToggleRef.current = true;
    setDrag(next);
    setDropGroupId(null);
    setDropItemHref(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(NAV_DRAG_MIME, JSON.stringify(next));
  }

  function startItemDrag(event: DragEvent<HTMLAnchorElement>, groupId: string, href: string) {
    const next: DragState = { kind: "item", groupId, href };
    dragRef.current = next;
    setDrag(next);
    setDropGroupId(null);
    setDropItemHref(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(NAV_DRAG_MIME, JSON.stringify(next));
  }

  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    setDropGroupId(null);
    setDropItemHref(null);
    // 拖动结束后浏览器可能补发 click，稍后解除抑制，避免误触折叠
    window.setTimeout(() => { suppressToggleRef.current = false; }, 120);
  }

  function dragOverGroup(event: DragEvent<HTMLDivElement>, groupId: string) {
    if (dragRef.current?.kind !== "group") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropGroupId(groupId);
    setDropItemHref(null);
  }

  function dropOnGroup(event: DragEvent<HTMLDivElement>, targetGroupId: string) {
    event.preventDefault();
    const dragged = dragRef.current;
    endDrag();
    if (!dragged || dragged.kind !== "group" || dragged.groupId === targetGroupId) return;
    const currentOrder = groups.map(group => group.id);
    const nextOrder = moveKeyBefore(currentOrder, dragged.groupId, targetGroupId);
    updateNavLayout(current => ({ ...current, groupOrder: nextOrder }));
  }

  function dragOverItem(event: DragEvent<HTMLAnchorElement>, groupId: string, href: string) {
    const dragged = dragRef.current;
    if (dragged?.kind !== "item" || dragged.groupId !== groupId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropItemHref(href);
    setDropGroupId(null);
  }

  function dropOnItem(event: DragEvent<HTMLAnchorElement>, groupId: string, targetHref: string) {
    event.preventDefault();
    event.stopPropagation();
    const dragged = dragRef.current;
    endDrag();
    if (!dragged || dragged.kind !== "item" || dragged.groupId !== groupId || dragged.href === targetHref) return;
    const group = groups.find(candidate => candidate.id === groupId);
    if (!group) return;
    const currentOrder = group.items.map(item => item.href);
    const nextOrder = moveKeyBefore(currentOrder, dragged.href, targetHref);
    updateNavLayout(current => ({ ...current, itemOrder: { ...current.itemOrder, [groupId]: nextOrder } }));
  }

  const dragEnabled = !iconMode;

  return (
    <nav className="sidebar-nav" aria-label="主导航">
      {groups.map(group => {
        const collapsed = !iconMode && isNavGroupCollapsed(layout, group.id);
        const groupClass = [
          "nav-group",
          collapsed ? "is-collapsed" : "",
          drag?.kind === "group" && drag.groupId === group.id ? "is-dragging" : "",
          dropGroupId === group.id ? "is-drop-target" : "",
        ].filter(Boolean).join(" ");

        return (
          <div className={groupClass} key={group.id}>
            <div
              className="nav-group-head"
              draggable={dragEnabled}
              onDragStart={event => startGroupDrag(event, group.id)}
              onDragEnd={endDrag}
              onDragOver={event => dragOverGroup(event, group.id)}
              onDrop={event => dropOnGroup(event, group.id)}
              title={dragEnabled ? "拖动调整分组顺序" : undefined}
            >
              <button
                className="nav-group-toggle"
                type="button"
                onClick={event => toggleGroup(event, group.id)}
                aria-expanded={!collapsed}
                aria-controls={`nav-group-${group.id}`}
                title={collapsed ? `展开${group.label}` : `收起${group.label}`}
              >
                <Icon name="chevronDown" className="nav-group-chevron" />
                <span className="nav-group-label">{group.label}</span>
              </button>
              <span className="nav-group-grip" aria-hidden="true"><Icon name="grip" /></span>
            </div>
            {collapsed ? null : (
              <div className="nav-group-items" id={`nav-group-${group.id}`}>
                {group.items.map(item => (
                  <Link
                    className={[
                      "nav-item",
                      isActivePath(pathname, item.href) ? "is-active" : "",
                      drag?.kind === "item" && drag.href === item.href ? "is-dragging" : "",
                      dropItemHref === item.href ? "is-drop-target" : "",
                    ].filter(Boolean).join(" ")}
                    href={item.href}
                    key={item.href}
                    onClick={onNavigate}
                    title={item.label}
                    aria-label={item.label}
                    draggable={dragEnabled}
                    onDragStart={event => startItemDrag(event, group.id, item.href)}
                    onDragEnd={endDrag}
                    onDragOver={event => dragOverItem(event, group.id, item.href)}
                    onDrop={event => dropOnItem(event, group.id, item.href)}
                  >
                    <span className="nav-icon"><Icon name={item.icon} /></span>
                    <span className="nav-item-label">{item.label}</span>
                    {item.href === "/chat" && unread > 0 ? <span className="nav-badge" aria-label={`${unread} 条未读`}>{unread > 99 ? "99+" : unread}</span> : null}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
