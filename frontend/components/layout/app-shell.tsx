"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { canVisitPage, isActivePath, isAdmin, navigation, navTitle, REGULAR_HOME } from "../../lib/navigation";
import type { AuthStatus } from "../../lib/types";
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";
import { ChatToastView, useChatNotify, useChatNotifyEffects, useChatWatcher } from "../chatworld/room/chat-watcher";
import { DocumentTitle } from "./document-title";
import { ShellContext, type ShellInfo } from "./shell-context";
import { SidebarNav } from "./sidebar-nav";

/** 侧栏收起状态保存在浏览器，刷新与跨页面跳转后保持同一形态 */
const COLLAPSE_STORAGE_KEY = "hannishub_sidebar_collapsed";
const COLLAPSE_CHANGE_EVENT = "hannishub:sidebar-collapse-change";
const MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    return;
  }
  window.dispatchEvent(new Event(COLLAPSE_CHANGE_EVENT));
}

function subscribeSidebarCollapsed(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSE_CHANGE_EVENT, onChange);
  };
}

function subscribeMobileViewport(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 静态导出的构建期没有浏览器环境，服务端快照统一回退到默认形态 */
const serverSnapshot = () => false;

interface AppShellProps {
  children: ReactNode;
  contentClassName?: string;
  /** 普通账号访问时整页显示页面内容（不渲染侧栏与顶栏），管理员仍使用完整外壳 */
  immersiveForRegular?: boolean;
}

export function AppShell({ children, contentClassName = "", immersiveForRegular = false }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const sidebarCollapsed = useSyncExternalStore(subscribeSidebarCollapsed, readSidebarCollapsed, serverSnapshot);
  const isMobile = useSyncExternalStore(subscribeMobileViewport, isMobileViewport, serverSnapshot);
  const [drawer, setDrawer] = useState({ pathname, open: false });
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState("");

  // 抽屉只在当前路径下有效，切换页面即自动收起
  const mobileDrawerOpen = drawer.pathname === pathname && drawer.open;

  const current = useMemo(() => {
    for (const group of navigation) {
      const item = group.items.find(candidate => isActivePath(pathname, candidate.href));
      if (item) return item;
    }
    return navigation[0].items[0];
  }, [pathname]);
  const pageTitle = navTitle(current);

  // 聊天室新消息提醒：聊天室页面与内嵌聊天面板由聊天组件自己处理，其他情况在后台检查
  const onChatPage = pathname === "/chat" || pathname === "/chat/";
  const { unread, embedded } = useChatNotify();
  useChatWatcher(!!auth?.authenticated && !onChatPage && !embedded);
  useChatNotifyEffects(unread);

  useEffect(() => {
    let active = true;
    apiFetch<AuthStatus>("/api/auth/status")
      .then(value => {
        if (active) setAuth(value);
        if (active && !value.authenticated) {
          router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        }
      })
      .catch(error => { if (active) setAuthError(error instanceof Error ? error.message : "无法读取登录状态"); });
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    const redirect = (event: Event) => {
      const next = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : window.location.pathname;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    };
    window.addEventListener("hannishub:unauthorized", redirect);
    return () => window.removeEventListener("hannishub:unauthorized", redirect);
  }, [router]);

  useEffect(() => {
    if (auth?.authenticated && !canVisitPage(auth.username, pathname)) router.replace(REGULAR_HOME);
  }, [auth, pathname, router]);

  /** 桌面端切换侧栏的展开/收起，移动端切换抽屉 */
  const toggleNavigation = useCallback(() => {
    if (isMobileViewport()) {
      setDrawer(current => ({ pathname, open: !(current.pathname === pathname && current.open) }));
      return;
    }
    writeSidebarCollapsed(!readSidebarCollapsed());
  }, [pathname]);

  const closeDrawer = useCallback(() => setDrawer(current => ({ ...current, open: false })), []);

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }, [router]);

  const admin = isAdmin(auth?.username);
  const immersive = immersiveForRegular && !!auth?.authenticated && !admin;
  const shellInfo = useMemo<ShellInfo>(
    () => ({ username: auth?.username ?? "", admin, immersive, logout }),
    [auth?.username, admin, immersive, logout],
  );

  if (authError) return <div className="app-error-screen"><DocumentTitle title="无法连接" />{authError}</div>;
  if (!auth || !auth.authenticated) {
    return <div className="app-loading-screen"><DocumentTitle title="载入中" /><span className="loading-line" />正在载入 HannisHub…</div>;
  }

  if (!canVisitPage(auth.username, pathname)) {
    return <div className="app-loading-screen"><DocumentTitle title="载入中" />正在前往聊天大厅…</div>;
  }

  if (immersive) {
    return (
      <ShellContext.Provider value={shellInfo}>
        <DocumentTitle title={pageTitle} unread={unread} />
        <main className={`immersive-container${contentClassName ? ` ${contentClassName}` : ""}`}>{children}</main>
      </ShellContext.Provider>
    );
  }

  // 移动端侧栏始终是抽屉形态，收起形态只在桌面端生效
  const collapsed = sidebarCollapsed && !isMobile;
  const navigationOpen = isMobile ? mobileDrawerOpen : !collapsed;

  return (
    <ShellContext.Provider value={shellInfo}>
      <div className="app-shell">
        <DocumentTitle title={pageTitle} unread={unread} />
        <div className={`shell-overlay${mobileDrawerOpen ? " is-visible" : ""}`} onClick={closeDrawer} />
        <aside className={`sidebar${collapsed ? " is-collapsed" : ""}${mobileDrawerOpen ? " is-open" : ""}`} id="main-sidebar">
          <div className="sidebar-head">
            <div className="brand-lockup">
              <Link href={admin ? "/" : REGULAR_HOME} className="brand-mark" aria-label="返回 HannisHub 首页" title="返回 HannisHub 首页">HH</Link>
              <div><strong>HannisHub</strong><span>本地管理工作台</span></div>
            </div>
            <button
              className="sidebar-toggle"
              type="button"
              onClick={toggleNavigation}
              aria-expanded={navigationOpen}
              aria-controls="main-sidebar"
              aria-label={navigationOpen ? "收起侧栏" : "展开侧栏"}
              title={navigationOpen ? "收起侧栏" : "展开侧栏"}
            >
              <Icon name={navigationOpen ? "panelCollapse" : "panelExpand"} />
            </button>
          </div>
          <SidebarNav
            pathname={pathname}
            username={auth.username}
            unread={unread}
            iconMode={collapsed}
            onNavigate={closeDrawer}
          />
          <div className="sidebar-footer">
            <div className="sidebar-status"><span className="status-dot" />FastAPI 在线</div>
            <span className="sidebar-version">HannisHub workspace</span>
          </div>
        </aside>
        <div className="shell-content">
          <header className="topbar">
            <button className="menu-toggle" type="button" onClick={toggleNavigation} aria-expanded={navigationOpen} aria-controls="main-sidebar" aria-label={navigationOpen ? "收起导航" : "展开导航"}>☰</button>
            <div className="topbar-context"><span>HANNISHUB</span><b>/</b><strong>{current.label}</strong></div>
            <div className="topbar-user">
              <span className="user-name">{auth.username || "管理员"}</span>
              <Button variant="quiet" size="sm" onClick={logout}>退出</Button>
            </div>
          </header>
          <main className={`content-container${contentClassName ? ` ${contentClassName}` : ""}`}>{children}</main>
        </div>
        {onChatPage ? null : <ChatToastView />}
      </div>
    </ShellContext.Provider>
  );
}
