import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const sandbox = {document:{hidden:false},localStorage:{getItem:()=>null,setItem(){}},Date,Map,Set};
vm.runInNewContext(await readFile(new URL('webgame/audio.js',root),'utf8'),sandbox);
const {clipsFor,TableAudio} = sandbox.MahjongAudio;
const manifest = JSON.parse(await readFile(new URL('webgame/audio/weihai/manifest.json',root),'utf8'));
const available = new Set(manifest.files.map(f=>'/webgame/audio/weihai/'+f.file));
assert.equal(manifest.files.filter(f=>f.file.endsWith('.mp3')).length,63);
for(const entry of manifest.files) {
  const bytes = await readFile(new URL('webgame/audio/weihai/'+entry.file,root));
  assert.equal(bytes.length,entry.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
}
for(let participant=0;participant<4;participant++) {
  for(let suit=0;suit<3;suit++)for(let n=1;n<=9;n++) {
    const clips=clipsFor([0,'discard',[suit,n]],participant);
    assert.equal(clips.length,2);
    assert.ok(clips[1].endsWith(`sex_${participant%2}_/MahjongVal_${[40,20,80][suit]+n}_.mp3`));
    clips.forEach(url=>assert.ok(available.has(url),url));
  }
  for(const action of ['pong','kong','ankong','jiakong','hu','robkong','zimo']) {
    const clips=clipsFor([0,action,[1,1]],participant);
    assert.equal(clips.length,1);assert.ok(available.has(clips[0]));
  }
}
for(const action of ['draw','exchange','daque','pass'])assert.equal(clipsFor([0,action,[0,1]],0).length,0);
const game={number:1,players:[{participant:1},{participant:2},{participant:3},{participant:0}],history:[[0,'discard',[0,1]]]};
const audio=new TableAudio();audio.unlocked=true;
const played=[];
audio.play=async job=>played.push(job.clips);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
audio.observe('room',game);await flush();assert.equal(played.length,0,'Joining must not replay history');
game.history.push([0,'pong',[0,1]],[1,'hu',[0,1]]);
audio.observe('room',game);await flush();assert.equal(played.length,2);
assert.ok(played[0][0].includes('sex_1_'),'Voice follows participant, not seat');
audio.observe('room',game);await flush();assert.equal(played.length,2,'Repeated render is silent');
audio.setEnabled(false);game.history.push([2,'zimo',[1,1]]);audio.observe('room',game);
audio.setEnabled(true);audio.observe('room',game);await flush();assert.equal(played.length,2,'Unmute does not replay');
game.history.push([0,'discard',[0,2]]);audio.observe('room',game,true);
audio.observe('room',game);await flush();assert.equal(played.length,2,'Replay consumes live events silently');
sandbox.document.hidden=true;game.history.push([0,'pong',[0,2]]);audio.observe('room',game);
sandbox.document.hidden=false;audio.skipNext=true;game.history.push([0,'hu',[0,2]]);audio.observe('room',game);
await flush();assert.equal(played.length,2,'Returning from background must not catch up');
game.number=2;game.history=[[0,'discard',[1,1]]];audio.observe('room',game);
game.history.push([3,'zimo',[1,2]]);audio.observe('room',game);await flush();assert.equal(played.length,3);
audio.reset();audio.observe('room',game);audio.observe('other-room',game);await flush();assert.equal(played.length,3);
console.log('PASS: 63 MP3 checksums, all tile/action mappings, participant rotation, event deduplication, mute, background, replay and room transitions.');
