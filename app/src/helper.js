'use strict';
// Live mirroring session through a phone-side helper, the way the original's libmirrorcontrol.dll
// works (DeviceControl::startScrcpy 0x10032930, adbPush 0x1002c6b0, adbAppProcess 0x1002bac0,
// adbForward 0x1002c3d0): push a helper jar to /data/local/tmp, start it with app_process, forward a
// TCP port (27183, constructor 0x100182f0) and talk to it over sockets: one for the picture
// (length-prefixed H.264 packets, startReceive 0x10032540) and one for control (touch / key /
// screen-off messages, scrcpySendTouchEvent 0x10031e80, scrcpySendKeybdEvent 0x10031b00,
// scrcpySendScreenOffEvent 0x10031dd0).
//
// The original ships its own helper jar; this rebuild uses the open-source scrcpy server (Apache-2.0),
// downloaded once, whose protocol is the documented descendant of the one the original speaks.
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER_VERSION = '3.1';
const SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SERVER_VERSION}/scrcpy-server-v${SERVER_VERSION}`;
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const FIRST_PORT = 27183;            // DeviceControl ctor: *(this+0x48) = 0x6a2f
const SOCKET_TIMEOUT_MS = 1000;      // startScrcpy: setsockopt SO_SNDTIMEO/SO_RCVTIMEO 0x3e8
const SEND_GAP_MS = 10;              // scrcpySendTouchEvent / scrcpySendKeybdEvent: Sleep(10)

function download(url, file) {
  return new Promise((resolve, reject) => {
    const get = (u, depth) => https.get(u, { headers: { 'User-Agent': 'MirrorDesk' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 6) { res.resume(); return get(res.headers.location, depth + 1); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download failed: ' + res.statusCode)); }
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        const head = Buffer.alloc(2);
        const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
        if (head.toString() !== 'PK') { fs.unlinkSync(tmp); return reject(new Error('not a helper file')); }
        fs.renameSync(tmp, file);
        resolve(file);
      }));
      out.on('error', reject);
    }).on('error', reject);
    get(url, 0);
  });
}

// Reads exact byte counts from a socket.
class Reader {
  constructor(sock) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    sock.on('close', () => { this.closed = true; this.pump(); });
    sock.on('error', () => {});
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        this.waiters.shift();
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.resolve(Buffer.from(out));
      } else if (this.closed) {
        this.waiters.shift();
        w.reject(new Error('closed'));
      } else break;
    }
  }
  read(n) { return new Promise((resolve, reject) => { this.waiters.push({ n, resolve, reject }); this.pump(); }); }
}

let portInUse = new Set();

class HelperSession {
  constructor(adb, toolsDir, serial) {
    this.adb = adb;
    this.toolsDir = toolsDir;
    this.serial = serial;
    this.proc = null;
    this.video = null;
    this.control = null;
    this.stopped = false;
    this.queue = Promise.resolve();
    this.width = 0;
    this.height = 0;
    this.port = 0;
  }

  async ensureServer() {
    const file = path.join(this.toolsDir, `scrcpy-server-v${SERVER_VERSION}`);
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(this.toolsDir, { recursive: true });
    return download(SERVER_URL, file);
  }

  async start({ maxSize, bitRate, maxFps }, onPacket, onEvent) {
    const local = await this.ensureServer();
    const push = await this.adb.run(['push', local, REMOTE_JAR], { serial: this.serial, timeout: 60000 });
    if (push.code !== 0) throw new Error('could not copy the helper to the phone: ' + (push.stderr || push.stdout).trim());

    this.scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const sockName = 'scrcpy_' + this.scid.toString(16).padStart(8, '0');
    this.port = FIRST_PORT;
    while (portInUse.has(this.port)) this.port++;
    portInUse.add(this.port);
    const fwd = await this.adb.run(['forward', `tcp:${this.port}`, `localabstract:${sockName}`], { serial: this.serial });
    if (fwd.code !== 0) throw new Error('adb forward failed: ' + (fwd.stderr || fwd.stdout).trim());

    const args = [
      '-s', this.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
      `scid=${this.scid.toString(16).padStart(8, '0')}`, 'log_level=info', 'tunnel_forward=true',
      'audio=false', 'control=true', 'video_codec=h264',
      `video_bit_rate=${bitRate}`, `max_size=${maxSize}`, `max_fps=${maxFps}`,
      'send_device_meta=true', 'send_frame_meta=true', 'send_dummy_byte=true', 'send_codec_meta=true',
      'clipboard_autosync=false', 'power_off_on_close=false', 'cleanup=true'
    ];
    let log = '';
    this.proc = spawn(this.adb.bin, args, { windowsHide: true });
    this.proc.stdout.on('data', (d) => { log += d; });
    this.proc.stderr.on('data', (d) => { log += d; });
    this.proc.on('close', () => { if (!this.stopped) onEvent({ type: 'ended', message: log.trim().split('\n').slice(-3).join(' ') }); });

    // The forwarded port accepts at once; the helper's dummy byte says it is really there.
    let reader = null;
    for (let i = 0; i < 100 && !this.stopped; i++) {
      try {
        const sock = await this.connect();
        const r = new Reader(sock);
        await Promise.race([r.read(1), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), SOCKET_TIMEOUT_MS))]);
        this.video = sock; reader = r;
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!reader) throw new Error('the phone helper did not answer. ' + log.trim().slice(-200));
    this.control = await this.connect();
    this.control.setNoDelay(true);
    this.control.on('data', () => {}); // clipboard replies are not used
    this.control.on('error', () => {});

    // Device name (64 bytes), like the 0x44-byte handshake in startScrcpy.
    const name = (await reader.read(64)).toString('utf8').replace(/\0.*$/s, '');
    const meta = await reader.read(12);
    this.width = meta.readUInt32BE(4);
    this.height = meta.readUInt32BE(8);
    onEvent({ type: 'ready', name, width: this.width, height: this.height });

    (async () => {
      try {
        for (;;) {
          const head = await reader.read(12);
          const hi = head.readUInt32BE(0);
          const size = head.readUInt32BE(8);
          const config = (hi & 0x80000000) !== 0;
          const key = (hi & 0x40000000) !== 0;
          const data = await reader.read(size);
          onPacket({ config, key, data });
        }
      } catch (_) {
        if (!this.stopped) onEvent({ type: 'ended', message: 'picture stopped' });
      }
    })();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(s));
      s.once('error', reject);
    });
  }

  // Messages go out one by one with the original's 10 ms gap.
  send(buf) {
    this.queue = this.queue.then(() => new Promise((resolve) => {
      if (!this.control || this.control.destroyed) return resolve();
      this.control.write(buf, () => setTimeout(resolve, SEND_GAP_MS));
    }));
    return this.queue;
  }

  // Touch: action 0 down, 1 up, 2 move (TouchEventType BUTTON_DOWN/BUTTON_UP/MOUSEMOVE),
  // touch id 0, position in picture pixels with the picture size (scrcpySendTouchEvent).
  touch(action, x, y, w, h) {
    const b = Buffer.alloc(32);
    b.writeUInt8(2, 0);
    b.writeUInt8(action, 1);
    b.writeBigUInt64BE(0n, 2);                       // touch id 0
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(w || this.width, 18);
    b.writeUInt16BE(h || this.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22); // pressure
    b.writeUInt32BE(0, 24);
    b.writeUInt32BE(0, 28);
    return this.send(b);
  }

  // Key: press then release (scrcpySendKeybdEvent loops action 0 then 1).
  key(keycode) {
    const make = (action) => {
      const b = Buffer.alloc(14);
      b.writeUInt8(0, 0); b.writeUInt8(action, 1);
      b.writeUInt32BE(keycode, 2); b.writeUInt32BE(0, 6); b.writeUInt32BE(0, 10);
      return b;
    };
    this.send(make(0));
    return this.send(make(1));
  }

  text(str) {
    const t = Buffer.from(String(str), 'utf8').subarray(0, 300);
    const b = Buffer.alloc(5);
    b.writeUInt8(1, 0); b.writeUInt32BE(t.length, 1);
    return this.send(Buffer.concat([b, t]));
  }

  // Any language: put the text on the phone clipboard and paste it, which is what the original's
  // keyboard helper achieves for text the key path cannot type (InputMirrorKeybdString 0x1001e000).
  paste(str) {
    const t = Buffer.from(String(str), 'utf8');
    const b = Buffer.alloc(14);
    b.writeUInt8(9, 0); b.writeBigUInt64BE(0n, 1); b.writeUInt8(1, 9); b.writeUInt32BE(t.length, 10);
    return this.send(Buffer.concat([b, t]));
  }

  // Phone display off/on while mirroring goes on (scrcpySendScreenOffEvent: 2-byte message).
  displayPower(on) {
    return this.send(Buffer.from([10, on ? 1 : 0])); // helper v3: one on/off byte
  }

  async stop() {
    this.stopped = true;
    try { this.video && this.video.destroy(); } catch (_) { /* gone */ }
    try { this.control && this.control.destroy(); } catch (_) { /* gone */ }
    try { this.proc && this.proc.kill(); } catch (_) { /* gone */ }
    portInUse.delete(this.port);
    if (this.port) await this.adb.run(['forward', '--remove', `tcp:${this.port}`], { serial: this.serial });
  }
}

module.exports = { HelperSession, SERVER_VERSION };
