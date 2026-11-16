// 在隔离测试 Hub 中验证大厅台球桌（中式八球）：两个账号用键盘走到球桌两端按 E 入座开局、击球同步、离开判负、单人练习。
// 角色位置由第三个账号的同步连接观察，路径用场景自己的寻路网格（frontend/.../pathfinding.ts，运行时编译到临时目录）。
// 环境变量：PW_CORE（playwright-core 路径）、CHROME（浏览器可执行文件）、HUB_PORT、SHOT_DIR（可选，保存截图）。
const {chromium}=require(process.env.PW_CORE);
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.resolve(__dirname,'../..');
const navDir=fs.mkdtempSync(path.join(os.tmpdir(),'pool-nav-'));
execFileSync('npx',['tsc','--outDir',navDir,'--module','commonjs','--target','es2022','--skipLibCheck','components/chatworld/lobby/game/pathfinding.ts'],{cwd:path.join(root,'frontend')});
const {NavGrid}=require(path.join(navDir,'pathfinding.js'));
const layout=JSON.parse(fs.readFileSync(path.join(root,'frontend/public/chat-lobby/club/layout.json'),'utf8'));
const rooms=Object.fromEntries(layout.rooms.map(r=>[r.id,r]));
const grids=Object.fromEntries(layout.rooms.map(r=>[r.id,new NavGrid(r)]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shotDir=process.env.SHOT_DIR;

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME});
 try {
  const origin=`http://127.0.0.1:${process.env.HUB_PORT||18126}`;
  const login=async username=>{
   const ctx=await browser.newContext({viewport:{width:1400,height:900}});const p=await ctx.newPage();
   await p.goto(origin+'/login');
   assert.equal(await p.evaluate(async username=>(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'e2e-test-pass-123'})})).status,username),200);
   return p;
  };
  const lihan=await login('lihan');
  await lihan.evaluate(async()=>fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'watcher',password:'e2e-test-pass-123'})}));
  const guest=await login('guest');
  const observer=await login('watcher');
  // 观察者：记录每个角色的位置和台球消息
  await observer.evaluate(()=>{window.events=[];window.pos={};window.names={};window.ws=new WebSocket(`ws://${location.host}/api/chat-lobby/ws`);
   window.ws.onmessage=e=>{const m=JSON.parse(e.data);window.events.push(m);
    const put=p=>{window.names[p.name]=p.id;window.pos[p.id]={room:p.room,x:p.x,y:p.y};};
    if(m.type==='snapshot')m.players.forEach(put);else if(m.type==='player')put(m.player);else if(m.type==='move')window.pos[m.id]={room:m.room,x:m.x,y:m.y};};});
  await observer.waitForFunction(()=>window.ws.readyState===1);
  // 心跳：服务端 30 秒收不到消息会断开（位于私有房间，不会出现在场景里）
  await observer.evaluate(()=>{const beat=()=>window.ws.send(JSON.stringify({type:'state',room:'room'}));beat();setInterval(beat,5000);});
  await observer.evaluate(()=>window.ws.send(JSON.stringify({type:'pool',op:'watch'})));

  for(const p of [lihan,guest]){await p.goto(origin+'/chat-lobby');await p.locator('canvas').first().waitFor();}
  await sleep(2500);
  // 普通账号整页模式从「我的房间」出生：向下走出房门到入口厅
  await guest.keyboard.down('s');await sleep(1800);await guest.keyboard.up('s');

  const position=async name=>observer.evaluate(name=>{const id=window.names[name];return id?window.pos[id]:null;},name);
  const held=new Map();
  const press=async(page,keys)=>{const now=held.get(page)??new Set();for(const k of now)if(!keys.includes(k))await page.keyboard.up(k);for(const k of keys)if(!now.has(k))await page.keyboard.down(k);held.set(page,new Set(keys));};
  const inRect=(p,[x,y,w,h])=>p.x>=x&&p.x<=x+w&&p.y>=y&&p.y<=y+h;
  async function walk(page,name,roomId,rect){
   const target={x:rect[0]+rect[2]/2,y:rect[1]+rect[3]/2};
   for(let i=0;i<600;i++){
    const p=await position(name);
    if(!p||p.room!==roomId){await sleep(120);continue;}
    const room=rooms[roomId];const local={x:p.x-room.x,y:p.y-room.y};
    if(inRect(local,rect)){await press(page,[]);await sleep(300);return;}
    const route=grids[roomId].findPath(local,target)||[target];
    const next=route.find(q=>Math.hypot(q.x-local.x,q.y-local.y)>8)||target;
    const dx=next.x-local.x,dy=next.y-local.y;const keys=[];
    if(dx>2)keys.push('d');else if(dx<-2)keys.push('a');
    if(dy>2)keys.push('s');else if(dy<-2)keys.push('w');
    await press(page,keys);
    const near=Math.hypot(target.x-local.x,target.y-local.y)<24;
    await sleep(near?45:110);
    if(near){await press(page,[]);await sleep(160);}
   }
   throw new Error(`${name} 没有走到 ${roomId} ${rect}`);
  }
  const foyerExit=rooms.foyer.portals.find(p=>p.to==='hall').rect;
  const zone=id=>rooms.hall.machines.find(m=>m.id===id).zone;
  await Promise.all([
   (async()=>{await walk(lihan,'lihan','foyer',foyerExit);await walk(lihan,'lihan','hall',zone('pool-left'));})(),
   (async()=>{await walk(guest,'guest','foyer',foyerExit);await walk(guest,'guest','hall',zone('pool-right'));})(),
  ]);

  // 左端入座：等待对手
  await lihan.keyboard.press('e');
  await lihan.getByRole('dialog').waitFor();
  await lihan.getByText('已入座，等待对手').waitFor();
  if(shotDir)await lihan.screenshot({path:`${shotDir}/pool-waiting.png`});
  // 右端入座：开局
  await guest.keyboard.press('e');
  await guest.getByRole('dialog').waitFor();
  await Promise.all([lihan,guest].map(p=>p.locator('.pool-player.is-turn').waitFor()));
  await sleep(600);
  const shooterIsLihan=await lihan.locator('.pool-canvas.is-active').count()===1;
  const [shooter,other]=shooterIsLihan?[lihan,guest]:[guest,lihan];
  assert.equal(await other.locator('.pool-canvas.is-active').count(),0);
  if(shotDir)await shooter.screenshot({path:`${shotDir}/pool-break-aim.png`});
  // 开球：力度调大后空格击球
  for(let i=0;i<10;i++)await shooter.keyboard.press('ArrowUp');
  await shooter.keyboard.press(' ');
  assert.equal(await shooter.getByRole('dialog').count(),1,'空格击球不应关闭对话框');
  await observer.waitForFunction(()=>window.events.some(e=>e.type==='pool'&&e.ev==='shot'),null,{timeout:5000});
  await sleep(700);
  if(shotDir)await other.screenshot({path:`${shotDir}/pool-break-moving.png`});
  const shot=await observer.evaluate(()=>window.events.find(e=>e.type==='pool'&&e.ev==='shot'));
  assert.equal(shot.game.shots,1);
  // 双方回放结束后都显示同一条判定结果
  const msg=shot.game.msg;
  try {
   await Promise.all([lihan,guest].map(p=>p.locator('.pool-status',{hasText:msg.slice(0,6)}).waitFor({timeout:25000})));
  } catch(error) {
   if(shotDir){await lihan.screenshot({path:`${shotDir}/fail-lihan.png`});await guest.screenshot({path:`${shotDir}/fail-guest.png`});}
   console.error('期望结果', msg, await lihan.locator('.pool-status').textContent(), '|', await guest.locator('.pool-status').textContent());
   throw error;
  }
  await Promise.all([lihan,guest].map(p=>p.waitForFunction(()=>!document.querySelector('.pool-turn')?.textContent?.includes('击球中'),null,{timeout:25000})));
  if(shotDir){await lihan.screenshot({path:`${shotDir}/pool-after-break-lihan.png`});await guest.screenshot({path:`${shotDir}/pool-after-break-guest.png`});}

  // 对局中左侧离开：确认后判负，对方看到获胜
  lihan.once('dialog',d=>d.accept());
  await lihan.keyboard.press('Escape');
  await lihan.getByRole('dialog').waitFor({state:'detached'});
  await guest.getByText('对手离开球桌，判负').first().waitFor();
  await guest.locator('.pool-overlay-title',{hasText:'guest 获胜'}).waitFor();
  if(shotDir)await guest.screenshot({path:`${shotDir}/pool-forfeit.png`});
  await guest.keyboard.press('Escape');
  await guest.getByRole('dialog').waitFor({state:'detached'});

  // 单人练习：重新在左端按 E，点单人练习，一个人打两边
  await sleep(400);
  await lihan.keyboard.press('e');
  await lihan.getByRole('dialog').waitFor();
  await lihan.getByRole('button',{name:'单人练习（自己对打）'}).click();
  await lihan.locator('.pool-canvas.is-active').waitFor();
  const before=await observer.evaluate(()=>window.events.filter(e=>e.type==='pool'&&e.ev==='shot').length);
  await lihan.keyboard.press(' ');
  await observer.waitForFunction(n=>window.events.filter(e=>e.type==='pool'&&e.ev==='shot').length>n,before,{timeout:5000});
  await lihan.waitForFunction(()=>!document.querySelector('.pool-turn')?.textContent?.includes('击球中'),null,{timeout:25000});
  await lihan.locator('.pool-canvas.is-active').waitFor({timeout:5000});
  if(shotDir)await lihan.screenshot({path:`${shotDir}/pool-solo.png`});
  // 窄屏布局：对话框不超出视口
  await lihan.setViewportSize({width:390,height:844});
  await sleep(400);
  const box=await lihan.getByRole('dialog').boundingBox();
  assert.ok(box.width<=390&&box.height<=844,`对话框超出视口 ${JSON.stringify(box)}`);
  if(shotDir)await lihan.screenshot({path:`${shotDir}/pool-solo-narrow.png`});
  console.log('pool e2e ok');
 } finally { await browser.close(); fs.rmSync(navDir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exit(1);});
