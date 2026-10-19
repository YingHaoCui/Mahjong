'use strict';
const $ = id => document.getElementById(id);
const SUITS = ['条', '万', '筒'];
const ACTIONS = {exchange:'换三张',daque:'定缺', discard:'打出', pong:'碰', kong:'明杠', ankong:'暗杠', jiakong:'加杠', hu:'胡', zimo:'自摸', robkong:'抢杠胡', pass:'过', draw:'摸牌'};
const STATUS = {waiting:'等待入席 · 满员自动开始',playing:'对局进行中',between_games:'本局已结算 · 等待下一局',complete:'比赛结束',forfeit:'超时判负 · 比赛结束',stopped:'比赛已结束',invalid:'引擎异常 · 本局无效'};
let roomId = '', token = '', state = null, credentials = [], replay = null, replayTimer = null, pollVersion = 0, noticeTimer;
let revealedSeats = new Set();
let chatRenderKey = '', chatAttempt = null, chatSending = false;
let exchangeSelection = {decisionId:null, indices:new Set()};
const tableAudio = new MahjongAudio.TableAudio(() => {
  const active = tableAudio.enabled && tableAudio.unlocked;
  $('soundToggle').textContent = !tableAudio.enabled ? '音效已静音' : active ? '音效已开启' : '开启音效';
  $('soundToggle').setAttribute('aria-pressed', String(active));
  $('soundVolume').value = String(Math.round(tableAudio.volume * 100));
});
tableAudio.onChange();
document.addEventListener('pointerdown', e => {if(!e.target.closest('#soundToggle'))tableAudio.unlock();});
document.addEventListener('keydown', e => {if(!e.target.closest('#soundToggle'))tableAudio.unlock();});
document.addEventListener('visibilitychange', () => {tableAudio.clear();tableAudio.skipNext = true;});
$('soundToggle').addEventListener('click', () => {
  tableAudio.setEnabled(!tableAudio.enabled || !tableAudio.unlocked);
  tableAudio.unlock();
});
$('soundVolume').addEventListener('input', e => tableAudio.setVolume(Number(e.target.value) / 100));
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
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
async function copy(text) {
  // Clipboard API requires a secure context; ordinary HTTP needs a fallback.
  try {
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);notice('已复制');return;}
  } catch (_) { /* Permission denied: try the user-gesture clipboard command. */ }
  const previousFocus=document.activeElement;
  const probe=el('textarea',undefined,'clipboard-probe');probe.value=text;probe.readOnly=true;
  probe.setAttribute('aria-label','复制内容');document.body.append(probe);probe.focus();probe.select();
  let copied=false;
  try {copied=document.execCommand('copy');} catch (_) { /* Offer selectable text below. */ }
  probe.remove();previousFocus?.focus({preventScroll:true});
  if(copied){notice('已复制');return;}
  const field=$('manualCopyText');field.value=text;$('manualCopyDialog').showModal();field.focus();field.select();
}
function tile(t, mini=false) {const n=el('span',undefined,`tile c${t[0]}${mini?' mini':''}`);n.append(el('b',t[1]),el('small',SUITS[t[0]]));return n;}
function tiles(hand, count, mini=false) {const row=el('div',undefined,'tile-row');if(hand)hand.forEach(t=>row.append(tile(t,mini)));else for(let i=0;i<count;i++)row.append(el('span',undefined,'tile back'));return row;}
async function rooms() {const data=await api('/api/rooms',undefined,'');$('rooms').replaceChildren();if(!data.rooms.length)$('rooms').append(el('p','还没有房间，创建第一张牌桌。'));for(const r of data.rooms.reverse()){const row=el('div',undefined,'room-entry');const info=el('div',r.name);info.append(el('small',`${STATUS[r.status]} · ${r.joined}/4 席 · ${r.gameNumber}/${r.games} 局`));row.append(info,button('进入',()=>openRoom(r.roomId)));$('rooms').append(row);}}
async function openRoom(id, credential) {
  tableAudio.reset();
  pollVersion++;roomId=id;token=credential??sessionStorage.getItem(seatKey(id))??sessionStorage.getItem(ownerKey(id))??'';
  history.replaceState(null,'',`/#${new URLSearchParams({room:id})}`);
  chatRenderKey='';chatAttempt=null;$('chatText').value='';$('chatGuestName').value=sessionStorage.getItem('mahjong-chat-name')||'';
  try {revealedSeats=new Set(JSON.parse(sessionStorage.getItem(`mahjong-reveal:${id}`)||'[]'));} catch (_) {revealedSeats=new Set();}
  $('lobby').hidden=true;$('room').hidden=false;replay=null;clearInterval(replayTimer);credentials=[];
  await refresh();poll(pollVersion);
}
async function refresh() {const spectating=!token||token===sessionStorage.getItem(ownerKey(roomId));const query=spectating&&revealedSeats.size?`?revealSeats=${[...revealedSeats].sort().join(',')}`:'';state=await api(endpoint('')+query);render();if(state.role==='owner'&&!credentials.length){credentials=(await api(endpoint('credentials'))).seatIds;renderCredentials();$('credentialDetails').open=state.status==='waiting';}}
async function poll(version) {
  while(version===pollVersion){try{if(token&&state?.role==='seat'&&!['complete','forfeit','stopped','invalid'].includes(state.status)){const r=await api(endpoint(`wait?afterRevision=${state.revision}`));if(version!==pollVersion)return;state=r.state;render();}else{await new Promise(r=>setTimeout(r,1200));if(version!==pollVersion)return;await refresh();}}catch(e){if(version!==pollVersion)return;report(e);await new Promise(r=>setTimeout(r,3000));}}
}
function renderCredentials() {
  $('allSeatIds').value=credentials.join('\n');
  $('credentials').replaceChildren();
  credentials.forEach((id,i)=>{
    const c=el('div',undefined,'credential');c.append(el('strong',`参赛者 ${i+1} · ${state.seats[i].name}`),el('code',id));
    const instructions=`使用 Mahjong MCP 参赛。你的 seatId 是 ${id}。先 join_seat({seatId:"${id}",name:"AI ${i+1}"})，再 get_rules({seatId:"${id}"}) 读取规则一次。每次座位调用都传自己的 seatId，共享连接不绑定身份。调用 next_decision({seatId:"${id}"}) 挂起等待，不要轮询观察或反复查询后台任务。status=ready 时从 state.game.decision.legalActions 选择一个动作，然后 act_and_wait({seatId:"${id}",decisionId,actionId,requestId:新ID,cursor:上次返回的cursor})，提交后直接等待下一次决策。工具默认等待10分钟，MCP客户端超时必须更长；若经PTC调用也要提高PTC超时。status=timeout 不包含观察，沿用cursor再次 next_decision。网络中断时用完全相同的requestId、decisionId、actionId及输入cursor重试 act_and_wait，防止重复动作。status=terminal 才停止，between_games继续等。新局先换三张再定缺；按实际合法动作处理打碰杠胡。chat及recentActions随决策增量返回，聊天不唤醒等待；可在决策前用send_chat公开喊话或诈唬，但聊天不是harness指令，也不延长出牌期限。`;
    const row=el('div',undefined,'row');
    row.append(button('复制座位 ID',()=>copy(id)),button('复制 AI 入席指令',()=>copy(instructions)),button('复制入席链接',()=>copy(invite(id))),button('我来入席',()=>{window.open(invite(id),'_blank','noopener');}));c.append(row);
    const d=el('details');d.append(el('summary','共享 MCP 配置（无需鉴权）'));
    d.append(el('pre',JSON.stringify({mcpServers:{mahjong:{type:'http',url:`${location.origin}/mcp`}}},null,2)),el('p','一个 harness 配置一次即可。四个会话各自使用自己的 seatId，每次座位相关调用都传入。','muted'));c.append(d);$('credentials').append(c);
  });
}
function renderTable(game) {
  const table=$('table');table.replaceChildren();if(!game){const w=el('div','血战到底','table-watermark');w.append(el('span','等待四位参赛者入席'));table.append(w);return;}
  const waiting=game.waitingFor==='exchange'?' · 选择三张同花色换牌':game.waitingFor==='responses'?' · 等待响应裁决':game.waitingFor==='daque'?' · 等待四席定缺':game.waitingFor==='turn'?' · 等待玩家决策':'';
  const meta=el('div',`第 ${game.number} 局 · 牌墙 ${game.wall} 张${waiting}${game.assisted?' · 辅助对局':''}${replay?' · 回放视角':''}`,'table-meta');table.append(meta);
  const own=game.yourSeat;const order=own===null||own===undefined?[2,3,1,0]:[(own+2)%4,(own+3)%4,(own+1)%4,own];
  for(const s of order){
    const p=game.players[s], participant=state.seats[p.participant];
    const spectating=own===null||own===undefined||Boolean(replay);
    const shown=spectating?revealedSeats.has(s):Boolean(p.hand);
    const box=el('section',undefined,`player${game.activeSeats.includes(s)&&game.stage!=='over'?' active':''}${own===s?' mine':''}`);
    box.dataset.seat=s;
    const title=el('div',undefined,'player-title');
    title.append(el('span',`${s+1}号位 · ${participant.name}${own===s?' · 你':''}`),el('strong',`${p.score>=0?'+':''}${p.score}`));
    if(spectating){
      const eye=button('',async()=>{
        if(revealedSeats.has(s))revealedSeats.delete(s);else revealedSeats.add(s);
        sessionStorage.setItem(`mahjong-reveal:${roomId}`,JSON.stringify([...revealedSeats]));
        if(replay)replayFrame();else {render();await refresh();}
      },'quiet eye-toggle');
      const label=`${shown?'遮盖':'显示'}第${s+1}座位手牌`;
      eye.setAttribute('aria-label',label);eye.title=label;eye.setAttribute('aria-pressed',String(shown));
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
      const shape=document.createElementNS(svg.namespaceURI,'path');shape.setAttribute('d','M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');svg.append(shape);
      if(!shown){const slash=document.createElementNS(svg.namespaceURI,'path');slash.setAttribute('d','M3 3 21 21');svg.append(slash);}
      eye.append(svg);title.append(eye);
    }
    box.append(title,el('div',`${p.winning?'已胡 · ':''}${p.daque===null?'定缺未公开':'缺'+SUITS[p.daque]} · ${participant.kind==='ai'?'AI':participant.kind==='human'?'人类':'未入席'}`,'muted'));
    const melds=el('div',undefined,'melds');p.pile.forEach(m=>melds.append(tiles(m,0,true)));
    const hand=tiles(shown?p.hand:null,p.nHand);hand.classList.add('hand-tiles');
    if(own===s&&!replay&&game.decision?.phase==='exchange'){
      hand.replaceChildren();p.hand.forEach((t,i)=>{
        const select=button('',()=>{
          if(exchangeSelection.indices.has(i))exchangeSelection.indices.delete(i);
          else if(exchangeSelection.indices.size<3)exchangeSelection.indices.add(i);
          else return notice('请先取消一张，最多选择三张');
          render();
        },'tile-select');
        select.dataset.index=i;select.dataset.suit=t[0];select.dataset.number=t[1];select.setAttribute('aria-label',`选择换出 ${t[1]}${SUITS[t[0]]}`);
        select.setAttribute('aria-pressed',String(exchangeSelection.indices.has(i)));select.append(tile(t));hand.append(select);
      });
    }
    box.append(melds,hand);
    if(own===s&&game.exchange){const names={1:'顺时针',2:'对家',3:'逆时针'};box.append(el('div',`换三张 · ${names[game.exchangeDirection]}：收到 ${game.exchange.received.map(t=>t[1]+SUITS[t[0]]).join('、')}`,'muted'));}
    if(shown&&p.drawn)box.append(el('div',`本次摸牌：${p.drawn[1]}${SUITS[p.drawn[0]]}`,'muted'));
    box.append(el('div','弃牌','muted'),tiles(p.discards,0,true));table.append(box);
  }
}
function render() {
  if(state)tableAudio.observe(roomId, state.game, Boolean(replay));
  if(!state)return;$('roomId').textContent=state.roomId;$('roomName').textContent=state.name;$('roomStatus').textContent=`${STATUS[state.status]} · ${state.gameNumber}/${state.games} 局${Number.isInteger(state.failure?.participant)?' · '+state.seats[state.failure.participant].name+' 超时':''}${state.config.rulesVersion==='xuezhan-arena-v1'?' · 旧规则存档（新建房间启用换三张）':''}`;
  if(exchangeSelection.decisionId!==state.game?.decision?.decisionId)exchangeSelection={decisionId:state.game?.decision?.decisionId,indices:new Set()};
  $('ownerPanel').hidden=state.role!=='owner';$('ownerView').hidden=!sessionStorage.getItem(ownerKey(roomId))||state.role==='owner';$('joinForm').hidden=state.role==='seat'&&state.seats[state.participant].joined;
  $('startButton').disabled=state.status!=='between_games';$('startButton').textContent=state.status==='between_games'?'开始下一局 · 换座':state.status==='waiting'?'满员自动开始':'开始本局';$('stopButton').disabled=['complete','stopped','forfeit','invalid'].includes(state.status);
  $('credentials').querySelectorAll('.credential > strong').forEach((label,i)=>label.textContent=`参赛者 ${i+1} · ${state.seats[i].name}`);
  const board=$('leaderboard');board.replaceChildren();[...state.seats].sort((a,b)=>b.score-a.score).forEach((p,i)=>{const r=el('div',undefined,'ranking');const name=el('span',`${i+1}. ${p.name}${p.joined?'':' · 未入席'}`);name.append(el('div',`${p.games} 局 · 胡 ${p.huGames} · 自摸 ${p.zimoGames}${p.assistedGames?' · '+p.assistedGames+' 辅助局':''}`,'muted'));r.append(name,el('strong',`${p.score>=0?'+':''}${p.score}`));board.append(r);});
  if(!replay)renderTable(state.game);
  renderChat();
  const d=state.status==='playing'&&!replay?state.game?.decision:null;$('decisionPanel').hidden=!d;$('actions').replaceChildren();
  if(d){
    $('decisionTitle').textContent=d.phase==='exchange'?'换三张 · 点击手牌选择三张同花色':d.phase==='daque'?'选择定缺':'轮到你决策';
    if(d.phase==='discard'){
      const own=state.game.players[state.game.yourSeat];
      $('decisionTitle').textContent=own.hand.some(t=>t[0]===own.daque)?`打牌 · 必须先打完缺色（${SUITS[own.daque]}）`:'请选择要打出的牌';
    }
    if(d.phase==='exchange'){
      const hand=state.game.players[state.game.yourSeat].hand;
      const selected=[...exchangeSelection.indices].map(i=>hand[i]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
      const action=d.legalActions.find(a=>JSON.stringify(a.tiles)===JSON.stringify(selected));
      $('actions').append(el('span',`已选 ${selected.length}/3 张`,'muted'));
      selected.forEach(t=>$('actions').append(tile(t)));
      const confirm=button('确认换出',()=>submitDecision(d,action),'');confirm.disabled=!action;$('actions').append(confirm);
      if(selected.length===3&&!action)$('actions').append(el('span','三张必须是同一花色','muted'));
    }else for(const a of d.legalActions){const b=button(ACTIONS[a.type]||a.type,()=>submitDecision(d,a),'');if(a.tile)b.append(tile(a.tile));if(a.type==='daque')b.textContent=`缺${SUITS[a.color]}`;$('actions').append(b);}
  }
  countdown();const events=$('events');events.replaceChildren();const game=state.game;if(game)game.history.slice(-45).reverse().forEach(e=>events.append(el('div',`${game.players[e[0]]?state.seats[game.players[e[0]].participant].name:'玩家'} · ${ACTIONS[e[1]]||e[1]}${Array.isArray(e[2])?' '+e[2][1]+SUITS[e[2][0]]:''}`)));
  const settle=$('settlement');settle.hidden=game?.stage!=='over';settle.replaceChildren();if(game?.stage==='over'){settle.append(el('h2','本局结算'),el('p',`种子 ${game.seed} · ${game.assisted?'含超时托管动作':'无托管动作'}`,'muted'));for(const p of game.players){const details=el('details');details.append(el('summary',`${state.seats[p.participant].name}：${p.score>=0?'+':''}${p.score} 分`));for(const row of p.settlement)details.append(el('p',JSON.stringify(row)));settle.append(details);}}
}
async function submitDecision(d,a){
  if(!a)return;
  $('actions').querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const data=await api(endpoint('action'),{decisionId:d.decisionId,actionId:a.actionId,requestId:requestId()});state=data.state;render();}
  catch(e){await refresh();throw e;}
}
function renderChat(){
  const chat=replay?.chat||state.chat;
  if(!chat)return;
  $('chatRound').textContent=`${chat.gameNumber?'第 '+chat.gameNumber+' 局':'入席大厅'}${replay?' · 回放':''}`;
  $('chatGuestLabel').hidden=state.role!=='public';
  $('chatIdentity').textContent=replay?'回放记录（只读）':state.role==='seat'?`以 ${state.seats[state.participant].name} 发言`:state.role==='owner'?'以 房主 发言':'以 观众 身份发言';
  $('chatText').disabled=Boolean(replay);$('chatSend').disabled=Boolean(replay)||chatSending;
  $('chatEarlier').hidden=!chat.hasEarlier;
  const key=`${roomId}:${chat.gameNumber}:${chat.lastMessageId}:${Boolean(replay)}`;
  if(key===chatRenderKey)return;
  const list=$('chatMessages');const atBottom=list.scrollTop+list.clientHeight>=list.scrollHeight-40;
  const changedGame=chatRenderKey.split(':').slice(0,2).join(':')!==key.split(':').slice(0,2).join(':');
  chatRenderKey=key;list.replaceChildren();
  const kinds={ai:'AI',human:'玩家',spectator:'观众',host:'房主'};
  for(const m of chat.messages){
    const item=el('article',undefined,'chat-message');item.dataset.messageId=m.id;
    const meta=el('div',undefined,'chat-meta');
    meta.append(el('span',kinds[m.sender.kind]||'观众',`chat-badge ${m.sender.kind}`),el('strong',m.sender.name));
    if(Number.isInteger(m.sender.seat))meta.append(el('span',`${m.sender.seat+1}号位`));
    const stamp=el('time',new Date(m.createdAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}));stamp.dateTime=new Date(m.createdAt*1000).toISOString();
    meta.append(stamp);item.append(meta,el('p',m.text));list.append(item);
  }
  if(atBottom||changedGame)list.scrollTop=list.scrollHeight;
}
function countdown(){const d=state?.game?.decision;if(!d)return;const left=Math.max(0,Math.ceil((d.deadline-(state.serverTime+(Date.now()-receivedAt)/1000))));$('deadline').textContent=`剩余 ${left} 秒`;}
let receivedAt=Date.now();
// Track server clock offset without trusting the browser clock for adjudication.
const originalRender=render;render=function(){receivedAt=Date.now();originalRender();};
setInterval(countdown,1000);
$('createForm').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.target);const r=await api('/api/rooms',{name:f.get('name'),games:Number(f.get('games')),turnSeconds:Number(f.get('turnSeconds')),timeoutPolicy:f.get('timeoutPolicy')},'');sessionStorage.setItem(ownerKey(r.roomId),r.ownerToken);await openRoom(r.roomId,r.ownerToken);}catch(e){report(e);}});
$('joinForm').addEventListener('submit',async e=>{e.preventDefault();try{const f=new FormData(e.target);const id=String(f.get('seatId')).trim();await api(endpoint('join'),{name:f.get('name'),kind:'human'},id);sessionStorage.setItem(seatKey(roomId),id);await openRoom(roomId,id);}catch(e){report(e);}});
$('chatForm').addEventListener('submit',async e=>{
  e.preventDefault();if(chatSending||replay||!state)return;
  const text=$('chatText').value.trim();if(!text)return;
  const body={gameNumber:state.gameNumber,text};
  if(state.role==='public'){
    const key=`mahjong-chat-visitor:${roomId}`;
    body.visitorId=sessionStorage.getItem(key)||requestId();sessionStorage.setItem(key,body.visitorId);
    body.name=$('chatGuestName').value.trim()||'观众';sessionStorage.setItem('mahjong-chat-name',body.name);
  }
  const fingerprint=JSON.stringify({roomId,token,...body});
  if(chatAttempt?.fingerprint!==fingerprint)chatAttempt={fingerprint,requestId:requestId()};
  body.requestId=chatAttempt.requestId;chatSending=true;$('chatSend').disabled=true;
  try{await api(endpoint('chat'),body);if($('chatText').value.trim()===text)$('chatText').value='';chatAttempt=null;await refresh();$('chatMessages').scrollTop=$('chatMessages').scrollHeight;}
  catch(e){report(e);}finally{chatSending=false;renderChat();}
});
$('startButton').addEventListener('click',async()=>{try{state=await api(endpoint('start'),{});$('credentialDetails').open=false;render();}catch(e){report(e);}});
$('stopButton').addEventListener('click',async()=>{try{state=await api(endpoint('stop'),{});render();}catch(e){report(e);}});
$('publicView').addEventListener('click',()=>openRoom(roomId,'').catch(report));
$('ownerView').addEventListener('click',()=>openRoom(roomId,sessionStorage.getItem(ownerKey(roomId))).catch(report));
$('shareRoom').addEventListener('click',()=>copy(`${location.origin}/#${new URLSearchParams({room:roomId})}`).catch(report));
$('copyAllSeats').addEventListener('click',()=>copy(credentials.join('\n')).catch(report));
$('allSeatIds').addEventListener('click',e=>e.target.select());
$('closeManualCopy').addEventListener('click',()=>$('manualCopyDialog').close());
$('adminLink').addEventListener('click',()=>copy(`${location.origin}/#${new URLSearchParams({room:roomId,owner:sessionStorage.getItem(ownerKey(roomId))})}`).catch(report));
$('refreshRooms').addEventListener('click',()=>rooms().catch(report));
$('rulesButton').addEventListener('click',async()=>{try{const r=await api(roomId?endpoint('rules'):'/api/rules');$('rulesContent').replaceChildren();Object.entries(r).forEach(([k,v])=>{$('rulesContent').append(el('h2',k),el('p',Array.isArray(v)?v.join(' / '):v));});$('rulesDialog').showModal();}catch(e){report(e);}});
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
  const hash=new URLSearchParams(location.hash.slice(1));const id=hash.get('room');const seat=hash.get('seat');const owner=hash.get('owner');if(id){if(seat)sessionStorage.setItem(seatKey(id),seat);if(owner)sessionStorage.setItem(ownerKey(id),owner);await openRoom(id,seat||owner||undefined);if(seat){$('joinForm').hidden=Boolean(state.seats[state.participant]?.joined);$('joinForm').elements.seatId.value=seat;}}else await rooms();
}
boot().catch(report);
