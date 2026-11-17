// 使用临时 Hub，验证真实行走到琴凳、键盘和弦、音频信号、换调、延音、触屏及关闭停音。
const {chromium}=require(process.env.PW_CORE);
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.resolve(__dirname,'../..');
const navDir=fs.mkdtempSync(path.join(os.tmpdir(),'piano-nav-'));
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
  await ctx.addInitScript(()=>{window.pianoAudio = [];
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.pianoAudio.push(this); }
      createDynamicsCompressor() {
        const node = super.createDynamicsCompressor();
        this.meter = this.createAnalyser(); node.connect(this.meter); return node;
      }
    };});
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
    if(m.type==='emote'&&m.key==='piano')window.pianoEmotes=(window.pianoEmotes||0)+1;
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
  const seat=rooms.hall.seats.find(s=>s.play==='piano');
  assert.ok(seat, '大厅有琴凳');
  await walk('foyer',rooms.foyer.portals.find(p=>p.to==='hall').rect);
  await walk('hall',seat.zone);
  await page.keyboard.press('e');
  const dialog=page.getByRole('dialog');
  await page.getByRole('heading',{name:'留一段旋律'}).waitFor();
  const pressed=()=>page.locator('[data-piano-note][aria-pressed="true"]').count();
  const key=midi=>page.locator(`[data-piano-note="${midi}"]`);
  await page.keyboard.down('z'); await page.keyboard.down('a'); await page.keyboard.down('d');
  await page.waitForTimeout(100);
  assert.equal(await pressed(),3,'同时按下三个音');
  assert.equal(await key(48).getAttribute('aria-pressed'),'true');
  assert.equal(await key(60).getAttribute('aria-pressed'),'true');
  assert.equal(await key(64).getAttribute('aria-pressed'),'true');
  assert.ok(await page.evaluate(()=>{const ctx=window.pianoAudio.at(-1);const data=new Float32Array(ctx.meter.fftSize);ctx.meter.getFloatTimeDomainData(data);return ctx.state==='running'&&data.some(n=>Math.abs(n)>0.0001);}), '实际产生音频信号');
  await page.keyboard.up('z'); await page.keyboard.up('a'); await page.keyboard.up('d');
  assert.equal(await pressed(),0,'松开全部琴键');
  await page.getByLabel('音阶',{exact:true}).selectOption('minor');
  await page.getByLabel('主音',{exact:true}).selectOption('2');
  await page.getByLabel('起始八度',{exact:true}).selectOption('4');
  await page.getByRole('heading',{name:'留一段旋律'}).click();
  await page.keyboard.down('c');
  assert.equal(await key(65).getAttribute('aria-pressed'),'true','D 小调第三音是 F4');
  await page.keyboard.up('c');
  await page.keyboard.down('Space'); await page.keyboard.press('a');
  await page.getByRole('button',{name:/延音 开/}).waitFor();
  await page.keyboard.up('Space');
  await page.getByRole('button',{name:/延音 关/}).waitFor();
  await page.keyboard.down('a');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await pressed(),0,'失焦清理按键');
  await page.keyboard.up('a');
  for(const scale of ['pentatonic','chromatic','major']) {
    await page.getByLabel('音阶',{exact:true}).selectOption(scale);
    await page.getByRole('heading',{name:'留一段旋律'}).click();
    await page.keyboard.down('k'); assert.equal(await pressed(),1); await page.keyboard.up('k');
  }
  await page.getByLabel('音量',{exact:true}).fill('0');
  await page.getByRole('heading',{name:'留一段旋律'}).click();
  await page.keyboard.press('a');
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(()=>{const ctx=window.pianoAudio.at(-1);const data=new Float32Array(ctx.meter.fftSize);ctx.meter.getFloatTimeDomainData(data);return data.every(n=>Math.abs(n)<0.0001);}), '音量为零时静音');
  await page.getByLabel('音量',{exact:true}).fill('65');
  await page.setViewportSize({width:390,height:844});
  const box=await dialog.boundingBox(); assert.ok(box.width<=390&&box.height<=844);
  assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'钢琴面板不产生横向溢出');
  await shot(page,'piano-narrow');
  // 使用浏览器真实触屏事件验证双指和取消手势。
  const cdp=await ctx.newCDPSession(page);
  const one=await key(60).boundingBox(), two=await key(62).boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:one.x+one.width/2,y:one.y+one.height-35,id:1},{x:two.x+two.width/2,y:two.y+two.height-35,id:2}]});
  assert.equal(await pressed(),2,'双指同时演奏');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  assert.equal(await pressed(),0,'触屏取消释放');
  await page.setViewportSize({width:1400,height:900});
  const pianoKey=key(60); await pianoKey.scrollIntoViewIfNeeded();
  await pianoKey.hover(); await page.mouse.down(); assert.equal(await pressed(),1);
  await page.mouse.up(); assert.equal(await pressed(),0);
  await shot(page,'piano-desktop');
  // 自动演奏沿用当前主音 / 八度，首音与进度、琴键和音符广播同步。
  const twinkle=page.getByRole('button',{name:/小星星/});
  const ode=page.getByRole('button',{name:/欢乐颂/});
  const stopSong=page.getByRole('button',{name:'停止演奏',exact:true});
  const previousEmotes=await observer.evaluate(()=>window.pianoEmotes||0);
  await twinkle.click();
  await key(62).waitFor();
  assert.equal(await key(62).getAttribute('aria-pressed'),'true','小星星首音为当前主音 D4');
  await page.getByRole('status').filter({hasText:'1 / 42 音'}).waitFor();
  await observer.waitForFunction(previous=>(window.pianoEmotes||0)>previous,previousEmotes);
  assert.equal(await twinkle.getAttribute('aria-pressed'),'true');
  await ode.click();
  assert.equal(await twinkle.getAttribute('aria-pressed'),'false','切歌停止上一曲');
  assert.equal(await key(66).getAttribute('aria-pressed'),'true','欢乐颂首音为 F♯4');
  await stopSong.click();
  assert.equal(await pressed(),0,'停止按钮清理亮键');
  await page.waitForTimeout(600); assert.equal(await pressed(),0,'没有遗留下一音定时器');
  await twinkle.click(); await page.keyboard.down('z');
  assert.equal(await stopSong.isDisabled(),true,'手动弹琴接管');
  await page.keyboard.up('z');
  await twinkle.click();
  await page.getByLabel('主音',{exact:true}).selectOption('0');
  assert.equal(await stopSong.isDisabled(),true,'换调停止自动演奏');
  await twinkle.click(); await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await stopSong.isDisabled(),true,'失焦停止自动演奏');
  await ode.click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="示范曲"] button:last-of-type').disabled,{},{timeout:25000});
  assert.equal(await pressed(),0,'整首欢乐颂播完自动结束');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'新增曲目控件适配窄屏');
  await shot(page,'piano-songs-narrow');
  await twinkle.click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'}); await page.keyboard.up('a');
  assert.ok(await page.evaluate(()=>window.pianoAudio.filter(ctx=>ctx.meter).every(ctx=>ctx.state==='closed')),'关闭面板释放音频上下文');
  assert.deepEqual(errors,[],'无脚本错误');
  console.log('piano e2e ok');
 } finally { await browser.close(); fs.rmSync(navDir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exit(1);});
