// Loads the Doom wasm and exposes tick()/key()/frame. Works in browsers and in node.
async function createDoom(wasmBytes, wadBytes, hooks) {
  hooks = hooks || {};
  let mem, ex, dv;
  const files = {};            // id -> {ptr,size}
  const names = ['doom1.wad'];
  const str = (p) => { const u = new Uint8Array(mem.buffer); let e = p; while (u[e]) e++; return new TextDecoder().decode(u.subarray(p, e)); };
  let lineBuf = '';
  const env = {
    js_log: (p, n) => { lineBuf += new TextDecoder().decode(new Uint8Array(mem.buffer, p, n)); let i; while ((i = lineBuf.indexOf('\n')) >= 0) { if (hooks.log) hooks.log(lineBuf.slice(0, i)); lineBuf = lineBuf.slice(i + 1); } },
    js_open: (p) => { const n = str(p).split('/').pop().toLowerCase(); return names.indexOf(n); },
    js_open_fill: (id, f) => {
      if (!files[id]) { const ptr = ex.wasm_alloc(wadBytes.length); new Uint8Array(mem.buffer, ptr, wadBytes.length).set(wadBytes); files[id] = { ptr, size: wadBytes.length }; }
      const v = new DataView(mem.buffer); v.setUint32(f, files[id].ptr, true); v.setInt32(f + 4, files[id].size, true);
    },
    js_exit: (c) => { if (hooks.exit) hooks.exit(c); throw new Error('doom exit ' + c); },
    js_tan: Math.tan, js_atan: Math.atan,
    js_now: () => (hooks.now ? hooks.now() : performance.now()),
    js_frame: () => { if (hooks.frame) hooks.frame(); },
    js_snd_start: (ch, p, len, rate, vol, sep) => { const A = hooks.audio; if (A) A.sfxStart(ch, p, new Uint8Array(mem.buffer, p, len), rate, vol, sep); return ch; },
    js_snd_update: (ch, vol, sep) => { const A = hooks.audio; if (A) A.sfxUpdate(ch, vol, sep); },
    js_snd_stop: (ch) => { const A = hooks.audio; if (A) A.sfxStop(ch); },
    js_snd_playing: (ch) => { const A = hooks.audio; return A && A.sfxPlaying(ch) ? 1 : 0; },
    js_mus_register: (p, len) => { const A = hooks.audio; return A ? A.register(new Uint8Array(mem.buffer, p, len).slice()) : 0; },
    js_mus_play: (id, loop) => { const A = hooks.audio; if (A) A.play(id, loop); },
    js_mus_stop: () => { const A = hooks.audio; if (A) A.stop(); },
    js_mus_volume: (v) => { const A = hooks.audio; if (A) A.musVolume(v); },
    js_mus_pause: (on) => { const A = hooks.audio; if (A) A.musPause(on); },
    js_mus_playing: () => { const A = hooks.audio; return A && A.playing() ? 1 : 0; },
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env });
  ex = instance.exports; mem = ex.memory;
  ex.wasm_start();
  return {
    exports: ex,
    tick: () => ex.wasm_tick(),
    key: (pressed, k) => ex.wasm_key(pressed ? 1 : 0, k),
    screen: () => new Uint8Array(mem.buffer, ex.wasm_screen(), 320 * 200 * 4),
  };
}

// ---------- Web Audio: sound effects + a small synth for Doom's MUS music ----------
function createDoomAudio() {
  let ctx = null, master = null, sfxBus = null, musBus = null, noiseBuf = null;
  let muted = false, musVol = 0.8;
  const sfxCh = [], bufs = new Map();
  const songs = [];
  let cur = null, timer = 0, paused = false;
  const chans = [];
  let voices = [];

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    master.connect(comp); comp.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
    musBus = ctx.createGain(); musBus.gain.value = 0.55 * musVol; musBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    for (let c = 0; c < 16; c++) {
      const pre = ctx.createGain(), sh = ctx.createWaveShaper(), g = ctx.createGain();
      let pan = null; if (ctx.createStereoPanner) pan = ctx.createStereoPanner();
      pre.connect(sh); if (pan) { sh.connect(pan); pan.connect(g); } else sh.connect(g);
      g.connect(musBus);
      chans[c] = { pre, sh, pan, g, prog: 0, vol: 100, expr: 127, bend: 0, dist: false };
      applyChanGain(c);
    }
    return true;
  }
  function applyChanGain(c) { const ch = chans[c]; ch.g.gain.value = (ch.vol / 127) * (ch.expr / 127); }
  const distCurve = (() => { const n = 256, a = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; a[i] = Math.tanh(x * 5) * 0.8; } return a; })();

  function resume() { if (ensure() && ctx.state !== 'running') ctx.resume(); }
  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 1; }

  // ----- sound effects -----
  function sfxStart(ch, key, bytes, rate, vol, sep) {
    if (!ensure()) return;
    sfxStop(ch);
    let buf = bufs.get(key);
    if (!buf) { buf = ctx.createBuffer(1, bytes.length, rate); const d = buf.getChannelData(0); for (let i = 0; i < bytes.length; i++) d[i] = (bytes[i] - 128) / 128; bufs.set(key, buf); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = vol / 127;
    let pan = null; if (ctx.createStereoPanner) { pan = ctx.createStereoPanner(); pan.pan.value = (sep - 128) / 128; src.connect(g); g.connect(pan); pan.connect(sfxBus); } else { src.connect(g); g.connect(sfxBus); }
    src.start(); sfxCh[ch] = { src, g, pan, end: ctx.currentTime + buf.duration };
  }
  function sfxUpdate(ch, vol, sep) { const c = sfxCh[ch]; if (!c) return; c.g.gain.value = vol / 127; if (c.pan) c.pan.pan.value = (sep - 128) / 128; }
  function sfxStop(ch) { const c = sfxCh[ch]; if (c) { try { c.src.stop(); } catch (_) {} sfxCh[ch] = null; } }
  function sfxPlaying(ch) { const c = sfxCh[ch]; return !!(c && ctx && c.end > ctx.currentTime); }

  // ----- MUS parsing -----
  function parseMus(b) {
    if (b[0] !== 0x4d || b[1] !== 0x55 || b[2] !== 0x53) return null;
    let p = b[6] | (b[7] << 8); const ev = []; let t = 0; let last = 0;
    const ctl = [0, 0, 1, 7, 10, 11, 0, 0, 0, 0];  // MUS controller -> MIDI controller (index 1 bank, 2 mod, 3 vol, 4 pan, 5 expr)
    for (; p < b.length;) {
      const e = b[p++]; const lastFlag = e & 0x80, type = (e >> 4) & 7; let ch = e & 15;
      if (type === 6) break;
      if (type === 0) ev.push({ t, k: 0, ch, a: b[p++] });
      else if (type === 1) { let n = b[p++]; let v = -1; if (n & 0x80) v = b[p++]; ev.push({ t, k: 1, ch, a: n & 127, b: v }); }
      else if (type === 2) ev.push({ t, k: 2, ch, a: b[p++] });
      else if (type === 3) ev.push({ t, k: 3, ch, a: b[p++] });
      else if (type === 4) { const c = b[p++], v = b[p++]; ev.push({ t, k: 4, ch, a: c, b: v }); }
      if (lastFlag) { let d = 0, x; do { x = b[p++]; d = d * 128 + (x & 127); } while (x & 128 && p < b.length); t += d; }
    }
    return { ev, end: t };
  }
  function chIndex(c) { return c === 15 ? 9 : c; } // (unused: MUS ch 15 = percussion)

  // ----- synth -----
  function preset(p) {
    if (p < 8) return { type: 'triangle', a: .004, d: .5, s: .2, r: .25, cut: 5000 };
    if (p < 16) return { type: 'sine', a: .002, d: .7, s: .08, r: .5, cut: 8000 };
    if (p < 24) return { type: 'square', a: .01, d: .1, s: .7, r: .08, cut: 2200 };
    if (p < 32) return { type: 'sawtooth', a: .004, d: .3, s: .5, r: .08, cut: 2600 };
    if (p < 40) return { type: 'sawtooth', a: .004, d: .25, s: .5, r: .1, cut: 800 };
    if (p < 56) return { type: 'sawtooth', a: .07, d: .2, s: .75, r: .3, cut: 1800 };
    if (p < 72) return { type: 'sawtooth', a: .03, d: .15, s: .7, r: .12, cut: 2800 };
    if (p < 80) return { type: 'triangle', a: .04, d: .1, s: .8, r: .15, cut: 5000 };
    if (p < 88) return { type: 'square', a: .01, d: .1, s: .7, r: .1, cut: 3500 };
    if (p < 104) return { type: 'triangle', a: .15, d: .3, s: .7, r: .5, cut: 3000 };
    return { type: 'triangle', a: .01, d: .3, s: .3, r: .2, cut: 4000 };
  }
  function noteOn(c, note, vel, t) {
    const ch = chans[c];
    if (c === 15) return drum(note, vel, t);
    const P = preset(ch.prog), f = 440 * Math.pow(2, (note - 69) / 12);
    const o = ctx.createOscillator(); o.type = P.type; o.frequency.value = f; o.detune.value = ch.bend;
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = Math.min(P.cut + f * 0.5, 12000);
    const g = ctx.createGain(); const peak = 0.22 * (vel / 127);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + P.a);
    g.gain.exponentialRampToValueAtTime(Math.max(peak * P.s, 0.0002), t + P.a + P.d);
    o.connect(fl); fl.connect(g); g.connect(ch.pre); o.start(t);
    const v = { c, note, o, g, P, t, off: false };
    voices.push(v);
    if (voices.length > 26) { const old = voices.shift(); kill(old, t, 0.03); }
  }
  function kill(v, t, r) { if (v.dead) return; v.dead = true; try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, r / 3); v.o.stop(t + r + 0.05); } catch (_) {} }
  function noteOff(c, note, t) {
    for (let i = voices.length - 1; i >= 0; i--) { const v = voices[i]; if (v.c === c && v.note === note && !v.off) { v.off = true; kill(v, t, v.P.r); voices.splice(i, 1); break; } }
  }
  function drum(n, vel, t) {
    const out = chans[15].pre, k = vel / 127;
    const noise = (hp, bp, dec, amp) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = false;
      const f = ctx.createBiquadFilter(); if (bp) { f.type = 'bandpass'; f.frequency.value = bp; } else { f.type = 'highpass'; f.frequency.value = hp; }
      const g = ctx.createGain(); g.gain.setValueAtTime(amp * k, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dec + 0.05);
    };
    const tone = (f0, f1, dec, amp, type) => {
      const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dec);
      const g = ctx.createGain(); g.gain.setValueAtTime(amp * k, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dec + 0.05);
    };
    if (n === 35 || n === 36) tone(160, 45, 0.14, 0.9);
    else if (n === 38 || n === 40 || n === 37 || n === 39) { noise(0, 1900, 0.16, 0.55); tone(220, 130, 0.08, 0.35, 'triangle'); }
    else if (n === 42 || n === 44) noise(7000, 0, 0.045, 0.35);
    else if (n === 46) noise(6500, 0, 0.28, 0.3);
    else if (n === 41 || n === 43 || n === 45 || n === 47 || n === 48 || n === 50) tone(60 + (n - 41) * 22 + 90, 55, 0.3, 0.7);
    else if (n === 49 || n === 51 || n === 52 || n === 53 || n === 55 || n === 57 || n === 59) noise(5000, 0, 0.7, 0.28);
    else noise(3000, 0, 0.05, 0.25);
  }
  function handle(e, t) {
    const ch = chans[e.ch]; if (!ch) return;
    if (e.k === 0) noteOff(e.ch, e.a, t);
    else if (e.k === 1) { if (e.b >= 0) ch.lastVel = e.b; noteOn(e.ch, e.a, ch.lastVel == null ? 100 : ch.lastVel, t); }
    else if (e.k === 2) { ch.bend = (e.a - 128) / 128 * 200; for (const v of voices) if (v.c === e.ch) v.o.detune.setValueAtTime(ch.bend, t); }
    else if (e.k === 3) { if (e.a === 10 || e.a === 11) { for (const v of voices) if (v.c === e.ch) kill(v, t, 0.08); voices = voices.filter(v => v.c !== e.ch); } }
    else if (e.k === 4) {
      if (e.a === 0) { ch.prog = e.b; const d = e.ch !== 15 && (e.b === 29 || e.b === 30); if (d !== ch.dist) { ch.dist = d; ch.sh.curve = d ? distCurve : null; } }
      else if (e.a === 3) { ch.vol = e.b; applyChanGain(e.ch); }
      else if (e.a === 4 && ch.pan) ch.pan.pan.value = (e.b - 64) / 64;
      else if (e.a === 5) { ch.expr = e.b; applyChanGain(e.ch); }
    }
  }
  function pump() {
    if (!cur || paused || !ctx) return;
    const now = ctx.currentTime;
    while (true) {
      if (cur.i >= cur.song.ev.length) {
        const endT = cur.t0 + cur.song.end / 140;
        if (now + 0.2 < endT) break;
        if (cur.loop) { cur.t0 = Math.max(endT, now); cur.i = 0; for (const v of voices) kill(v, cur.t0, 0.1); voices = []; continue; }
        stopMus(); break;
      }
      const e = cur.song.ev[cur.i], t = cur.t0 + e.t / 140;
      if (t > now + 0.18) break;
      handle(e, Math.max(t, now)); cur.i++;
    }
  }
  function register(bytes) { const s = parseMus(bytes); songs.push(s); return songs.length - 1; }
  function play(id, loop) {
    if (!ensure()) return; stopMus(); const song = songs[id]; if (!song) return;
    for (let c = 0; c < 16; c++) { const ch = chans[c]; ch.prog = 0; ch.vol = 100; ch.expr = 127; ch.bend = 0; ch.lastVel = null; ch.dist = false; ch.sh.curve = null; applyChanGain(c); if (ch.pan) ch.pan.pan.value = 0; }
    cur = { song, i: 0, t0: ctx.currentTime + 0.05, loop: !!loop };
    clearInterval(timer); timer = setInterval(pump, 25);
  }
  function stopMus() { clearInterval(timer); timer = 0; cur = null; if (ctx) { for (const v of voices) kill(v, ctx.currentTime, 0.05); } voices = []; }
  function musVolume(v) { musVol = v / 127; if (musBus) musBus.gain.value = 0.55 * musVol; }
  function musPause(on) { paused = !!on; if (ctx) { if (on) ctx.suspend(); else if (!pausedByExit) ctx.resume(); } }
  let pausedByExit = false;
  return { resume, suspend, setMuted, isMuted: () => muted, sfxStart, sfxUpdate, sfxStop, sfxPlaying, register, play, stop: stopMus, musVolume, musPause, playing: () => !!cur, setExit: (v) => { pausedByExit = v; } };
}

// ---------- Doom overlay (loaded only when the easter egg is triggered) ----------
(function () {
  if (window.launchDoom) return;
  const K = { UP: 0xad, DOWN: 0xaf, LEFT: 0xac, RIGHT: 0xae, FIRE: 0xa3, USE: 0xa2, ESC: 27, ENTER: 13, SHIFT: 0x80 + 0x36, TAB: 9, SL: 0xa0, SR: 0xa1 };
  let inst = null, loading = null, root = null, running = false, raf = 0, lastTick = 0, run = true;
  const audio = createDoomAudio();
  let pausedTotal = 0, exitedAt = 0;
  try { if (window.settings && window.settings.sound === false) audio.setMuted(true); } catch (_) {}
  const held = new Set();

  const css = `
  #doomRoot{position:fixed;inset:0;z-index:99999;background:#000;color:#e8e8e8;font:700 13px ui-monospace,Menlo,Consolas,monospace;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;overflow:hidden}
  #doomRoot canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated;background:#000}
  #doomMsg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#d33;letter-spacing:.08em}
  .dbtn{position:absolute;display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,.55);background:rgba(20,20,20,.38);color:#fff;border-radius:14px;font:inherit;-webkit-tap-highlight-color:transparent;touch-action:none}
  .dbtn.on{background:rgba(220,40,40,.55);border-color:#fff}
  .dbtn.small{height:34px;min-width:44px;padding:0 10px;font-size:12px}
  .dpad{width:62px;height:62px;font-size:24px}
  .dfire{width:92px;height:92px;border-radius:50%;font-size:15px;border-color:rgba(255,90,90,.9)}
  .duse{width:70px;height:70px;border-radius:50%;font-size:14px}
  @media (max-width:640px){#doomWep{top:56px !important}}
  .dwep{height:30px;min-width:30px;font-size:12px;padding:0 4px;border-radius:8px}
  `;
  function el(tag, cls, txt, par) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; if (par) par.appendChild(e); return e; }

  function press(k, down) { if (!inst) return; if (down) { if (held.has(k)) return; held.add(k); } else { if (!held.has(k)) return; held.delete(k); } inst.key(down, k); }

  function bindBtn(b, k) {
    const ids = new Set();
    const dn = (e) => { e.preventDefault(); ids.add(e.pointerId); try { b.setPointerCapture(e.pointerId); } catch (_) {} b.classList.add('on'); press(k, true); if (navigator.vibrate) navigator.vibrate(8); };
    const up = (e) => { e.preventDefault(); ids.delete(e.pointerId); if (!ids.size) { b.classList.remove('on'); press(k, false); } };
    b.addEventListener('pointerdown', dn); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', e => e.preventDefault());
  }
  function tap(k) { press(k, true); setTimeout(() => press(k, false), 60); }

  function layout() {
    const cv = root.querySelector('canvas'); if (!cv) return;
    const W = innerWidth, H = innerHeight, s = Math.min(W / 320, H / 200);
    cv.style.width = Math.floor(320 * s) + 'px'; cv.style.height = Math.floor(200 * s) + 'px';
  }

  function build() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = el('div'); root.id = 'doomRoot';
    const cv = el('canvas', null, null, root); cv.width = 320; cv.height = 200;
    const msg = el('div', null, 'LOADING…', root); msg.id = 'doomMsg';
    // d-pad (bottom-left)
    const pad = (txt, k, css) => { const b = el('button', 'dbtn dpad', txt, root); b.style.cssText = css; bindBtn(b, k); return b; };
    pad('▲', K.UP, 'left:76px;bottom:140px'); pad('▼', K.DOWN, 'left:76px;bottom:14px');
    pad('◀', K.LEFT, 'left:10px;bottom:77px'); pad('▶', K.RIGHT, 'left:142px;bottom:77px');
    // fire / use (bottom-right)
    const fire = el('button', 'dbtn dfire', 'FIRE', root); fire.style.cssText = 'right:20px;bottom:30px'; bindBtn(fire, K.FIRE);
    const use = el('button', 'dbtn duse', 'USE', root); use.style.cssText = 'right:124px;bottom:110px'; bindBtn(use, K.USE);
    // top bar
    const top = (txt, css, fn) => { const b = el('button', 'dbtn small', txt, root); b.style.cssText = css; b.addEventListener('click', fn); return b; };
    top('✕ EXIT', 'right:10px;top:10px', exit);
    const snd = top(audio.isMuted() ? 'SND OFF' : 'SND ON', 'right:274px;top:10px', () => { audio.setMuted(!audio.isMuted()); snd.textContent = audio.isMuted() ? 'SND OFF' : 'SND ON'; audio.resume(); });
    top('MENU', 'right:92px;top:10px', () => tap(K.ESC));
    top('OK', 'right:160px;top:10px', () => tap(K.ENTER));
    const runBtn = top('RUN', 'right:216px;top:10px', () => { run = !run; runBtn.classList.toggle('on', run); inst && inst.key(run, K.SHIFT); });
    runBtn.classList.toggle('on', run);
    // weapon row (bottom centre)
    const row = el('div', null, null, root); row.id = 'doomWep'; row.style.cssText = 'position:absolute;left:10px;top:10px;display:flex;gap:4px';
    for (let n = 1; n <= 7; n++) { const b = el('button', 'dbtn dwep', String(n), row); b.style.position = 'static'; b.addEventListener('click', () => tap(48 + n)); }
    for (const ev of ['touchend', 'click', 'pointerup', 'keydown']) root.addEventListener(ev, () => audio.resume(), true);
    document.body.appendChild(root);
    layout(); addEventListener('resize', layout);
    // keyboard (desktop)
    const km = { ArrowUp: K.UP, ArrowDown: K.DOWN, ArrowLeft: K.LEFT, ArrowRight: K.RIGHT, ControlLeft: K.FIRE, ControlRight: K.FIRE, KeyF: K.FIRE, Space: K.USE, KeyE: K.USE, Enter: K.ENTER, Escape: K.ESC, Tab: K.TAB, ShiftLeft: K.SHIFT, ShiftRight: K.SHIFT, Comma: K.SL, Period: K.SR, KeyA: K.SL, KeyD: K.SR };
    const kh = (down) => (e) => { if (!root || !running) return; let k = km[e.code]; if (!k && /^Digit[1-7]$/.test(e.code)) k = 48 + +e.code[5]; if (!k) return; e.preventDefault(); e.stopPropagation(); if (e.code === 'Escape' && down === false) {} press(k, down); };
    addEventListener('keydown', kh(true), true); addEventListener('keyup', kh(false), true);
    root._msg = msg; root._cv = cv;
  }

  async function fetchFiles(bust) {
    const o = bust ? { cache: 'reload' } : {};
    const [wr, ar] = await Promise.all([fetch('doom/doom.wasm', o), fetch('doom/DOOM1.WAD', o)]);
    if (!wr.ok || !ar.ok) throw new Error('doom.wasm: ' + wr.status + ' / DOOM1.WAD: ' + ar.status);
    const [wasm, wad] = await Promise.all([wr.arrayBuffer(), ar.arrayBuffer()]);
    const w = new Uint8Array(wasm), d = new Uint8Array(wad);
    if (w[0] !== 0 || w[1] !== 0x61 || w[2] !== 0x73 || w[3] !== 0x6d) throw new Error('doom.wasm is not a wasm file (' + w.length + ' bytes)');
    if (d[0] !== 0x49 || d[1] !== 0x57 || d[2] !== 0x41 || d[3] !== 0x44) throw new Error('DOOM1.WAD is not a WAD file (' + d.length + ' bytes)');
    return [w, d];
  }
  async function load() {
    if (inst) return inst;
    if (loading) return loading;
    loading = (async () => {
      let files;
      try { files = await fetchFiles(false); }
      catch (e1) {
        // A stale or bad cached copy (e.g. from an older version of the app) can break loading: wipe the doom caches and try again.
        try { const ks = await caches.keys(); await Promise.all(ks.filter(k => k.startsWith('commander-doom-')).map(k => caches.delete(k))); } catch (_) {}
        files = await fetchFiles(true);
      }
      inst = await createDoom(files[0], files[1], { frame: draw, audio, now: () => performance.now() - pausedTotal });
      return inst;
    })();
    try { return await loading; } finally { loading = null; }
  }

  let ctx, img;
  function draw() {
    if (!inst) return;
    if (!ctx) { ctx = root._cv.getContext('2d'); img = ctx.createImageData(320, 200); }
    const src = inst.screen(), d = img.data;
    for (let i = 0; i < 64000; i++) { const j = i * 4; d[j] = src[j + 2]; d[j + 1] = src[j + 1]; d[j + 2] = src[j]; d[j + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }
  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (t - lastTick >= 1000 / 35 - 1) { lastTick = t; try { inst.tick(); } catch (e) { running = false; showMsg('DOOM CRASHED\n' + (e && e.message)); } }
  }
  function showMsg(t) { root._msg.style.display = t ? 'flex' : 'none'; root._msg.textContent = t || ''; }
  function exit() {
    running = false; cancelAnimationFrame(raf); exitedAt = performance.now(); audio.setExit(true); audio.suspend();
    for (const k of [...held]) press(k, false);
    if (root) root.style.display = 'none';
  }

  window.launchDoom = async function () {
    if (!root) build();
    root.style.display = 'block'; layout();
    if (!inst) {
      showMsg('LOADING…');
      try { await load(); } catch (e) { console.error('doom load', e && e.stack); showMsg('DOOM COULD NOT START\n' + (e && e.message) + '\n(are the doom/ files uploaded next to index.html?)'); return; }
    }
    showMsg('');
    inst.key(run, K.SHIFT);
    if (exitedAt) { pausedTotal += performance.now() - exitedAt; exitedAt = 0; }
    audio.setExit(false); audio.resume();
    running = true; lastTick = 0; raf = requestAnimationFrame(loop);
  };
})();
