// 用隔离 Hub 和临时账号验证真实 Chrome 画面、账号隔离与退出后断流。
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PW_CORE);

const port = Number(process.env.HUB_PORT);
assert.ok(port > 0 && port !== 8081, "必须使用隔离测试 Hub");
const origin = `http://127.0.0.1:${port}`;
const PASSWORD = "e2e-test-pass-123";
const START = "/api/chat-lobby/desk-browser/start";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  const username = "desk-browser-test";
  const request = (context, method, path, data) => context.request.fetch(origin + path, {
    method, data, headers: { origin }, timeout: 90000,
  });
  let admin;
  try {
    const login = async username => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const response = await request(context, "POST", "/api/auth/login", { username, password: PASSWORD });
      assert.equal(response.status(), 200);
      return context;
    };
    admin = await login("lihan");
    const guest = await login("guest");
    const created = await request(admin, "POST", "/api/users", { username, password: PASSWORD });
    assert.equal(created.status(), 200);
    const other = await login(username);
    assert.equal((await request(other, "POST", START)).status(), 403);
    const sessions = [];
    for (const [index, context] of [guest, other].entries()) {
      assert.equal((await request(context, "PUT", "/api/chat-lobby/desks/mine", { desk: `desk-${index + 1}` })).status(), 200);
      const started = await request(context, "POST", START);
      assert.equal(started.status(), 200, await started.text());
      sessions.push((await started.json()).url);
    }
    assert.notEqual(sessions[0], sessions[1]);
    assert.equal((await guest.request.get(origin + sessions[1])).status(), 404);
    assert.equal((await other.request.get(origin + sessions[0])).status(), 404);
    assert.equal((await guest.request.get(origin + "/browser/session/")).status(), 403);

    const otherPage = await other.newPage();
    await otherPage.goto(origin + "/chat-lobby");
    assert.equal(await otherPage.evaluate(path => new Promise(resolve => {
      const socket = new WebSocket(`ws://${location.host}${path}api/websockets`);
      socket.onopen = () => { socket.close(); resolve(false); };
      socket.onerror = () => resolve(true);
    }), sessions[0]), true);

    const guestPage = await guest.newPage();
    let frames = 0;
    let disconnected = false;
    guestPage.on("websocket", socket => {
      if (!socket.url().endsWith(sessions[0] + "api/websockets")) return;
      socket.on("framereceived", ({ payload }) => { if (Buffer.isBuffer(payload)) frames++; });
      socket.on("close", () => { disconnected = true; });
    });
    await guestPage.goto(origin + sessions[0]);
    for (let attempt = 0; frames < 2 && attempt < 60; attempt++) await guestPage.waitForTimeout(250);
    assert.ok(frames >= 2, "应收到真实 Chrome 画面");
    assert.equal(disconnected, false);
    assert.equal((await request(guest, "POST", "/api/auth/logout")).status(), 200);
    for (let attempt = 0; !disconnected && attempt < 28; attempt++) await guestPage.waitForTimeout(250);
    assert.equal(disconnected, true, "退出登录后已有画面连接应关闭");

    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const containers = sessions.map(url => `hh-desk-browser-${url.split("/").at(-2)}`);
    for (const name of containers) {
      assert.equal(docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", name), "none");
    }
    let preferences = "";
    for (let attempt = 0; !preferences && attempt < 20; attempt++) {
      preferences = docker("exec", containers[0], "find", "/config", "-name", "Preferences");
      if (!preferences) await guestPage.waitForTimeout(500);
    }
    assert.match(preferences, /\/Default\/Preferences/);
    docker("exec", containers[0], "touch", "/config/e2e-profile-marker");
    docker("exec", containers[1], "test", "!", "-e", "/config/e2e-profile-marker");
    docker("stop", "-t", "8", containers[0]);
    const relogged = await login("guest");
    const restarted = await request(relogged, "POST", START);
    assert.equal(restarted.status(), 200);
    assert.equal((await restarted.json()).url, sessions[0]);
    docker("exec", containers[0], "test", "-e", "/config/e2e-profile-marker");

    assert.equal((await request(admin, "DELETE", "/api/users/guest")).status(), 200);
    assert.equal((await request(admin, "DELETE", `/api/users/${username}`)).status(), 200);
    console.log("工位浏览器账号隔离、真实画面、退出断流与个人卷恢复通过");
  } finally {
    if (admin) {
      for (const account of ["guest", username]) {
        await request(admin, "DELETE", `/api/users/${account}`).catch(() => {});
      }
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
