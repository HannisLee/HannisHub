/** 浏览器桌面通知入口；调用方负责权限、提醒策略和跨标签页去重。 */
export function canUseDesktopNotifications(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "Notification" in window;
}

export function showDesktopNotification(
  title: string,
  options: NotificationOptions,
  onClick: () => void,
  onError?: () => void,
): boolean {
  if (!canUseDesktopNotifications() || Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => { window.focus(); onClick(); notification.close(); };
    if (onError) notification.onerror = onError;
    setTimeout(() => notification.close(), 20000);
    return true;
  } catch {
    return false;
  }
}
