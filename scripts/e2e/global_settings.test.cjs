// 在隔离 Hub 验证账号首页、桌面通知和本机网络恢复设置。
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PW_CORE);
const origin = `http://127.0.0.1:${process.env.HUB_PORT || 18127}`;

async function login(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("e2e-test-pass-123");
  await page.getByRole("button", { name: "登录 HannisHub" }).click();
}

async function watchNotificationConnection(target) {
  await target.addInitScript(() => {
    window.notificationConnected = false;
    window.WebSocket = class extends window.WebSocket {
      constructor(...args) {
        super(...args);
        if (this.url.endsWith("/api/notifications/ws")) {
          this.addEventListener("open", () => { window.notificationConnected = true; });
          this.addEventListener("close", () => { window.notificationConnected = false; });
        }
      }
    };
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  try {
    const admin = await browser.newContext({ permissions: ["notifications"], viewport: { width: 1360, height: 900 } });
    await watchNotificationConnection(admin);
    await admin.addInitScript(() => {
      const Native = window.Notification;
      window.testNotices = [];
      window.permissionRequests = 0;
      window.Notification = class extends Native {
        constructor(title, options) {
          super(title, options);
          window.testNotices.push({ title, tag: options.tag });
        }
        static get permission() {
          return window.testPermission ?? Native.permission;
        }
        static requestPermission() {
          window.permissionRequests++;
          return Promise.resolve(window.testPermissionResponse ?? this.permission);
        }
      };
    });
    const page = await admin.newPage();
    await page.goto(origin);
    await page.waitForURL(/\/login\?next=\/$/);
    await login(page, "lihan");
    await page.waitForURL(/\/terminal\/?$/);

    const sidebar = page.locator("#main-sidebar");
    const settings = sidebar.getByRole("link", { name: "全局设置", exact: true });
    await settings.waitFor();
    assert.equal(await sidebar.getByText(/总览|Overview/).count(), 0);
    await settings.click();
    await page.getByRole("heading", { name: "全局设置", exact: true }).waitFor();
    await page.getByRole("heading", { name: "本机网络恢复", exact: true }).waitFor();
    await page.getByText("巡检尚未运行", { exact: true }).waitFor();
    const recoveryUrl = origin + "/api/network-recovery";
    const pauseRecovery = page.getByRole("button", { name: "暂停自动恢复" });
    const enableRecovery = page.getByRole("button", { name: "启用自动恢复" });
    const [saved] = await Promise.all([
      page.waitForResponse(response => response.url() === recoveryUrl && response.request().method() === "PUT"),
      pauseRecovery.click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.deepEqual(await saved.json(), { enabled: false, monitor: null });
    assert.equal((await page.request.put(recoveryUrl, {
      headers: { Origin: "https://evil.invalid" },
      data: { enabled: true },
    })).status(), 403);
    await page.reload();
    await enableRecovery.waitFor();
    await enableRecovery.click();
    await pauseRecovery.waitFor();
    const send = page.getByRole("button", { name: "发送测试通知", exact: true });
    await send.click();
    await page.getByRole("status").filter({ hasText: "已请求显示测试通知" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.testNotices), [
      { title: "HannisHub 桌面通知测试", tag: "hannishub-desktop-notification-test" },
    ]);
    assert.equal(await page.evaluate(() => localStorage.getItem("hannishub_admin_desktop_notify")), null);
    assert.equal(await page.evaluate(() => window.permissionRequests), 0);

    const reapply = page.getByRole("button", { name: "重新申请权限", exact: true });
    await page.evaluate(() => { window.testPermission = "default"; });
    await send.click();
    await page.getByRole("status").filter({ hasText: "尚未授权" }).waitFor();
    assert.equal(await page.evaluate(() => window.permissionRequests), 0);
    await reapply.click();
    await page.getByRole("status").filter({ hasText: "重新申请并选择允许" }).waitFor();
    assert.equal(await page.evaluate(() => window.permissionRequests), 1);

    await page.evaluate(() => { window.testPermission = "denied"; });
    await reapply.click();
    await page.getByRole("status").filter({ hasText: "通知权限已被阻止" }).waitFor();
    assert.equal(await page.evaluate(() => window.testNotices.length), 1);
    assert.equal(await page.evaluate(() => window.permissionRequests), 2);

    await page.evaluate(() => { window.testPermission = "granted"; });
    await reapply.click();
    await page.getByRole("status").filter({ hasText: "已授权并开启新消息桌面提醒" }).waitFor();
    assert.equal(await page.evaluate(() => window.permissionRequests), 3);
    assert.equal(await page.evaluate(() => window.testNotices.length), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("hannishub_admin_desktop_notify")), "on");
    await page.getByRole("button", { name: "消息提醒设置", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: "桌面通知", exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await send.click();
    await page.getByRole("status").filter({ hasText: "已请求显示测试通知" }).waitFor();
    assert.equal(await page.evaluate(() => window.testNotices.length), 2);
    assert.equal(await page.evaluate(() => window.permissionRequests), 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { Object.defineProperty(window, "isSecureContext", { value: false }); });
    await send.click();
    await page.getByRole("status").filter({ hasText: "HTTPS 或 localhost" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.setViewportSize({ width: 1360, height: 900 });
    await sidebar.getByRole("link", { name: "返回 HannisHub 首页" }).click();
    await page.waitForURL(/\/terminal\/?$/);
    await page.goto(origin);
    await page.waitForURL(/\/terminal\/?$/);

    const deepLink = await browser.newPage();
    await watchNotificationConnection(deepLink);
    await deepLink.goto(origin + "/settings/global");
    await login(deepLink, "lihan");
    await deepLink.waitForURL(/\/settings\/global\/?$/);
    await deepLink.getByRole("heading", { name: "全局设置", exact: true }).waitFor();

    const guestContext = await browser.newContext();
    await watchNotificationConnection(guestContext);
    const guest = await guestContext.newPage();
    await guest.goto(origin + "/login");
    await login(guest, "guest");
    await guest.waitForURL(/\/chat-lobby\/?$/);
    await guest.goto(origin);
    await guest.waitForURL(/\/chat-lobby\/?$/);
    await guest.goto(origin + "/settings/global/");
    await guest.waitForURL(/\/chat-lobby\/?$/);
    assert.equal(await guest.getByRole("button", { name: "发送测试通知", exact: true }).count(), 0);
    assert.equal((await guest.request.get(origin + "/settings/global/index.txt")).status(), 403);
    assert.equal((await guest.request.get(recoveryUrl)).status(), 403);
    const anotherGuestTab = await guestContext.newPage();
    await anotherGuestTab.goto(origin + "/chat");
    for (const online of [page, deepLink, guest, anotherGuestTab]) {
      await online.waitForFunction(() => window.notificationConnected);
    }
    const broadcastUrl = origin + "/api/notifications/broadcast-test";
    assert.equal((await guest.request.post(broadcastUrl, { headers: { Origin: origin } })).status(), 403);
    assert.equal((await deepLink.request.post(broadcastUrl, { headers: { Origin: "https://evil.invalid" } })).status(), 403);
    await deepLink.getByRole("button", { name: "向所有在线会话发送测试通知", exact: true }).click();
    await deepLink.getByText("已向 2 个在线账号的 4 个浏览器会话发送广播。", { exact: true }).waitFor();
    for (const online of [page, deepLink, guest, anotherGuestTab]) {
      await online.getByRole("region", { name: "HannisHub 在线广播测试" }).waitFor();
    }
    await page.waitForFunction(() => window.testNotices.some(notice => notice.title === "HannisHub 在线广播测试"));
    await guest.getByRole("button", { name: "允许桌面通知", exact: true }).waitFor();
    console.log("通过：全局设置、桌面权限、多个账号及多个会话的在线广播、管理员及来源限制。");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
