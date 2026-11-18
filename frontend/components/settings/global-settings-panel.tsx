"use client";

import { useState } from "react";
import { canUseDesktopNotifications } from "../../lib/admin-notify";
import { useShell } from "../layout/shell-context";
import { Button, Card, CardHeader } from "../ui/primitives";

const NOTIFICATION_ERROR = "浏览器未能显示通知，请检查系统通知设置后重试。";

export function GlobalSettingsPanel() {
  const shell = useShell();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  if (!shell?.admin) return null;

  async function testNotification() {
    if (!canUseDesktopNotifications()) {
      setStatus(window.isSecureContext ? "当前浏览器不支持桌面通知。" : "桌面通知需要 HTTPS 或 localhost，请使用安全地址重新打开 HannisHub。");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "通知权限已被阻止，请在地址栏的站点设置中允许通知后重试。" : "尚未授权，请再次点击测试并选择允许。");
        return;
      }
      const notification = new Notification("HannisHub 桌面通知测试", {
        body: "你已成功收到 HannisHub 的桌面测试通知。",
        icon: "/icon.svg",
        tag: "hannishub-desktop-notification-test",
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      notification.onerror = () => setStatus(NOTIFICATION_ERROR);
      setStatus("已请求显示测试通知，请查看桌面或系统通知中心。");
    } catch {
      setStatus(NOTIFICATION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header"><h1 className="page-title">全局设置</h1></header>
      <div className="stack-grid">
        <Card>
          <CardHeader title="桌面通知" description="发送一条测试通知到当前浏览器。首次测试时，请在浏览器提示里选择允许。" />
          <Button type="button" onClick={testNotification} disabled={busy}>{busy ? "正在检查权限…" : "发送测试通知"}</Button>
          <div role="status">{status ? <p className="card-footer-note">{status}</p> : null}</div>
        </Card>
      </div>
    </>
  );
}
