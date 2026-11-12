// The page another device opens to share its screen (WebRTC) and swap files with the computer.
(function () {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const QUALITY = { '720P': 720, '1080P': 1080, '2K': 1440 };
  let ws = null, pc = null, stream = null;

  $('#code').value = (params.get('code') || localStorage.getItem('mirror-code') || '').toUpperCase();
  $('#name').value = localStorage.getItem('mirror-name') || guessName();

  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    const m = ua.match(/Android [\d.]+; ([^;)]+)/);
    if (m) return m[1].trim();
    if (/Windows/.test(ua)) return 'Windows computer';
    if (/Mac OS X/.test(ua)) return 'Mac';
    return 'Browser';
  }
  function status(text, kind) { const s = $('#status'); s.textContent = text; s.className = 'status ' + (kind || ''); }
  const code = () => $('#code').value.trim().toUpperCase();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    $('#shareScreen').disabled = true;
    $('#hint').textContent = 'This browser cannot share its screen (most phone browsers cannot). Share the camera instead, or use a computer browser. Android phones can be mirrored with full control over USB or Wi-Fi debugging from the computer app.';
  }

  async function start(useCamera) {
    if (!code()) { status('Type the screen code first.', 'bad'); return; }
    localStorage.setItem('mirror-code', code());
    localStorage.setItem('mirror-name', $('#name').value.trim());
    try {
      stream = useCamera
        ? await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: true })
        : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch (e) {
      status('Sharing was not allowed.', 'bad');
      return;
    }
    stream.getVideoTracks()[0].addEventListener('ended', stop);
    status('Connecting…');
    ws = new WebSocket(`wss://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', code: code(), name: $('#name').value.trim() || guessName(), kind: useCamera ? 'camera' : 'screen' }));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'denied') { status(msg.reason || 'Wrong screen code', 'bad'); stopTracks(); ws.close(); return; }
      if (msg.type === 'welcome') {
        pc = new RTCPeerConnection({ iceServers: [] });
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate.toJSON() })); };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') status('Sharing to the computer', 'ok');
          if (pc.connectionState === 'failed') status('Could not reach the computer. Are both on the same Wi-Fi?', 'bad');
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.toJSON() }));
        refreshFiles();
      }
      if (msg.type === 'answer' && pc) {
        await pc.setRemoteDescription(msg.sdp);
        applyQuality(msg.quality);
      }
      if (msg.type === 'ice' && pc) { try { await pc.addIceCandidate(msg.candidate); } catch (_) { /* ignore */ } }
      if (msg.type === 'stop') { stop(); status('The computer closed the window.', 'bad'); }
      if (msg.type === 'files-changed') refreshFiles();
    };
    ws.onclose = () => { if (stream) status('Disconnected from the computer.', 'bad'); };
    $('#shareScreen').hidden = true; $('#shareCamera').hidden = true; $('#stop').hidden = false;
  }

  async function applyQuality(q) {
    const max = QUALITY[q] || 1080;
    const track = stream && stream.getVideoTracks()[0];
    if (!track) return;
    const set = track.getSettings();
    if (set.height && set.width) {
      const shortSide = Math.min(set.width, set.height);
      if (shortSide > max) {
        const k = max / shortSide;
        try { await track.applyConstraints({ width: Math.round(set.width * k), height: Math.round(set.height * k), frameRate: 30 }); } catch (_) { /* keep */ }
      }
    }
    const sender = pc.getSenders().find((s) => s.track === track);
    if (sender) {
      const p = sender.getParameters();
      p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = max >= 1440 ? 12e6 : max >= 1080 ? 7.6e6 : 4e6;
      try { await sender.setParameters(p); } catch (_) { /* keep */ }
    }
  }

  function stopTracks() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
  function stop() {
    stopTracks();
    try { pc && pc.close(); } catch (_) { /* ignore */ }
    try { ws && ws.close(); } catch (_) { /* ignore */ }
    pc = null; ws = null;
    $('#shareScreen').hidden = false; $('#shareCamera').hidden = false; $('#stop').hidden = true;
    status('Stopped.');
  }

  $('#shareScreen').onclick = () => start(false);
  $('#shareCamera').onclick = () => start(true);
  $('#stop').onclick = stop;

  // files
  $('#files').addEventListener('change', async () => {
    if (!code()) { status('Type the screen code first.', 'bad'); return; }
    for (const f of $('#files').files) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<span></span><b>Sending…</b>`;
      row.firstChild.textContent = f.name;
      $('#uploads').prepend(row);
      try {
        const r = await fetch(`/upload?code=${encodeURIComponent(code())}&name=${encodeURIComponent(f.name)}&from=${encodeURIComponent($('#name').value.trim() || guessName())}`, { method: 'POST', body: f });
        row.lastChild.textContent = r.ok ? 'Sent' : (await r.text());
      } catch (_) { row.lastChild.textContent = 'Failed'; }
    }
    $('#files').value = '';
  });

  async function refreshFiles() {
    if (!code()) return;
    try {
      const r = await fetch(`/files?code=${encodeURIComponent(code())}`);
      if (!r.ok) { $('#incoming').innerHTML = '<p class="muted small">Wrong screen code.</p>'; return; }
      const list = await r.json();
      $('#incoming').innerHTML = list.length ? '' : '<p class="muted small">Nothing shared from the computer yet.</p>';
      for (const f of list) {
        const row = document.createElement('div');
        row.className = 'item';
        const name = document.createElement('span'); name.textContent = f.name;
        const a = document.createElement('a');
        a.href = `/download/${f.id}?code=${encodeURIComponent(code())}`; a.textContent = 'Download'; a.download = f.name;
        row.append(name, a);
        $('#incoming').appendChild(row);
      }
    } catch (_) { /* offline */ }
  }
  $('#refresh').onclick = refreshFiles;
  $('#code').addEventListener('change', refreshFiles);
  if (code()) refreshFiles();
})();
