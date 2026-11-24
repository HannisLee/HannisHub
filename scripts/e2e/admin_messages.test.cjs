// 在 launch_test_hub.py 的隔离实例中验证管理员直接挂终端、工位显示和跨页面提醒。
const {chromium}=require(process.env.PW_CORE);
const assert=require('node:assert/strict');
const fs=require('node:fs');
const origin=`http://127.0.0.1:${process.env.HUB_PORT||18126}`;

async function api(page,url,method='GET',body){
 return page.evaluate(async({url,method,body})=>{
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 },{url,method,body});
}
async function login(page,username){
 await page.goto(origin+'/login');
 assert.equal((await api(page,'/api/auth/login','POST',{username,password:'e2e-test-pass-123'})).status,200);
}
async function focus(page,value){
 if(value)await page.bringToFront();
 await page.evaluate(value=>{window.__focused=value;window.dispatchEvent(new Event(value?'focus':'blur'));},value);
}

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME,headless:true});
 try{
 const admin=await browser.newContext({viewport:{width:1400,height:900},permissions:['notifications']});
 await admin.addInitScript(()=>{
  window.__focused=true;document.hasFocus=()=>window.__focused;
  window.__notices=[];window.__dings=0;window.__contacts=0;
  const Native=window.Notification;
  function NotificationSpy(title,options){const n=new Native(title,options);window.__notices.push({title,body:options?.body,tag:options?.tag,notification:n});return n;}
  Object.defineProperty(NotificationSpy,'permission',{get:()=>Native.permission});
  NotificationSpy.requestPermission=()=>Native.requestPermission();window.Notification=NotificationSpy;
  const oscillator=AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator=function(...args){window.__dings++;return oscillator.apply(this,args);};
  const fetchOriginal=window.fetch;
  window.fetch=async(...args)=>{const response=await fetchOriginal(...args);if(String(args[0]).endsWith('/private-chat/contacts'))window.__contacts++;return response;};
 });
 const a=await admin.newPage();await login(a,'lihan');
 assert.equal((await api(a,'/api/chat-lobby/desks/mine','PUT',{desk:'desk-1'})).status,200);
 await api(a,'/api/chat-lobby/profile','PUT',{name:'管理员测试',avatar:null,photo:''});
 await a.goto(origin+'/terminal');
 const setup=await admin.newPage();await setup.goto(origin+'/settings/global');
 await setup.getByRole('button',{name:'重新申请权限',exact:true}).click();
 await setup.getByText('已授权并开启新消息桌面提醒。',{exact:true}).waitFor();
 await setup.close();
 await a.getByRole('button',{name:'消息提醒设置',exact:true}).click();
 assert.equal(await a.getByRole('checkbox',{name:'桌面通知',exact:true}).isChecked(),true);
 await a.getByRole('button',{name:'收起',exact:true}).click();
 await a.waitForFunction(()=>window.__contacts>0);
 const b=await admin.newPage();await b.goto(origin+'/llama/ocr');await b.waitForFunction(()=>window.__contacts>0);
 const visitor=await browser.newContext();const guest=await visitor.newPage();await login(guest,'guest');
 await guest.evaluate(()=>{
  window.__players={};window.__events=[];
  const socket=new WebSocket(location.origin.replace('http','ws')+'/api/chat-lobby/ws');window.__socket=socket;
  socket.onmessage=event=>{const data=JSON.parse(event.data);window.__events.push(data);if(data.type==='snapshot')for(const p of data.players)window.__players[p.id]=p;else{}if(data.type==='player')window.__players[data.player.id]=data.player;if(data.type==='move')Object.assign(window.__players[data.id]||={},data);if(['hide','leave'].includes(data.type))delete window.__players[data.id];};
 });
 await guest.waitForFunction(()=>Object.values(window.__players).some(p=>p.name==='管理员测试'&&p.pose==='sit'));
 const player=await guest.evaluate(()=>Object.values(window.__players).find(p=>p.name==='管理员测试'));
 const layout=JSON.parse(fs.readFileSync('frontend/public/chat-lobby/club/layout.json','utf8'));
 const hall=layout.rooms.find(room=>room.desks?.some(d=>d.id==='desk-1'));const seat=hall.desks.find(d=>d.id==='desk-1').seat;
 assert.equal(player.x,hall.x+seat.x);assert.equal(player.y,hall.y+seat.y);
 await guest.evaluate(player=>window.__socket.send(JSON.stringify({type:'state',room:player.room,x:player.x,y:player.y+20,dir:'up',moving:false})),player);
 const contact=(await api(guest,'/api/chat-lobby/private-chat/contacts')).data.find(c=>c.name==='管理员测试');
 const foreground=await admin.newPage();await foreground.goto(origin+'/llama/ocr');
 await foreground.waitForFunction(()=>window.__contacts>0);
 await focus(foreground,true);
 let resumeContacts;
 const contactsGate=new Promise(resolve=>{resumeContacts=resolve;});
 // 模拟后台标签页已显示系统通知，前台标签页才收到未读更新。
 await foreground.route('**/private-chat/contacts',async route=>{await contactsGate;await route.continue();});
 await focus(a,false);await focus(b,false);
 assert.equal((await api(guest,`/api/chat-lobby/private-chat/${contact.id}/messages`,'POST',{source:'near',text:'跨页面私聊提醒',request_id:'admin-notify-'+Date.now()})).status,200);
 for(const page of [a,b])await page.waitForFunction(()=>document.title.startsWith('(1)'));
 await a.waitForFunction(()=>window.__notices.length===1||Object.keys(JSON.parse(localStorage.getItem('hannishub_admin_message_alerts')||'{}')).some(k=>k.startsWith('private:')));
 const noticeCount=async()=>await a.evaluate(()=>window.__notices.length)+await b.evaluate(()=>window.__notices.length);
 assert.equal(await noticeCount(),1);
 assert.equal(await a.evaluate(()=>window.__dings)+await b.evaluate(()=>window.__dings),2);
 resumeContacts();
 await foreground.locator('.admin-message-toast').getByText('跨页面私聊提醒',{exact:true}).waitFor();
 assert.equal(await foreground.evaluate(()=>window.__notices.length),0);
 await foreground.close();
 const reader=(await a.evaluate(()=>window.__notices.length))?a:b;
 const previous=reader.url();await focus(reader,true);
 await reader.evaluate(()=>window.__notices[0].notification.onclick(new Event('click')));
 const dialog=reader.getByRole('dialog',{name:'管理员私聊',exact:true});await dialog.waitFor();
 await dialog.getByText('跨页面私聊提醒',{exact:true}).last().waitFor();assert.equal(reader.url(),previous);
 const input=dialog.locator('textarea');await input.fill('不离开当前页面回复');await input.press('Enter');
 await dialog.getByText('不离开当前页面回复',{exact:true}).last().waitFor();
 for(const page of [a,b])await page.waitForFunction(()=>!document.title.startsWith('('));
 const rows=(await api(guest,`/api/chat-lobby/private-chat/${contact.id}/messages`)).data;assert.equal(rows.at(-1).text,'不离开当前页面回复');
 await reader.setViewportSize({width:390,height:844});
 await reader.waitForTimeout(250);
 const bounds=await dialog.boundingBox();if(!(bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y+bounds.height<=845))await reader.screenshot({path:'/tmp/hannishub-admin-modal-mobile.png'});assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y+bounds.height<=845,JSON.stringify(bounds));
 await reader.getByRole('button',{name:'关闭私聊',exact:true}).click();
 await reader.getByRole('button',{name:'消息提醒设置',exact:true}).click();
 const settingsBounds=await reader.locator('.admin-message-settings').boundingBox();assert.ok(settingsBounds.x>=0&&settingsBounds.x+settingsBounds.width<=390);
 await reader.getByRole('button',{name:'收起',exact:true}).click();await reader.setViewportSize({width:1400,height:900});
 await focus(a,false);await focus(b,false);
 await api(guest,'/api/chat-room/profile','PUT',{client_id:'guest-admin-notify',nickname:'guest'});
 assert.equal((await api(guest,'/api/chat-room/messages','POST',{client_id:'guest-admin-notify',content:'聊天室找管理员',nonce:'admin-notify-room-'+Date.now()})).status,200);
 for(const page of [a,b])await page.waitForFunction(()=>document.title.startsWith('(1)'));
 // 等待一次完整轮询，重复推送与另一标签页均不应重复响铃或弹窗。
 await a.waitForTimeout(4200);
 assert.equal(await noticeCount(),2);
 const roomReader=(await a.evaluate(()=>window.__notices.some(n=>n.tag==='hannishub-admin-room')))?a:b;
 await focus(roomReader,true);await roomReader.evaluate(()=>window.__notices.find(n=>n.tag==='hannishub-admin-room').notification.onclick(new Event('click')));
 await roomReader.waitForURL(/\/chat\/?$/);await roomReader.getByText('聊天室找管理员',{exact:true}).last().waitFor();
 for(const page of [a,b])await page.waitForFunction(()=>!document.title.startsWith('('));
 // 管理员聊天室即使仍可见，失焦或被私聊对话框遮挡时也不能提前消掉未读。
 await roomReader.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>false}));
 await focus(roomReader,false);
 await api(guest,'/api/chat-room/messages','POST',{client_id:'guest-admin-notify',content:'失焦时保留未读',nonce:'admin-unfocused-'+Date.now()});
 await roomReader.waitForFunction(()=>document.title.startsWith('(1)'));
 await roomReader.waitForTimeout(2400);
 assert.ok((await roomReader.title()).startsWith('(1)'));
 await focus(roomReader,true);
 for(const page of [a,b])await page.waitForFunction(()=>!document.title.startsWith('('));
 await roomReader.getByRole('button',{name:/^管理员私聊/}).click();
 await roomReader.getByRole('dialog',{name:'管理员私聊',exact:true}).waitFor();
 await api(guest,'/api/chat-room/messages','POST',{client_id:'guest-admin-notify',content:'私聊遮挡时保留未读',nonce:'admin-covered-'+Date.now()});
 await roomReader.waitForFunction(()=>document.title.startsWith('(1)'));
 await roomReader.getByRole('button',{name:'关闭私聊',exact:true}).click();
 for(const page of [a,b])await page.waitForFunction(()=>!document.title.startsWith('('));
 await roomReader.evaluate(()=>delete document.hidden);
 const lobby=roomReader===a?b:a;await focus(lobby,true);await lobby.goto(origin+'/chat-lobby');
 await guest.waitForFunction(()=>Object.values(window.__players).some(p=>p.name==='管理员测试'&&p.pose!=='sit'));
 await lobby.goto(origin+'/llama/ocr');
 await guest.waitForFunction(()=>Object.values(window.__players).some(p=>p.name==='管理员测试'&&p.pose==='sit'));
 assert.equal(await guest.evaluate(()=>Object.values(window.__players).filter(p=>p.name==='管理员测试').length),1);
 assert.equal(await guest.evaluate(()=>Object.values(window.__players).find(p=>p.name==='管理员测试').id),player.id);
 // 拒绝权限与不安全上下文有明确说明，不影响网页提醒。
 await lobby.getByRole('button',{name:'消息提醒设置',exact:true}).click();
 await lobby.getByRole('checkbox',{name:'桌面通知',exact:true}).uncheck();
 await lobby.evaluate(()=>Notification.requestPermission=async()=> 'denied');
 await lobby.getByRole('button',{name:'开启桌面通知',exact:true}).click();await lobby.getByText('浏览器已阻止通知，可在地址栏的站点设置中允许。',{exact:true}).waitFor();
 await lobby.getByRole('button',{name:'收起',exact:true}).click();
 const insecure=await admin.newPage();await insecure.addInitScript(()=>Object.defineProperty(window,'isSecureContext',{value:false}));await insecure.goto(origin+'/llama/ocr');
 await insecure.getByRole('button',{name:'消息提醒设置',exact:true}).click();assert.equal(await insecure.getByRole('button',{name:'开启桌面通知',exact:true}).isDisabled(),true);
 await insecure.close();
 const closeCode=await guest.evaluate(()=>new Promise(resolve=>{const socket=new WebSocket(location.origin.replace('http','ws')+'/api/chat-lobby/ws?background=1');socket.onclose=e=>resolve(e.code);}));assert.ok([4403,1006].includes(closeCode));
 await a.close();await b.close();
 await guest.waitForFunction(()=>!Object.values(window.__players).some(p=>p.name==='管理员测试'));
 await guest.goto(origin+'/chat-lobby');await guest.locator('canvas').first().waitFor();assert.equal(await guest.getByRole('button',{name:'消息提醒设置',exact:true}).count(),0);
 console.log('通过：管理员直接挂终端与 OCR 工位显示、真实大厅优先、角色去重、跨页面私聊与回复、聊天室失焦/遮挡未读、音频/桌面去重、通知点击、拒绝与不安全上下文、普通账号边界');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
