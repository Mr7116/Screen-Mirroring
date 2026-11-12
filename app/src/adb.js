'use strict';
// Talks to Android phones through adb (USB or Wi-Fi), like the original's libmirrorcontrol + adb.exe.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const KEY = {
  back: 4, home: 3, tasks: 187, power: 26, volumeUp: 24, volumeDown: 25, enter: 66,
  backspace: 67, del: 112, up: 19, down: 20, left: 21, right: 22, moveHome: 122, moveEnd: 123,
  menu: 82, space: 62, tab: 61, escape: 111, cut: 277, copy: 278, paste: 279,
  playPause: 85, sleep: 223, wakeup: 224
};

const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';

class Adb {
  constructor(getConfiguredPath, toolsDir) {
    this.getConfiguredPath = getConfiguredPath;
    this.toolsDir = toolsDir; // where a downloaded copy of platform-tools lives
    this.bin = null;
    this.shells = new Map();
  }

  candidates() {
    const list = [];
    const cfg = this.getConfiguredPath();
    if (cfg) list.push(cfg);
    list.push(path.join(this.toolsDir, 'platform-tools', exe));
    for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
      if (process.env[env]) list.push(path.join(process.env[env], 'platform-tools', exe));
    }
    if (process.platform === 'win32') {
      if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe));
      if (process.env.USERPROFILE) list.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'adb', 'current', 'platform-tools', exe));
      list.push('C:\\platform-tools\\adb.exe', 'C:\\adb\\adb.exe');
    } else {
      list.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe));
      list.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe));
      list.push('/usr/bin/adb', '/usr/local/bin/adb', '/opt/homebrew/bin/adb');
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir) list.push(path.join(dir, exe));
    }
    return list;
  }

  locate() {
    for (const c of this.candidates()) {
      try { if (fs.statSync(c).isFile()) { this.bin = c; return c; } } catch (_) { /* next */ }
    }
    this.bin = null;
    return null;
  }

  run(args, { timeout = 15000, serial } = {}) {
    return new Promise((resolve) => {
      if (!this.bin && !this.locate()) return resolve({ code: -1, stdout: '', stderr: 'adb not found' });
      const full = serial ? ['-s', serial, ...args] : args;
      execFile(this.bin, full, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
      });
    });
  }

  async devices() {
    const r = await this.run(['devices', '-l'], { timeout: 6000 });
    if (r.code !== 0 && !r.stdout) return { ok: false, error: r.stderr, devices: [] };
    const devices = [];
    for (const line of r.stdout.split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
      if (!m) continue;
      const props = {};
      for (const kv of m[3].trim().split(/\s+/)) {
        const i = kv.indexOf(':');
        if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const serial = m[1];
      const wifi = /:\d+$/.test(serial) || serial.includes('._adb-tls-connect');
      devices.push({
        serial,
        state: m[2], // device | unauthorized | offline
        model: (props.model || '').replace(/_/g, ' ') || serial,
        product: props.product || '',
        transport: wifi ? 'wifi' : 'usb'
      });
    }
    return { ok: true, devices };
  }

  async screenSize(serial) {
    const r = await this.run(['shell', 'wm', 'size'], { serial, timeout: 6000 });
    const over = r.stdout.match(/Override size:\s*(\d+)x(\d+)/);
    const phys = r.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
    const m = over || phys;
    return m ? { width: +m[1], height: +m[2] } : { width: 1080, height: 1920 };
  }

  async info(serial) {
    const [ver, model, maker] = await Promise.all([
      this.run(['shell', 'getprop', 'ro.build.version.release'], { serial }),
      this.run(['shell', 'getprop', 'ro.product.model'], { serial }),
      this.run(['shell', 'getprop', 'ro.product.manufacturer'], { serial })
    ]);
    return { android: ver.stdout.trim(), model: model.stdout.trim(), maker: maker.stdout.trim() };
  }

  // Picture size asked from the phone: short side capped at displaySize, long side at 1920 (estimated).
  static streamSize(screen, displaySize) {
    let w = screen.width, h = screen.height;
    const shortSide = Math.min(w, h), longSide = Math.max(w, h);
    let scale = Math.min(1, displaySize / shortSide, 1920 / longSide);
    w = Math.max(2, Math.round((w * scale) / 8) * 8);
    h = Math.max(2, Math.round((h * scale) / 8) * 8);
    return { width: w, height: h };
  }

  // H.264 stream from the phone's own screenrecord; restarted when its time limit ends.
  startStream(serial, { width, height, bitRate }, onData, onEvent) {
    let stopped = false;
    let child = null;
    let fallback = false;
    let started = 0;
    const launch = () => {
      if (stopped) return;
      const args = ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--time-limit', '180',
        '--bit-rate', String(bitRate)];
      if (!fallback) args.push('--size', `${width}x${height}`);
      args.push('-');
      started = Date.now();
      child = spawn(this.bin, args, { windowsHide: true });
      let errText = '';
      child.stdout.on('data', (chunk) => onData(chunk));
      child.stderr.on('data', (d) => { errText += d.toString(); });
      child.on('close', (code) => {
        if (stopped) return;
        const quick = Date.now() - started < 2500;
        if (quick && !fallback) { fallback = true; onEvent({ type: 'retry', message: errText.trim() }); return setTimeout(launch, 300); }
        if (quick) { onEvent({ type: 'error', message: errText.trim() || `screen capture ended (${code})` }); return setTimeout(launch, 2000); }
        onEvent({ type: 'restart' });
        setTimeout(launch, 100);
      });
    };
    if (!this.bin && !this.locate()) { onEvent({ type: 'error', message: 'adb not found' }); return { stop() {} }; }
    launch();
    return {
      stop() { stopped = true; try { child && child.kill(); } catch (_) { /* gone */ } }
    };
  }

  // One long-lived shell per phone so control commands start quickly.
  shell(serial) {
    let s = this.shells.get(serial);
    if (s && !s.killed && s.exitCode === null) return s;
    s = spawn(this.bin, ['-s', serial, 'shell'], { windowsHide: true });
    s.on('error', () => {});
    s.stdout.on('data', () => {});
    s.stderr.on('data', () => {});
    this.shells.set(serial, s);
    return s;
  }

  send(serial, cmd) {
    if (!this.bin && !this.locate()) return false;
    try { this.shell(serial).stdin.write(cmd + '\n'); return true; } catch (_) { return false; }
  }

  tap(serial, x, y) { return this.send(serial, `input tap ${x | 0} ${y | 0}`); }
  swipe(serial, x1, y1, x2, y2, ms) { return this.send(serial, `input swipe ${x1 | 0} ${y1 | 0} ${x2 | 0} ${y2 | 0} ${Math.max(1, ms | 0)}`); }
  key(serial, name) {
    const code = typeof name === 'number' ? name : KEY[name];
    if (code == null) return false;
    return this.send(serial, `input keyevent ${code}`);
  }
  text(serial, str) {
    // `input text` only takes plain ASCII; spaces become %s and shell characters are escaped.
    const safe = String(str).replace(/[^\x20-\x7e]/g, '')
      .replace(/([\\"'`$&|;<>()*?!#~{}\[\]])/g, '\\$1')
      .replace(/ /g, '%s');
    if (!safe) return false;
    return this.send(serial, `input text "${safe}"`);
  }

  async push(serial, file, onProgress) {
    const dest = '/sdcard/Download/' + path.basename(file);
    const r = await this.run(['push', file, dest], { serial, timeout: 10 * 60 * 1000 });
    if (onProgress) onProgress(100);
    return { ok: r.code === 0, dest, error: r.code === 0 ? '' : (r.stderr || r.stdout).trim() };
  }

  async pull(serial, remote, localDir) {
    const r = await this.run(['pull', remote, localDir], { serial, timeout: 10 * 60 * 1000 });
    return { ok: r.code === 0, error: r.code === 0 ? '' : (r.stderr || r.stdout).trim() };
  }

  async listDownloads(serial) {
    const r = await this.run(['shell', 'ls', '-p', '/sdcard/Download/'], { serial });
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.endsWith('/'));
  }

  async connect(host) {
    const target = /:\d+$/.test(host) ? host : `${host}:5555`;
    const r = await this.run(['connect', target], { timeout: 12000 });
    const ok = /connected to/i.test(r.stdout) && !/failed|unable/i.test(r.stdout);
    return { ok, message: (r.stdout || r.stderr).trim() };
  }

  async pair(hostPort, code) {
    const r = await this.run(['pair', hostPort, code], { timeout: 20000 });
    const ok = /Successfully paired/i.test(r.stdout);
    return { ok, message: (r.stdout || r.stderr).trim() };
  }

  async disconnect(serial) { return this.run(['disconnect', serial]); }

  // Switch a USB phone to Wi-Fi: tcpip 5555, read its address, connect.
  async toWifi(serial) {
    const route = await this.run(['shell', 'ip', 'route'], { serial });
    const m = route.stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (!m) return { ok: false, message: 'The phone is not on Wi-Fi.' };
    await this.run(['tcpip', '5555'], { serial, timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500));
    return this.connect(`${m[1]}:5555`);
  }

  stopAll() {
    for (const s of this.shells.values()) { try { s.kill(); } catch (_) { /* gone */ } }
    this.shells.clear();
  }
}

// Download Google's platform-tools (adb) into dir and unpack it.
function downloadPlatformTools(dir, onProgress) {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const url = `https://dl.google.com/android/repository/platform-tools-latest-${plat}.zip`;
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'platform-tools.zip');
  return new Promise((resolve, reject) => {
    const get = (u, depth) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
          res.resume(); return get(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed: ' + res.statusCode)); }
        const total = +res.headers['content-length'] || 0;
        let got = 0;
        const out = fs.createWriteStream(zipPath);
        res.on('data', (c) => { got += c.length; if (total && onProgress) onProgress(Math.round((got / total) * 100)); });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              const AdmZip = require('adm-zip');
              new AdmZip(zipPath).extractAllTo(dir, true);
              fs.unlinkSync(zipPath);
              const bin = path.join(dir, 'platform-tools', exe);
              if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch (_) { /* ignore */ } }
              resolve(bin);
            } catch (e) { reject(e); }
          });
        });
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

module.exports = { Adb, KEY, downloadPlatformTools };
