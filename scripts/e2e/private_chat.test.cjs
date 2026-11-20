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
   const composer=ui.locator('.private-panel .chat-composer');
   const inputBox=await input.boundingBox();
   const sendBox=await composer.getByRole('button',{name:'发送',exact:true}).boundingBox();
   assert.ok(inputBox.width>80 && sendBox.x>=inputBox.x+inputBox.width);
   assert.ok(Math.abs(inputBox.y+inputBox.height-sendBox.y-sendBox.height)<4);
   await input.press('Shift+Enter');
   await input.press('a');
   assert.ok((await input.inputValue()).includes('\n'));
   assert.ok((await input.boundingBox()).height>inputBox.height);
   await composer.getByRole('button',{name:'表情',exact:true}).click();
   await ui.locator('.chat-emoji-button:visible').first().waitFor();
   const before=await input.inputValue();
   await ui.locator('.chat-emoji-button:visible').first().click();
   assert.ok((await input.inputValue()).length>before.length);
   await ui.keyboard.press('Escape');
   assert.equal(await ui.getByRole('dialog').count(),1);
   assert.equal(await ui.locator('.chat-emoji-popover').count(),0);
   // 自己的消息靠右：头像贴右边缘，气泡紧挨在头像左侧
   const mine=ui.locator('.chat-row-mine:not(.chat-row-grouped)').last();
   const rowBox=await mine.boundingBox();
   const avatarBox=await mine.locator('.chat-avatar').boundingBox();
   const bubbleBox=await mine.locator('.chat-bubble').boundingBox();
   assert.ok(Math.abs(avatarBox.x+avatarBox.width-rowBox.x-rowBox.width)<2);
   assert.ok(bubbleBox.x+bubbleBox.width<=avatarBox.x);

   await ui.keyboard.press('Escape');
   await ui.getByRole('dialog').waitFor({state:'hidden'});
 }
 await ui.unroute('**/private-chat/*/open');

 // 接收不限位置：guest 收到来信后可在任意位置（inbox）回复；lihan 收到回信前不能在任意位置发起
 assert.equal((await req(pages[1],lihan.id+'/open','POST',{source:'inbox'})).data.allowed,true);
 assert.equal((await req(pages[0],guest.id+'/open','POST',{source:'inbox'})).data.allowed,false);
 assert.equal((await req(pages[0],guest.id+'/messages','POST',{source:'inbox',text:'越权',request_id:'inbox-deny'})).status,409);
 assert.equal((await req(pages[1],lihan.id+'/messages','POST',{source:'inbox',text:'收到',request_id:'reply-1'})).status,200);
 assert.equal((await req(pages[0],guest.id+'/open','POST',{source:'inbox'})).data.allowed,true);

 // 头像与名字：在「我的房间」设置后，私聊联系人与聊天室同步
 const photo='🦊';
 assert.equal(await pages[1].evaluate(async photo=>(await fetch('/api/chat-lobby/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'访客小G',avatar:null,photo})})).status,photo),200);
 const renamed=(await req(pages[0],'contacts')).data.find(c=>c.id===guest.id);
 assert.equal(renamed.name,'访客小G');assert.equal(renamed.photo,photo);
 const roomProfile=await pages[1].evaluate(async()=>(await fetch('/api/chat-room/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'e2e-guest-client',nickname:'随便',avatar:''})})).json());
 assert.equal(roomProfile.nickname,'访客小G');assert.equal(roomProfile.avatar,photo);assert.equal(roomProfile.linked,true);

 // 游戏画面中的私聊提醒：点击直接打开会话，各种屏幕尺寸下对话框都不超出视口、外层不出现滚动条
 const gp=pages[1];
 const shots=process.env.SHOT_DIR;
 let n=0;
 for(const [width,height] of [[1400,850],[1280,640],[390,844]]){
   await pages[0].waitForTimeout(900);
   assert.equal((await req(pages[0],guest.id+'/messages','POST',{source:'inbox',text:`第${++n}条来信`,request_id:`badge-${n}`})).status,200);
   await gp.setViewportSize({width,height});
   await gp.goto(origin+'/chat-lobby');
   const badge=gp.locator('.lobby-private-badge');
   await badge.waitFor({timeout:20000});
   const badgeBox=await badge.boundingBox();
   const stageBox=await gp.locator('.lobby-stage').boundingBox();
   assert.ok(badgeBox.x>=stageBox.x && badgeBox.x+badgeBox.width<=stageBox.x+stageBox.width+0.5 && badgeBox.y>=stageBox.y);
   if(shots) await gp.screenshot({path:`${shots}/badge-${width}x${height}.png`});
   await badge.click();
   const dialog=gp.getByRole('dialog');await dialog.waitFor();
   await gp.locator('.chat-bubble',{hasText:`第${n}条来信`}).waitFor();
   const input=gp.getByRole('textbox',{name:'私聊消息'});await input.waitFor();
   await gp.waitForTimeout(300); // 等对话框入场动画结束再测量
   const layoutState=await gp.evaluate(()=>{
     const box=document.querySelector('.lobby-machine').getBoundingClientRect();
     const body=document.querySelector('.lobby-machine-body');
     return {bodyOverflow:body.scrollHeight-body.clientHeight,top:box.top,bottom:box.bottom,inner:innerHeight,
       back:getComputedStyle(document.querySelector('.private-back')).display,contacts:getComputedStyle(document.querySelector('.private-contacts')).display};
   });
   assert.ok(layoutState.bodyOverflow<=1 && layoutState.top>=0 && layoutState.bottom<=layoutState.inner+0.5,JSON.stringify(layoutState));
   assert.equal(layoutState.back==='none',width>767,JSON.stringify(layoutState));
   if(width<=767) assert.ok(layoutState.top===0 && Math.abs(layoutState.bottom-layoutState.inner)<1,'窄屏私聊应铺满屏幕 '+JSON.stringify(layoutState));
   assert.equal(layoutState.contacts==='none',width<=767,JSON.stringify(layoutState));
   const composerBox=await gp.locator('.private-panel .chat-composer').boundingBox();
   assert.ok(composerBox.y+composerBox.height<=height);
   assert.equal(await gp.locator('.private-thread .chat-avatar').first().count(),1);
   await input.fill(`回复${n}`);await input.press('Enter');
   await gp.locator('.chat-bubble',{hasText:`回复${n}`}).waitFor();
   if(shots) await gp.screenshot({path:`${shots}/inbox-${width}x${height}.png`});
   await gp.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 }
 // 独立私聊页实际发送剪贴板图片，第三个账号不能读取或引用该附件。
 const ap=pages[0];
 await ap.goto(origin+'/private-chat');
 await ap.getByRole('button',{name:/访客小G/}).click();
 const attach=ap.getByRole('button',{name:'发送图片或文件'});
 await attach.waitFor();
 const send=ap.getByRole('button',{name:'发送',exact:true});
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/axkAAAAASUVORK5CYII=';
 await ap.getByRole('textbox',{name:'私聊消息'}).evaluate((input,png)=>{
   const data=new DataTransfer();
   data.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'剪贴板.png',{type:'image/png'}));
   input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
 },png);
 await ap.locator('.private-attachment-draft img').waitFor();
 await send.click();
 const thumbnail=ap.getByRole('button',{name:'查看 剪贴板.png'});
 await thumbnail.click();
 await ap.getByRole('dialog',{name:'剪贴板.png'}).waitFor();
 await ap.keyboard.press('Escape');
 await ap.getByRole('dialog',{name:'剪贴板.png'}).waitFor({state:'hidden'});
 const image=(await req(gp,lihan.id+'/messages')).data.at(-1).attachment;
 assert.equal(image.kind,'image');assert.equal(image.name,'剪贴板.png');assert.equal(image.width,1);
 const filePath=(contact,id)=>'/api/chat-lobby/private-chat/'+contact+'/files/'+id;
 const imageResponse=await gp.request.get(origin+filePath(lihan.id,image.id));
 assert.equal(imageResponse.status(),200);
 assert.equal(imageResponse.headers()['cache-control'],'private, no-store');
 assert.deepEqual(await imageResponse.body(),Buffer.from(png,'base64'));
 assert.equal((await pages[2].request.get(origin+filePath(lihan.id,image.id))).status(),404);
 assert.equal((await pages[2].request.get(origin+'/api/chat-room/files/'+image.id)).status(),404);
 assert.equal((await gp.request.get(origin+filePath(lihan.id,image.id)+'?download=true')).headers()['content-disposition'].startsWith('attachment;'),true);
 assert.equal((await req(gp,lihan.id+'/messages','POST',{source:'inbox',attachment_id:image.id,request_id:'receiver-cannot-reuse'})).status,404);
 await ap.reload();
 await ap.getByRole('button',{name:/访客小G/}).click();
 await thumbnail.waitFor();
 await ap.waitForTimeout(850); // 同账号发送间隔为 0.8 秒。
 await ap.locator('.private-thread input[type=file]').setInputFiles({name:'准备移除.txt',mimeType:'text/plain',buffer:Buffer.from('草稿')});
 await ap.getByText('准备移除.txt',{exact:true}).waitFor();
 await ap.getByRole('button',{name:'移除'}).click();
 await ap.locator('.private-attachment-draft').waitFor({state:'hidden'});
 await ap.locator('.private-thread').evaluate(thread=>{
   const data=new DataTransfer();
   data.items.add(new File(['附件内容'],'拖入.txt',{type:'text/plain'}));
   thread.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
 });
 await ap.getByText('拖入.txt',{exact:true}).waitFor();
 await ap.getByRole('textbox',{name:'私聊消息'}).fill('随附说明');
 await send.click();
 await ap.getByRole('link',{name:'下载 拖入.txt'}).waitFor();
 const file=(await req(gp,lihan.id+'/messages')).data.at(-1);
 assert.equal(file.text,'随附说明');
 assert.equal(file.attachment.kind,'file');
 const download=await gp.request.get(origin+filePath(lihan.id,file.attachment.id));
 assert.equal(download.status(),200);
 assert.equal(await download.text(),'附件内容');
 console.log('私聊浏览器检查通过：三账号隔离、定向通知、幂等发送、已读与距离失效、任意位置回复、提醒入口、多尺寸布局、头像同步、图片与文件发送及访问隔离');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
