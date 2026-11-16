// 文档浏览端到端测试：使用 launch_test_hub.py 启动的隔离测试 Hub，文件与服务器响应由浏览器模拟。
// PW_CORE 指向 playwright-core，CHROME 可指定浏览器，HUB_PORT 默认 18094。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
 const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
 const page = await context.newPage();
 const origin = `http://127.0.0.1:${process.env.HUB_PORT || '18094'}`;
 await page.goto(`${origin}/login`);
 assert.equal(await page.evaluate(async () => (await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'lihan',password:'e2e-test-pass-123'})})).status), 200);
 const entries = ['notes.md','photo.png','vector.svg','sample.pdf','data.xyz'].map(name => ({name, path:name, type:'file', size:123, modified:1700000000, extension:name.split('.').pop()}));
 await page.route('**/api/file-manager/**', async route => {
   const u = new URL(route.request().url());
   const p = u.pathname;
   const remote = p.includes('/remote/');
   if (p.endsWith('/connections')) return route.fulfill({json:{connections:[{id:'local',name:'本机',type:'local'},{id:'remote38',name:'38服务器',type:'ssh'}]}});
   if (p.endsWith('/common-directories')) return route.fulfill({json:{directories:[]}});
   if (p.endsWith('/settings')) return route.fulfill({json:{roots:['/test'],resolved_roots:['/test']}});
   if (p.endsWith('/directory')) { const folder = remote ? '/home/test' : ''; return route.fulfill({json:{root_index:0,root_path:'/test',path:folder,entries:entries.map(e => ({...e,path:remote?`${folder}/${e.name}`:e.path})),cached:false,generated_at:0,expires_at:0,cache_ttl_seconds:0,max_entries:1000,truncated:false}}); }
   if (p.endsWith('/markdown')) { const path=u.searchParams.get('path'); return route.fulfill({json:{path,name:'notes.md',root_index:0,size:12,modified:1700000000,content:'# 测试文档'}}); }
   if (p.endsWith('/resource')) { const path=u.searchParams.get('path'); if(path.endsWith('.svg')) return route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'}); if(path.endsWith('.png')) return route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64')}); if(path.endsWith('.pdf')) return route.fulfill({status:200,contentType:'application/pdf',body:'%PDF-1.4\n%%EOF'}); }
   return route.continue();
 });
 await page.goto(`${origin}/files/documents`);
 await page.getByRole('button',{name:'photo.png'}).waitFor();
 await page.getByRole('button',{name:'photo.png'}).click();
 await page.locator('img.document-image-preview').waitFor();
 await page.getByRole('button',{name:'vector.svg'}).click();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.getByRole('button',{name:'sample.pdf'}).click();
 await page.locator('iframe.document-pdf-preview').waitFor();
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
 await page.getByRole('button',{name:'展开文件列表'}).click();
 assert.equal(Number(await page.getByRole('separator',{name:'调整文件列表宽度'}).getAttribute('aria-valuenow')), resized);
 await page.reload();
 await page.waitForFunction(width => Number(document.querySelector('.document-index-resizer')?.getAttribute('aria-valuenow')) === width, resized);
 await page.getByRole('tab',{name:'38服务器'}).click();
 await page.getByRole('button',{name:'vector.svg'}).click();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.reload();
 await page.waitForFunction(() => document.querySelector('.document-image-preview')?.naturalWidth === 10);
 await page.getByRole('button',{name:'sample.pdf'}).click();
 await page.locator('iframe.document-pdf-preview').waitFor();
 assert.ok((await page.locator('iframe.document-pdf-preview').getAttribute('src')).includes('/remote/remote38/resource'));
 console.log('通过：全部文件展示、PNG/SVG/PDF 预览、恢复、未知文件提示、列表宽度与折叠');
 await browser.close();
})().catch(error => {console.error(error);process.exit(1)});
