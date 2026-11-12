/* Mirror window: shows one phone / browser / demo screen with the original's tools. */
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.api;
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind');           // android | web | demo
  const title = q.get('title') || 'Mirror';
  document.title = title;
  const canControl = kind === 'android' || kind === 'demo';
  if (!canControl) document.body.classList.add('no-android');

  const view = $('#view');
  const vctx = view.getContext('2d');
  const wbCanvas = $('#wb');
  const video = $('#remote');
  let settings = {};
  let rotation = 0;           // 0..3 quarter turns
  let src = null;             // current picture (VideoFrame, canvas or video)
  let srcW = 0, srcH = 0;     // picture size before rotation
  let phone = { width: 0, height: 0 }; // real screen size for control
  let dirty = true;
  let gotFirst = false;
  let demo = null;
  let player = null;
  let remoteAudio = null;

  // ---------- small UI helpers ----------
  function toast(text, kind, action) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = action.fn;
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), action ? 6000 : 3200);
  }
  function setStatus(text, error) {
    const s = $('#status');
    if (!text) { s.hidden = true; return; }
    s.hidden = false;
    s.classList.toggle('error', !!error);
    $('#statusText').innerHTML = text;
  }

  // ---------- layout ----------
  function outSize() { return rotation % 2 ? { w: srcH, h: srcW } : { w: srcW, h: srcH }; }
  function layout() {
    if (!srcW || !srcH) return;
    const { w, h } = outSize();
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; dirty = true; }
    const stage = $('#stage');
    const pad = document.body.classList.contains('fs') ? 0 : 20;
    const availW = stage.clientWidth - pad, availH = stage.clientHeight - pad;
    const k = Math.min(availW / w, availH / h);
    view.style.width = Math.floor(w * k) + 'px';
    view.style.height = Math.floor(h * k) + 'px';
    wb.resize(Math.floor(w * k * devicePixelRatio), Math.floor(h * k * devicePixelRatio));
  }
  window.addEventListener('resize', () => { layout(); dirty = true; });

  function fitWindow() {
    const { w, h } = outSize();
    const tb = $('#toolbar').hidden ? 0 : 56;
    api.fitAspect({ width: w, height: h, chrome: { w: tb + 20, h: 20 } });
  }

  // ---------- drawing loop ----------
  function paint() {
    if (!src) return;
    const { w, h } = outSize();
    vctx.save();
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rotation === 0) vctx.drawImage(src, 0, 0, w, h);
    else {
      vctx.translate(w / 2, h / 2);
      vctx.rotate(rotation * Math.PI / 2);
      vctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
    }
    vctx.restore();
  }

  function setSource(s, w, h) {
    const changed = w !== srcW || h !== srcH;
    src = s; srcW = w; srcH = h;
    if (changed) { layout(); if (!gotFirst || changed) fitWindow(); }
    if (!gotFirst) { gotFirst = true; setStatus(''); }
    dirty = true;
  }

  function loop(now) {
    if (kind === 'demo' && demo) setSource(demo.render(now), demo.width, demo.height);
    if (kind === 'web' && video.readyState >= 2 && video.videoWidth) setSource(video, video.videoWidth, video.videoHeight);
    if (dirty) { paint(); dirty = false; }
    if (recorder) composeFrame();
    requestAnimationFrame(loop);
  }

  // ---------- sources ----------
  async function startAndroid() {
    setStatus('Starting the phone picture…<br><span style="opacity:.7">Unlock the phone if it is locked.</span>');
    player = new H264Player((frame) => {
      const old = src;
      setSource(frame, frame.displayWidth, frame.displayHeight);
      paint(); dirty = false;
      if (old && old !== frame && typeof old.close === 'function') old.close();
    }, (ev) => { if (ev.type === 'decode-error') console.warn(ev.message); });
    api.onVideo((chunk) => player.push(chunk));
    api.onPacket((pkt) => player.pushPacket(pkt.data));
    api.onMirrorEvent((ev) => {
      if (ev.type === 'error') setStatus(`The phone did not send a picture.<br><span style="opacity:.7">${ev.message || ''}</span><br>Check that the phone is unlocked and USB debugging is allowed.`, true);
      if (ev.type === 'retry') setStatus('Trying a smaller picture size…');
      if (ev.type === 'helper-starting') setStatus('Starting the helper on the phone…<br><span style="opacity:.7">The first time, it is downloaded (about 90 KB).</span>');
      if (ev.type === 'fallback') toast('Live control is not available (' + ev.message + '). Using basic control.', 'bad');
      if (ev.type === 'ended') setStatus(`The phone stopped sending.<br><span style="opacity:.7">${ev.message || ''}</span>`, true);
    });
    const r = await api.startAndroid();
    if (!r.ok) { setStatus(r.error || 'Could not start', true); return; }
    androidMode = r.mode;
    phone = r.screen;
    if (r.info && r.info.model) document.title = `${r.info.maker ? r.info.maker + ' ' : ''}${r.info.model} · Android ${r.info.android}`;
    setTimeout(() => { if (!gotFirst) setStatus('Waiting for the phone…<br><span style="opacity:.7">Move something on the phone screen if this stays.</span>'); }, 6000);
  }

  // Developer check of the phone video path: encode the demo phone to raw H.264, cut the bytes
  // into uneven pieces like a USB pipe does, and play them back through the same decoder.
  async function startSelftest() {
    const fake = new DemoPhone();
    phone = { width: fake.width, height: fake.height };
    setStatus('Self-test: encoding…');
    player = new H264Player((frame) => {
      const old = src;
      setSource(frame, frame.displayWidth, frame.displayHeight);
      paint(); dirty = false;
      if (old && old !== frame && typeof old.close === 'function') old.close();
    }, (ev) => console.log('h264', JSON.stringify(ev)));
    const enc = new VideoEncoder({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        let o = 0;
        while (o < b.length) { const n = 1 + Math.floor(Math.random() * 9000); player.push(b.subarray(o, o + n)); o += n; }
      },
      error: (e) => setStatus('Encoder error: ' + e.message, true)
    });
    enc.configure({ codec: 'avc1.42E028', width: 720, height: 1520, bitrate: 4e6, framerate: 30, avc: { format: 'annexb' }, latencyMode: 'realtime' });
    let n = 0;
    const tick = () => {
      const c = fake.render(performance.now());
      const vf = new VideoFrame(c, { timestamp: n * 33333 });
      enc.encode(vf, { keyFrame: n % 60 === 0 });
      vf.close();
      n++;
      setTimeout(tick, 33);
    };
    tick();
  }

  // iPhone app (ReplayKit broadcast): same length-prefixed H.264 packets as the Android helper.
  // iPhones can't be controlled from a computer, so only the picture tools are shown.
  function startIos() {
    setStatus('Waiting for the iPhone picture…<br><span style="opacity:.7">On the iPhone, tap Start Broadcast.</span>');
    player = new H264Player((frame) => {
      const old = src;
      setSource(frame, frame.displayWidth, frame.displayHeight);
      paint(); dirty = false;
      if (old && old !== frame && typeof old.close === 'function') old.close();
    }, (ev) => { if (ev.type === 'decode-error') console.warn(ev.message); });
    api.onPacket((pkt) => (pkt.audio ? playIosSound(pkt) : player.pushPacket(pkt.data)));
    api.onMirrorEvent((ev) => {
      if (ev.type === 'ended') { setStatus(ev.message || 'The iPhone stopped sharing.', true); gotFirst = false; }
    });
  }

  // iPhone sound: 16-bit PCM chunks played back to back, about 80 ms behind, never more than 400 ms.
  let iosAudio = null, iosAudioAt = 0;
  function playIosSound(pkt) {
    const ch = pkt.channels, rate = pkt.rate;
    if (!ch || !rate) return;
    if (!iosAudio) {
      iosAudio = new AudioContext();
      const dest = iosAudio.createMediaStreamDestination();
      iosAudio.out = iosAudio.createGain();
      iosAudio.out.connect(iosAudio.destination);
      iosAudio.out.connect(dest);
      remoteAudio = { srcObject: dest.stream }; // lets recording include the iPhone sound
    }
    if (iosAudio.state === 'suspended') iosAudio.resume().catch(() => {});
    const bytes = pkt.data;
    const view16 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = Math.floor(bytes.byteLength / 2 / ch);
    if (!frames) return;
    const buf = iosAudio.createBuffer(ch, frames, rate);
    for (let c = 0; c < ch; c++) {
      const out = buf.getChannelData(c);
      for (let f = 0; f < frames; f++) out[f] = view16.getInt16((f * ch + c) * 2, true) / 32768;
    }
    const now = iosAudio.currentTime;
    if (iosAudioAt < now + 0.02 || iosAudioAt > now + 0.4) iosAudioAt = now + 0.08;
    const node = iosAudio.createBufferSource();
    node.buffer = buf;
    node.connect(iosAudio.out);
    node.start(iosAudioAt);
    iosAudioAt += buf.duration;
  }

  function startDemo() {
    demo = new DemoPhone();
    phone = { width: demo.width, height: demo.height };
    setStatus('');
  }

  // Browser sender over Wi-Fi: answer its WebRTC offer.
  let pc = null;
  function startWeb() {
    setStatus('Waiting for the other device to share its screen…');
    api.onSender(async (msg) => {
      if (msg.type === 'offer') {
        if (pc) pc.close();
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.onicecandidate = (e) => { if (e.candidate) api.toSender({ type: 'ice', candidate: e.candidate.toJSON() }); };
        pc.ontrack = (e) => {
          const stream = e.streams[0] || new MediaStream([e.track]);
          if (e.track.kind === 'video') { video.srcObject = stream; video.play().catch(() => {}); }
          if (e.track.kind === 'audio') {
            remoteAudio = new Audio();
            remoteAudio.srcObject = new MediaStream([e.track]);
            remoteAudio.play().catch(() => {});
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc && ['failed', 'disconnected'].includes(pc.connectionState)) setStatus('The connection was lost.', true);
        };
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        api.toSender({ type: 'answer', sdp: pc.localDescription.toJSON(), quality: settings.receiverQuality });
      } else if (msg.type === 'ice' && pc) {
        try { await pc.addIceCandidate(msg.candidate); } catch (_) { /* ignore */ }
      } else if (msg.type === 'stop' || msg.type === 'bye') {
        setStatus('The other device stopped sharing.', true);
        gotFirst = false;
      }
    });
    video.addEventListener('resize', () => { dirty = true; fitWindow(); });
  }

  // ---------- control ----------
  // Point in the shown picture → point on the phone screen, undoing the rotation.
  function toPhone(clientX, clientY) {
    const r = view.getBoundingClientRect();
    let u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
    u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
    let x, y;
    switch (rotation) {
      case 1: x = v; y = 1 - u; break;
      case 2: x = 1 - u; y = 1 - v; break;
      case 3: x = 1 - v; y = u; break;
      default: x = u; y = v;
    }
    // The phone may be turned sideways while the picture is landscape.
    const landscapePic = srcW > srcH, landscapePhone = phone.width > phone.height;
    const pw = landscapePic !== landscapePhone ? phone.height : phone.width;
    const ph = landscapePic !== landscapePhone ? phone.width : phone.height;
    return { x: Math.round(x * (pw || srcW)), y: Math.round(y * (ph || srcH)) };
  }

  const TAP_MOVE = 8, LONG_PRESS = 500; // basic control only, estimated, see MECHANICS.md
  const SEND_GAP_MS = 10;               // scrcpySendTouchEvent 0x10031e80: Sleep(10)
  const TOUCH = { DOWN: 0, UP: 1, MOVE: 2 }; // TouchEventType BUTTON_DOWN / BUTTON_UP / MOUSEMOVE
  // Android key codes, as the original maps them (scrcpySendKeybdEvent 0x10031b00):
  // ENTER 0x42, UP 0x13, DOWN 0x14, LEFT 0x15, RIGHT 0x16, HOME 3, END(=back) 4, POWER 0x1a,
  // APP_SWITCH 0xbb, CUT 0x115, COPY 0x116, PASTE 0x117, VOICE_UP 0x18, VOICE_DOWN 0x19.
  // backspace/del/tab/moveHome/moveEnd/playPause are additions of this rebuild.
  const KEYCODE = {
    enter: 66, up: 19, down: 20, left: 21, right: 22, home: 3, back: 4, power: 26, tasks: 187,
    cut: 277, copy: 278, paste: 279, volumeUp: 24, volumeDown: 25,
    backspace: 67, del: 112, tab: 61, moveHome: 122, moveEnd: 123, playPause: 85
  };
  let androidMode = 'basic';
  const live = () => kind === 'android' && androidMode === 'helper';

  // Point in the shown picture → picture pixels (what the helper expects, with the picture size),
  // undoing the window rotation. Same rule as scrcpySendTouchEvent: x * pictureW / windowW.
  function toFrame(clientX, clientY) {
    const r = view.getBoundingClientRect();
    const u0 = (clientX - r.left) / r.width, v0 = (clientY - r.top) / r.height;
    const inside = u0 >= 0 && u0 <= 1 && v0 >= 0 && v0 <= 1;
    const u = Math.min(1, Math.max(0, u0)), v = Math.min(1, Math.max(0, v0));
    let x, y;
    switch (rotation) {
      case 1: x = v; y = 1 - u; break;
      case 2: x = 1 - u; y = 1 - v; break;
      case 3: x = 1 - v; y = u; break;
      default: x = u; y = v;
    }
    return { x: Math.round(x * (srcW - 1)), y: Math.round(y * (srcH - 1)), inside };
  }
  let press = null;
  view.addEventListener('pointerdown', (e) => {
    if (!canControl || wb.active) return;
    $('#stage').focus();
    if (e.button === 2) {
      if (settings.hotkeys && settings.hotkeys.back === 'RButton') sendKey('back');
      return;
    }
    if (e.button !== 0) return;
    view.setPointerCapture(e.pointerId);
    press = { x: e.clientX, y: e.clientY, t: performance.now(), p: toPhone(e.clientX, e.clientY), lastMove: 0 };
    if (live()) { const f = toFrame(e.clientX, e.clientY); api.touch(TOUCH.DOWN, f.x, f.y, srcW, srcH); }
  });
  view.addEventListener('pointermove', (e) => {
    if (!press || !live()) return;
    const now = performance.now();
    if (now - press.lastMove < SEND_GAP_MS) return; // the original sleeps 10 ms per touch message
    press.lastMove = now;
    const f = toFrame(e.clientX, e.clientY);
    if (!f.inside) {
      // SendTouchEvent 0x100210a0: a point off the picture ends the touch.
      api.touch(TOUCH.UP, f.x, f.y, srcW, srcH);
      press = null;
      return;
    }
    api.touch(TOUCH.MOVE, f.x, f.y, srcW, srcH);
  });
  view.addEventListener('pointerup', (e) => {
    if (!press || e.button !== 0) return;
    if (live()) {
      const f = toFrame(e.clientX, e.clientY);
      api.touch(TOUCH.UP, f.x, f.y, srcW, srcH);
      press = null;
      return;
    }
    const dt = performance.now() - press.t;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    const end = toPhone(e.clientX, e.clientY);
    if (moved < TAP_MOVE && dt < LONG_PRESS) control('tap', press.p.x, press.p.y);
    else if (moved < TAP_MOVE) control('swipe', press.p.x, press.p.y, press.p.x, press.p.y, Math.round(dt));
    else control('swipe', press.p.x, press.p.y, end.x, end.y, Math.min(2000, Math.max(80, Math.round(dt))));
    press = null;
  });
  view.addEventListener('contextmenu', (e) => e.preventDefault());

  let wheel = null;
  view.addEventListener('wheel', (e) => {
    if (!canControl || wb.active) return;
    e.preventDefault();
    if (!wheel) {
      wheel = { dx: 0, dy: 0, x: e.clientX, y: e.clientY };
      setTimeout(() => {
        const w = wheel; wheel = null;
        const r = view.getBoundingClientRect();
        const fy = (settings.scrollFactorY || 10) / 100, fx = (settings.scrollFactorX || 20) / 100;
        const notchesY = Math.max(-5, Math.min(5, w.dy / 100)), notchesX = Math.max(-5, Math.min(5, w.dx / 100));
        const ex = Math.min(r.right - 2, Math.max(r.left + 2, w.x - notchesX * fx * r.width));
        const ey = Math.min(r.bottom - 2, Math.max(r.top + 2, w.y - notchesY * fy * r.height));
        if (live()) {
          // A short finger drag: down, four moves, up (each message 10 ms apart in the main process).
          const a = toFrame(w.x, w.y), b = toFrame(ex, ey);
          api.touch(TOUCH.DOWN, a.x, a.y, srcW, srcH);
          for (let i = 1; i <= 4; i++) api.touch(TOUCH.MOVE, a.x + (b.x - a.x) * i / 4, a.y + (b.y - a.y) * i / 4, srcW, srcH);
          api.touch(TOUCH.UP, b.x, b.y, srcW, srcH);
          return;
        }
        const a = toPhone(w.x, w.y), b = toPhone(ex, ey);
        control('swipe', a.x, a.y, b.x, b.y, 120);
      }, 90);
    }
    wheel.dx += e.shiftKey ? e.deltaY : e.deltaX;
    wheel.dy += e.shiftKey ? 0 : e.deltaY;
  }, { passive: false });

  function control(type, ...a) {
    if (kind === 'demo') {
      const k = demo.width / (phone.width || demo.width);
      if (type === 'tap') demo.tap(a[0] * k, a[1] * k);
      if (type === 'swipe') {
        if (a[0] === a[2] && a[1] === a[3]) demo.tap(a[0] * k, a[1] * k);
        else demo.swipe(a[0] * k, a[1] * k, a[2] * k, a[3] * k);
      }
      return;
    }
    if (kind !== 'android') return;
    if (type === 'tap') api.tap(a[0], a[1]);
    if (type === 'swipe') api.swipe(a[0], a[1], a[2], a[3], a[4]);
  }
  function sendKey(name) {
    if (kind === 'demo') return demo.key(name);
    if (kind !== 'android') return;
    if (KEYCODE[name] != null) api.keycode(KEYCODE[name]);
  }
  function sendText(t) {
    if (!t) return;
    if (kind === 'demo') return demo.text(t);
    if (kind === 'android') {
      if (!live() && /[^\x20-\x7e\n]/.test(t)) toast('Basic control can only type plain letters, numbers and symbols. Live control types any language.', 'bad');
      t.split('\n').forEach((line, i) => { if (i) api.keycode(KEYCODE.enter); if (line) api.text(line); });
    }
  }

  // Typing straight onto the picture.
  let textBuf = '', textTimer = null;
  const KEYMAP = { Enter: 'enter', Backspace: 'backspace', Delete: 'del', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'moveHome', End: 'moveEnd', Tab: 'tab', Escape: 'back' };

  // ---------- tools ----------
  const wb = new Whiteboard(wbCanvas, updateWbButtons);
  function setWhiteboard(on) {
    wb.setActive(on);
    $('#wbBar').hidden = !on;
    $('#swatches').hidden = true;
    btn('whiteboard').classList.toggle('on', on);
    if (!on) wb.clear();
    updateWbButtons();
  }
  function updateWbButtons() {
    $('#wbUndo').disabled = !wb.canUndo;
    $('#wbRedo').disabled = !wb.canRedo;
    $('#wbClear').disabled = !wb.canUndo;
    $('#wbSwatch').style.background = wb.color;
    document.querySelectorAll('#swatches button').forEach((b) => b.classList.toggle('on', b.dataset.c === wb.color));
  }
  $('#swatches').innerHTML = Whiteboard.COLORS.map((c) => `<button data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
  $('#wbBar').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    if (t) {
      wb.setTool(t.dataset.tool);
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b === t));
      updateWbButtons();
    }
  });
  $('#wbColor').onclick = (e) => { e.stopPropagation(); $('#swatches').hidden = !$('#swatches').hidden; };
  $('#swatches').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { wb.setColor(b.dataset.c); $('#swatches').hidden = true; updateWbButtons(); } };
  $('#wbUndo').onclick = () => wb.undo();
  $('#wbRedo').onclick = () => wb.redo();
  $('#wbClear').onclick = () => wb.clear();
  $('#wbClose').onclick = () => setWhiteboard(false);

  // Picture of the screen with the drawing on top.
  const comp = document.createElement('canvas');
  const cctx = comp.getContext('2d');
  function composeFrame() {
    if (!view.width) return;
    if (comp.width !== view.width || comp.height !== view.height) { comp.width = view.width; comp.height = view.height; }
    cctx.drawImage(view, 0, 0);
    if (wb.items.length || wb.cur) cctx.drawImage(wbCanvas, 0, 0, comp.width, comp.height);
  }

  async function screenshot() {
    if (!gotFirst) return toast('Nothing to capture yet.', 'bad');
    composeFrame();
    const fmt = settings.imageFormat === 'JPG' ? 'JPG' : 'PNG';
    const blob = await new Promise((res) => comp.toBlob(res, fmt === 'JPG' ? 'image/jpeg' : 'image/png', 0.92));
    const r = await api.saveImage(new Uint8Array(await blob.arrayBuffer()), fmt, document.title);
    const fl = document.createElement('div'); fl.className = 'flash';
    $('#screenBox').appendChild(fl); setTimeout(() => fl.remove(), 400);
    if (r.where === 'clipboard') toast('Screenshot copied to the clipboard', 'ok');
    else toast('Screenshot saved', 'ok', { label: 'Show', fn: () => api.showItem(r.path) });
  }

  // Recording (MP4 when the system can, otherwise WebM).
  let recorder = null, recChunks = [], recStart = 0, recTimer = null, recExtra = [];
  const QUALITY_BITS = { High: 8000000, Standard: 4000000, Low: 1500000 }; // estimated
  async function toggleRecording() {
    if (recorder) { recorder.stop(); return; }
    if (!gotFirst) return toast('Nothing to record yet.', 'bad');
    composeFrame();
    const stream = comp.captureStream(settings.recFrameRate || 30);
    const audio = settings.recAudio || 'None';
    const tracks = [];
    try {
      if ((audio === 'SystemSound' || audio === 'SysSoundAndMicrophone') && remoteAudio && remoteAudio.srcObject) tracks.push(...remoteAudio.srcObject.getAudioTracks());
      if (audio === 'Microphone' || audio === 'SysSoundAndMicrophone') {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        recExtra = mic.getTracks();
        tracks.push(...recExtra);
      }
    } catch (_) { toast('The microphone could not be used.', 'bad'); }
    if (tracks.length > 1) {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      tracks.forEach((t) => ac.createMediaStreamSource(new MediaStream([t])).connect(dest));
      stream.addTrack(dest.stream.getAudioTracks()[0]);
    } else if (tracks.length) stream.addTrack(tracks[0]);
    if (kind === 'android' && audio !== 'None' && audio !== 'Microphone') toast('Phone sound is not sent over adb; recording without it.');

    const wantMp4 = (settings.videoFormat || 'MP4') === 'MP4';
    const types = wantMp4
      ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: QUALITY_BITS[settings.videoQuality] || QUALITY_BITS.Standard,
      audioBitsPerSecond: 128000 // WXMedia.dll 0x101916e0 default audio bit rate
    });
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      clearInterval(recTimer);
      recExtra.forEach((t) => t.stop()); recExtra = [];
      $('#recBadge').hidden = true;
      btn('recording').classList.remove('on');
      const ext = (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm';
      recorder = null;
      const blob = new Blob(recChunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
      const r = await api.saveVideo(new Uint8Array(await blob.arrayBuffer()), ext, document.title);
      toast('Recording saved', 'ok', { label: 'Show', fn: () => api.showItem(r.path) });
    };
    recorder.start(1000);
    recStart = Date.now();
    $('#recBadge').hidden = false;
    $('#recTime').textContent = '00:00';
    btn('recording').classList.add('on');
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('#recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  }

  function rotate() {
    rotation = (rotation + 1) % 4;
    layout(); fitWindow(); dirty = true;
    wb.draw();
  }

  async function toggleFullscreen() {
    const on = await api.fullscreen();
    document.body.classList.toggle('fs', on);
    btn('fullscreen').classList.toggle('on', on);
    setTimeout(() => { layout(); dirty = true; }, 120);
  }

  async function toggleTopmost() {
    const on = await api.topmost();
    btn('topmost').classList.toggle('on', on);
    toast(on ? 'Kept on top' : 'No longer on top');
  }

  function toggleSimple() {
    const tb = $('#toolbar');
    tb.hidden = !tb.hidden;
    $('#showToolbar').hidden = !tb.hidden;
    setTimeout(() => { layout(); fitWindow(); }, 50);
  }
  $('#showToolbar').onclick = toggleSimple;

  function toggleKeyboard() {
    const bar = $('#typeBar');
    bar.hidden = !bar.hidden;
    btn('keyboard').classList.toggle('on', !bar.hidden);
    if (!bar.hidden) $('#typeInput').focus();
  }
  function sendTyped() {
    const t = $('#typeInput').value;
    if (t) sendText(t);
    $('#typeInput').value = '';
  }
  $('#typeSend').onclick = sendTyped;
  $('#typeInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    const hk = settings.hotkeys || {};
    if (Hotkeys.matches(e, hk.newLine || 'Ctrl+Enter')) {
      e.preventDefault();
      const ta = e.target, p = ta.selectionStart;
      ta.value = ta.value.slice(0, p) + '\n' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = p + 1;
      return;
    }
    if (Hotkeys.matches(e, hk.send || 'Enter')) { e.preventDefault(); sendTyped(); }
    if (e.key === 'Escape') toggleKeyboard();
  });

  // Files: drop on the window, or the files panel.
  async function sendFiles(paths) {
    if (!paths.length) return;
    if (kind === 'demo') return toast('Connect a real phone to send files.', 'bad');
    toast(`Sending ${paths.length} file(s)…`);
    const res = await api.pushFiles(paths);
    const ok = res.filter((r) => r.ok).length;
    if (ok) toast(kind === 'web' ? `${ok} file(s) offered on the share page` : `${ok} file(s) saved in the phone's Download folder`, 'ok');
    res.filter((r) => !r.ok).forEach((r) => toast(`${r.file}: ${r.error}`, 'bad'));
    if (!$('#filesPop').hidden) loadPhoneFiles();
  }
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    sendFiles([...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean));
  });
  async function loadPhoneFiles() {
    const list = $('#fpList');
    if (kind !== 'android') { list.innerHTML = `<div class="fp-empty">${kind === 'web' ? 'Files you send appear on the share page for the other device to download. Files it sends land in the Received folder.' : 'Connect a real phone to see its files.'}</div>`; return; }
    list.innerHTML = '<div class="fp-empty">Loading…</div>';
    const names = await api.phoneFiles();
    list.innerHTML = names.length ? names.map((n) => `<div class="fp-item"><span title="${n}">${n}</span><button data-pull="${encodeURIComponent(n)}">Copy to PC</button></div>`).join('')
      : '<div class="fp-empty">The Download folder is empty.</div>';
  }
  $('#fpList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pull]');
    if (!b) return;
    b.textContent = 'Copying…';
    const r = await api.pullFile(decodeURIComponent(b.dataset.pull));
    b.textContent = r.ok ? 'Copied' : 'Failed';
    if (r.ok) toast('Copied to the computer', 'ok', { label: 'Show', fn: () => api.showItem(r.path) });
  });
  $('#fpSend').onclick = async () => sendFiles(await api.pickFiles());
  $('#fpClose').onclick = () => { $('#filesPop').hidden = true; btn('files').classList.remove('on'); };
  function toggleFiles() {
    const p = $('#filesPop');
    p.hidden = !p.hidden;
    btn('files').classList.toggle('on', !p.hidden);
    if (!p.hidden) loadPhoneFiles();
  }

  let screenIsOff = false;
  const ACTIONS = {
    fullscreen: toggleFullscreen,
    screenshot,
    recording: toggleRecording,
    whiteboard: () => setWhiteboard(!wb.active),
    keyboard: toggleKeyboard,
    rotate,
    topmost: toggleTopmost,
    files: toggleFiles,
    folder: () => api.openFolder(''),
    simpleMode: toggleSimple,
    boss: () => api.boss(),
    volumeUp: () => sendKey('volumeUp'),
    volumeDown: () => sendKey('volumeDown'),
    // Phone display off/on while mirroring continues (SendScreenEvent 0x10021070 → 2-byte message).
    screenOff: () => {
      screenIsOff = !screenIsOff;
      if (kind === 'demo') demo.key('power');
      else if (kind === 'android') api.displayPower(!screenIsOff);
      btn('screenOff').classList.toggle('on', screenIsOff);
      toast(screenIsOff ? 'Phone screen off, still mirroring' : 'Phone screen on');
    },
    back: () => sendKey('back'),
    home: () => sendKey('home'),
    tasks: () => sendKey('tasks'),
    pauseOrPlay: () => {
      if (kind === 'web') { video.paused ? video.play() : video.pause(); }
      else sendKey('playPause');
    }
  };
  function btn(act) { return document.querySelector(`.toolbar [data-act="${act}"]`) || document.createElement('i'); }
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act]();
  });
  btn('recording').classList.add('rec');

  function refreshTooltips() {
    const hk = settings.hotkeys || {};
    document.querySelectorAll('.toolbar [data-act]').forEach((b) => {
      const base = b.title.replace(/ \(.*\)$/, '');
      const key = hk[b.dataset.act];
      b.title = key ? `${base} (${key === 'RButton' ? 'right click' : key})` : base;
    });
  }

  // Hotkeys first, then typing goes to the phone.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('textarea, input')) return;
    const hk = settings.hotkeys || {};
    if (settings.hotkeysEnabled !== false) {
      for (const [name, combo] of Object.entries(hk)) {
        if (['send', 'newLine', 'back'].includes(name)) continue;
        if (Hotkeys.matches(e, combo) && ACTIONS[name]) { e.preventDefault(); ACTIONS[name](); return; }
      }
    }
    if (e.key === 'Escape' && document.body.classList.contains('fs')) { toggleFullscreen(); return; }
    if (wb.active) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') wb.redo();
      return;
    }
    if (!canControl || e.ctrlKey || e.altKey || e.metaKey) return;
    if (KEYMAP[e.key]) {
      e.preventDefault();
      if (textBuf) { sendText(textBuf); textBuf = ''; }
      sendKey(KEYMAP[e.key]);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      textBuf += e.key;
      clearTimeout(textTimer);
      textTimer = setTimeout(() => { sendText(textBuf); textBuf = ''; }, 120);
    }
  });

  // Full screen: show the toolbar when the mouse reaches the right edge.
  window.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('fs')) return;
    document.body.classList.toggle('toolbar-peek', e.clientX > window.innerWidth - 70);
  });

  api.onSettings((s) => { settings = s; refreshTooltips(); });

  // ---------- start ----------
  (async () => {
    settings = await api.getSettings();
    refreshTooltips();
    if (settings.topmost) btn('topmost').classList.add('on');
    updateWbButtons();
    requestAnimationFrame(loop);
    if (kind === 'android') startAndroid();
    else if (kind === 'web') startWeb();
    else if (kind === 'selftest') startSelftest();
    else if (kind === 'ios') startIos();
    else startDemo();
    $('#stage').focus();
    if (q.get('sample') === 'wb') {
      // Developer check: show the whiteboard with a few marks.
      setWhiteboard(true);
      wb.add({ tool: 'ellipse', color: '#FF0000', width: 4, alpha: 1, pts: [{ x: 0.06, y: 0.42 }, { x: 0.3, y: 0.56 }] });
      wb.add({ tool: 'arrow', color: '#FF0000', width: 4, alpha: 1, pts: [{ x: 0.55, y: 0.3 }, { x: 0.3, y: 0.44 }] });
      wb.add({ tool: 'highlighter', color: '#FFFF00', width: 20, alpha: 0.4, pts: [{ x: 0.1, y: 0.73 }, { x: 0.5, y: 0.73 }, { x: 0.9, y: 0.73 }] });
      wb.add({ tool: 'text', color: '#28D728', size: 0.045, pts: [{ x: 0.5, y: 0.22 }], text: 'Tap here' });
      wb.draw();
    }
  })();
})();
