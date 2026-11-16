// 连连看核心算法测试（纯逻辑，不需要浏览器和 Hub）：两折以内寻路、11 种关卡变化、重列、关卡生成的可解性与耗时。
// 运行：node scripts/e2e/linkup_logic.test.cjs（会把 frontend/components/chatworld/linkup 下的 TS 编译到临时目录）
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

const root=path.resolve(__dirname,'../..');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'linkup-logic-'));
execFileSync('npx',['tsc','--outDir',out,'--module','commonjs','--target','es2022','--skipLibCheck','components/chatworld/linkup/levels.ts'],{cwd:path.join(root,'frontend')});
const B=require(path.join(out,'board.js'));
const L=require(path.join(out,'levels.js'));
const S=require(path.join(out,'sprites.js'));

/** 用字符画建盘：'.' 为空，字母为图案 */
function parse(lines){
 const rows=lines.length,cols=lines[0].length;const b=B.emptyBoard(rows,cols);
 lines.forEach((line,r)=>[...line].forEach((ch,c)=>{if(ch!=='.')B.set(b,r+1,c+1,ch.charCodeAt(0)-64);}));
 return b;
}
const at=(r,c)=>({r,c});
let passed=0;
const test=(name,fn)=>{fn();passed++;console.log('ok',name);};

test('图案素材尺寸',()=>{
 const icons=S.allIconRows();
 assert.ok(icons.length>=36);
 for(const icon of icons){assert.equal(icon.rows.length,14,icon.name);for(const row of icon.rows)assert.equal(row.length,14,icon.name);}
});

test('直线、一折、两折与绕外圈',()=>{
 const b=parse([
  'A.A.',
  'BCCB',
  'D..E',
  'EXXD',
 ]);
 // 同行直线（中间空）
 assert.equal(B.findPath(b,at(1,1),at(1,3)).length,2);
 // 相邻
 assert.equal(B.findPath(b,at(2,2),at(2,3)).length,2);
 // B 与 B 中间被 C 挡住，从上方绕：B(2,1) 上到第 0 行再下来到 B(2,4)？(1,1) 有 A 挡住 → 走不通上方；
 // 应从左右外圈绕：不可能（同一行两端，外圈需要绕三折）。实际可行：两折 上-右-下 被 A 挡；结论 null
 assert.equal(B.findPath(b,at(2,1),at(2,4)),null);
 // D(3,1) 与 D(4,4)：一折 (4,1)? 被 E 占；(3,4) 被 E 占；两折 经第 5 行（外圈）：(3,1)→(5,1)? (4,1) 有 E 挡 → 不通；
 // 经第 3 行中间 (3,2),(3,3) 空 → (3,1)→(3,3)→(4,3)? (4,3) 是 X → 不通。经列 0：(3,0)→(4,0)→横到(4,4)被 E/X 挡 → 不通
 assert.equal(B.findPath(b,at(3,1),at(4,4)),null);
 // E(3,4) 与 E(4,1)：同上对称 → 不通
 assert.equal(B.findPath(b,at(3,4),at(4,1)),null);
 // X 相邻
 assert.ok(B.findPath(b,at(4,2),at(4,3)));
 // 绕外圈：两个角上的同图案
 const c=parse(['A..B','CDEF','B..A']);
 const p=B.findPath(c,at(1,1),at(3,4));
 assert.equal(p,null,'对角需要三折');
 const d=parse(['A.BA','CDEF']);
 const q=B.findPath(d,at(1,1),at(1,4));
 assert.ok(q,'经外圈上方两折');
 assert.equal(q.length,4);
 assert.deepEqual(q[1],{r:0,c:1});
 // 最少拐弯优先：能直线时不绕
 const e=parse(['A..A','....']);
 assert.equal(B.findPath(e,at(1,1),at(1,4)).length,2);
 // 端点不能是自己，图案不同不能连
 assert.equal(B.findPath(e,at(1,1),at(1,1)),null);
 assert.equal(B.canLink(parse(['AB']),at(1,1),at(1,2)),false);
});

test('两折路径与暴力搜索一致',()=>{
 // 随机盘面上，与「按拐弯数 BFS」的结果对比是否连通
 const rng=B.makeRng(7);
 function bfs(b,a,t){
  const R=b.rows+2,C=b.cols+2;const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
  const best=new Map();const queue=[];
  for(let d=0;d<4;d++)queue.push([a.r,a.c,d,0]);
  while(queue.length){
   const [r,c,d,turns]=queue.shift();
   const nr=r+dirs[d][0],nc=c+dirs[d][1];
   if(nr<0||nc<0||nr>=R||nc>=C)continue;
   if(nr===t.r&&nc===t.c)return true;
   if(B.get(b,nr,nc)!==0)continue;
   for(let nd=0;nd<4;nd++){const nt=turns+(nd===d?0:1);if(nt>2)continue;const key=`${nr},${nc},${nd}`;if((best.get(key)??9)<=nt)continue;best.set(key,nt);queue.push([nr,nc,nd,nt]);}
  }
  return false;
 }
 for(let k=0;k<300;k++){
  const b=B.emptyBoard(6,8);
  for(const p of B.innerCells(b))if(rng()<0.55)B.set(b,p.r,p.c,1);
  const cells=B.occupied(b);if(cells.length<2)continue;
  const a=cells[Math.floor(rng()*cells.length)],t=cells[Math.floor(rng()*cells.length)];
  if(a===t)continue;
  assert.equal(Boolean(B.findPath(b,a,t)),bfs(b,a,t),`第 ${k} 个随机盘面`);
 }
});

test('11 种关卡变化',()=>{
 assert.equal(B.SHIFTS.length,11);
 const show=b=>Array.from({length:b.rows},(_,r)=>Array.from({length:b.cols},(_,c)=>{const v=B.get(b,r+1,c+1);return v?String.fromCharCode(64+v):'.';}).join(''));
 const cases=[
  // [变化方式, 原盘面, 期望结果]；4 行 6 列时上半为 1–2 行、左半为 1–3 列
  ['none',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','G.H.IJ','K.L..M','NOPQRS']],
  ['down',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['A.C..F','G.H.EJ','KBLDIM','NOPQRS']],
  ['up',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','GOHQIJ','K.L.RM','N.P..S']],
  ['left',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','GHIJ..','KLM...','NOPQRS']],
  ['right',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','..GHIJ','...KLM','NOPQRS']],
  ['split-h',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','GH..IJ','KL...M','NOPQRS']],
  ['gather-h',['ABCDEF','G.H.IJ','K.L..M','NOPQRS'],['ABCDEF','.GHIJ.','.KLM..','NOPQRS']],
  ['split-v',['.A','B.','.C','D.'],['BA','..','..','DC']],
  ['gather-v',['A.','.B','C.','.D'],['..','AB','CD','..']],
  ['up-left-down-right',['.A.B','C...','..D.','E...'],['AB..','C...','...D','...E']],
  ['left-down-right-up',['A..B','....','.C..','...D'],['...B','...D','....','AC..']],
 ];
 for(const [shift,from,want] of cases){const b=parse(from);B.applyShift(b,shift);assert.deepEqual(show(b),want,shift);}
 // 所有变化都保持方块数量，且移动列表与结果一致
 const rng=B.makeRng(3);
 for(const shift of B.SHIFTS){
  for(let k=0;k<20;k++){
   const b=B.emptyBoard(7,10);for(const p of B.innerCells(b))if(rng()<0.6)B.set(b,p.r,p.c,1+Math.floor(rng()*5));
   const before=B.remaining(b);const copy=B.cloneBoard(b);
   const moves=B.applyShift(b,shift);
   assert.equal(B.remaining(b),before,shift);
   for(const m of moves)assert.equal(B.get(b,m.to.r,m.to.c),B.get(copy,m.from.r,m.from.c),shift);
   // 再执行一次不会再移动（已经压紧）
   assert.equal(B.applyShift(b,shift).length,0,shift+' 幂等');
  }
 }
});

test('重列后至少有一对可消除',()=>{
 const rng=B.makeRng(11);
 for(let k=0;k<30;k++){
  const b=B.emptyBoard(8,14);
  const kinds=28;const bag=[];for(let i=0;i<56;i++){const v=1+(i%kinds);bag.push(v,v);}
  B.shuffleInPlace(bag,rng);B.innerCells(b).forEach((p,i)=>B.set(b,p.r,p.c,bag[i]));
  // 随机拿掉一些
  for(let i=0;i<20;i++){const pairs=B.availablePairs(b);if(!pairs.length)break;const [x,y]=pairs[0];B.removePair(b,x,y,'none');}
  const counts=JSON.stringify(B.occupied(b).map(p=>B.get(b,p.r,p.c)).sort());
  B.reshuffle(b,rng,1);
  assert.equal(JSON.stringify(B.occupied(b).map(p=>B.get(b,p.r,p.c)).sort()),counts,'图案数量不变');
  assert.ok(B.availablePairs(b,1).length>=1);
 }
});

test('关卡生成：可解、难度递进、耗时可接受',()=>{
 let worst=0;const stats=[];
 for(let level=1;level<=22;level++){
  const cfg=L.campaignLevel(level,12345);
  const t0=performance.now();
  const g=B.generateLevel({rows:cfg.rows,cols:cfg.cols,kinds:cfg.kinds,pool:S.TILE_KINDS,shift:cfg.shift,difficulty:cfg.difficulty},B.makeRng(cfg.seed));
  const ms=performance.now()-t0;worst=Math.max(worst,ms);
  assert.equal(B.remaining(g.board),cfg.rows*cfg.cols);
  // 每种图案都是偶数个
  const counts={};for(const p of B.occupied(g.board)){const v=B.get(g.board,p.r,p.c);counts[v]=(counts[v]||0)+1;}
  for(const n of Object.values(counts))assert.equal(n%2,0);
  assert.ok(Object.keys(counts).length<=cfg.kinds);
  // 按生成器编排的路线逐步消除：每一步两块图案相同且可连通，最后清空 → 证明有解
  assert.equal(g.route.length,cfg.rows*cfg.cols/2,`第 ${level} 关有完整路线`);
  const replay=B.cloneBoard(g.board);
  for(const [a,b] of g.route){assert.ok(B.canLink(replay,a,b),`第 ${level} 关路线可走`);B.removePair(replay,a,b,cfg.shift);}
  assert.equal(B.remaining(replay),0);
  stats.push(`${level}:${cfg.shift}/${cfg.kinds}种/${cfg.time}s/开局${g.openMoves}/相邻${g.adjacent}/${Math.round(ms)}ms`);
 }
 const daily=L.dailyLevel('2026-11-17');
 assert.deepEqual(L.dailyLevel('2026-11-17'),daily,'同一天配置相同');
 const t0=performance.now();
 const d1=B.generateLevel({rows:daily.rows,cols:daily.cols,kinds:daily.kinds,pool:S.TILE_KINDS,shift:daily.shift,difficulty:daily.difficulty},B.makeRng(daily.seed));
 const dms=performance.now()-t0;
 const d2=B.generateLevel({rows:daily.rows,cols:daily.cols,kinds:daily.kinds,pool:S.TILE_KINDS,shift:daily.shift,difficulty:daily.difficulty},B.makeRng(daily.seed));
 assert.deepEqual(d1.board.cells,d2.board.cells,'每日挑战盘面可复现');
 for(const size of Object.keys(L.CASUAL_SIZES))for(const lv of Object.keys(L.CASUAL_LEVELS)){
  const cfg=L.casualLevel(size,lv,'random',99);
  const g=B.generateLevel({rows:cfg.rows,cols:cfg.cols,kinds:cfg.kinds,pool:S.TILE_KINDS,shift:cfg.shift,difficulty:cfg.difficulty},B.makeRng(cfg.seed));
  assert.equal(B.remaining(g.board),cfg.rows*cfg.cols);
  const replay=B.cloneBoard(g.board);
  for(const [a,b] of g.route){assert.ok(B.canLink(replay,a,b));B.removePair(replay,a,b,cfg.shift);}
  assert.equal(B.remaining(replay),0,`休闲 ${size}/${lv}`);
 }
 const dr=B.cloneBoard(d1.board);for(const [a,b] of d1.route){assert.ok(B.canLink(dr,a,b));B.removePair(dr,a,b,daily.shift);}
 assert.equal(B.remaining(dr),0,'每日挑战可解');
 console.log('  ',stats.join('  '));
 console.log(`   每日挑战 ${daily.title} ${Math.round(dms)}ms；闯关单关最慢 ${Math.round(worst)}ms`);
 assert.ok(worst<2500,'单关生成不超过 2.5 秒');
});

console.log(`全部通过：${passed} 项`);
fs.rmSync(out,{recursive:true,force:true});
