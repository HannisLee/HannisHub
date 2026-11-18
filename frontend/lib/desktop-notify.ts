/** 浏览器桌面通知入口；调用方负责权限、提醒策略和跨标签页去重。 */
export function canUseDesktopNotifications(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "Notification" in window;
}

export function showDesktopNotification(title: string, options: NotificationOptions, onClick: () => void): void {
  if (!canUseDesktopNotifications() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => { window.focus(); onClick(); notification.close(); };
    setTimeout(() => notification.close(), 20000);
  } catch { /* 浏览器通知不可用时不影响其他提醒 */ }
}
