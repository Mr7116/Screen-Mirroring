/* Main window: connect phones by USB / Wi-Fi, browser senders, files and settings. */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const api = window.api;
  let settings = {};
  let info = {};
  let devices = [];
  let openMirrors = [];
  const received = [];

  // ---------- helpers ----------
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
  function modal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
  $('#modalOk').onclick = () => { $('#modal').hidden = true; };
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function applyTheme() { document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light'; }

  // ---------- title bar ----------
  $('#btnMin').onclick = () => api.minimize();
  $('#btnClose').onclick = () => api.close();
  $('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
  document.addEventListener('click', () => { $('#menu').hidden = true; });
  $('#menu').onclick = (e) => {
    const act = e.target.dataset.act;
    if (act === 'output') api.openFolder('');
    if (act === 'demo') openDemo();
    if (act === 'help') modal('<b>Three ways to connect</b><br>1. <b>USB</b>: plug in an Android phone with USB debugging on.<br>2. <b>Android over Wi-Fi</b>: after USB once, press “Use Wi-Fi”, or pair with a code on Android 11+.<br>3. <b>Any browser</b>: open the address on the Wi-Fi tab, type the screen code and share the screen.');
    if (act === 'about') modal(`<b>MirrorDesk ${esc(info.version || '')}</b><br>Mirror and control Android phones, receive screens from browsers, record, take screenshots, draw on the screen and send files.`);
  };

  // ---------- tabs ----------
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'files') refreshShared();
  }));

  // ---------- adb ----------
  function showAdb(path) {
    $('#adbDot').className = 'dot ' + (path ? 'ok' : 'bad');
    $('#adbTitle').textContent = path ? 'Android tools ready' : 'Android tools (adb) not found';
    $('#adbPath').textContent = path || 'Needed for USB and Wi-Fi control. Download them once (about 7 MB) or point to adb.';
    $('#adbActions').hidden = !!path;
    $('#adbCard').classList.toggle('missing', !path);
  }
  $('#btnAdbDownload').onclick = async () => {
    $('#btnAdbDownload').disabled = true;
    $('#adbProgress').hidden = false;
    const r = await api.downloadAdb();
    $('#adbProgress').hidden = true;
    $('#btnAdbDownload').disabled = false;
    if (r.ok) { toast('Android tools installed', 'ok'); showAdb(r.path); pollDevices(); }
    else toast('Download failed: ' + r.error, 'bad');
  };
  api.onAdbProgress((p) => { $('#adbProgress span').style.width = p + '%'; });
  const browse = async () => { const p = await api.browseAdb(); if (p) { showAdb(p); settings.adbPath = p; fillSettings(); pollDevices(); } };
  $('#btnAdbBrowse').onclick = browse;
  $('#btnAdbBrowse2').onclick = browse;

  // ---------- devices ----------
  const phoneIcon = '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>';
  function renderDevices() {
    const list = $('#deviceList');
    if (!devices.length) {
      list.innerHTML = `<div class="empty">${phoneIcon}<div>No phone found yet</div><div class="muted small">Connect a phone and tap “Allow” on its screen.</div></div>`;
      return;
    }
    list.innerHTML = devices.map((d) => {
      const mirroring = openMirrors.some((m) => m.serial === d.serial);
      const state = d.state === 'device' ? (mirroring ? '<span class="badge usb">Mirroring</span>' : '')
        : d.state === 'unauthorized' ? '<span class="badge warn">Tap “Allow” on the phone</span>'
          : `<span class="badge warn">${esc(d.state)}</span>`;
      const ready = d.state === 'device';
      return `<div class="device">
        <div class="ico">${phoneIcon}</div>
        <div class="grow"><div class="title">${esc(d.model)}</div>
          <div class="small"><span class="badge ${d.transport}">${d.transport === 'usb' ? 'USB' : 'Wi-Fi'}</span>${state}</div></div>
        <div class="acts">
          <button class="btn primary sm" data-mirror="${esc(d.serial)}" ${ready ? '' : 'disabled'}>${mirroring ? 'Show' : 'Mirror'}</button>
          ${d.transport === 'usb' && ready ? `<button class="link" data-wifi="${esc(d.serial)}">Use Wi-Fi</button>` : ''}
          ${d.transport === 'wifi' ? `<button class="link" data-disc="${esc(d.serial)}">Disconnect</button>` : ''}
        </div></div>`;
    }).join('');
  }
  $('#deviceList').addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mirror]');
    if (m) {
      const d = devices.find((x) => x.serial === m.dataset.mirror);
      api.openMirror({ kind: 'android', serial: d.serial, title: d.model });
      return;
    }
    const w = e.target.closest('[data-wifi]');
    if (w) {
      toast('Switching to Wi-Fi…');
      const r = await api.toWifi(w.dataset.wifi);
      toast(r.ok ? 'Connected over Wi-Fi. You can unplug the cable.' : (r.message || 'Could not switch'), r.ok ? 'ok' : 'bad');
      pollDevices();
      return;
    }
    const dc = e.target.closest('[data-disc]');
    if (dc) { await api.disconnect(dc.dataset.disc); pollDevices(); }
  });
  let polling = false;
  async function pollDevices() {
    if (polling) return;
    polling = true;
    try {
      const path = await api.locateAdb();
      showAdb(path);
      if (path) {
        const r = await api.devices();
        devices = r.devices || [];
        renderDevices();
      }
    } finally { polling = false; }
  }
  $('#btnRefresh').onclick = pollDevices;
  api.onMirrorList((list) => { openMirrors = list; renderDevices(); });

  // ---------- Wi-Fi ----------
  async function loadInfo() {
    info = await api.info();
    $('#screenCode').textContent = info.code || '----';
    $('#pcName').textContent = `${info.computer || ''} · ${info.address || ''}`;
    $('#shareUrl').textContent = info.url || (info.screenshotMode ? 'https://' + (info.address || '') + ':15486/' : 'Starting…');
    if (info.qr) { $('#qr').src = info.qr; $('#qr').parentElement.classList.add('ready'); }
    else $('#qrEmpty').textContent = info.screenshotMode ? 'QR code' : 'Not available';
    showAdb(info.adb);
    fillIphone();
  }
  function fillIphone() {
    $('#iosCode').textContent = info.code || '----';
    $('#iosAddr').textContent = info.iosPort ? `This computer: ${info.address} · port ${info.iosPort}` : '';
    $('#iosUrl').textContent = info.url || 'https://' + (info.address || '') + ':15486/';
  }
  api.onIos((list) => {
    $('#iosList').innerHTML = list.length ? list.map((s) => `<div class="device"><div class="ico">${phoneIcon}</div>
      <div class="grow"><div class="title">${esc(s.name)}</div><div class="small"><span class="badge wifi">iPhone app</span></div></div>
      <button class="btn primary sm" data-ios="${esc(s.id)}">Show</button></div>`).join('')
      : '<div class="empty small muted">No iPhone is sharing yet.</div>';
  });
  $('#iosList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ios]');
    if (b) api.openMirror({ kind: 'ios', senderId: b.dataset.ios, title: b.closest('.device').querySelector('.title').textContent });
  });
  $('#shareUrl').addEventListener('dblclick', () => info.url && navigator.clipboard.writeText(info.url).then(() => toast('Address copied')));
  function setWifiStatus(text, ok) { const el = $('#wifiStatus'); el.textContent = text; el.className = 'small status ' + (ok ? 'ok' : 'bad'); }
  $('#btnWifiConnect').onclick = async () => {
    const host = $('#wifiHost').value.trim();
    if (!host) return setWifiStatus('Type the phone address or its screen code.', false);
    setWifiStatus('Connecting…', true);
    const r = await api.connect(host);
    setWifiStatus(r.message || (r.ok ? 'Connected' : 'Could not connect'), r.ok);
    pollDevices();
  };
  $('#btnPair').onclick = async () => {
    const host = $('#pairHost').value.trim(), code = $('#pairCode').value.trim();
    if (!host || !code) return setWifiStatus('Type the address and code shown on the phone.', false);
    setWifiStatus('Pairing…', true);
    const r = await api.pair(host, code);
    setWifiStatus(r.ok ? 'Paired. Now type the address shown under “Wireless debugging” and press Connect.' : (r.message || 'Pairing failed'), r.ok);
  };
  api.onSenders((list) => {
    const el = $('#senderList');
    el.innerHTML = list.length ? list.map((s) => `<div class="device"><div class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></div>
      <div class="grow"><div class="title">${esc(s.name)}</div><div class="small"><span class="badge wifi">Browser</span></div></div>
      <button class="btn primary sm" data-sender="${esc(s.id)}">Show</button></div>`).join('')
      : '<div class="empty small muted">Nobody is sharing to this computer.</div>';
  });
  $('#senderList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sender]');
    if (b) api.openMirror({ kind: 'web', senderId: b.dataset.sender, title: b.closest('.device').querySelector('.title').textContent });
  });

  // ---------- files ----------
  async function refreshShared(list) {
    list = list || await api.sharedList();
    $('#sharedList').innerHTML = list.map((f) => `<div class="file"><span class="n">${esc(f.name)}</span><span class="muted small">${size(f.size)}</span><button class="link" data-unshare="${f.id}">Remove</button></div>`).join('');
  }
  $('#btnShareAdd').onclick = async () => refreshShared(await api.shareAdd());
  $('#sharedList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unshare]');
    if (b) refreshShared(await api.shareRemove(b.dataset.unshare));
  });
  api.onFileReceived((f) => {
    received.unshift(f);
    $('#receivedList').innerHTML = received.slice(0, 20).map((x, i) => `<div class="file"><span class="n">${esc(x.name)}</span><span class="muted small">${esc(x.from)}</span><button class="link" data-show="${i}">Show</button></div>`).join('');
  });
  $('#receivedList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) api.showItem(received[+b.dataset.show].file);
  });
  $('#btnOpenReceived').onclick = () => api.openFolder('Received');

  // ---------- footer ----------
  function openDemo() { api.openMirror({ kind: 'demo', title: 'Demo phone' }); }
  $('#btnDemo').onclick = openDemo;
  $('#btnOutput').onclick = () => api.openFolder('');

  // ---------- settings ----------
  $('#btnSettings').onclick = () => { $('#settingsSheet').hidden = false; };
  $('#btnSettingsBack').onclick = () => { $('#settingsSheet').hidden = true; };
  $$('.chip').forEach((c) => c.addEventListener('click', () => {
    $$('.chip').forEach((x) => x.classList.toggle('active', x === c));
    $$('.sec').forEach((s) => s.classList.toggle('active', s.dataset.sec === c.dataset.sec));
  }));
  function fillSettings() {
    $$('[data-key]').forEach((el) => {
      const v = settings[el.dataset.key];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
    });
    renderHotkeys();
  }
  $$('[data-key]').forEach((el) => el.addEventListener('change', async () => {
    const key = el.dataset.key;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.hasAttribute('data-num')) v = Number(v);
    settings = await api.setSettings({ [key]: v });
    if (key === 'theme') applyTheme();
    if (key === 'adbPath') pollDevices();
  }));
  $('#btnPickFolder').onclick = async () => { const d = await api.pickFolder(); if (d) { settings.outputDir = d; fillSettings(); } };

  let listening = null;
  function renderHotkeys() {
    const hk = settings.hotkeys || {};
    $('#hotkeyList').innerHTML = Object.keys(Hotkeys.LABELS).map((k) =>
      `<div class="hk"><span>${Hotkeys.LABELS[k]}</span><input readonly data-hk="${k}" value="${esc(hk[k] === 'RButton' ? 'Right mouse button' : (hk[k] || 'None'))}"></div>`).join('');
  }
  $('#hotkeyList').addEventListener('click', (e) => {
    const inp = e.target.closest('[data-hk]');
    if (!inp) return;
    if (listening) listening.classList.remove('listening');
    listening = inp;
    inp.classList.add('listening');
    inp.value = 'Press keys…';
  });
  document.addEventListener('keydown', async (e) => {
    if (!listening) return;
    e.preventDefault();
    if (e.key === 'Escape') { listening.classList.remove('listening'); listening = null; renderHotkeys(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      settings = await api.setSettings({ hotkeys: { ...settings.hotkeys, [listening.dataset.hk]: '' } });
      listening = null; renderHotkeys(); return;
    }
    const combo = Hotkeys.fromEvent(e);
    if (!combo) return;
    const clash = Object.entries(settings.hotkeys).find(([k, v]) => k !== listening.dataset.hk && Hotkeys.normalize(v) === combo);
    if (clash) { toast(`${combo} is already used for “${Hotkeys.LABELS[clash[0]]}”`, 'bad'); return; }
    settings = await api.setSettings({ hotkeys: { ...settings.hotkeys, [listening.dataset.hk]: combo } });
    listening = null;
    renderHotkeys();
  });
  $('#btnResetHotkeys').onclick = async () => { settings = await api.resetHotkeys(); renderHotkeys(); toast('Hotkeys reset'); };
  api.onSettings((s) => { settings = s; applyTheme(); });

  api.onToast((t) => toast(t.text, t.kind));

  // ---------- start ----------
  (async () => {
    settings = await api.getSettings();
    applyTheme();
    fillSettings();
    await loadInfo();
    const startTab = new URLSearchParams(location.search).get('tab');
    if (startTab) document.querySelector(`.tab[data-tab="${startTab}"]`)?.click();
    pollDevices();
    setInterval(pollDevices, 2000);
    if (!info.url && !info.screenshotMode) setTimeout(loadInfo, 1500);
  })();
})();
