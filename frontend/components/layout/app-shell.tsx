"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { isActivePath, navigation } from "../../lib/navigation";
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";

interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  username?: string | null;
}

interface SidebarState {
  pathname: string;
  collapsed: boolean;
  menuOpen: boolean;
}

export function AppShell({ children, contentClassName = "" }: { children: ReactNode; contentClassName?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarState, setSidebarState] = useState<SidebarState>({ pathname, collapsed: pathname !== "/", menuOpen: false });
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState("");

  const routeChanged = sidebarState.pathname !== pathname;
  const sidebarCollapsed = routeChanged ? pathname !== "/" : sidebarState.collapsed;
  const menuOpen = routeChanged ? false : sidebarState.menuOpen;

  function updateSidebar(updater: (state: SidebarState) => SidebarState) {
    setSidebarState(current => updater(current.pathname === pathname ? current : {
      pathname,
      collapsed: pathname !== "/",
      menuOpen: false,
    }));
  }

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

  const current = useMemo(() => {
    for (const group of navigation) {
      const item = group.items.find(candidate => isActivePath(pathname, candidate.href));
      if (item) return item;
    }
    return navigation[0].items[0];
  }, [pathname]);

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  function toggleNavigation() {
    updateSidebar(current => window.matchMedia("(max-width: 767px)").matches
      ? { ...current, menuOpen: !current.menuOpen }
      : { ...current, collapsed: !current.collapsed });
  }

  if (authError) return <div className="app-error-screen">{authError}</div>;
  if (!auth || !auth.authenticated) return <div className="app-loading-screen"><span className="loading-line" />正在载入 HannisHub…</div>;

  const navigationOpen = menuOpen || !sidebarCollapsed;

  return (
    <div className="app-shell">
      <div className={`shell-overlay${menuOpen ? " is-visible" : ""}`} onClick={() => updateSidebar(current => ({ ...current, menuOpen: false }))} />
      <aside className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}${menuOpen ? " is-open" : ""}`} id="main-sidebar">
        <div className="brand-lockup">
          <Link href="/" className="brand-mark" aria-label="返回 HannisHub 首页">HH</Link>
          <div><strong>HannisHub</strong><span>本地管理工作台</span></div>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map(group => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              {group.items.map(item => (
                <Link className={`nav-item${isActivePath(pathname, item.href) ? " is-active" : ""}`} href={item.href} key={item.href} onClick={() => updateSidebar(current => ({ ...current, menuOpen: false }))} title={item.label}>
                  <span className="nav-icon"><Icon name={item.icon} /></span>
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
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
    </div>
  );
}
