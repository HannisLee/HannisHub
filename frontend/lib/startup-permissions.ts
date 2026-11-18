/** 同一页面的外壳重新挂载时共用申请流程，避免并发弹窗。 */
let pending: Promise<void> | null = null;

export function requestStartupPermissions(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    if (!window.isSecureContext) return;
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* 浏览器可能限制非交互申请 */ }
    }
  })().finally(() => { pending = null; });
  return pending;
}
