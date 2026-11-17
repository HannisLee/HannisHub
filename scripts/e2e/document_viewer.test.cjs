// 文档浏览端到端测试：使用 launch_test_hub.py 启动的隔离测试 Hub，文件与服务器响应由浏览器模拟。
// PW_CORE 指向 playwright-core，CHROME 可指定浏览器，HUB_PORT 默认 18094。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');
// 同时覆盖四种公式分隔符、Markdown 容器、错误降级与代码保护。
const mathDocument = [
 '# 测试文档 $x_i^2$',
 String.raw`行内 $E=mc^2$，括号 \(\frac{a_1}{b_2}\)，单字母 $x$，**加粗 $z_1$**。`,
 '',
 '$$',
 String.raw`\begin{aligned} a_1 &= \sum_{i=1}^{n} x_i \\ b_2 &= \sqrt{2} \end{aligned}`,
 '$$',
 '',
 String.raw`\[\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\]`,
 '',
 '- 列表 $a_b$ 与 $c_d$',
 '',
 '> 引用公式',
 '> $$',
 String.raw`> \int_0^1 x\,dx`,
 '> $$',
 '',
 '| 公式 | 说明 |',
 '| --- | --- |',
 String.raw`| $|x|$ | 绝对值 |`,
 '',
 String.raw`代码：\`$raw_1$\`，价格 \$5 和 \$10，未闭合 $oops`,
 '',
 '```latex',
 String.raw`$$\frac{raw}{code}$$`,
 '```',
 '',
 String.raw`错误 $\frac{$，后续公式 $y^2$。`,
 '',
 String.raw`安全 $\href{javascript:alert(1)}{x}$`,
 '',
 '$$' + Array.from({length:40}, (_, i) => `x_{${i}}`).join(' + ') + '$$',
 '',
 '公式之后的正文。',
].join('\n').replace(/\\`/g, '`');
// 构造有效的单页 PDF，避免用空文件误判浏览器预览成功。
function makeTestPdf() {
 const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Length 48 >>\nstream\nBT /F1 24 Tf 72 720 Td (PDF preview test) Tj ET\nendstream',
 ];
 let pdf = '%PDF-1.4\n';
 const offsets = [0];
 objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
 const xref = Buffer.byteLength(pdf);
 pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
 for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
 pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(pdf);
}
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
 const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
 await context.grantPermissions(['clipboard-read', 'clipboard-write']);
 const page = await context.newPage();
 const origin = `http://127.0.0.1:${process.env.HUB_PORT || '18094'}`;
 await page.goto(`${origin}/login`);
 assert.equal(await page.evaluate(async () => (await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'lihan',password:'e2e-test-pass-123'})})).status), 200);
 const entries = ['notes.md','photo.png','vector.svg','big.svg','sample.pdf','data.xyz'].map(name => ({name, path:name, type:'file', size:123, modified:1700000000, extension:name.split('.').pop()}));
 await page.route('**/api/file-manager/**', async route => {
   const u = new URL(route.request().url());
   const p = u.pathname;
   const remote = p.includes('/remote/');
   if (p.endsWith('/connections')) return route.fulfill({json:{connections:[{id:'local',name:'本机',type:'local'},{id:'remote38',name:'38服务器',type:'ssh'}]}});
   if (p.endsWith('/common-directories')) return route.fulfill({json:{directories:[]}});
   if (p.endsWith('/settings')) return route.fulfill({json:{roots:['/home/test/project'],resolved_roots:['/home/test/project'],home_dir:'/home/test'}});
   if (p.endsWith('/directory')) { const folder = u.searchParams.get('path') || ''; const files = entries.map(e => ({...e,path:folder ? `${folder}/${e.name}` : e.path})); if (!folder) files.push({name:'sub',path:'sub',type:'directory',size:0,modified:0,extension:''}); return route.fulfill({json:{root_index:0,root_path:remote?'/home/test':'/home/test/project',path:folder,entries:files,cached:false,generated_at:0,expires_at:0,cache_ttl_seconds:0,max_entries:1000,truncated:false}}); }
   if (p.endsWith('/markdown')) { const path=u.searchParams.get('path'); return route.fulfill({json:{path,name:'notes.md',root_index:0,size:12,modified:1700000000,content:mathDocument}}); }
   if (p.endsWith('/resource')) { const path=u.searchParams.get('path'); if(path.endsWith('big.svg')) return route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1600"><rect width="2000" height="1600"/></svg>'}); if(path.endsWith('.svg')) return route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'}); if(path.endsWith('.png')) return route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64')}); if(path.endsWith('.pdf')) return route.fulfill({status:200,contentType:'application/pdf',headers:remote?{'Content-Security-Policy':'sandbox','Content-Disposition':'inline; filename=sample.pdf'}:{'Content-Disposition':'inline; filename=sample.pdf'},body:makeTestPdf()}); }
   return route.continue();
 });
 await page.goto(`${origin}/files/documents`);
 await page.getByRole('button',{name:'photo.png'}).waitFor();
 await page.getByRole('button',{name:'notes.md'}).click();
 const article = page.locator('.document-reader > .markdown-content');
 await article.locator('.katex').first().waitFor();
 assert.equal(await article.locator('h1 .katex').count(), 1);
 assert.equal(await article.locator('strong .katex').count(), 1);
 assert.equal(await article.locator('li .katex').count(), 2);
 assert.equal(await article.locator('blockquote .katex-display').count(), 1);
 assert.equal(await article.locator('td .katex').count(), 1);
 assert.equal(await article.locator('td').count(), 2);
 assert.equal(await article.locator('.katex-display').count(), 4);
 assert.ok(await article.locator('math').count() >= 12);
 assert.equal(await article.locator('code .katex').count(), 0);
 assert.ok((await article.innerText()).includes('$raw_1$'));
 assert.ok((await article.innerText()).includes('价格 $5 和 $10，未闭合 $oops'));
 assert.equal(await article.locator('pre code').innerText(), String.raw`$$\frac{raw}{code}$$`);
 assert.equal(await article.locator('.markdown-math-error').count(), 1);
 assert.equal(await article.locator('a[href^="javascript:"]').count(), 0);
 await article.getByText('公式之后的正文。',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'折叠文件列表'}).click();
 await page.evaluate(() => document.fonts.ready);
 assert.ok(await article.locator('.markdown-math.is-display').last().evaluate(el => el.scrollWidth > el.clientWidth));
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 await page.getByRole('button',{name:'展开文件列表'}).click();
 await page.setViewportSize({width:1400,height:900});
 const header = page.locator('.document-index-head');
 const toggleBox = await page.getByRole('button',{name:'折叠文件列表'}).boundingBox();
 const crumbBox = await page.getByRole('navigation',{name:'当前目录路径'}).boundingBox();
 const copyBox = await page.getByRole('button',{name:'复制路径'}).boundingBox();
 assert.ok(toggleBox.x < crumbBox.x && crumbBox.x < copyBox.x);
 assert.ok(Math.abs(toggleBox.y - copyBox.y) < 8);
 assert.equal(await header.getByText('文档目录',{exact:true}).count(), 0);
 assert.equal(await page.getByLabel('筛选当前目录').count(), 0);
 await page.getByRole('button',{name:'复制路径'}).click();
 assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '~/project');
 await page.getByRole('button',{name:'已复制',exact:true}).click();
 await page.getByRole('button',{name:'复制路径',exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'下载 notes.md',exact:true}).getAttribute('href'), '/api/file-manager/download?root=0&path=notes.md');
 await page.getByRole('button',{name:'photo.png'}).click();
 await page.locator('img.document-image-preview').waitFor();
 await page.getByRole('button',{name:'vector.svg'}).click();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.getByRole('button',{name:'全屏查看'}).click();
 const lightbox = page.getByRole('dialog',{name:'vector.svg 图片查看'});
 await lightbox.waitFor();
 const image = lightbox.locator('img');
 await page.waitForFunction(() => document.querySelector('.document-image-lightbox img')?.naturalWidth === 10);
 const initialWidth = await image.evaluate(el => el.getBoundingClientRect().width);
 await lightbox.getByRole('button',{name:'放大图片'}).click();
 assert.ok(await image.evaluate(el => el.getBoundingClientRect().width) > initialWidth);
 await lightbox.getByRole('button',{name:'缩小图片'}).click();
 assert.equal(await lightbox.getByRole('button',{name:'重置图片缩放'}).innerText(), '100%');
 await page.keyboard.press('Escape');
 await lightbox.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'big.svg'}).click();
 await page.getByRole('button',{name:'全屏查看'}).click();
 const bigLightbox = page.getByRole('dialog',{name:'big.svg 图片查看'});
 const viewport = bigLightbox.locator('.document-image-lightbox-viewport');
 await page.waitForFunction(() => document.querySelector('.document-image-lightbox img')?.naturalWidth === 2000);
 const bounds = await viewport.boundingBox();
 await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
 await page.mouse.wheel(0, -300);
 await page.waitForFunction(() => document.querySelector('[aria-label="重置图片缩放"]')?.textContent === '110%');
 await page.mouse.wheel(0, 300);
 await page.waitForFunction(() => document.querySelector('[aria-label="重置图片缩放"]')?.textContent === '100%');
 for (let i = 0; i < 5; i++) await bigLightbox.getByRole('button',{name:'放大图片'}).click();
 await viewport.evaluate(el => { el.scrollLeft = 150; el.scrollTop = 150; });
 const beforeDrag = await viewport.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
 await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
 await page.mouse.down();
 await page.mouse.move(bounds.x + bounds.width / 2 - 80, bounds.y + bounds.height / 2 - 70);
 await page.mouse.up();
 const afterDrag = await viewport.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
 assert.ok(afterDrag.x > beforeDrag.x && afterDrag.y > beforeDrag.y);
 const cursor = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
 await page.mouse.move(cursor.x, cursor.y);
 const pointBefore = await bigLightbox.locator('img').evaluate((el, point) => { const rect = el.getBoundingClientRect(); return {x:(point.x-rect.left)/rect.width, y:(point.y-rect.top)/rect.height}; }, cursor);
 await page.mouse.wheel(0, -100);
 await page.waitForFunction(() => document.querySelector('[aria-label="重置图片缩放"]')?.textContent === '248%');
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const pointAfter = await bigLightbox.locator('img').evaluate((el, point) => { const rect = el.getBoundingClientRect(); return {x:(point.x-rect.left)/rect.width, y:(point.y-rect.top)/rect.height}; }, cursor);
 assert.ok(Math.abs(pointBefore.x - pointAfter.x) < 0.02 && Math.abs(pointBefore.y - pointAfter.y) < 0.02);
 await page.keyboard.press('Escape');
 await bigLightbox.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'sample.pdf'}).click();
 const pdfFrame = page.locator('iframe.document-pdf-preview');
 await pdfFrame.waitFor();
 assert.ok((await pdfFrame.getAttribute('src')).includes('#view=FitH&navpanes=0'));
 const pdfBox = await pdfFrame.boundingBox();
 assert.ok(pdfBox.y + pdfBox.height <= 900 && pdfBox.width > 700);
 await pdfFrame.evaluate(el => { el.dataset.testIdentity = 'same-frame'; });
 await page.getByRole('button',{name:'全屏查看'}).click();
 const pdfDialog = page.getByRole('dialog',{name:'sample.pdf 全屏查看'});
 await pdfDialog.waitFor();
 assert.equal(await pdfFrame.getAttribute('data-test-identity'), 'same-frame');
 const expandedBox = await pdfFrame.boundingBox();
 assert.ok(expandedBox.width > 1200 && expandedBox.height > 700);
 await page.getByRole('button',{name:'退出全屏'}).click();
 assert.equal(await pdfFrame.getAttribute('data-test-identity'), 'same-frame');
 assert.ok((await page.getByRole('link',{name:'新标签页打开'}).getAttribute('href')).includes('/resource?'));
 await page.reload();
 await page.locator('iframe.document-pdf-preview').waitFor();
 await page.getByRole('button',{name:'data.xyz'}).click();
 await page.getByText('暂不支持预览此文件').waitFor();
 const handle = page.getByRole('separator',{name:'调整文件列表宽度'}); await handle.focus(); await page.keyboard.press('ArrowRight');
 assert.equal(await handle.getAttribute('aria-valuenow'),'316');
 const box = await handle.boundingBox();
 await page.mouse.move(box.x + box.width / 2, box.y + 60);
 await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + 60); await page.mouse.up();
 const resized = Number(await handle.getAttribute('aria-valuenow'));
 assert.ok(resized > 350);
 await page.getByRole('button',{name:'折叠文件列表'}).click();
 await page.getByRole('navigation',{name:'当前目录路径'}).waitFor();
 const headerWidth = await page.locator('.document-index-head').evaluate(el => el.getBoundingClientRect().width);
 const workspaceWidth = await page.locator('.document-workspace').evaluate(el => el.getBoundingClientRect().width);
 assert.ok(Math.abs(headerWidth - workspaceWidth) < 2);
 await page.getByRole('button',{name:'复制路径'}).waitFor();
 await page.getByRole('button',{name:'展开文件列表'}).click();
 assert.equal(Number(await page.getByRole('separator',{name:'调整文件列表宽度'}).getAttribute('aria-valuenow')), resized);
 await page.reload();
 await page.waitForFunction(width => Number(document.querySelector('.document-index-resizer')?.getAttribute('aria-valuenow')) === width, resized);
 await page.getByRole('tab',{name:'38服务器'}).click();
 await page.getByRole('button',{name:'sub'}).waitFor();
 await page.getByRole('button',{name:'notes.md'}).click();
 await article.locator('h1 .katex').waitFor();
 assert.equal(await article.locator('.katex-display').count(), 4);
 await page.getByRole('button',{name:'复制路径'}).click();
 assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '~');
 await page.getByRole('button',{name:'vector.svg'}).click();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.reload();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.getByRole('button',{name:'sub'}).click();
 await page.getByRole('button',{name:'vector.svg'}).waitFor();
 await page.getByRole('button',{name:'复制路径'}).click();
 assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '~/sub');
 await page.getByRole('button',{name:'vector.svg'}).click();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.reload();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.getByRole('button',{name:'sample.pdf'}).click();
 await page.locator('iframe.document-pdf-preview').waitFor();
 assert.ok((await page.locator('iframe.document-pdf-preview').getAttribute('src')).includes('/remote/remote38/resource'));
 await page.setViewportSize({width: 390, height: 844});
 await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.shell-content')).marginLeft) < 1);
 const mobileToggle = await page.getByRole('button',{name:'折叠文件列表'}).boundingBox();
 const mobileCopy = await page.getByRole('button',{name:'复制路径'}).boundingBox();
 assert.ok(Math.abs(mobileToggle.y - mobileCopy.y) < 8);
 assert.ok(mobileCopy.x + mobileCopy.width <= 390);
 const mobilePdf = await page.locator('iframe.document-pdf-preview').boundingBox();
 assert.ok(mobilePdf.width > 200 && mobilePdf.x + mobilePdf.width <= 390);
 assert.equal(await page.locator('.document-reader-head h1').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
 console.log('通过：公式渲染、代码保护、错误降级与窄屏布局，PDF 全屏、图片缩放、路径导航和列表折叠');
 await browser.close();
})().catch(error => {console.error(error);process.exit(1)});
