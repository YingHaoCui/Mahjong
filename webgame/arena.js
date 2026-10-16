'use strict';
const $ = id => document.getElementById(id);
const SUITS = ['条', '万', '筒'];
const ACTIONS = {daque:'定缺', discard:'打出', pong:'碰', kong:'明杠', ankong:'暗杠', jiakong:'加杠', hu:'胡', zimo:'自摸', robkong:'抢杠胡', pass:'过', draw:'摸牌'};
const STATUS = {waiting:'等待入席',playing:'对局进行中',between_games:'本局已结算 · 等待下一局',complete:'比赛结束',forfeit:'超时判负 · 比赛结束',stopped:'比赛已结束',invalid:'引擎异常 · 本局无效'};
let roomId = '', token = '', state = null, credentials = [], replay = null, replayTimer = null, pollVersion = 0, noticeTimer;
function el(tag, text, cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(label, fn, cls='quiet') {const b=el('button',label,cls);b.type='button';b.addEventListener('click',()=>Promise.resolve().then(fn).catch(report));return b;}
function notice(message) {$('notice').textContent=message;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,5500);}
function report(e) {notice(e.message || String(e));}
async function api(path, body, credential=token) {
  const headers={};if(credential)headers.Authorization=`Bearer ${credential}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(`${data.error?.code || response.status}: ${data.error?.message || '请求失败'}`);return data;
}
const endpoint = op => `/api/rooms/${encodeURIComponent(roomId)}${op?'/'+op:''}`;
const ownerKey = id => `mahjong-owner:${id}`;
const seatKey = id => `mahjong-seat:${id}`;
function invite(seatId) {return `${location.origin}/#${new URLSearchParams({room:roomId,seat:seatId})}`;}
async function copy(text) {await navigator.clipboard.writeText(text);notice('已复制');}
function tile(t, mini=false) {const n=el('span',undefined,`tile c${t[0]}${mini?' mini':''}`);n.append(el('b',t[1]),el('small',SUITS[t[0]]));return n;}
function tiles(hand, count, mini=false) {const row=el('div',undefined,'tile-row');if(hand)hand.forEach(t=>row.append(tile(t,mini)));else for(let i=0;i<count;i++)row.append(el('span',undefined,'tile back'));return row;}
async function rooms() {const data=await api('/api/rooms',undefined,'');$('rooms').replaceChildren();if(!data.rooms.length)$('rooms').append(el('p','还没有房间，创建第一张牌桌。'));for(const r of data.rooms.reverse()){const row=el('div',undefined,'room-entry');const info=el('div',r.name);info.append(el('small',`${STATUS[r.status]} · ${r.joined}/4 席 · ${r.gameNumber}/${r.games} 局`));row.append(info,button('进入',()=>openRoom(r.roomId)));$('rooms').append(row);}}
async function openRoom(id, credential) {
  pollVersion++;roomId=id;token=credential??sessionStorage.getItem(seatKey(id))??sessionStorage.getItem(ownerKey(id))??'';
  history.replaceState(null,'',`/#${new URLSearchParams({room:id})}`);
  $('lobby').hidden=true;$('room').hidden=false;replay=null;clearInterval(replayTimer);credentials=[];
  await refresh();poll(pollVersion);
}
async function refresh() {state=await api(endpoint(''));render();if(state.role==='owner'&&!credentials.length){credentials=(await api(endpoint('credentials'))).seatIds;renderCredentials();$('credentialDetails').open=state.status==='waiting';}}
async function poll(version) {
  while(version===pollVersion){try{if(token&&state?.role==='seat'&&!['complete','forfeit','stopped','invalid'].includes(state.status)){const r=await api(endpoint(`wait?afterRevision=${state.revision}`));if(version!==pollVersion)return;state=r.state;render();}else{await new Promise(r=>setTimeout(r,1200));if(version!==pollVersion)return;await refresh();}}catch(e){if(version!==pollVersion)return;report(e);await new Promise(r=>setTimeout(r,3000));}}
}
function renderCredentials() {
  $('credentials').replaceChildren();credentials.forEach((id,i)=>{const c=el('div',undefined,'credential');c.append(el('strong',`参赛者 ${i+1} · ${state.seats[i].name}`),el('code',id));const row=el('div',undefined,'row');row.append(button('复制座位 ID',()=>copy(id)),button('复制 AI 入席指令',()=>copy(`使用 Mahjong MCP 参赛。你的 seatId 是 ${id}。先调用 join_seat({seatId: "${id}", name: "AI ${i+1}"}) 加入。此后每次 get_observation、wait_for_decision 和 submit_action 都必须传 seatId: "${id}"；不要依赖共享连接记住座位。读取 get_rules，按 legalActions 决策；between_games 继续等待，complete/forfeit/stopped/invalid 时结束。`)),button('复制入席链接',()=>copy(invite(id))),button('我来入席',()=>{window.open(invite(id),'_blank','noopener');}));c.append(row);const d=el('details');d.append(el('summary','共享 MCP 配置（无需鉴权）'));d.append(el('pre',JSON.stringify({mcpServers:{mahjong:{type:'http',url:`${location.origin}/mcp`}}},null,2)),el('p','一个 harness 配置一次即可。四个会话各自使用自己的 seatId，每次座位相关调用都传入。','muted'));c.append(d);$('credentials').append(c);});
}
function renderTable(game) {
  const table=$('table');table.replaceChildren();if(!game){const w=el('div','血战到底','table-watermark');w.append(el('span','等待四位参赛者入席'));table.append(w);return;}
  const waiting=game.waitingFor==='responses'?' · 等待响应裁决':game.waitingFor==='daque'?' · 等待四席定缺':game.waitingFor==='turn'?' · 等待玩家决策':'';
  const meta=el('div',`第 ${game.number} 局 · 牌墙 ${game.wall} 张${waiting}${game.assisted?' · 辅助对局':''}${replay?' · 回放视角':''}`,'table-meta');table.append(meta);
  const own=game.yourSeat;const order=own===null||own===undefined?[2,3,1,0]:[(own+2)%4,(own+3)%4,(own+1)%4,own];
  for(const s of order){const p=game.players[s];const participant=state.seats[p.participant];const box=el('section',undefined,`player${game.activeSeats.includes(s)&&game.stage!=='over'?' active':''}${own===s?' mine':''}`);const title=el('div',undefined,'player-title');title.append(el('span',`${s+1}号位 · ${participant.name}${own===s?' · 你':''}`),el('strong',`${p.score>=0?'+':''}${p.score}`));box.append(title,el('div',`${p.winning?'已胡 · ':''}${p.daque===null?'定缺未公开':'缺'+SUITS[p.daque]} · ${participant.kind==='ai'?'AI':participant.kind==='human'?'人类':'未入席'}`,'muted'));const melds=el('div',undefined,'melds');p.pile.forEach(m=>melds.append(tiles(m,0,true)));box.append(melds,tiles(p.hand,p.nHand));if(p.drawn)box.append(el('div',`本次摸牌：${p.drawn[1]}${SUITS[p.drawn[0]]}`,'muted'));box.append(el('div','弃牌','muted'),tiles(p.discards,0,true));table.append(box);}
}
function render() {
  if(!state)return;$('roomId').textContent=state.roomId;$('roomName').textContent=state.name;$('roomStatus').textContent=`${STATUS[state.status]} · ${state.gameNumber}/${state.games} 局${Number.isInteger(state.failure?.participant)?' · '+state.seats[state.failure.participant].name+' 超时':''}`;
  $('ownerPanel').hidden=state.role!=='owner';$('ownerView').hidden=!sessionStorage.getItem(ownerKey(roomId))||state.role==='owner';$('joinForm').hidden=state.role==='seat'&&state.seats[state.participant].joined;
  $('startButton').disabled=!['waiting','between_games'].includes(state.status)||!state.seats.every(s=>s.joined);$('startButton').textContent=state.status==='between_games'?'开始下一局 · 换座':'开始本局';$('stopButton').disabled=['complete','stopped','forfeit','invalid'].includes(state.status);
  $('credentials').querySelectorAll('.credential > strong').forEach((label,i)=>label.textContent=`参赛者 ${i+1} · ${state.seats[i].name}`);
  const board=$('leaderboard');board.replaceChildren();[...state.seats].sort((a,b)=>b.score-a.score).forEach((p,i)=>{const r=el('div',undefined,'ranking');const name=el('span',`${i+1}. ${p.name}${p.joined?'':' · 未入席'}`);name.append(el('div',`${p.games} 局 · 胡 ${p.huGames} · 自摸 ${p.zimoGames}${p.assistedGames?' · '+p.assistedGames+' 辅助局':''}`,'muted'));r.append(name,el('strong',`${p.score>=0?'+':''}${p.score}`));board.append(r);});
  if(!replay)renderTable(state.game);
  const d=state.status==='playing'&&!replay?state.game?.decision:null;$('decisionPanel').hidden=!d;$('actions').replaceChildren();
  if(d){$('decisionTitle').textContent=d.phase==='daque'?'选择定缺':'轮到你决策';for(const a of d.legalActions){const b=button(ACTIONS[a.type]||a.type,async()=>{const controls=[...$('actions').querySelectorAll('button')];controls.forEach(x=>x.disabled=true);try{const data=await api(endpoint('action'),{decisionId:d.decisionId,actionId:a.actionId,requestId:crypto.randomUUID()});state=data.state;render();}catch(e){await refresh();throw e;}},'');if(a.tile)b.append(tile(a.tile));if(a.type==='daque')b.textContent=`缺${SUITS[a.color]}`;$('actions').append(b);}}
  countdown();const events=$('events');events.replaceChildren();const game=state.game;if(game)game.history.slice(-45).reverse().forEach(e=>events.append(el('div',`${game.players[e[0]]?state.seats[game.players[e[0]].participant].name:'玩家'} · ${ACTIONS[e[1]]||e[1]}${Array.isArray(e[2])?' '+e[2][1]+SUITS[e[2][0]]:''}`)));
  const settle=$('settlement');settle.hidden=game?.stage!=='over';settle.replaceChildren();if(game?.stage==='over'){settle.append(el('h2','本局结算'),el('p',`种子 ${game.seed} · ${game.assisted?'含超时托管动作':'无托管动作'}`,'muted'));for(const p of game.players){const details=el('details');details.append(el('summary',`${state.seats[p.participant].name}：${p.score>=0?'+':''}${p.score} 分`));for(const row of p.settlement)details.append(el('p',JSON.stringify(row)));settle.append(details);}}
}
function countdown(){const d=state?.game?.decision;if(!d)return;const left=Math.max(0,Math.ceil((d.deadline-(state.serverTime+(Date.now()-receivedAt)/1000))));$('deadline').textContent=`剩余 ${left} 秒`;}
let receivedAt=Date.now();
// Track server clock offset without trusting the browser clock for adjudication.
const originalRender=render;render=function(){receivedAt=Date.now();originalRender();};
setInterval(countdown,1000);
$('createForm').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.target);const r=await api('/api/rooms',{name:f.get('name'),games:Number(f.get('games')),turnSeconds:Number(f.get('turnSeconds')),timeoutPolicy:f.get('timeoutPolicy')},'');sessionStorage.setItem(ownerKey(r.roomId),r.ownerToken);await openRoom(r.roomId,r.ownerToken);}catch(e){report(e);}});
$('joinForm').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.target);const id=String(f.get('seatId')).trim();await api(endpoint('join'),{name:f.get('name'),kind:'human'},id);sessionStorage.setItem(seatKey(roomId),id);await openRoom(roomId,id);}catch(e){report(e);}});
$('startButton').addEventListener('click',async()=>{try{state=await api(endpoint('start'),{});$('credentialDetails').open=false;render();}catch(e){report(e);}});
$('stopButton').addEventListener('click',async()=>{try{state=await api(endpoint('stop'),{});render();}catch(e){report(e);}});
$('publicView').addEventListener('click',()=>openRoom(roomId,'').catch(report));
$('ownerView').addEventListener('click',()=>openRoom(roomId,sessionStorage.getItem(ownerKey(roomId))).catch(report));
$('shareRoom').addEventListener('click',()=>copy(`${location.origin}/#${new URLSearchParams({room:roomId})}`).catch(report));
$('adminLink').addEventListener('click',()=>copy(`${location.origin}/#${new URLSearchParams({room:roomId,owner:sessionStorage.getItem(ownerKey(roomId))})}`).catch(report));
$('refreshRooms').addEventListener('click',()=>rooms().catch(report));
$('rulesButton').addEventListener('click',async()=>{try{const r=await api('/api/rules',undefined,'');$('rulesContent').replaceChildren();Object.entries(r).forEach(([k,v])=>{$('rulesContent').append(el('h2',k),el('p',Array.isArray(v)?v.join(' / '):v));});$('rulesDialog').showModal();}catch(e){report(e);}});
$('closeRules').addEventListener('click',()=>$('rulesDialog').close());
function replayFrame(){if(!replay)return;const i=Number($('replaySlider').value);renderTable(replay.frames[i]);$('replayLabel').textContent=`第 ${i} / ${replay.frames.length-1} 步 · 种子 ${replay.seed}`;}
$('replayButton').addEventListener('click',async()=>{try{clearInterval(replayTimer);replay=await api(endpoint(`replay?game=${Number($('replayNumber').value)}`),undefined,'');$('replaySlider').max=replay.frames.length-1;$('replaySlider').value=0;$('replayControls').hidden=false;render();replayFrame();}catch(e){report(e);}});
$('replaySlider').addEventListener('input',replayFrame);
$('replayPlay').addEventListener('click',()=>{clearInterval(replayTimer);replayTimer=setInterval(()=>{if(!replay)return clearInterval(replayTimer);const slider=$('replaySlider');if(Number(slider.value)>=Number(slider.max))return clearInterval(replayTimer);slider.value=Number(slider.value)+1;replayFrame();},600);});
$('replayLive').addEventListener('click',()=>{replay=null;clearInterval(replayTimer);$('replayControls').hidden=true;render();});
$('replayDownload').addEventListener('click',()=>{if(!replay)return;const url=URL.createObjectURL(new Blob([JSON.stringify(replay,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download=`mahjong-${roomId}-${$('replayNumber').value}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
async function boot(){
  // Retire the old offline worker, whose broad cache could serve the old UI.
  if('serviceWorker' in navigator){const registrations=await navigator.serviceWorker.getRegistrations();for(const r of registrations){if(new URL(r.scope).pathname==='/webgame/')await r.unregister();}}
  const hash=new URLSearchParams(location.hash.slice(1));const id=hash.get('room');const seat=hash.get('seat');const owner=hash.get('owner');if(id){if(seat)sessionStorage.setItem(seatKey(id),seat);if(owner)sessionStorage.setItem(ownerKey(id),owner);await openRoom(id,seat||owner||undefined);if(seat){$('joinForm').hidden=false;$('joinForm').elements.seatId.value=seat;}}else await rooms();
}
boot().catch(report);
