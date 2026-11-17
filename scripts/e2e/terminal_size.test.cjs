// 只连接 launch_test_hub.py 启动的隔离 Hub，验证终端尺寸恢复与隐藏会话重连。
// PW_CORE=<playwright-core 目录> HUB_PORT=18094 node scripts/e2e/terminal_size.test.cjs
const { chromium } = require(process.env.PW_CORE);
const assert = require("node:assert/strict");
const port = Number(process.env.HUB_PORT || 18094);
assert.notEqual(port, 8081, "禁止连接线上 Hub");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.terminalSockets = [];
    window.terminalSizes = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        window.terminalSockets.push(this);
      }
      send(data) {
        const message = JSON.parse(data);
        if (message.type === "resize") window.terminalSizes.push({ url: this.url, ...message });
        super.send(data);
      }
    };
  });
  const ids = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/login`);
    assert.equal(await page.evaluate(async () => (await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "lihan", password: "e2e-test-pass-123" }),
    })).status), 200);
    for (let i = 0; i < 2; i++) {
      ids.push(await page.evaluate(async () => {
        const response = await fetch("/api/terminal/sessions", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (!response.ok) throw new Error(`创建终端失败：${response.status}`);
        return (await response.json()).session.id;
      }));
    }
    await page.goto(`http://127.0.0.1:${port}/terminal`);
    await page.waitForFunction(() => window.terminalSizes.some(size => size.cols > 100));
    const original = await page.evaluate(() => window.terminalSizes.at(-1));
    const activeId = ids.find(id => original.url.includes(id));
    const hiddenId = ids.find(id => id !== activeId);
    assert.ok(activeId && hiddenId);
    await page.waitForTimeout(300);

    // 模拟其他客户端把 PTY 改小，本页的外框与本地行列数保持不变。
    await page.evaluate(id => {
      const socket = window.terminalSockets.find(socket => socket.url.includes(id));
      socket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      socket.send(JSON.stringify({ type: "input", data: "printf 'BEFORE_%s_' SIZE; stty size\r" }));
    }, activeId);
    await page.waitForFunction(() => document.querySelector(".terminal-view:not([hidden]) .xterm-rows").textContent.includes("BEFORE_SIZE_24 80"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(expected => {
      const last = window.terminalSizes.at(-1);
      return last.cols === expected.cols && last.rows === expected.rows;
    }, original);
    await page.evaluate(id => {
      window.terminalSockets.find(socket => socket.url.includes(id)).send(JSON.stringify({
        type: "input", data: "printf 'AFTER_%s_' SIZE; stty size\r",
      }));
    }, activeId);
    await page.waitForFunction(expected => document.querySelector(".terminal-view:not([hidden]) .xterm-rows").textContent.includes(`AFTER_SIZE_${expected.rows} ${expected.cols}`), original);
    console.log("PASS 外框不变时，焦点恢复纠正 PTY 尺寸，实际 stty size 与全屏行列数一致");

    await page.evaluate(id => {
      window.terminalSizes = [];
      window.terminalSockets.find(socket => socket.url.includes(id)).close();
    }, hiddenId);
    await page.waitForFunction(id => window.terminalSockets.filter(socket => socket.url.includes(id) && socket.readyState === WebSocket.OPEN).length === 1 && window.terminalSockets.filter(socket => socket.url.includes(id)).length === 2, hiddenId);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(id => window.terminalSizes.filter(size => size.url.includes(id)).length, hiddenId), 0);
    console.log("PASS 隐藏终端重连不上报尺寸");

    await page.getByRole("tab").filter({ has: page.locator(".terminal-tab-dot") }).nth(ids.indexOf(hiddenId)).click();
    await page.waitForFunction(id => window.terminalSizes.some(size => size.url.includes(id) && size.cols > 100), hiddenId);
    console.log("PASS 切回隐藏终端后重新校准尺寸");
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.waitForFunction(() => window.terminalSizes.at(-1).cols < 100);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(expected => window.terminalSizes.at(-1).cols === expected.cols && window.terminalSizes.at(-1).rows === expected.rows, original);
    assert.deepEqual(errors, []);
    console.log("PASS 缩小并恢复浏览器后行列数恢复，页面无运行错误");
  } finally {
    await page.evaluate(async ids => {
      for (const id of ids) await fetch(`/api/terminal/sessions/${id}`, { method: "DELETE" });
    }, ids).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
