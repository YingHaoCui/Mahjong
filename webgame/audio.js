'use strict';
// WeiHai Mahjong, Apache-2.0. See audio/weihai/NOTICE.md and manifest.json.
(() => {
  const ROOT = '/webgame/audio/weihai/';
  const SUIT_BASES = [40, 20, 80]; // Arena: 条、万、筒. Upstream: 41,21,81.
  const CALLS = {pong:'Peng',kong:'Gang',ankong:'Gang',jiakong:'Gang',hu:'Hu',robkong:'Hu',zimo:'ZiMo'};
  function clipsFor(action, participant) {
    const [, type, tile] = action;
    const voice = `sex_${participant % 2}_/`;
    if(type === 'discard') {
      const clips = [ROOT + 'ChuPai.mp3'];
      if(Array.isArray(tile) && Number.isInteger(tile[0]) && tile[0] >= 0 && tile[0] < 3 && Number.isInteger(tile[1]) && tile[1] >= 1 && tile[1] <= 9)
        clips.push(`${ROOT}${voice}MahjongVal_${SUIT_BASES[tile[0]] + tile[1]}_.mp3`);
      return clips;
    }
    return CALLS[type] ? [`${ROOT}${voice}Round_${CALLS[type]}_.mp3`] : [];
  }
  class TableAudio {
    constructor(onChange = () => {}) {
      this.onChange = onChange;
      let settings;
      try {settings = JSON.parse(localStorage.getItem('mahjong-audio'));} catch (_) { /* Defaults also work without storage. */ }
      this.enabled = settings?.enabled !== false;
      this.volume = Number.isFinite(settings?.volume) ? Math.max(0, Math.min(1, settings.volume)) : 0.7;
      this.context = null;this.unlocked = false;this.buffers = new Map();
      this.sources = new Set();this.queue = [];this.running = false;this.generation = 0;
      this.key = null;this.cursor = 0;this.skipNext = false;
    }
    save() {
      try {localStorage.setItem('mahjong-audio', JSON.stringify({enabled:this.enabled,volume:this.volume}));} catch (_) { /* Audio still works. */ }
      this.onChange();
    }
    setEnabled(value) {this.enabled = value;if(!value)this.clear();this.save();}
    setVolume(value) {
      this.volume = Math.max(0, Math.min(1, Number(value) || 0));
      if(this.gain)this.gain.gain.value = this.volume;
      this.save();
    }
    unlock() {
      if(!this.enabled)return;
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if(!AudioContext)return;
      try {
        if(!this.context) {
          this.context = new AudioContext();this.gain = this.context.createGain();
          this.gain.gain.value = this.volume;this.gain.connect(this.context.destination);
        }
        // Called directly from pointer/keyboard handlers, including on HTTP.
        this.context.resume().then(() => {
          this.unlocked = this.context.state === 'running';this.onChange();
        }).catch(() => {this.unlocked = false;this.onChange();});
      } catch (_) {this.unlocked = false;this.onChange();}
    }
    clear() {
      this.generation++;this.queue = [];
      for(const source of this.sources)source.stop();
      this.sources.clear();
    }
    reset() {this.clear();this.key = null;this.cursor = 0;}
    observe(room, game, silent = false) {
      if(!game) {this.reset();return;}
      const key = `${room}:${game.number}`, history = game.history || [];
      if(key !== this.key || history.length < this.cursor || this.skipNext) {
        this.clear();this.key = key;this.cursor = history.length;this.skipNext = false;return;
      }
      const actions = history.slice(this.cursor);this.cursor = history.length;
      if(silent || document.hidden || !this.enabled || !this.unlocked || this.volume === 0) {this.clear();return;}
      for(const action of actions) {
        const participant = game.players[action[0]]?.participant ?? action[0];
        const clips = clipsFor(action, participant);
        if(clips.length)this.queue.push({clips, type:action[1], at:Date.now()});
      }
      // Don't build a long backlog during fast AI play. Keep winning calls.
      while(this.queue.length > 8) {
        const i = this.queue.findIndex(job => !['hu','robkong','zimo'].includes(job.type));
        if(i < 0)break;
        this.queue.splice(i, 1);
      }
      this.drain();
    }
    async buffer(url) {
      if(!this.buffers.has(url)) {
        const promise = fetch(url).then(r => {
          if(!r.ok)throw new Error('Audio unavailable');
          return r.arrayBuffer();
        }).then(data => this.context.decodeAudioData(data));
        this.buffers.set(url, promise);
        promise.catch(() => this.buffers.delete(url));
      }
      return this.buffers.get(url);
    }
    async play(job, generation) {
      const buffers = await Promise.all(job.clips.map(url => this.buffer(url)));
      if(generation !== this.generation || !this.enabled || document.hidden || this.context.state !== 'running')return;
      const now = this.context.currentTime;
      await Promise.all(buffers.map((buffer, i) => new Promise(resolve => {
        const source = this.context.createBufferSource();source.buffer = buffer;source.connect(this.gain);
        source.onended = () => {source.disconnect();this.sources.delete(source);resolve();};
        this.sources.add(source);source.start(now + i * 0.06);
      })));
    }
    async drain() {
      if(this.running)return;
      this.running = true;
      try {
        while(this.queue.length) {
          const job = this.queue.shift();
          if(Date.now() - job.at > 4500 && !['hu','robkong','zimo'].includes(job.type))continue;
          try {await this.play(job, this.generation);} catch (_) { /* Missing/blocked sound must never interrupt play. */ }
        }
      } finally {this.running = false;}
    }
  }
  globalThis.MahjongAudio = {clipsFor, TableAudio};
})();
