// Real Chromium + four official MCP SDK clients. No model keys.
// npm install; npx playwright install chromium; npm run test:web
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(process.env.MAHJONG_TEST_MODULE_ROOT || root, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const { chromium } = require('@playwright/test');
const temp = await mkdtemp(path.join(root, 'tests', '.runtime-'));
const server = spawn(process.env.MAHJONG_PYTHON || 'python', ['webgame/server.py', '0'], {
  cwd: root, env: { ...process.env, HOST: '127.0.0.1', ARENA_DATA_DIR: temp }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '', browser;
const clients = [];
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000);
    server.stdout.on('data', b => { output += b; const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) {clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);} });
    server.stderr.on('data', b => { output += b; });
    server.on('error', reject);
    server.on('exit', code => {clearTimeout(timer);reject(new Error(`Server exited ${code}: ${output}`));});
  });
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
  const context = await browser.newContext({ viewport: {width:1440,height:1000} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('#createForm input[name=name]').fill('四 AI 集成赛');
  await page.locator('#createForm input[name=games]').fill('1');
  await page.locator('#createForm button[type=submit]').click();
  await page.locator('#credentials .credential').first().waitFor();
  const roomId = await page.locator('#roomId').textContent();
  const seatIds = await page.locator('#credentials code').allTextContents();
  assert.equal(seatIds.length, 4);
  const allSeats=seatIds.join('\n');
  assert.equal(await page.locator('#allSeatIds').inputValue(),allSeats);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('#copyAllSeats').click();
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),allSeats);
  // Ordinary HTTP has no Clipboard API. Exercise the actual legacy copy path.
  await page.evaluate(()=>{
    window.testClipboard=navigator.clipboard;
    window.testExecCommand=document.execCommand;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
  });
  await page.getByRole('button',{name:'复制座位 ID',exact:true}).first().click();
  assert.equal(await page.evaluate(()=>window.testClipboard.readText()),seatIds[0]);
  await page.locator('#copyAllSeats').click();
  assert.equal((await page.evaluate(()=>window.testClipboard.readText())).replace(/\r\n/g,'\n'),allSeats);
  // If copying is blocked entirely, show selected text rather than false success.
  await page.evaluate(()=>document.execCommand=()=>false);
  await page.locator('#copyAllSeats').click();
  await page.locator('#manualCopyDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#manualCopyText').inputValue(),allSeats);
  assert.equal(await page.locator('#manualCopyText').evaluate(n=>n.value.slice(n.selectionStart,n.selectionEnd)),allSeats);
  await page.locator('#closeManualCopy').click();
  await page.locator('#allSeatIds').click();
  assert.equal(await page.locator('#allSeatIds').evaluate(n=>n.value.slice(n.selectionStart,n.selectionEnd)),allSeats);
  await page.evaluate(()=>{
    document.execCommand=window.testExecCommand;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.testClipboard});
  });
  const client = new Client({name:'shared-harness-connector',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  clients.push(client);
  const tools = await client.listTools();
  assert.equal(tools.tools.length,8);
  for (let i=0;i<4;i++) {
    const joined = await client.callTool({name:'join_seat',arguments:{name:`模型 ${i+1}`,seatId:seatIds[i]}});
    assert.equal(joined.structuredContent.participant,i);
  }
  // The fourth AI join starts the game without any owner click.
  await page.waitForFunction(() => document.getElementById('roomStatus').textContent.includes('对局进行中'));
  const bluff=await client.callTool({name:'send_chat',arguments:{seatId:seatIds[0],gameNumber:1,text:'我这把可能很快就胡，你们小心点。',requestId:'opening-bluff'}});
  assert.equal(bluff.structuredContent.message.sender.kind,'ai');
  await page.getByText('我这把可能很快就胡，你们小心点。',{exact:true}).waitFor();
  const publicRoom = await (await fetch(`${base}/api/rooms/${roomId}`)).json();
  assert.ok(publicRoom.game.players.every(p=>!('hand' in p)));
  let moves=0;
  while (true) {
    const views = await Promise.all(seatIds.map(seatId=>client.callTool({name:'get_observation',arguments:{seatId}})));
    const states = views.map(r=>{assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;});
    if(states[0].status==='complete')break;
    const work=states.map(async (s,i)=>{
      const d=s.game.decision;if(!d)return;
      assert.equal(s.participant,i);
      for(const p of s.game.players)if(p.seat!==s.game.yourSeat)assert.ok(!('hand' in p));
      const options=d.legalActions;
      const action=options.find(a=>['hu','zimo','robkong'].includes(a.type)) || options.find(a=>a.type==='pass') || options.at(-1);
      const args={seatId:seatIds[i],decisionId:d.decisionId,actionId:action.actionId,requestId:d.decisionId};
      const result=await client.callTool({name:'submit_action',arguments:args});
      assert.ok(!result.isError,JSON.stringify(result));
      if(moves===0){const retry=await client.callTool({name:'submit_action',arguments:args});assert.equal(retry.structuredContent.duplicate,true);}
      moves++;
    });
    await Promise.all(work);
    assert.ok(moves<1500,'Game failed to terminate');
  }
  await page.waitForFunction(()=>document.getElementById('roomStatus').textContent.includes('比赛结束'));
  await page.locator('#replayButton').click();
  await page.locator('#replayControls').waitFor({state:'visible'});
  const max=await page.locator('#replaySlider').getAttribute('max');
  assert.ok(Number(max)>50);
  await page.locator('#replaySlider').fill(max);
  await page.locator('#replayLive').click();
  await page.screenshot({path:path.join(temp,'arena-desktop.png'),fullPage:true});
  // Second room: a human joins via fragment, credentials disappear from URL,
  // the browser submits a real decision and another context sees no hand.
  const second = await (await fetch(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({games:1})})).json();
  const human=await context.newPage();
  human.on('pageerror',e=>errors.push(e.message));
  await human.goto(`${base}/#room=${second.roomId}&seat=${second.seatIds[0]}`);
  await human.locator('#joinForm input[name=name]').fill('人类玩家');
  await human.locator('#joinForm button').click();
  await human.waitForFunction(()=>document.getElementById('joinForm').hidden);
  assert.ok(!human.url().includes(second.seatIds[0]));
  for(let i=1;i<4;i++)await fetch(`${base}/api/rooms/${second.roomId}/join`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+second.seatIds[i]},body:JSON.stringify({name:`玩家 ${i}`,kind:'human'})});
  await human.locator('#actions button').first().waitFor();
  const suits=await human.locator('.tile-select').evaluateAll(nodes=>nodes.map(n=>({index:n.dataset.index,suit:n.dataset.suit})));
  const suit=suits.find(t=>suits.filter(x=>x.suit===t.suit).length>=3).suit;
  const same=suits.filter(t=>t.suit===suit).slice(0,3),other=suits.find(t=>t.suit!==suit);
  for(const t of same.slice(0,2))await human.locator(`.tile-select[data-index="${t.index}"]`).click();
  if(other){await human.locator(`.tile-select[data-index="${other.index}"]`).click();assert.equal(await human.locator('#actions button').first().isDisabled(),true);await human.locator(`.tile-select[data-index="${other.index}"]`).click();}
  await human.locator(`.tile-select[data-index="${same[2].index}"]`).click();
  await human.locator('#actions button').first().click();
  await human.waitForFunction(()=>document.getElementById('decisionPanel').hidden);
  const spectator=await browser.newContext();
  const publicPage=await spectator.newPage();
  await publicPage.goto(`${base}/#room=${second.roomId}`);
  await publicPage.locator('.player').first().waitFor();
  assert.equal(await publicPage.locator('.arena-layout > aside > section').count(),1);
  assert.equal(await publicPage.locator('#gameInfo .info-block').count(),3);
  assert.ok(await publicPage.locator('#gameInfo').evaluate(n=>n.getBoundingClientRect().top>=document.getElementById('table').getBoundingClientRect().bottom));
  await publicPage.locator('#chatGuestName').fill('验收观众');
  await publicPage.locator('#chatText').fill('你们是不是都在做清一色？');
  await publicPage.locator('#chatSend').click();
  await publicPage.getByText('你们是不是都在做清一色？',{exact:true}).waitFor();
  const aiChat=await client.callTool({name:'read_chat',arguments:{seatId:second.seatIds[1]}});
  assert.equal(aiChat.structuredContent.messages.at(-1).sender.kind,'spectator');
  assert.equal(aiChat.structuredContent.messages.at(-1).sender.name,'验收观众');
  const deadlineBefore=(await client.callTool({name:'get_observation',arguments:{seatId:second.seatIds[1]}})).structuredContent.game.decision.deadline;
  const aiSaid=await client.callTool({name:'send_chat',arguments:{seatId:second.seatIds[1],gameNumber:1,text:'我的牌可没那么简单，猜猜看。',requestId:'chat-e2e'}});
  assert.ok(!aiSaid.isError,JSON.stringify(aiSaid));
  await publicPage.getByText('我的牌可没那么简单，猜猜看。',{exact:true}).waitFor();
  assert.equal((await client.callTool({name:'get_observation',arguments:{seatId:second.seatIds[1]}})).structuredContent.game.decision.deadline,deadlineBefore);
  await human.locator('#chatText').fill('<b>我先打个招呼</b>');
  await human.locator('#chatSend').click();
  await publicPage.getByText('<b>我先打个招呼</b>',{exact:true}).waitFor();
  assert.equal(await publicPage.locator('.chat-message b').count(),0);
  await publicPage.reload();
  await publicPage.getByText('你们是不是都在做清一色？',{exact:true}).waitFor();
  assert.equal(await publicPage.locator('.player .tile-row .tile:not(.back)').count(),0);
  assert.equal(await publicPage.locator('.eye-toggle').count(),4);
  await publicPage.getByRole('button',{name:'显示第1座位手牌',exact:true}).click();
  await publicPage.locator('.player[data-seat="0"] .hand-tiles .tile:not(.back)').first().waitFor();
  assert.equal(await publicPage.locator('.player[data-seat="1"] .hand-tiles .tile:not(.back)').count(),0);
  await publicPage.getByRole('button',{name:'显示第2座位手牌',exact:true}).click();
  await publicPage.locator('.player[data-seat="1"] .hand-tiles .tile:not(.back)').first().waitFor();
  await publicPage.getByRole('button',{name:'遮盖第1座位手牌',exact:true}).click();
  assert.equal(await publicPage.locator('.player[data-seat="0"] .hand-tiles .tile:not(.back)').count(),0);
  assert.ok(await publicPage.locator('.player[data-seat="1"] .hand-tiles .tile:not(.back)').count()>0);
  await publicPage.reload();
  await publicPage.locator('.player[data-seat="1"] .hand-tiles .tile:not(.back)').first().waitFor();
  assert.equal(await publicPage.locator('.player[data-seat="0"] .hand-tiles .tile:not(.back)').count(),0);
  const aiPrivate=await client.callTool({name:'get_observation',arguments:{seatId:second.seatIds[0]}});
  assert.ok(!('hand' in aiPrivate.structuredContent.game.players[1]));
  await human.setViewportSize({width:390,height:844});
  await human.screenshot({path:path.join(temp,'arena-mobile.png'),fullPage:true});
  assert.equal(await human.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  if(process.env.MAHJONG_SCREENSHOT_DIR){
    const {copyFile,mkdir}=await import('node:fs/promises');
    await mkdir(process.env.MAHJONG_SCREENSHOT_DIR,{recursive:true});
    for(const f of ['arena-desktop.png','arena-mobile.png'])await copyFile(path.join(temp,f),path.join(process.env.MAHJONG_SCREENSHOT_DIR,f));
  }
  console.log(`PASS: one unauthenticated official MCP connection controlled four isolated seats for ${moves} decisions; Chromium human join/action, private views, replay, desktop/mobile; no JS errors.`);
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  if(browser)await browser.close();
  server.kill();
  await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));
  // Only remove the exact test directory we created within this workspace.
  assert.ok(path.resolve(temp).startsWith(path.resolve(root,'tests')+path.sep+'.runtime-'));
  await rm(temp,{recursive:true,force:true});
}
