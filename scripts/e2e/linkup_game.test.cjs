// 在隔离测试 Hub 中验证大厅街机连连看：走到街机前按 E 打开、闯关消除（真实鼠标点击）、道具、暂停、过关、超时结算、
// 排行榜、每日挑战、休闲模式、计分局中途关闭的确认与结算、窄屏布局。
// 测试钩子：页面加载前设置 window.__LINKUP_E2E__，引擎把自己挂到画布的 __linkup 上，提供「一对可消除方块的点击坐标」。
// 环境变量：PW_CORE（playwright-core 路径）、CHROME（浏览器可执行文件）、HUB_PORT、SHOT_DIR（可选，保存截图）。
const {chromium}=require(process.env.PW_CORE);
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.resolve(__dirname,'../..');
const navDir=fs.mkdtempSync(path.join(os.tmpdir(),'linkup-nav-'));
execFileSync('npx',['tsc','--outDir',navDir,'--module','commonjs','--target','es2022','--skipLibCheck','components/chatworld/lobby/game/pathfinding.ts'],{cwd:path.join(root,'frontend')});
const {NavGrid}=require(path.join(navDir,'pathfinding.js'));
const layout=JSON.parse(fs.readFileSync(path.join(root,'frontend/public/chat-lobby/club/layout.json'),'utf8'));
const rooms=Object.fromEntries(layout.rooms.map(r=>[r.id,r]));
const grids=Object.fromEntries(layout.rooms.map(r=>[r.id,new NavGrid(r)]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shotDir=process.env.SHOT_DIR;
const shot=async(page,name)=>{if(shotDir)await page.screenshot({path:`${shotDir}/${name}.png`});};

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME});
 try {
  const origin=`http://127.0.0.1:${process.env.HUB_PORT||18127}`;
  const ctx=await browser.newContext({viewport:{width:1400,height:900}});
  await ctx.addInitScript(()=>{window.__LINKUP_E2E__=true;});
  const page=await ctx.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(origin+'/login');
  assert.equal(await page.evaluate(async()=>(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'lihan',password:'e2e-test-pass-123'})})).status),200);

  // 观察者连接：读取自己的位置（同账号的同步连接能看到其他标签页？不能，因此用第二个账号观察）
  const obsCtx=await browser.newContext();const observer=await obsCtx.newPage();
  await observer.goto(origin+'/login');
  await observer.evaluate(async()=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'guest',password:'e2e-test-pass-123'})}));
  await observer.evaluate(()=>{window.pos={};window.names={};window.ws=new WebSocket(`ws://${location.host}/api/chat-lobby/ws`);
   window.ws.onmessage=e=>{const m=JSON.parse(e.data);
    const put=p=>{window.names[p.name]=p.id;window.pos[p.id]={room:p.room,x:p.x,y:p.y};};
    if(m.type==='snapshot')m.players.forEach(put);else if(m.type==='player')put(m.player);else if(m.type==='move')window.pos[m.id]={room:m.room,x:m.x,y:m.y};};});
  await observer.waitForFunction(()=>window.ws.readyState===1);
  await observer.evaluate(()=>{const beat=()=>window.ws.send(JSON.stringify({type:'state',room:'room'}));beat();setInterval(beat,5000);});

  await page.goto(origin+'/chat-lobby');
  await page.locator('canvas').first().waitFor();
  await sleep(2500);
  const position=async name=>observer.evaluate(name=>{const id=window.names[name];return id?window.pos[id]:null;},name);
  let held=new Set();
  const press=async keys=>{for(const k of held)if(!keys.includes(k))await page.keyboard.up(k);for(const k of keys)if(!held.has(k))await page.keyboard.down(k);held=new Set(keys);};
  const inRect=(p,[x,y,w,h])=>p.x>=x&&p.x<=x+w&&p.y>=y&&p.y<=y+h;
  async function walk(roomId,rect){
   const target={x:rect[0]+rect[2]/2,y:rect[1]+rect[3]/2};
   let last=null,still=0;
   for(let i=0;i<600;i++){
    const p=await position('lihan');
    if(!p||p.room!==roomId){await sleep(120);continue;}
    const room=rooms[roomId];const local={x:p.x-room.x,y:p.y-room.y};
    if(inRect(local,rect)){await press([]);await sleep(300);return;}
    // 卡住（寻路网格比角色碰撞体宽松的窄缝）：向左右随机挪一步再继续
    still=last&&Math.hypot(local.x-last.x,local.y-last.y)<0.5?still+1:0;last=local;
    if(still>=6){await press([Math.random()<0.5?'a':'d']);await sleep(220);await press(['w']);await sleep(120);still=0;continue;}
    const route=grids[roomId].findPath(local,target)||[target];
    const next=route.find(q=>Math.hypot(q.x-local.x,q.y-local.y)>8)||target;
    const dx=next.x-local.x,dy=next.y-local.y;const keys=[];
    if(dx>2)keys.push('d');else if(dx<-2)keys.push('a');
    if(dy>2)keys.push('s');else if(dy<-2)keys.push('w');
    await press(keys);
    const near=Math.hypot(target.x-local.x,target.y-local.y)<24;
    await sleep(near?45:110);
    if(near){await press([]);await sleep(160);}
   }
   await shot(page,'linkup-walk-fail');console.error('最后位置',await position('lihan'));
   throw new Error(`没有走到 ${roomId} ${rect}`);
  }
  const machine=rooms.hall.machines.find(m=>m.id==='linkup');
  assert.ok(machine,'大厅有街机连连看');
  assert.ok(!(rooms.hall.actions||[]).some(a=>a.id==='arcade'),'街机不再是小互动气泡');
  await walk('foyer',rooms.foyer.portals.find(p=>p.to==='hall').rect);
  // 先走到街机正前方偏下的空地，再往上走进交互区（从斜上方靠近容易卡在机身侧面）
  const [zx,zy,zw,zh]=machine.zone;
  await walk('hall',[zx+8,zy+zh+8,zw-16,10]);
  await walk('hall',machine.zone);
  await shot(page,'linkup-lobby');
  await page.keyboard.press('e');
  const dialog=page.getByRole('dialog');
  await dialog.waitFor();
  await page.locator('.linkup-menu').waitFor();
  await page.getByText('今日挑战榜').waitFor();
  await page.locator('.linkup-rank-empty').first().waitFor();
  await shot(page,'linkup-menu');

  const engine=()=>page.evaluate(()=>!!document.querySelector('.linkup-canvas').__linkup);
  assert.ok(await engine(),'测试钩子已挂载');
  const pair=()=>page.evaluate(()=>document.querySelector('.linkup-canvas').__linkup.testPair());
  const score=async()=>Number((await page.locator('.linkup-stat').first().locator('.linkup-stat-value').textContent()).replace(/,/g,''));
  async function matchOne(){
   for(let i=0;i<40;i++){
    const p=await pair();
    if(p){await page.mouse.click(p.a.x,p.a.y);await page.mouse.click(p.b.x,p.b.y);return true;}
    if(await page.locator('.linkup-overlay').count())return false;
    await sleep(100);
   }
   throw new Error('找不到可以消除的一对');
  }

  // 闯关：开始 → 准备横幅 → 开始
  await page.getByRole('button',{name:'开始闯关'}).click();
  await page.locator('.linkup-banner',{hasText:'第 1 关 · 不变化'}).waitFor();
  await shot(page,'linkup-ready');
  await page.locator('.linkup-banner').waitFor({state:'detached',timeout:4000});
  assert.equal(await score(),0);
  await page.getByText('56').first().waitFor();
  // 消除几对：分数增加，第二对起连击加分
  await matchOne();
  await page.waitForFunction(()=>document.querySelector('.linkup-stat-value').textContent!=='0');
  assert.equal(await score(),10,'第一对 10 分');
  await matchOne();
  await sleep(120);
  assert.equal(await score(),25,'第二对连击 +5');
  await page.locator('.linkup-stat.is-hot').waitFor();
  await matchOne();
  await sleep(60);
  await shot(page,'linkup-match');
  // 点同一块两次：取消选中；点不同图案：只切换选中，不扣分
  const before=await score();
  const p=await pair();
  await page.mouse.click(p.a.x,p.a.y);await page.mouse.click(p.a.x,p.a.y);
  assert.equal(await score(),before);
  // 道具：提示与重列各减一次
  await page.locator('.linkup-tool',{hasText:'提示'}).click();
  await page.locator('.linkup-tool',{hasText:'提示'}).locator('.linkup-tool-count',{hasText:'3'}).waitFor();
  await sleep(150);
  await shot(page,'linkup-hint');
  await page.keyboard.press('r');
  await page.locator('.linkup-tool',{hasText:'重列'}).locator('.linkup-tool-count',{hasText:'2'}).waitFor();
  // 暂停：棋盘盖住，继续后可以接着消除
  await page.keyboard.press('p');
  await page.locator('.linkup-overlay',{hasText:'已暂停'}).waitFor();
  assert.equal(await pair(),null,'暂停时不能操作');
  await shot(page,'linkup-paused');
  await page.getByRole('button',{name:'继续游戏'}).click();
  await page.locator('.linkup-overlay').waitFor({state:'detached'});

  // 清空第一关
  for(let i=0;i<80;i++){if(!(await matchOne()))break;}
  await page.locator('.linkup-overlay',{hasText:'第 1 关完成'}).waitFor({timeout:8000});
  await page.getByText('剩余时间奖励').waitFor();
  await shot(page,'linkup-clear');
  const afterClear=await score();
  assert.ok(afterClear>56*10,`过关总分 ${afterClear}`);
  // 回车进入第二关：向下，道具补充
  await page.keyboard.press('Enter');
  await page.locator('.linkup-banner',{hasText:'第 2 关 · 向下'}).waitFor();
  await page.locator('.linkup-tool',{hasText:'提示'}).locator('.linkup-tool-count',{hasText:'4'}).waitFor();
  await page.locator('.linkup-banner').waitFor({state:'detached',timeout:4000});
  for(let i=0;i<6;i++)await matchOne();
  await sleep(250);
  await shot(page,'linkup-level2');
  // 超时：结算并提交成绩，创下新纪录
  await page.evaluate(()=>document.querySelector('.linkup-canvas').__linkup.testSetTime(1.2));
  await page.locator('.linkup-overlay',{hasText:'时间到'}).waitFor({timeout:5000});
  await page.locator('.linkup-overlay-note.is-record').waitFor({timeout:5000});
  await shot(page,'linkup-over');
  const finalScore=await score();
  const board=await page.evaluate(async()=>(await fetch('/api/chat-lobby/linkup')).json());
  assert.equal(board.campaign.length,1);
  assert.equal(board.campaign[0].score,finalScore);
  assert.equal(board.campaign[0].level,2);
  assert.ok(board.campaign[0].mine);

  // 返回菜单：排行榜显示成绩
  await page.getByRole('button',{name:'返回菜单'}).click();
  await page.locator('.linkup-rank-row.is-mine').waitFor();
  await shot(page,'linkup-menu-ranked');

  // 每日挑战：16×9 大盘面
  await page.getByRole('button',{name:'开始挑战'}).click();
  await page.locator('.linkup-banner',{hasText:'每日挑战'}).waitFor();
  await page.locator('.linkup-banner').waitFor({state:'detached',timeout:4000});
  await page.getByText('/ 72 对').waitFor();
  for(let i=0;i<4;i++)await matchOne();
  await sleep(200);
  await shot(page,'linkup-daily');
  // 计分局中途按 Esc 关闭：先确认，确认后按当前分数结算
  const dailyScore=await score();
  let asked='';
  page.once('dialog',d=>{asked=d.message();d.accept();});
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.match(asked,/按当前分数结算/);
  await sleep(600);
  const board2=await observer.evaluate(async()=>(await fetch('/api/chat-lobby/linkup')).json());
  assert.equal(board2.daily.length,1,'离开时提交了每日挑战成绩');
  assert.equal(board2.daily[0].score,dailyScore);
  assert.equal(board2.daily[0].mine,false,'别的账号看到的不是自己的');

  // 休闲模式：不限时、道具不限
  await sleep(500);
  await page.keyboard.press('e');
  await dialog.waitFor();
  await page.getByRole('button',{name:'大 16×9'}).click();
  await page.getByRole('button',{name:'困难'}).click();
  await page.locator('.linkup-select select').selectOption('gather-h');
  await page.getByRole('button',{name:'开始',exact:true}).click();
  await page.locator('.linkup-banner',{hasText:'左右集中 · 困难'}).waitFor();
  await page.locator('.linkup-banner').waitFor({state:'detached',timeout:4000});
  assert.equal(await page.locator('.linkup-tool-count',{hasText:'∞'}).count(),2);
  for(let i=0;i<8;i++)await matchOne();
  await sleep(250);
  await shot(page,'linkup-casual');
  // 休闲模式关闭不需要确认
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});

  // 窄屏：对话框不超出视口
  await page.setViewportSize({width:390,height:844});
  await sleep(300);
  await page.keyboard.press('e');
  await dialog.waitFor();
  await page.getByRole('button',{name:'开始',exact:true}).click();
  await page.locator('.linkup-banner').waitFor({state:'detached',timeout:5000});
  const box=await dialog.boundingBox();
  assert.ok(box.width<=390&&box.height<=844,`对话框超出视口 ${JSON.stringify(box)}`);
  const canvasBox=await page.locator('.linkup-canvas').boundingBox();
  assert.ok(canvasBox.x>=0&&canvasBox.x+canvasBox.width<=390,`画布超出视口 ${JSON.stringify(canvasBox)}`);
  await matchOne();
  await shot(page,'linkup-narrow');
  assert.deepEqual(errors,[],'页面无脚本错误');
  console.log('linkup e2e ok');
 } finally { await browser.close(); fs.rmSync(navDir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exit(1);});
