/** 同一页面的外壳重新挂载时共用申请流程，避免并发弹窗。 */
let pending: Promise<void> | null = null;

export function requestStartupPermissions(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    if (!window.isSecureContext) return;
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* 浏览器可能限制非交互申请 */ }
    }
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      if (navigator.permissions?.query) {
        try {
          const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
          if (permission.state !== "prompt") return;
        } catch { /* 不支持查询时由浏览器处理既有权限 */ }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch { /* 用户拒绝、无设备或浏览器不支持时不影响页面 */ }
  })().finally(() => { pending = null; });
  return pending;
}
