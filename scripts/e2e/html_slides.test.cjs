// 使用隔离测试 Hub 验证演示 HTML；SLIDES_FIXTURE_DIR 可指向真实 slides.html 和 assets 的临时副本。
// 可设置 REMOTE_SLIDES_CONNECTION / REMOTE_SLIDES_FOLDER，对指定远端文档做只读验证。
const { chromium } = require(process.env.PW_CORE);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function checkSlides(page) {
 const iframe = page.locator('.document-html-preview');
 const frame = page.frameLocator('.document-html-preview');
 await frame.locator('.slide.active').waitFor({state:'attached'});
 await frame.locator('body').evaluate(() => document.readyState==='complete' ? undefined : new Promise(resolve => addEventListener('load',resolve,{once:true})));
 await frame.locator('.slide.active').waitFor();
 await iframe.focus();
 const count = await frame.locator('.slide').count();
 assert.ok(count >= 3);
 const index = () => frame.locator('body').evaluate(() => [...document.querySelectorAll('.slide')].findIndex(el => el.classList.contains('active')));
 assert.equal(await index(),0);
 await frame.locator('body').press('ArrowRight');
 assert.equal(await index(),1);
 await frame.locator('body').press('PageDown');
 assert.equal(await index(),2);
 await frame.locator('body').press('PageUp');
 assert.equal(await index(),1);
 await iframe.scrollIntoViewIfNeeded();
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const box = await iframe.boundingBox();
 await page.mouse.click(box.x+box.width*0.9,box.y+box.height*0.5);
 assert.equal(await index(),2);
 // 由页面自身执行的代码仍受浏览器同源边界限制。
 assert.equal(await frame.locator('body').evaluate(() => {try {parent.document.body.dataset.slideInjected='yes';return false;}catch{return true;}}),true);
 assert.equal(await frame.locator('body').evaluate(() => {try {localStorage.setItem('slide-probe','yes');return false;}catch{return true;}}),true);
 const denied = await frame.locator('body').evaluate(async () => {try {return (await fetch('/api/file-manager/settings',{credentials:'include'})).status;}catch{return 0;}});
 assert.notEqual(denied,200);
 await iframe.evaluate(el => el.dataset.identity='preserved');
 await page.getByRole('button',{name:'全屏查看',exact:true}).click();
 assert.equal(await iframe.getAttribute('data-identity'),'preserved');
 assert.equal(await index(),2);
 await frame.locator('body').press('ArrowRight');
 assert.equal(await index(),3 < count ? 3 : count-1);
 await frame.locator('body').press('Escape');
 await page.getByRole('button',{name:'全屏查看',exact:true}).waitFor();
 assert.equal(await iframe.getAttribute('data-identity'),'preserved');
 // 逐页检查实际配图，保证隐藏页的相对资源也能加载。
 for(let i=0;i<count;i++) await frame.locator('body').press('ArrowLeft');
 for(let i=0;i<count;i++) {
  assert.equal(await index(),i);
  for(const image of await frame.locator('.slide.active img').all()) {
   await image.evaluate(el => el.complete ? undefined : new Promise(resolve => el.addEventListener('load',resolve,{once:true})));
   assert.ok(await image.evaluate(el => el.naturalWidth>0));
  }
  if(i<count-1) await frame.locator('body').press('ArrowRight');
 }
 const url = await iframe.getAttribute('src');
 const popup = await page.context().newPage();
 await popup.goto(new URL(url,page.url()).href);
 assert.equal(await popup.locator('.slide').count(),count);
 await popup.keyboard.press('ArrowRight');
 assert.equal(await popup.locator('.slide').nth(1).getAttribute('class').then(value=>value.includes('active')),true);
 await popup.close();
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('.shell-content')).marginLeft)<1);
 const mobile = await iframe.boundingBox();
 assert.ok(mobile.width>200 && mobile.x+mobile.width<=390);
 await frame.locator('body').press('ArrowLeft');
 assert.equal(await index(),count-2);
 await page.setViewportSize({width:1400,height:900});
 return count;
}

(async()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'hannishub-slides-'));
 const root=path.join(work,'files');
 if(process.env.SLIDES_FIXTURE_DIR) fs.cpSync(process.env.SLIDES_FIXTURE_DIR,root,{recursive:true});
 else {
  fs.mkdirSync(path.join(root,'assets'),{recursive:true});
  fs.writeFileSync(path.join(root,'assets','image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>');
  fs.writeFileSync(path.join(root,'slides.html'),'<style>.slide{display:none}.active{display:block}</style>'+[0,1,2].map(n=>`<section class="slide${n?'':' active'}"><h1>幻灯片 ${n+1}</h1><img src="assets/image.svg"></section>`).join('')+'<script>let i=0;const slides=[...document.querySelectorAll(".slide")];function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((e,k)=>e.classList.toggle("active",k===i))}addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key))show(i+1);if(["ArrowLeft","PageUp"].includes(e.key))show(i-1)});addEventListener("click",e=>show(e.clientX>innerWidth/2?i+1:i-1))</script>');
 }
 const browser=await chromium.launch({executablePath:process.env.CHROME||undefined,headless:true});
 try {
  const context=await browser.newContext({viewport:{width:1400,height:900}});
  const page=await context.newPage();
  const origin=`http://127.0.0.1:${process.env.HUB_PORT||'18094'}`;
  await page.goto(`${origin}/login`);
  assert.equal(await page.evaluate(async root=>{
   await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'lihan',password:'e2e-test-pass-123'})});
   return (await fetch('/api/file-manager/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({roots:[root]})})).status;
  },root),200);
  await page.goto(`${origin}/files/documents`);
  await page.getByRole('button',{name:'slides.html'}).click();
  console.log('本机演示通过，页数：',await checkSlides(page));
  if(process.env.REMOTE_SLIDES_CONNECTION) {
   await page.evaluate(({connection,folder})=>{
    localStorage.setItem('hannishub_doc_active_connection',connection);
    localStorage.setItem('hannishub_document_viewer_remote_locations',JSON.stringify({[connection]:{folder,document:folder+'/slides.html'}}));
   },{connection:process.env.REMOTE_SLIDES_CONNECTION,folder:process.env.REMOTE_SLIDES_FOLDER});
   await page.reload();
   console.log('远端演示通过，页数：',await checkSlides(page));
  }
  console.log('通过：键盘与点击翻页、全屏保持当前页、沙箱内 Esc 退出、逐页配图、新标签页、窄屏及主站隔离');
 } finally {await browser.close();fs.rmSync(work,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1)});
