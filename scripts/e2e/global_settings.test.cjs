// 在隔离 Hub 验证账号首页及管理员桌面通知测试。
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PW_CORE);
const origin = `http://127.0.0.1:${process.env.HUB_PORT || 18127}`;

async function login(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("e2e-test-pass-123");
  await page.getByRole("button", { name: "登录 HannisHub" }).click();
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  try {
    const admin = await browser.newContext({ permissions: ["notifications"], viewport: { width: 1360, height: 900 } });
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
    const send = page.getByRole("button", { name: "发送测试通知", exact: true });
    await send.click();
    await page.getByRole("status").filter({ hasText: "已请求显示测试通知" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.testNotices), [
      { title: "HannisHub 桌面通知测试", tag: "hannishub-desktop-notification-test" },
    ]);
    assert.equal(await page.evaluate(() => localStorage.getItem("hannishub_admin_desktop_notify")), null);
    assert.equal(await page.evaluate(() => window.permissionRequests), 0);

    await page.evaluate(() => { window.testPermission = "default"; });
    await send.click();
    await page.getByRole("status").filter({ hasText: "尚未授权" }).waitFor();
    assert.equal(await page.evaluate(() => window.permissionRequests), 1);
    await page.evaluate(() => { window.testPermission = "denied"; });
    await send.click();
    await page.getByRole("status").filter({ hasText: "通知权限已被阻止" }).waitFor();
    assert.equal(await page.evaluate(() => window.testNotices.length), 1);
    assert.equal(await page.evaluate(() => window.permissionRequests), 1);

    await page.evaluate(() => {
      window.testPermission = "default";
      window.testPermissionResponse = "granted";
    });
    await send.click();
    await page.getByRole("status").filter({ hasText: "已请求显示测试通知" }).waitFor();
    assert.equal(await page.evaluate(() => window.testNotices.length), 2);
    assert.equal(await page.evaluate(() => window.permissionRequests), 2);
    assert.equal(await page.evaluate(() => localStorage.getItem("hannishub_admin_desktop_notify")), null);

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
    await deepLink.goto(origin + "/settings/global");
    await login(deepLink, "lihan");
    await deepLink.waitForURL(/\/settings\/global\/?$/);
    await deepLink.getByRole("heading", { name: "全局设置", exact: true }).waitFor();

    const guest = await browser.newPage();
    await guest.goto(origin + "/login");
    await login(guest, "guest");
    await guest.waitForURL(/\/chat-lobby\/?$/);
    await guest.goto(origin);
    await guest.waitForURL(/\/chat-lobby\/?$/);
    await guest.goto(origin + "/settings/global/");
    await guest.waitForURL(/\/chat-lobby\/?$/);
    assert.equal(await guest.getByRole("button", { name: "发送测试通知", exact: true }).count(), 0);
    assert.equal((await guest.request.get(origin + "/settings/global/index.txt")).status(), 403);
    console.log("通过：管理员默认终端与深链、普通账号权限、原生桌面通知、权限提示、提醒开关隔离与窄屏。");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
