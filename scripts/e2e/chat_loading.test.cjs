// 仅连接隔离测试 Hub，验证普通账号页面内导航、聊天收发及窄屏加载。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  try {
    const origin = `http://127.0.0.1:${process.env.HUB_PORT || 18137}`;
    const page = await browser.newPage();
    const errors = [];
    const denied = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).pathname.endsWith('.txt')) denied.push(response.url());
    });
    await page.goto(origin + '/login');
    assert.equal(await page.evaluate(async () => (await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'guest', password: 'e2e-test-pass-123' }),
    })).status), 200);
    const response = await page.goto(origin + '/todo');
    assert.equal(response.headers()['cache-control'], 'no-store');
    // 保留全局标记，确认跳转成功依靠客户端导航，无需退回整页刷新。
    await page.evaluate(() => { window.chatNavigationMarker = true; });
    await page.getByRole('link', { name: '聊天室', exact: true }).click();
    const composer = page.locator('.chat-composer textarea');
    await composer.waitFor();
    assert.equal(await page.evaluate(() => window.chatNavigationMarker), true);
    const message = `聊天室加载回归-${Date.now()}`;
    await composer.fill(message);
    await page.locator('.chat-composer').getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.chat-row[data-msg-id] .chat-bubble', { hasText: message }).waitFor();
    await page.getByRole('link', { name: '工位待办', exact: true }).click();
    await page.waitForURL('**/todo/');
    await page.getByRole('link', { name: '聊天室', exact: true }).click();
    await page.locator('.chat-bubble', { hasText: message }).waitFor();
    assert.equal(await page.evaluate(() => window.chatNavigationMarker), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('.chat-bubble', { hasText: message }).waitFor();
    assert.deepEqual(denied, []);
    assert.deepEqual(errors, []);
    console.log('普通账号聊天室导航、消息发送与恢复、窄屏加载通过');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
