"use client";

import { useState } from "react";
import { requestAdminDesktopPermission } from "../../lib/admin-notify";
import { canUseDesktopNotifications, showDesktopNotification } from "../../lib/desktop-notify";
import { useShell } from "../layout/shell-context";
import { Button, Card, CardHeader } from "../ui/primitives";
import { NetworkRecoveryPanel } from "./network-recovery-panel";

const NOTIFICATION_ERROR = "浏览器未能显示通知，请检查系统通知设置后重试。";
const PERMISSION_DENIED = "通知权限已被阻止，请在地址栏的站点设置中允许通知后重试。";

export function GlobalSettingsPanel() {
  const shell = useShell();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  if (!shell?.admin) return null;

  function checkNotificationSupport() {
    if (canUseDesktopNotifications()) return true;
    setStatus(window.isSecureContext ? "当前浏览器不支持桌面通知。" : "桌面通知需要 HTTPS 或 localhost，请使用安全地址重新打开 HannisHub。");
    return false;
  }

  async function requestPermission() {
    if (!checkNotificationSupport()) return;
    setBusy(true);
    setStatus("");
    try {
      const permission = await requestAdminDesktopPermission();
      setStatus(permission === "granted" ? "已授权并开启新消息桌面提醒。"
        : permission === "denied" ? PERMISSION_DENIED : "尚未授权，请重新申请并选择允许。");
    } catch {
      setStatus("浏览器未能申请通知权限，请检查站点设置后重试。");
    } finally {
      setBusy(false);
    }
  }

  function testNotification() {
    if (!checkNotificationSupport()) return;
    if (Notification.permission !== "granted") {
      setStatus(Notification.permission === "denied" ? PERMISSION_DENIED : "尚未授权，请先点击「重新申请权限」。");
      return;
    }
    const sent = showDesktopNotification("HannisHub 桌面通知测试", {
      body: "你已成功收到 HannisHub 的桌面测试通知。",
      icon: "/icon.svg",
      tag: "hannishub-desktop-notification-test",
      silent: true,
    }, () => {}, () => setStatus(NOTIFICATION_ERROR));
    setStatus(sent ? "已请求显示测试通知，请查看桌面或系统通知中心。" : NOTIFICATION_ERROR);
  }

  return (
    <>
      <header className="page-header"><h1 className="page-title">全局设置</h1></header>
      <div className="stack-grid">
        <NetworkRecoveryPanel />
        <Card>
          <CardHeader title="桌面通知" description="授权后开启新消息桌面提醒，也可以发送一条测试通知检查当前浏览器。" />
          <div className="row-actions">
            <Button type="button" variant="secondary" onClick={requestPermission} disabled={busy}>重新申请权限</Button>
            <Button type="button" onClick={testNotification} disabled={busy}>发送测试通知</Button>
          </div>
          <div role="status">{status ? <p className="card-footer-note">{status}</p> : null}</div>
        </Card>
      </div>
    </>
  );
}
