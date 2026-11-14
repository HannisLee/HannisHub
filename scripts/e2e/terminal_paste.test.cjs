// 终端粘贴端到端测试：模拟 Windows 浏览器（navigator.platform = Win32），走真实键盘快捷键与系统剪贴板。
//
// 只连接 launch_test_hub.py 启动的测试 Hub（临时 settings 与数据库），不要指向 8081 线上服务。用法：
//   conda activate llama-manager && python scripts/e2e/launch_test_hub.py /tmp/hub-e2e 18093 &
//   PW_CORE=<playwright-core 目录> CHROME=/usr/bin/google-chrome OUT_DIR=<可写临时目录> \
//     node scripts/e2e/terminal_paste.test.cjs
// OUT_DIR 必须是终端 shell 可写的绝对路径，测试会在其中写入粘贴结果并逐字比对。
const { chromium } = require(process.env.PW_CORE);
const fs = require("fs");
const crypto = require("crypto");
const assert = require("assert/strict");

const PORT = process.env.HUB_PORT || "18093";
const OUT = process.env.OUT_DIR;
const SECURE = `http://127.0.0.1:${PORT}`;
const INSECURE = `http://hub.test:${PORT}`; // 非 localhost 的 HTTP 地址 = 非安全上下文，模拟局域网 IP 访问
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, label = "条件") {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`等待超时：${label}（最后结果：${String(last).slice(0, 300)}）`);
}

async function check(name, fn) {
  const started = Date.now();
  try { await fn(); results.push(["PASS", name, Date.now() - started]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, Date.now() - started, e.message]); console.log("FAIL", name, "\n   ", e.message); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: [`--host-resolver-rules=MAP hub.test 127.0.0.1`],
  });

  async function openTerminal(origin) {
    const context = await browser.newContext({ userAgent: WIN_UA, viewport: { width: 1280, height: 800 } });
    if (origin === SECURE) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
    });
    const page = await context.newPage();
    page.on("pageerror", e => console.log("[pageerror]", e.message));
    await page.goto(`${origin}/login`);
    const login = await page.evaluate(async () => {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "lihan", password: "e2e-test-pass-123" }) });
      return r.status;
    });
    assert.equal(login, 200, "登录失败");
    await page.evaluate(async () => {
      const r = await fetch("/api/terminal/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error("创建终端失败 " + r.status);
    });
    await page.goto(`${origin}/terminal`);
    await page.waitForSelector(".xterm-rows", { timeout: 20000 });
    await page.click(".terminal-view:not([hidden]) .xterm-screen");
    return { context, page };
  }

  const screen = page => page.evaluate(() => {
    const view = document.querySelector(".terminal-view:not([hidden]) .xterm-rows");
    return view ? Array.from(view.children).map(row => row.textContent.replace(/ /g, " ")).join("\n") : "";
  });
  async function typeLine(page, text) { await page.keyboard.type(text); await page.keyboard.press("Enter"); }
  async function marker(page, tag) {
    // 命令里写成 $((1+1)) 计算后再显示，避免把回显的命令本身当成结果
    await typeLine(page, `echo ${tag}_$((40+2))`);
    await waitFor(async () => (await screen(page)).includes(`${tag}_42`), 15000, `终端输出 ${tag}`);
  }
  async function setClipboard(page, text) {
    await page.evaluate(t => navigator.clipboard.writeText(t), text);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, "写入剪贴板失败");
  }
  const fileText = path => { try { return fs.readFileSync(path, "utf8"); } catch { return null; } };

  const { page } = await openTerminal(SECURE);
  await check("模拟环境：navigator.platform 为 Win32、终端就绪", async () => {
    assert.equal(await page.evaluate(() => navigator.platform), "Win32");
    await marker(page, "READY");
  });

  await check("Ctrl+V 粘贴单行命令并执行", async () => {
    const target = `${OUT}/single.txt`;
    await setClipboard(page, `echo 粘贴成功-hello > ${target}`);
    await page.keyboard.press("Control+V");
    await waitFor(async () => (await screen(page)).includes("粘贴成功-hello"), 5000, "粘贴内容回显");
    await page.keyboard.press("Enter");
    await waitFor(() => fileText(target) === "粘贴成功-hello\n", 5000, "命令执行结果");
  });

  await check("Ctrl+V 不向 shell 写入多余字符", async () => {
    await setClipboard(page, "");
    await typeLine(page, `cat -v > ${OUT}/ctrlv.txt`);
    await sleep(300);
    await page.keyboard.press("Control+V");
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+D");
    await waitFor(() => fileText(`${OUT}/ctrlv.txt`) === "x\n", 5000, "cat -v 输出只有 x（不含 ^V）");
  });

  await check("Windows 剪贴板 CRLF 多行文本（中文、emoji、制表符）粘贴到 cat 后逐字一致", async () => {
    const lines = ["第一行 中文", "second\tline with tab", "表情 😀👍", "  缩进行  ", "最后一行"];
    await setClipboard(page, lines.join("\r\n") + "\r\n");
    await typeLine(page, `cat > ${OUT}/multiline.txt`);
    await sleep(300);
    await page.keyboard.press("Control+V");
    await page.keyboard.press("Control+D");
    await waitFor(() => fileText(`${OUT}/multiline.txt`) === lines.join("\n") + "\n", 8000, "多行文件内容");
  });

  await check("Ctrl+Shift+V 粘贴", async () => {
    await setClipboard(page, `echo shift-v-ok > ${OUT}/shiftv.txt`);
    await page.keyboard.press("Control+Shift+V");
    await page.keyboard.press("Enter");
    await waitFor(() => fileText(`${OUT}/shiftv.txt`) === "shift-v-ok\n", 5000, "Ctrl+Shift+V 结果");
  });

  await check("Shift+Insert 粘贴", async () => {
    await setClipboard(page, `echo shift-insert-ok > ${OUT}/shiftins.txt`);
    await page.keyboard.press("Shift+Insert");
    await page.keyboard.press("Enter");
    await waitFor(() => fileText(`${OUT}/shiftins.txt`) === "shift-insert-ok\n", 5000, "Shift+Insert 结果");
  });

  await check("bash 提示符下多行粘贴走 bracketed paste，不会逐行误执行", async () => {
    // 两行命令一起粘贴：bracketed paste 下 bash 把它们作为待编辑文本，直到按回车才执行
    await setClipboard(page, `echo bp-1 >> ${OUT}/bracketed.txt\necho bp-2 >> ${OUT}/bracketed.txt`);
    await page.keyboard.press("Control+V");
    await sleep(600);
    assert.equal(fileText(`${OUT}/bracketed.txt`), null, "粘贴后未按回车就执行了命令");
    await page.keyboard.press("Enter");
    await waitFor(() => fileText(`${OUT}/bracketed.txt`) === "bp-1\nbp-2\n", 5000, "按回车后两行都执行");
  });

  await check("大段粘贴 1.5 MB（2 万行）完整写入且 Hub 保持响应", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `${String(i).padStart(6, "0")} ${"abcdefghijklmnopqrstuvwxyz中文".repeat(2)} ${crypto.createHash("md5").update(String(i)).digest("hex")}`);
    const text = lines.join("\n") + "\n";
    await setClipboard(page, text);
    await typeLine(page, `stty -echo; cat > ${OUT}/big.txt; stty echo`);
    await sleep(300);
    const started = Date.now();
    await page.keyboard.press("Control+V");
    // 粘贴进行期间 Hub 其他请求仍应及时响应（旧实现会阻塞事件循环）
    const latencies = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const r = await fetch(`${SECURE}/login`);
      assert.equal(r.status, 200);
      latencies.push(Date.now() - t);
      await sleep(100);
    }
    await waitFor(() => (fileText(`${OUT}/big.txt`) || "").length >= text.length, 60000, "大文件写入完成");
    await page.keyboard.press("Control+D");
    await sleep(300);
    const got = fileText(`${OUT}/big.txt`);
    assert.equal(got.length, text.length, "长度不一致");
    assert.equal(crypto.createHash("sha256").update(got).digest("hex"), crypto.createHash("sha256").update(text).digest("hex"), "内容哈希不一致");
    console.log(`    大段粘贴 ${Buffer.byteLength(text)} 字节，耗时 ${Date.now() - started} ms，期间请求延迟 ${latencies.join("/")} ms`);
    assert.ok(Math.max(...latencies) < 1000, `粘贴期间 Hub 响应过慢：${latencies}`);
    await marker(page, "AFTER_BIG");
  });

  await check("没有选中文字时 Ctrl+C 仍中断前台程序", async () => {
    await typeLine(page, "sleep 30; echo SLEEP_NOT_$((40+2))");
    await sleep(500);
    await page.keyboard.press("Control+C");
    await marker(page, "INTERRUPTED");
    assert.ok(!(await screen(page)).includes("SLEEP_NOT_42"), "sleep 没有被中断");
  });

  await check("选中文字后 Ctrl+C 复制到剪贴板且不发送中断", async () => {
    await page.keyboard.press("Control+L");
    await typeLine(page, "printf 'COPY%sTARGET\\n' _ME_");
    await waitFor(async () => (await screen(page)).includes("COPY_ME_TARGET"), 5000, "输出 COPY_ME_TARGET");
    await setClipboard(page, "旧内容");
    const box = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".terminal-view:not([hidden]) .xterm-rows > div"));
      const row = rows.find(r => r.textContent.trim() === "COPY_ME_TARGET");
      const rect = row.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2, w: rect.width };
    });
    await page.mouse.dblclick(box.x + 20, box.y);
    await page.keyboard.press("Control+C");
    await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "COPY_ME_TARGET", 3000, "剪贴板内容为选中文字");
    // 复制不应向 shell 发送 ^C：此时继续输入命令仍在同一行正常执行
    await marker(page, "AFTER_COPY");
    assert.ok(!(await screen(page)).includes("^C"), "复制时向 shell 发送了 ^C");
  });

  await check("Ctrl+Shift+C 复制选中文字", async () => {
    await page.keyboard.press("Control+L");
    await typeLine(page, "printf 'SHIFT%sCOPY\\n' _C_");
    await waitFor(async () => (await screen(page)).includes("SHIFT_C_COPY"), 5000, "输出 SHIFT_C_COPY");
    await setClipboard(page, "旧内容");
    const box = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".terminal-view:not([hidden]) .xterm-rows > div"));
      const rect = rows.find(r => r.textContent.trim() === "SHIFT_C_COPY").getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
    await page.mouse.dblclick(box.x + 20, box.y);
    await page.keyboard.press("Control+Shift+C");
    await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "SHIFT_C_COPY", 3000, "剪贴板内容");
  });

  // 非安全上下文（HTTP + 非 localhost，相当于用局域网 IP 访问）：页面里没有 navigator.clipboard，原生粘贴仍应可用
  const insecure = await openTerminal(INSECURE);
  await check("非安全上下文（HTTP 局域网地址）下 Ctrl+V 依然可粘贴", async () => {
    const p = insecure.page;
    assert.equal(await p.evaluate(() => window.isSecureContext), false);
    assert.equal(await p.evaluate(() => typeof navigator.clipboard), "undefined");
    await marker(p, "INSECURE_READY");
    await setClipboard(page, `echo insecure-paste-ok > ${OUT}/insecure.txt`); // 通过安全页写入同一浏览器的系统剪贴板
    await p.bringToFront();
    await p.click(".terminal-view:not([hidden]) .xterm-screen");
    await p.keyboard.press("Control+V");
    await p.keyboard.press("Enter");
    await waitFor(() => fileText(`${OUT}/insecure.txt`) === "insecure-paste-ok\n", 5000, "非安全上下文粘贴结果");
  });

  await page.evaluate(async () => {
    const r = await fetch("/api/terminal/sessions"); const d = await r.json();
    for (const s of d.sessions) await fetch(`/api/terminal/sessions/${s.id}`, { method: "DELETE" });
  });
  await browser.close();
  const failed = results.filter(r => r[0] === "FAIL");
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
