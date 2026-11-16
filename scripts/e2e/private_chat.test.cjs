// 在隔离测试 Hub 中验证三账号的私聊权限与定向通知。
const {chromium}=require(process.env.PW_CORE);
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME});
 try {
 const origin=`http://127.0.0.1:${process.env.HUB_PORT||18126}`;
 const pages=[];
 for(const username of ['lihan','guest','third']){
 const ctx=await browser.newContext();const p=await ctx.newPage();await p.goto(origin+'/login');
 if(username==='third') await pages[0].evaluate(async()=>fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'third',password:'e2e-test-pass-123'})}));
 assert.equal(await p.evaluate(async username=>(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'e2e-test-pass-123'})})).status,username),200);
 await p.evaluate(()=>{window.events=[];window.ws=new WebSocket(`ws://${location.host}/api/chat-lobby/ws`);window.ws.onmessage=e=>window.events.push(JSON.parse(e.data));});
 await p.waitForFunction(()=>window.ws.readyState===1);pages.push(p);
 }
 const state=async(p,x,dir='right')=>p.evaluate(({x,dir})=>window.ws.send(JSON.stringify({type:'state',room:'hall',x,y:300,dir,moving:false})),{x,dir});
 await state(pages[0],100);await state(pages[1],120,'left');await state(pages[2],500);
 const req=async(p,path,method='GET',body)=>p.evaluate(async({path,method,body})=>{const r=await fetch('/api/chat-lobby/private-chat/'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};},{path,method,body});
 const c=(await req(pages[0],'contacts')).data;const guest=c.find(c=>c.name==='guest');
 assert.equal((await req(pages[0],guest.id+'/open','POST',{source:'near',opening:true})).data.allowed,true);
 const payload={source:'near',text:'私聊测试',request_id:'browser-one'};
 assert.equal((await req(pages[0],guest.id+'/messages','POST',payload)).status,200);
 assert.equal((await req(pages[0],guest.id+'/messages','POST',payload)).status,200);
 const contacts=(await req(pages[1],'contacts')).data;const lihan=contacts.find(c=>c.name==='lihan');assert.equal(lihan.unread,1);
 const messages=(await req(pages[1],lihan.id+'/messages')).data;assert.equal(messages.length,1);assert.equal(messages[0].text,'私聊测试');
 assert.equal((await req(pages[2],guest.id+'/messages')).data.length,0);
 await req(pages[1],lihan.id+'/read','PUT',{seq:messages[0].seq});
 assert.equal((await req(pages[1],'contacts')).data.find(c=>c.id===lihan.id).unread,0);
 assert.equal(await pages[2].evaluate(()=>window.events.some(e=>e.type==='private-chat')),false);
 await state(pages[1],300);
 await pages[0].waitForTimeout(150);
 assert.equal((await req(pages[0],guest.id+'/open','POST',{source:'near'})).data.allowed,false);
 assert.equal((await req(pages[0],guest.id+'/messages','POST',{...payload,request_id:'far'})).status,409);
 assert.equal((await req(pages[0],guest.id+'/messages')).data.length,1);
 // 自己的工位可以向离线联系人发送消息。
 const layout=JSON.parse(require('node:fs').readFileSync('frontend/public/chat-lobby/club/layout.json','utf8'));
 const room=layout.rooms.find(r=>r.desks?.length);const desk=room.desks[0];
 assert.equal(await pages[0].evaluate(async desk=>(await fetch('/api/chat-lobby/desks/mine',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({desk})})).status,desk.id),200);
 await pages[0].evaluate(({room,desk})=>window.ws.send(JSON.stringify({type:'state',room:room.id,x:room.x+desk.seat.x,y:room.y+desk.seat.y,dir:desk.seat.dir,pose:'sit',moving:false})),{room,desk});
 await pages[1].evaluate(()=>window.ws.close());
 await pages[0].waitForTimeout(900);
 assert.equal((await req(pages[0],guest.id+'/messages','POST',{source:'desk',text:'离线留言',request_id:'offline'})).status,200);
 assert.equal((await req(pages[1],lihan.id+'/messages')).data.at(-1).text,'离线留言');
 await state(pages[0],500);
 await pages[0].waitForTimeout(150);
 assert.equal((await req(pages[0],guest.id+'/open','POST',{source:'desk'})).data.allowed,false);
 // 界面冒烟：仅模拟持续有效的交谈资格，消息仍来自隔离数据库。
 const ui=pages[0];
 await ui.route('**/private-chat/*/open',route=>route.fulfill({json:{allowed:true}}));
 await ui.goto(origin+'/chat-lobby');
 await ui.locator('canvas').first().waitFor();
 await ui.waitForTimeout(1200);
 const latest=(await req(ui,'contacts')).data.find(c=>c.name==='guest');
 for(const width of [1400,390]) {
   await ui.setViewportSize({width,height:850});
   await ui.evaluate(id=>window.dispatchEvent(new CustomEvent('lobby-private-open',{detail:id})),latest.scene_id);
   await ui.getByRole('dialog').waitFor();
   const input=ui.getByRole('textbox',{name:'私聊消息'});
   await input.fill('WASD E 空格正常输入');
   assert.equal(await input.inputValue(),'WASD E 空格正常输入');
   await ui.getByText('离线留言',{exact:true}).waitFor();
   await ui.keyboard.press('Escape');
   await ui.getByRole('dialog').waitFor({state:'hidden'});
 }
 console.log('私聊浏览器检查通过：三账号隔离、定向通知、幂等发送、已读与距离失效');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
