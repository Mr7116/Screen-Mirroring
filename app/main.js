'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Settings } = require('./src/settings');
const { Adb, downloadPlatformTools } = require('./src/adb');
const { LanServer, lanAddresses, codeToIp } = require('./src/lan');
const { HelperSession } = require('./src/helper');
const { IosServer } = require('./src/ios');

// ---- --screenshot <file.png> -------------------------------------------------------------
const argv = process.argv.slice(1);
const shotIdx = argv.indexOf('--screenshot');
const screenshotPath = shotIdx >= 0 ? path.resolve(argv[shotIdx + 1] || 'screenshot.png') : null;
const shotMirrorArg = argv.find((a) => a.startsWith('--shot-mirror='));
const shotMirror = shotMirrorArg ? shotMirrorArg.split('=')[1] : null; // demo | selftest

if (screenshotPath) {
  // Let a covered or unfocused window keep drawing.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

let settings, adb, lan, ios;
const iosSenders = new Map(); // id -> { name, width, height }
let mainWin = null;
const mirrors = new Map(); // webContents.id -> { win, kind, serial, senderId, stream, title }
const senders = new Map(); // senderId -> { name, winId }

const ROOT = __dirname;
const preload = path.join(ROOT, 'preload.js');

function toast(text, kind = 'info') {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app:toast', { text, kind });
}

function createMainWindow() {
  const s = settings.get();
  mainWin = new BrowserWindow({
    width: 408,
    height: 776,
    minWidth: 380,
    minHeight: 640,
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: s.theme === 'dark' ? '#1d2129' : '#ffffff',
    title: 'MirrorDesk',
    alwaysOnTop: !screenshotPath && s.topmost,
    focusable: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const tabArg = argv.find((a) => a.startsWith('--shot-tab='));
  mainWin.loadFile(path.join(ROOT, 'renderer', 'index.html'), { query: { tab: tabArg ? tabArg.split('=')[1] : '' } });

  if (screenshotPath && shotMirror) {
    // Developer check: picture of a mirror window (demo, or the H.264 self-test) instead.
    mainWin.once('ready-to-show', () => mainWin.showInactive());
    openMirror({ kind: shotMirror === 'demo-wb' ? 'demo' : shotMirror, sample: shotMirror === 'demo-wb' ? 'wb' : '', title: shotMirror === 'selftest' ? 'Decoder self-test' : 'Demo phone' });
    const m = [...mirrors.values()].pop();
    m.win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await m.win.webContents.capturePage();
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, img.toPNG());
        app.exit(0);
      }, 4000);
    });
  } else if (screenshotPath) {
    mainWin.once('ready-to-show', () => {
      mainWin.showInactive();
      if (process.platform === 'win32') {
        // Stay behind the window the person is using; a covered window still draws on Windows.
        mainWin.setAlwaysOnTop(false);
        try { mainWin.setFocusable(false); } catch (_) { /* ignore */ }
      }
    });
    mainWin.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWin.webContents.capturePage();
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          fs.writeFileSync(screenshotPath, img.toPNG());
        } catch (e) {
          console.error('screenshot failed', e);
        }
        app.exit(0);
      }, 2200);
    });
  } else {
    mainWin.once('ready-to-show', () => mainWin.show());
  }

  mainWin.on('closed', () => {
    mainWin = null;
    if (!screenshotPath) app.quit();
  });
}

// ---- mirror windows ----------------------------------------------------------------------
function openMirror(opts) {
  // Reuse a window that already shows this phone or sender.
  for (const m of mirrors.values()) {
    if ((opts.serial && m.serial === opts.serial) || (opts.senderId && m.senderId === opts.senderId)) {
      if (!m.win.isDestroyed()) { m.win.show(); m.win.focus(); return; }
    }
  }
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.min(860, workArea.height - 40);
  const win = new BrowserWindow({
    width: Math.round(h * 0.5) + 64,
    height: h,
    minWidth: 300,
    minHeight: 360,
    title: opts.title || 'Mirror',
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    alwaysOnTop: settings.get('topmost'),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  win.setMenuBarVisibility(false);
  const q = { kind: opts.kind, serial: opts.serial || '', sender: opts.senderId || '', title: opts.title || '', sample: opts.sample || '' };
  win.loadFile(path.join(ROOT, 'renderer', 'mirror.html'), { query: q });
  const id = win.webContents.id;
  mirrors.set(id, { win, kind: opts.kind, serial: opts.serial, senderId: opts.senderId, stream: null, title: opts.title });
  if (opts.senderId && senders.has(opts.senderId)) senders.get(opts.senderId).winId = id;
  win.on('closed', () => {
    const m = mirrors.get(id);
    if (m && m.stream) m.stream.stop();
    if (m && m.senderId) lan.toSender(m.senderId, { type: 'stop' });
    if (m && m.kind === 'ios') ios.disconnect(m.senderId);
    mirrors.delete(id);
    sendMirrorList();
  });
  if (settings.get('autoFullscreen')) win.once('ready-to-show', () => win.setFullScreen(true));
  sendMirrorList();
}

function sendMirrorList() {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('mirror:list', [...mirrors.values()].map((m) => ({ kind: m.kind, serial: m.serial, senderId: m.senderId, title: m.title })));
}

function mirrorOf(event) { return mirrors.get(event.sender.id); }

// ---- IPC ---------------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', async () => {
    const addrs = lanAddresses();
    const url = lan.url;
    let qr = '';
    try { if (url) qr = await QRCode.toDataURL(`${url}?code=${lan.code}`, { margin: 1, width: 220, color: { dark: '#1f2d3d', light: '#ffffff' } }); } catch (_) { /* ignore */ }
    return {
      version: app.getVersion(),
      computer: require('os').hostname(),
      address: lan.address,
      addresses: addrs,
      code: lan.code,
      port: lan.port,
      iosPort: ios ? ios.port : 0,
      url,
      qr,
      adb: adb.locate(),
      outputDir: settings.get('outputDir'),
      screenshotMode: !!screenshotPath
    };
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = settings.set(patch || {});
    if ('topmost' in (patch || {})) {
      for (const m of mirrors.values()) if (!m.win.isDestroyed()) m.win.setAlwaysOnTop(!!s.topmost);
      if (mainWin) mainWin.setAlwaysOnTop(!!s.topmost);
    }
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s);
    return s;
  });
  ipcMain.handle('settings:resetHotkeys', () => {
    const s = settings.resetHotkeys();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s);
    return s;
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get('outputDir') });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set({ outputDir: r.filePaths[0] });
    return r.filePaths[0];
  });

  // window buttons
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('win:fullscreen', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(on == null ? !w.isFullScreen() : !!on);
    return w.isFullScreen();
  });
  ipcMain.handle('win:topmost', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    const v = on == null ? !w.isAlwaysOnTop() : !!on;
    w.setAlwaysOnTop(v);
    return v;
  });
  ipcMain.on('win:boss', () => {
    // Hide every window; the same key (or the tray of the OS) brings them back.
    const all = BrowserWindow.getAllWindows();
    const anyVisible = all.some((w) => w.isVisible());
    for (const w of all) anyVisible ? w.hide() : w.show();
    if (anyVisible) {
      // Bring them back with the same key from anywhere.
      const { globalShortcut } = require('electron');
      const accel = toAccelerator(settings.get('hotkeys').boss || 'Alt+A');
      try {
        globalShortcut.register(accel, () => {
          globalShortcut.unregister(accel);
          for (const w of BrowserWindow.getAllWindows()) w.show();
        });
      } catch (_) { /* key taken */ }
    }
  });
  ipcMain.on('win:aspect', (e, { width, height, chrome }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isFullScreen() || !width || !height) return;
    const { workArea } = screen.getDisplayMatching(w.getBounds());
    const maxH = workArea.height - 60, maxW = workArea.width - 60;
    let ch = Math.min(maxH, Math.max(420, Math.round(w.getBounds().height)));
    let cw = Math.round((ch - (chrome?.h || 0)) * (width / height)) + (chrome?.w || 0);
    if (cw > maxW) { cw = maxW; ch = Math.round((cw - (chrome?.w || 0)) * (height / width)) + (chrome?.h || 0); }
    w.setContentSize(Math.max(300, cw), Math.max(360, ch));
  });

  // adb
  ipcMain.handle('adb:devices', () => adb.devices());
  ipcMain.handle('adb:locate', () => adb.locate());
  ipcMain.handle('adb:browse', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Find adb', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'adb', extensions: ['exe'] }] : []
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set({ adbPath: r.filePaths[0] });
    return adb.locate();
  });
  ipcMain.handle('adb:download', async () => {
    try {
      const bin = await downloadPlatformTools(path.join(app.getPath('userData'), 'tools'), (p) => mainWin?.webContents.send('adb:progress', p));
      adb.locate();
      return { ok: true, path: bin };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('adb:connect', (_e, host) => {
    const h = String(host || '').trim();
    const ip = /^[0-9a-f]{4}$|^[0-9a-f]{8}$/i.test(h) ? codeToIp(h) : h;
    return adb.connect(ip);
  });
  ipcMain.handle('adb:pair', (_e, { host, code }) => adb.pair(host, code));
  ipcMain.handle('adb:toWifi', (_e, serial) => adb.toWifi(serial));
  ipcMain.handle('adb:disconnect', (_e, serial) => adb.disconnect(serial));

  // mirror windows
  ipcMain.on('mirror:open', (_e, opts) => openMirror(opts || {}));
  ipcMain.handle('mirror:startAndroid', async (e) => {
    const m = mirrorOf(e);
    if (!m || !m.serial) return { ok: false, error: 'No phone' };
    const screenInfo = await adb.screenSize(m.serial);
    const info = await adb.info(m.serial);
    const s = settings.get();
    if (m.stream) m.stream.stop();
    const send = (ch, data) => { if (!m.win.isDestroyed()) m.win.webContents.send(ch, data); };

    // 1) Live helper on the phone, like the original (see MECHANICS.md).
    if (s.controlMode !== 'basic') {
      const session = new HelperSession(adb, path.join(app.getPath('userData'), 'tools'), m.serial);
      try {
        send('mirror:event', { type: 'helper-starting' });
        await session.start({ maxSize: s.displaySize, bitRate: s.bitRate, maxFps: s.frameRate },
          (pkt) => send('mirror:packet', pkt),
          (ev) => send('mirror:event', ev));
        m.stream = { stop: () => session.stop() };
        m.session = session;
        return { ok: true, mode: 'helper', screen: { width: session.width, height: session.height }, info };
      } catch (err) {
        await session.stop();
        send('mirror:event', { type: 'fallback', message: err.message });
      }
    }

    // 2) Fallback: the phone's own screenrecord and `input` commands.
    m.session = null;
    const size = Adb.streamSize(screenInfo, s.displaySize);
    m.stream = adb.startStream(m.serial, { ...size, bitRate: s.bitRate },
      (chunk) => { if (!m.win.isDestroyed()) m.win.webContents.send('mirror:data', chunk); },
      (ev) => { if (!m.win.isDestroyed()) m.win.webContents.send('mirror:event', ev); });
    return { ok: true, mode: 'basic', screen: screenInfo, stream: size, info };
  });
  ipcMain.on('mirror:stopAndroid', (e) => { const m = mirrorOf(e); if (m && m.stream) { m.stream.stop(); m.stream = null; } });

  // reverse control (Android)
  ipcMain.on('ctl:tap', (e, { x, y }) => { const m = mirrorOf(e); if (m?.serial) adb.tap(m.serial, x, y); });
  ipcMain.on('ctl:swipe', (e, { x1, y1, x2, y2, ms }) => { const m = mirrorOf(e); if (m?.serial) adb.swipe(m.serial, x1, y1, x2, y2, ms); });
  ipcMain.on('ctl:key', (e, name) => { const m = mirrorOf(e); if (m?.serial) adb.key(m.serial, name); });
  ipcMain.on('ctl:text', (e, text) => {
    const m = mirrorOf(e);
    if (!m?.serial) return;
    if (m.session) {
      // Plain text goes as typed text; anything else (Thai, emoji...) through the clipboard paste.
      if (/^[\x20-\x7e]*$/.test(text)) m.session.text(text); else m.session.paste(text);
    } else adb.text(m.serial, text);
  });
  // Live helper control (original: scrcpySendTouchEvent / scrcpySendKeybdEvent / scrcpySendScreenOffEvent).
  ipcMain.on('ctl:touch', (e, { action, x, y, w, h }) => { const m = mirrorOf(e); if (m?.session) m.session.touch(action, x, y, w, h); });
  ipcMain.on('ctl:keycode', (e, code) => {
    const m = mirrorOf(e);
    if (m?.session) m.session.key(code); else if (m?.serial) adb.key(m.serial, code);
  });
  ipcMain.on('ctl:displayPower', (e, on) => {
    const m = mirrorOf(e);
    if (m?.session) m.session.displayPower(on); else if (m?.serial) adb.key(m.serial, 'power');
  });

  // files
  ipcMain.handle('file:pick', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('file:push', async (e, files) => {
    const m = mirrorOf(e);
    const results = [];
    for (const f of files || []) {
      if (m?.serial) results.push({ file: path.basename(f), ...(await adb.push(m.serial, f)) });
      else if (m?.senderId) { lan.shareFile(f); results.push({ file: path.basename(f), ok: true, dest: 'shared with the browser' }); }
    }
    return results;
  });
  ipcMain.handle('file:phoneList', async (e) => { const m = mirrorOf(e); return m?.serial ? adb.listDownloads(m.serial) : []; });
  ipcMain.handle('file:pull', async (e, name) => {
    const m = mirrorOf(e);
    if (!m?.serial) return { ok: false };
    const dir = path.join(settings.get('outputDir'), 'Received');
    fs.mkdirSync(dir, { recursive: true });
    const r = await adb.pull(m.serial, '/sdcard/Download/' + name, dir);
    return { ...r, path: path.join(dir, name) };
  });
  ipcMain.handle('share:list', () => lan.sharedList());
  ipcMain.handle('share:add', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) for (const f of r.filePaths) lan.shareFile(f);
    return lan.sharedList();
  });
  ipcMain.handle('share:remove', (_e, id) => { lan.unshare(id); return lan.sharedList(); });

  // captures
  ipcMain.handle('capture:image', async (_e, { data, format, title }) => {
    const buf = Buffer.from(data);
    if (settings.get('imageTo') === 'Clipboard') {
      clipboard.writeImage(nativeImage.createFromBuffer(buf));
      return { ok: true, where: 'clipboard' };
    }
    // ScreenshotHelper::GetOutputFilePath: <output dir>\yyyyMMdd_HHmmss.<png|jpg>
    const file = outputFile(format === 'JPG' ? 'jpg' : 'png');
    fs.writeFileSync(file, buf);
    return { ok: true, where: 'file', path: file };
  });
  ipcMain.handle('capture:video', async (_e, { data, ext }) => {
    // Recorder::GetOutputFilePath: <output dir>\yyyyMMdd_HHmmss.<format>
    const file = outputFile(ext);
    fs.writeFileSync(file, Buffer.from(data));
    if (settings.get('openFolderOnFinish')) shell.showItemInFolder(file);
    return { ok: true, path: file };
  });
  ipcMain.on('capture:openFolder', (_e, sub) => {
    const dir = path.join(settings.get('outputDir'), sub || '');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
  ipcMain.on('shell:showItem', (_e, file) => shell.showItemInFolder(file));
  ipcMain.on('shell:openUrl', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  // WebRTC signalling between a browser sender and its mirror window
  ipcMain.on('rtc:toSender', (e, msg) => {
    const m = mirrorOf(e);
    if (m?.senderId) lan.toSender(m.senderId, msg);
  });
}

function toAccelerator(hk) {
  return String(hk).replace(/^Ctrl\+/i, 'CommandOrControl+').replace(/\+\+$/, '+Plus').replace(/\+-$/, '+-');
}
// Original naming; a second file in the same second gets " (2)" so nothing is overwritten.
function outputFile(ext) {
  const dir = settings.get('outputDir');
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${stamp()}.${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stamp()} (${i}).${ext}`);
  return file;
}
function safeName(s) { return String(s || 'Mirror').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 40) || 'Mirror'; }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- start -------------------------------------------------------------------------------
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  settings = new Settings(app);
  adb = new Adb(() => settings.get('adbPath'), path.join(app.getPath('userData'), 'tools'));
  lan = new LanServer({
    dataDir: app.getPath('userData'),
    staticDir: path.join(ROOT, 'renderer', 'sender'),
    getOutputDir: () => settings.get('outputDir'),
    events: {
      onSenderJoin(id, name) {
        senders.set(id, { name, winId: null });
        toast(`${name} wants to share its screen`);
        if (mainWin) mainWin.webContents.send('senders:update', [...senders.entries()].map(([sid, s]) => ({ id: sid, name: s.name })));
        openMirror({ kind: 'web', senderId: id, title: name });
      },
      onSenderLeave(id) {
        const s = senders.get(id);
        senders.delete(id);
        if (s?.winId != null) { const m = mirrors.get(s.winId); if (m && !m.win.isDestroyed()) m.win.webContents.send('rtc:fromSender', { type: 'bye' }); }
        if (mainWin) mainWin.webContents.send('senders:update', [...senders.entries()].map(([sid, x]) => ({ id: sid, name: x.name })));
      },
      onSignal(id, msg) {
        const s = senders.get(id);
        const deliver = () => {
          const m = s && s.winId != null ? mirrors.get(s.winId) : null;
          if (m && !m.win.isDestroyed()) {
            if (m.win.webContents.isLoading()) m.win.webContents.once('did-finish-load', () => m.win.webContents.send('rtc:fromSender', msg));
            else m.win.webContents.send('rtc:fromSender', msg);
          }
        };
        deliver();
      },
      onFileReceived(file, from) {
        toast(`Received ${path.basename(file)} from ${from}`, 'ok');
        if (mainWin) mainWin.webContents.send('file:received', { file, name: path.basename(file), from });
      }
    }
  });
  ios = new IosServer({
    checkCode: (c) => lan.checkCode(c),
    events: {
      onJoin(id, info) {
        iosSenders.set(id, info);
        toast(`${info.name} is sharing its screen`, 'ok');
        sendIosList();
        openMirror({ kind: 'ios', senderId: id, title: info.name });
      },
      onPacket(id, pkt) {
        const m = [...mirrors.values()].find((x) => x.senderId === id);
        // Pictures before the window is ready are dropped; the iPhone repeats its settings with
        // every key frame, so the picture starts at the next one.
        if (m && !m.win.isDestroyed() && !m.win.webContents.isLoading()) m.win.webContents.send('mirror:packet', pkt);
      },
      onLeave(id) {
        iosSenders.delete(id);
        sendIosList();
        const m = [...mirrors.values()].find((x) => x.senderId === id);
        if (m && !m.win.isDestroyed()) m.win.webContents.send('mirror:event', { type: 'ended', message: 'The iPhone stopped sharing.' });
      }
    }
  });
  registerIpc();
  if (!screenshotPath) {
    await lan.start(settings.get('lanPort'));
    await ios.start(settings.get('lanPort') + 1);
  }
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  for (const m of mirrors.values()) if (m.stream) m.stream.stop();
  if (adb) adb.stopAll();
  if (lan) lan.stop();
  if (ios) ios.stop();
});

function sendIosList() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('ios:update', [...iosSenders.entries()].map(([id, x]) => ({ id, name: x.name })));
}
