// 仅连接隔离测试 Hub，验证待办筛选、跨视图搜索、编辑保存、清理范围与窄屏布局。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${process.env.HUB_PORT || 18149}`;
    await page.goto(origin + '/login');
    const api = (path, method = 'GET', data) => page.evaluate(async ({ path, method, data }) => {
      const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    }, { path, method, data });
    await api('/api/auth/login', 'POST', { username: 'guest', password: 'e2e-test-pass-123' });
    // 每次使用独有清单，不清理其他测试的数据。
    const prefix = `待办回归${Date.now()}`;
    const listA = prefix + '甲', listB = prefix + '乙';
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));
    const late = await api('/api/todos', 'POST', { title: prefix + '逾期', due_date: '2020-01-01', list: listA, subtasks: [{ id: 'step1', title: '原子任务', done: false }] });
    await api('/api/todos', 'POST', { title: prefix + '未来', due_date: '2099-01-01', list: listB });
    const doneA = await api('/api/todos', 'POST', { title: prefix + '完成甲', done: true, list: listA });
    const doneB = await api('/api/todos', 'POST', { title: prefix + '完成乙', done: true, list: listB });
    await api('/api/todos', 'POST', { title: prefix + '未分类' });
    await page.goto(origin + '/todo');
    const nav = page.getByRole('navigation', { name: '待办视图' });
    await nav.waitFor();
    assert.equal(await page.getByRole('heading', { name: '工位待办', exact: true }).count(), 0);
    assert.equal(await page.locator('.page-header').count(), 0);
    await nav.getByRole('button', { name: /^已逾期/ }).click();
    const row = page.locator('.todo-item', { hasText: late.title });
    await row.waitFor();
    assert.ok((await nav.boundingBox()).width <= 100);
    assert.equal(await nav.getByRole('button', { name: new RegExp('^' + listA) }).locator('span').first().textContent(), '待办回');
    const header = row.locator('.todo-row');
    assert.equal(await header.getByRole('button', { name: /加入今天|移出今天|^删除/ }).count(), 0);
    assert.equal(await header.locator('.todo-caret').count(), 0);
    const before = await header.boundingBox();
    await row.locator('.todo-row-main').click();
    assert.deepEqual(await header.boundingBox(), before);
    const patchResponse = () => page.waitForResponse(r => r.url().endsWith(`/api/todos/${late.id}`) && r.request().method() === 'PATCH');
    let saved = patchResponse();
    await row.getByRole('button', { name: '今天', exact: true }).click();
    await saved;
    await row.waitFor({ state: 'detached' });
    assert.equal((await api('/api/todos')).todos.find(t => t.id === late.id).due_date, today);
    await nav.getByRole('button', { name: /^全部/ }).click();
    await row.locator('.todo-row-main').click();
    const sub = row.getByRole('textbox', { name: '子任务标题「原子任务」' });
    await sub.fill('修改后的子任务');
    saved = patchResponse();
    await sub.press('Enter');
    await saved;
    saved = patchResponse();
    await row.getByRole('button', { name: '清除日期', exact: true }).click();
    await saved;
    await page.reload();
    await nav.getByRole('button', { name: /^全部/ }).click();
    const progressButton = row.getByRole('button', { name: /记进度/ });
    const progressList = row.getByRole('list', { name: '进度记录' });
    for (const text of ['等卡', '等待狗头', '已收到']) {
      await progressButton.click();
      const input = row.getByRole('textbox', { name: '进度内容' });
      await input.fill(text);
      await input.press('Enter');
      await progressList.getByText(text, { exact: true }).waitFor();
    }
    assert.equal(await row.locator('.todo-row-main').getAttribute('aria-expanded'), 'false');
    assert.equal(await progressList.getByRole('listitem').count(), 2);
    assert.equal(await progressList.getByText('等卡', { exact: true }).count(), 0);
    assert.ok(!Number.isNaN(Date.parse(await progressList.locator('time').first().getAttribute('datetime'))));
    await row.getByRole('button', { name: '展开全部进度（3）' }).click();
    assert.equal(await progressList.getByRole('listitem').count(), 3);
    await row.getByRole('button', { name: '收起进度' }).click();
    assert.equal(await progressList.getByRole('listitem').count(), 2);
    await page.reload();
    await nav.getByRole('button', { name: /^全部/ }).click();
    await progressList.getByText('已收到', { exact: true }).waitFor();
    assert.equal(await progressList.getByRole('listitem').count(), 2);
    await row.locator('.todo-row-main').click();
    assert.equal(await row.getByRole('textbox', { name: '子任务标题「修改后的子任务」' }).inputValue(), '修改后的子任务');
    assert.equal((await api('/api/todos')).todos.find(t => t.id === late.id).due_date, '');
    await nav.getByRole('button', { name: /^未分类/ }).click();
    await page.locator('.todo-item', { hasText: prefix + '未分类' }).waitFor();
    assert.equal(await page.locator('.todo-item', { hasText: late.title }).count(), 0);
    await nav.getByRole('button', { name: /^今天/ }).click();
    await page.getByRole('searchbox', { name: '搜索待办' }).fill(prefix);
    assert.equal(await page.locator('.todo-item').count(), 0);
    await page.getByRole('checkbox', { name: '搜索全部' }).check();
    await page.getByRole('heading', { name: '搜索结果', exact: true }).waitFor();
    assert.equal(await page.locator('.todo-item').count(), 5);
    assert.equal(await page.getByRole('button', { name: /清除已完成/ }).count(), 0);
    await page.getByRole('searchbox', { name: '搜索待办' }).fill('');
    await nav.getByRole('button', { name: new RegExp('^' + listA) }).click();
    let message = '';
    page.once('dialog', async dialog => { message = dialog.message(); await dialog.accept(); });
    const cleared = page.waitForResponse(r => r.url().endsWith('/api/todos/clear-completed'));
    await page.getByRole('button', { name: '清除已完成（1）' }).click();
    await cleared;
    assert.ok(message.includes(listA));
    const remaining = (await api('/api/todos')).todos;
    assert.ok(!remaining.some(t => t.id === doneA.id));
    assert.ok(remaining.some(t => t.id === doneB.id));
    await page.setViewportSize({ width: 390, height: 844 });
    await nav.getByRole('button', { name: /^全部/ }).click();
    await row.locator('.todo-row-main').click();
    saved = patchResponse();
    await row.getByRole('checkbox', { name: '加入今天', exact: true }).check();
    await saved;
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const [summary, action] = await Promise.all([row.locator('.todo-meta').boundingBox(), progressButton.boundingBox()]);
    assert.ok(summary.x + summary.width <= action.x && summary.y < action.y + action.height);
    assert.equal((await row.locator('.todo-meta .todo-chip').evaluateAll(chips => new Set(chips.map(chip => chip.getBoundingClientRect().top)).size)), 1);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/todo-mobile.png', fullPage: true });
    // 保存失败后恢复服务器数据，同时保留错误提示供用户重试。
    await page.route(`**/api/todos/${late.id}`, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '模拟保存失败' }) }) : route.continue());
    const rollback = page.waitForResponse(r => new URL(r.url()).pathname === '/api/todos' && r.request().method() === 'GET');
    await row.getByRole('textbox', { name: '子任务标题「修改后的子任务」' }).fill('失败的修改');
    await row.getByRole('textbox', { name: '子任务标题「修改后的子任务」' }).press('Enter');
    await rollback;
    await page.getByText('模拟保存失败', { exact: true }).waitFor();
    assert.equal((await api('/api/todos')).todos.find(t => t.id === late.id).subtasks[0].title, '修改后的子任务');
    await page.unroute(`**/api/todos/${late.id}`);
    await api('/api/todos', 'POST', { title: prefix + '外部新增' });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.locator('.todo-item', { hasText: prefix + '外部新增' }).waitFor();
    assert.equal(await page.getByText('模拟保存失败', { exact: true }).count(), 0);
    // 在已完成视图添加后显示新条目，避免添加成功却看不到内容。
    await nav.getByRole('button', { name: /^已完成/ }).click();
    await page.getByRole('textbox', { name: '待办内容', exact: true }).fill(prefix + '新待办');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.getByRole('heading', { name: '全部待办', exact: true }).waitFor();
    await page.locator('.todo-item', { hasText: prefix + '新待办' }).waitFor();
    // 日期列与标题同一行，任何相对日期以及空日期都占相同宽度。
    const dayLabels = [[0, '今天'], [-1, '昨天'], [-42, '42天前'], [null, '']];
    for (const [offset] of dayLabels) {
      const myDay = offset === null ? '' : await page.evaluate(days => {
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toLocaleDateString('en-CA');
      }, offset);
      await api('/api/todos', 'POST', { title: `C588-${prefix}-${offset}`, my_day: myDay });
    }
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    for (const width of [390, 1400]) {
      await page.setViewportSize({ width, height: 844 });
      const slots = [];
      for (const [offset, label] of dayLabels) {
        const datedRow = page.locator('.todo-item', { hasText: `C588-${prefix}-${offset}` });
        const slot = datedRow.locator('.todo-row-day');
        await slot.waitFor();
        assert.equal((await slot.textContent()).trim(), label);
        assert.equal(await datedRow.locator('.todo-meta time').count(), 0);
        const [slotBox, titleBox] = await Promise.all([slot.boundingBox(), datedRow.locator('.todo-title-text').boundingBox()]);
        assert.ok(slotBox.x + slotBox.width <= titleBox.x);
        assert.ok(Math.abs(slotBox.y + slotBox.height / 2 - titleBox.y - titleBox.height / 2) < 1);
        slots.push(slotBox.width);
      }
      assert.ok(slots[0] >= 55 && slots[0] <= 65);
      assert.ok(slots.every(size => size === slots[0]));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log('待办紧凑分类、详情展开位置、进度添加和折叠持久化、筛选、编辑与窄屏通过');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
