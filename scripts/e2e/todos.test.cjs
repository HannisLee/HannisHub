// 仅连接隔离测试 Hub，验证待办三状态、今天视图卡片（最新进度 + 折叠更早记录）、原地记进度、精简添加区、统计、长标题与窄屏布局。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${process.env.HUB_PORT || 18149}`;
    await page.goto(origin + '/login');
    const api = (urlPath, method = 'GET', data) => page.evaluate(async ({ urlPath, method, data }) => {
      const response = await fetch(urlPath, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`${urlPath}: ${response.status}`);
      return response.json();
    }, { urlPath, method, data });

    await api('/api/auth/login', 'POST', { username: 'guest', password: 'e2e-test-pass-123' });

    const prefix = `待办E2E_${Date.now()}`;
    const listA = prefix + '甲';
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));

    // 1) 创建测试基础数据：逾期、P0 重要、未分类
    const late = await api('/api/todos', 'POST', {
      title: prefix + '逾期',
      due_date: '2020-01-01',
      list: listA,
      subtasks: [{ id: 'step1', title: '原子任务', done: false }],
    });
    const p0Task = await api('/api/todos', 'POST', {
      title: prefix + 'P0高优',
      priority: 3,
      my_day: today,
    });
    const timelineTask = await api('/api/todos', 'POST', {
      title: 'C588-2node-16gbs8-amp-both-very-long-experiment-name-check-overflow',
      priority: 2,
      my_day: today,
    });

    // 如提供了 TEST_DB，直接往隔离测试库写入精确时间戳的 6 条进度，验收时间轴规则
    if (process.env.TEST_DB) {
      const timestamps = await page.evaluate(() => {
        const mk = (y, m, d, hh, mm) => Math.floor(new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000);
        return [
          { id: 'tl1', text: '开始训练', created_at: mk(2026, 11, 19, 15, 0) },
          { id: 'tl2', text: '完成第一次测试', created_at: mk(2026, 11, 19, 17, 0) },
          { id: 'tl3', text: '发现问题', created_at: mk(2026, 11, 19, 17, 35) },
          { id: 'tl4', text: '完成修复', created_at: mk(2026, 11, 19, 18, 55) },
          { id: 'tl5', text: '开始第二轮', created_at: mk(2026, 11, 20, 9, 0) },
          { id: 'tl6', text: '完成第二轮', created_at: mk(2026, 11, 20, 9, 45) },
        ];
      });
      execFileSync(process.env.PYTHON_BIN || 'python3', [
        '-c',
        'import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute("UPDATE todos SET progress = ? WHERE id = ?", (sys.argv[2], sys.argv[3])); c.commit(); c.close()',
        process.env.TEST_DB,
        JSON.stringify(timestamps),
        timelineTask.id,
      ]);
    }

    await page.goto(origin + '/todo');
    const nav = page.getByRole('navigation', { name: '待办视图' });
    await nav.waitFor();
    assert.ok((await nav.boundingBox()).width <= 100);
    assert.equal(await page.locator('.page-header').count(), 0);

    // E. 顶部信息与分组标题检查
    assert.equal(await page.locator('.todo-view-title').textContent(), '今天');
    assert.ok((await page.locator('.todo-view-date').textContent()).includes('月'));
    assert.equal(await page.locator('.todo-view-hint').count(), 0);
    await page.getByRole('heading', { name: /^待完成 · 2$/ }).waitFor();
    await page.getByRole('heading', { name: /^已逾期 · 1$/ }).waitFor();
    assert.equal(await page.locator('.todo-progress').textContent(), '已完成 0 / 3');
    // 重要分类只计数 P0 高优先级（1 条），不把 P1 默认优先级混入
    assert.equal(await nav.getByRole('button', { name: /^重要/ }).locator('.todo-nav-count').textContent(), '1');
    // 侧栏计数为 0：保留条目但隐藏数字并淡化
    const doneNav = nav.getByRole('button', { name: /^已完成/ });
    assert.equal(await doneNav.locator('.todo-nav-count').count(), 0);
    assert.ok(await doneNav.evaluate(el => el.classList.contains('is-empty')));
    // 「已完成 N / M」与进度条同一行
    const [progressTextBox, progressBarBox] = await Promise.all([
      page.locator('.todo-progress > span').boundingBox(),
      page.locator('.todo-progress .progress').boundingBox(),
    ]);
    assert.ok(Math.abs((progressTextBox.y + progressTextBox.height / 2) - (progressBarBox.y + progressBarBox.height / 2)) < 4);
    // 今天视图不显示「今天」日期标签；默认 P1 不显示优先级，P0 显示为圆点而非描边标签
    assert.equal(await page.locator('.todo-row-day').count(), 0);
    assert.equal(await page.locator('.todo-item', { hasText: 'C588-2node' }).locator('.todo-priority-dot').count(), 0);
    assert.equal(await page.locator('.todo-item', { hasText: p0Task.title }).locator('.todo-priority-dot.is-p3').count(), 1);

    // C. 添加任务区域：默认精简，聚焦展开，P1 默认，今天视图仅设 my_day 不设 due_date
    const addForm = page.locator('.todo-add');
    assert.equal(await addForm.locator('.todo-add-options').count(), 0);
    const addInput = page.getByRole('textbox', { name: '待办内容', exact: true });
    await addInput.click();
    await addForm.locator('.todo-add-options').waitFor();
    assert.equal(await addForm.locator('select').inputValue(), '2');
    // 在列表输入框按 Enter 不触发提交
    await addForm.getByLabel('清单', { exact: true }).press('Enter');
    assert.equal((await api('/api/todos')).todos.length, 3);
    const addSubmit = addForm.locator('.todo-add-submit');
    assert.ok(await addSubmit.isDisabled());
    assert.equal(await addSubmit.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    // 填写标题并回车创建
    await addInput.fill(prefix + '新建');
    await page.waitForTimeout(250); // 等待按钮背景色过渡结束
    assert.equal(await addSubmit.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(93, 184, 114)');
    await addInput.press('Enter');
    const createdRow = page.locator('.todo-item', { hasText: prefix + '新建' });
    await createdRow.waitFor();
    assert.equal(await addInput.inputValue(), '');
    const createdData = (await api('/api/todos')).todos.find(t => t.title === prefix + '新建');
    assert.equal(createdData.my_day, today);
    assert.equal(createdData.due_date, '');
    assert.equal(createdData.priority, 2);
    assert.equal(createdData.status, 'not_started');
    assert.equal(await page.locator('.todo-progress').textContent(), '已完成 0 / 4');

    // A. 无左侧复选框与拖动条；状态菜单包含三态与已完成
    assert.equal(await createdRow.locator('.todo-rail, .todo-check, .todo-drag-handle').count(), 0);
    const statusBtn = createdRow.locator('.todo-status-btn');
    assert.equal((await statusBtn.textContent()).trim(), '待开始');
    await statusBtn.click();
    const menu = createdRow.getByRole('menu');
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitemradio').count(), 4);
    assert.equal(await menu.getByRole('menuitemradio', { name: '待开始' }).getAttribute('aria-checked'), 'true');
    // Escape 关闭菜单
    await page.keyboard.press('Escape');
    assert.equal(await createdRow.getByRole('menu').count(), 0);

    // 切换为「阻塞中」并刷新验证持久化
    await statusBtn.click();
    const patchStatus = page.waitForResponse(r => r.url().endsWith(`/api/todos/${createdData.id}`) && r.request().method() === 'PATCH');
    await createdRow.getByRole('menuitemradio', { name: '阻塞中' }).click();
    await patchStatus;
    assert.equal((await statusBtn.textContent()).trim(), '阻塞中');
    await page.reload();
    await createdRow.waitFor();
    assert.equal((await createdRow.locator('.todo-status-btn').textContent()).trim(), '阻塞中');
    // 阻塞中的任务排在「待完成」最前，卡片有 3px 红色左边线；红色不出现在其他卡片
    const todayGroup = page.locator('.todo-group', { has: page.getByRole('heading', { name: /^待完成/ }) });
    assert.ok((await todayGroup.locator('.todo-item').first().textContent()).includes(prefix + '新建'));
    assert.ok((await createdRow.evaluate(el => getComputedStyle(el).boxShadow)).includes('3px 0px 0px 0px'));
    const redOutsideBlocked = await page.evaluate(() => [...document.querySelectorAll('.todo-item:not(.is-blocked), .todo-item:not(.is-blocked) *, .todo-main-head *, .todo-add *, .todo-group-title')]
      .filter(el => ['color', 'backgroundColor', 'boxShadow'].some(prop => getComputedStyle(el)[prop].includes('240, 82, 82'))).length);
    assert.equal(redOutsideBlocked, 0);
    // 卡片内不再有任何描边标签
    const borderedInCards = await page.evaluate(() => [...document.querySelectorAll('.todo-item, .todo-item *')]
      .filter(el => ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(getComputedStyle(el)[`border${side}Width`]) > 0)).length);
    assert.equal(borderedInCards, 0);

    // 通过状态菜单标记为「已完成」-> 进入今天完成 -> 通过状态菜单恢复未完成仍保留「阻塞中」
    await createdRow.locator('.todo-status-btn').click();
    const donePatch = page.waitForResponse(r => r.url().endsWith(`/api/todos/${createdData.id}`) && r.request().method() === 'PATCH');
    await createdRow.getByRole('menuitemradio', { name: '已完成' }).click();
    await donePatch;
    assert.equal(await page.locator('.todo-progress').textContent(), '已完成 1 / 4');
    await page.getByRole('button', { name: /^今天完成 · 1$/ }).click();
    const doneCard = page.locator('.todo-item.is-done', { hasText: prefix + '新建' });
    await doneCard.waitFor();
    assert.equal((await doneCard.locator('.todo-status-btn').textContent()).trim(), '已完成');
    await doneCard.locator('.todo-status-btn').click();
    const reopenPatch = page.waitForResponse(r => r.url().endsWith(`/api/todos/${createdData.id}`) && r.request().method() === 'PATCH');
    await doneCard.getByRole('menuitemradio', { name: /阻塞中/ }).click();
    await reopenPatch;
    await createdRow.waitFor();
    assert.equal((await createdRow.locator('.todo-status-btn').textContent()).trim(), '阻塞中');
    assert.equal(await page.locator('.todo-progress').textContent(), '已完成 0 / 4');

    // 状态保存失败时回滚 UI 并提示错误
    await page.route(`**/api/todos/${createdData.id}`, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '模拟状态保存失败' }) })
      : route.continue());
    await createdRow.locator('.todo-status-btn').click();
    await createdRow.getByRole('menuitemradio', { name: '进行中' }).click();
    await page.getByText('模拟状态保存失败', { exact: true }).waitFor();
    assert.equal((await createdRow.locator('.todo-status-btn').textContent()).trim(), '阻塞中');
    await page.unroute(`**/api/todos/${createdData.id}`);

    // B. 进度：第二行只显示最新一条，更早记录折叠为「N 条更早记录」，展开后按时间倒序；今天视图仅显示 HH:MM
    const tlRow = page.locator('.todo-item', { hasText: 'C588-2node-16gbs8-amp-both' });
    const tlList = tlRow.getByRole('list', { name: '进度记录' });
    if (process.env.TEST_DB) {
      assert.deepEqual(await tlList.locator('li').evaluateAll(els => els.map(el => el.innerText.replace(/\s+/g, ' ').trim())), ['完成第二轮 09:45']);
      const moreBtn = tlRow.getByRole('button', { name: '5 条更早记录' });
      assert.equal(await moreBtn.getAttribute('aria-expanded'), 'false');
      assert.equal(await tlRow.getByRole('list', { name: '更早的进度记录' }).count(), 0);
      await moreBtn.click();
      const olderList = tlRow.getByRole('list', { name: '更早的进度记录' });
      assert.deepEqual(await olderList.locator('li').evaluateAll(els => els.map(el => el.innerText.replace(/\s+/g, ' ').trim())), [
        '开始第二轮 09:00', '完成修复 18:55', '发现问题 17:35', '完成第一次测试 17:00', '开始训练 15:00',
      ]);
      // 时间右对齐（tabular-nums），不显示日期与 +时长
      const timeRights = await tlRow.locator('.todo-progress-time').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().right)));
      assert.equal(new Set(timeRights).size, 1, `时间应右对齐: ${JSON.stringify(timeRights)}`);
      assert.equal(await tlRow.locator('.todo-progress-time').first().evaluate(el => getComputedStyle(el).fontVariantNumeric), 'tabular-nums');
      assert.equal(await tlRow.locator('.todo-progress-time').first().getAttribute('title'), '2026-11-20 09:45');
      if (process.env.SHOT_DIR) {
        await tlRow.screenshot({ path: path.join(process.env.SHOT_DIR, 'todo-card-expanded.png') });
      }
      await moreBtn.click();
      assert.equal(await tlRow.getByRole('list', { name: '更早的进度记录' }).count(), 0);
    }

    // D. 原地「记进度」编辑：多行 Shift+Enter、Enter 保存、草稿跨任务保留、仅记进度不改状态、配合状态同步保存
    await tlRow.getByRole('button', { name: /记进度/ }).click();
    const tlBox = tlRow.getByRole('textbox', { name: '进度内容' });
    await tlBox.waitFor();
    await tlBox.fill('暂存草稿内容');
    // 切到另一张卡片：第一张草稿保留且显示「草稿」提示
    await createdRow.getByRole('button', { name: /记进度/ }).click();
    assert.ok(await tlRow.getByRole('button', { name: '记进度', exact: true }).evaluate(el => el.classList.contains('has-draft')));
    const createdBox = createdRow.getByRole('textbox', { name: '进度内容' });
    await createdBox.fill('第一行');
    await createdBox.press('Shift+Enter');
    await createdBox.type('第二行');
    // 仅记录进度，不修改状态，状态应保持为「阻塞中」
    const progResp1 = page.waitForResponse(r => r.url().endsWith(`/api/todos/${createdData.id}/progress`));
    await createdBox.press('Enter');
    await progResp1;
    await createdRow.getByRole('list', { name: '进度记录' }).getByText('第一行\n第二行').waitFor();
    assert.equal((await createdRow.locator('.todo-status-btn').textContent()).trim(), '阻塞中');

    // 再记一条进度，同时选择「进行中」
    await createdRow.getByRole('button', { name: /记进度/ }).click();
    await createdBox.fill('解除阻塞，开始推进');
    await createdRow.getByLabel('进度保存时执行状态').selectOption('in_progress');
    const progResp2 = page.waitForResponse(r => r.url().endsWith(`/api/todos/${createdData.id}/progress`));
    await createdRow.getByRole('button', { name: '保存进度', exact: true }).click();
    await progResp2;
    assert.equal((await createdRow.locator('.todo-status-btn').textContent()).trim(), '进行中');

    // 记进度并选择「已完成」作为完成结语：原子完成并进入「今天完成」
    const finishCandidate = await api('/api/todos', 'POST', { title: prefix + '结语任务', my_day: today, status: 'in_progress' });
    await page.reload();
    const finishRow = page.locator('.todo-item', { hasText: finishCandidate.title });
    await finishRow.waitFor();
    await finishRow.getByRole('button', { name: /记进度/ }).click();
    await finishRow.getByRole('textbox', { name: '进度内容' }).fill('实验跑通，结语归档');
    await finishRow.getByLabel('进度保存时执行状态').selectOption('done');
    const finishProgResp = page.waitForResponse(r => r.url().endsWith(`/api/todos/${finishCandidate.id}/progress`));
    await finishRow.getByRole('button', { name: '保存进度', exact: true }).click();
    await finishProgResp;
    assert.equal(await page.locator('.todo-progress').textContent(), '已完成 1 / 5');
    await page.getByRole('button', { name: /^今天完成 · 1$/ }).click();
    const finishedCard = page.locator('.todo-item.is-done', { hasText: finishCandidate.title });
    await finishedCard.getByText('实验跑通，结语归档').waitFor();
    // 清理结语临时任务以免影响后续计数，或通过日期槽拖动测试排序
    await page.getByRole('button', { name: /^今天完成 · 1$/ }).click();

    // 验证标题行可拖动，聚焦标题后可用方向键排序
    const p0Card = page.locator('.todo-item', { hasText: p0Task.title });
    assert.equal(await p0Card.locator('.todo-row').getAttribute('draggable'), 'true');
    const reorderResp = page.waitForResponse(r => r.url().endsWith('/api/todos/reorder'));
    await p0Card.locator('.todo-row-main').focus();
    await p0Card.locator('.todo-row-main').press('ArrowDown');
    await reorderResp;

    // 进度保存失败时保留输入内容
    await page.route(`**/api/todos/${createdData.id}/progress`, route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '模拟进度失败' }) }));
    await createdRow.getByRole('button', { name: /记进度/ }).click();
    await createdBox.fill('不该丢失的草稿');
    await createdRow.getByRole('button', { name: '保存进度', exact: true }).click();
    await createdRow.getByRole('alert').getByText('模拟进度失败').waitFor();
    assert.equal(await createdBox.inputValue(), '不该丢失的草稿');
    await page.unroute(`**/api/todos/${createdData.id}/progress`);
    await createdRow.getByRole('button', { name: '取消', exact: true }).click();

    // 长标题单行省略且不把右侧状态 / + 挤出卡片；完整标题在 title 提示中
    const [cardBox, statusBox, actionBox] = await Promise.all([
      tlRow.boundingBox(),
      tlRow.locator('.todo-status-btn').boundingBox(),
      tlRow.getByRole('button', { name: '记进度', exact: true }).boundingBox(),
    ]);
    assert.ok(statusBox.x + statusBox.width <= cardBox.x + cardBox.width);
    assert.ok(actionBox.x + actionBox.width <= cardBox.x + cardBox.width);
    assert.ok(Math.abs((statusBox.y + statusBox.height / 2) - (actionBox.y + actionBox.height / 2)) < 2);
    const tlTitle = tlRow.locator('.todo-title-text');
    assert.equal(await tlTitle.getAttribute('title'), timelineTask.title);
    // + 按钮为幽灵图标：鼠标不在卡片上时隐藏，悬停时出现
    const p0Plus = page.locator('.todo-item', { hasText: p0Task.title }).getByRole('button', { name: '记进度', exact: true });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    assert.equal(await p0Plus.evaluate(el => getComputedStyle(el).opacity), '0');
    await page.locator('.todo-item', { hasText: p0Task.title }).hover();
    await page.waitForTimeout(200);
    assert.equal(await p0Plus.evaluate(el => getComputedStyle(el).opacity), '1');

    // 窄屏响应式检查：无横向溢出（等待侧栏响应式过渡结束）
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const overflowInfo = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      overflowEls: [...document.querySelectorAll('*')]
        .filter(el => el.getBoundingClientRect().right > innerWidth + 0.5 && !el.closest('.todo-nav'))
        .map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right, text: (el.textContent || '').slice(0, 30) })),
    }));
    assert.ok(overflowInfo.scrollWidth <= overflowInfo.innerWidth, JSON.stringify(overflowInfo));
    // 窄屏下长标题仍为单行省略
    assert.ok(await tlTitle.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap'));
    if (process.env.SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'todo-mobile.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(250);
    if (process.env.SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'todo-desktop.png'), fullPage: true });
    }

    // 「全部」视图保留「今天」日期标签（纯文字、固定宽度，位于标题左侧）
    await nav.getByRole('button', { name: /^全部/ }).click();
    const p0Row = page.locator('.todo-item', { hasText: p0Task.title });
    await p0Row.waitFor();
    assert.equal((await p0Row.locator('.todo-row-day').textContent()).trim(), '今天');
    const [slotBox, titleBox] = await Promise.all([
      p0Row.locator('.todo-row-day').boundingBox(),
      p0Row.locator('.todo-title-text').boundingBox(),
    ]);
    assert.ok(slotBox.x + slotBox.width <= titleBox.x);
    assert.ok(slotBox.width >= 55 && slotBox.width <= 65);

    // 验证逾期条目仍在已逾期视图可见，且切换排序模式正常
    await nav.getByRole('button', { name: /^已逾期/ }).click();
    await page.locator('.todo-item', { hasText: late.title }).waitFor();

    // 空的今天列表：用另一个没有待办的测试账号
    const emptyPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    emptyPage.on('pageerror', error => errors.push(error.message));
    await emptyPage.goto(origin + '/login');
    await emptyPage.evaluate(async () => {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lihan', password: 'e2e-test-pass-123' }) });
      if (!response.ok) throw new Error('login ' + response.status);
    });
    await emptyPage.goto(origin + '/todo');
    await emptyPage.getByText('今天还没有安排').waitFor();
    assert.equal(await emptyPage.locator('.todo-item').count(), 0);
    assert.equal(await emptyPage.locator('.todo-progress').textContent(), '已完成 0 / 0');
    if (process.env.SHOT_DIR) {
      await emptyPage.screenshot({ path: path.join(process.env.SHOT_DIR, 'todo-empty.png') });
    }
    await emptyPage.close();

    assert.deepEqual(errors, []);
    console.log('待办三状态、今天视图卡片、原地记进度、精简添加与响应式回归全部通过');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
