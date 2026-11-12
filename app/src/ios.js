'use strict';
// Receiver for the iPhone sender app (ios-sender/, ReplayKit broadcast extension).
// The original reaches iPhones through AirPlay (libairplay.dll, needs Apple's FairPlay) and Apple's
// USB screen-capture protocol (libwxaus.dll: usbmuxd + lockdown pairing + a replaced USB driver);
// neither can be rebuilt here, so the iPhone runs our own sender instead (the person's plan:
// "Sender: iOS with ReplayKit, H.264").
//
// Protocol (TCP, port = Wi-Fi share port + 1 = 15487):
//   iPhone → PC  one JSON line: {"type":"hello","code":"0178","name":"iPhone","width":1170,"height":2532}\n
//   PC → iPhone  one JSON line: {"type":"welcome"} or {"type":"denied","reason":"..."}
//   iPhone → PC  packets: 12-byte header [u32 flags (bit31 config, bit30 key frame), u32 0, u32 size]
//                then `size` bytes of H.264 Annex B — the same packet shape the Android helper uses.
//   Either side may close; a packet with size 0 and flags 0x20000000 means "orientation/size changed"
//   and is followed by a JSON line with the new width/height (optional).
const net = require('net');
const crypto = require('crypto');

const MAX_PACKET = 8 * 1024 * 1024;

class IosServer {
  constructor({ checkCode, events }) {
    this.checkCode = checkCode;
    this.events = events; // { onJoin(id, info), onPacket(id, pkt), onLeave(id) }
    this.server = null;
    this.port = 0;
    this.clients = new Map();
  }

  start(port) {
    return new Promise((resolve) => {
      const tryPort = (p, left) => {
        const srv = net.createServer((sock) => this.onSocket(sock));
        srv.once('error', () => (left > 0 ? tryPort(p + 1, left - 1) : resolve(0)));
        srv.listen(p, '0.0.0.0', () => { this.server = srv; this.port = p; resolve(p); });
      };
      tryPort(port, 10);
    });
  }

  stop() {
    for (const c of this.clients.values()) { try { c.sock.destroy(); } catch (_) { /* gone */ } }
    try { this.server && this.server.close(); } catch (_) { /* ignore */ }
  }

  disconnect(id) {
    const c = this.clients.get(id);
    if (c) c.sock.destroy();
  }

  /** A connection that came through the USB cable (src/usbmux.js): no screen code needed. */
  adopt(sock) {
    this.onSocket(sock, true);
    sock.resume();
  }

  onSocket(sock, trusted = false) {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let id = null;
    let need = null; // header waiting for its body
    const fail = (reason) => {
      try { sock.end(JSON.stringify({ type: 'denied', reason }) + '\n'); } catch (_) { /* gone */ }
      sock.destroy();
    };
    const timer = setTimeout(() => { if (!id) fail('No hello'); }, 10000);

    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (!id) {
          const nl = buf.indexOf(10);
          if (nl < 0) { if (buf.length > 4096) fail('Bad hello'); return; }
          let hello;
          try { hello = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch (_) { return fail('Bad hello'); }
          buf = buf.subarray(nl + 1);
          if (hello.type !== 'hello' || (!trusted && !this.checkCode(hello.code))) return fail('Wrong screen code');
          clearTimeout(timer);
          id = 'ios-' + crypto.randomBytes(4).toString('hex');
          const info = {
            name: String(hello.name || 'iPhone').slice(0, 40),
            width: hello.width | 0, height: hello.height | 0
          };
          this.clients.set(id, { sock, info });
          sock.write(JSON.stringify({ type: 'welcome', id }) + '\n');
          this.events.onJoin(id, info);
          continue;
        }
        if (!need) {
          if (buf.length < 12) return;
          const flags = buf.readUInt32BE(0);
          const aux = buf.readUInt32BE(4);
          const size = buf.readUInt32BE(8);
          if (size > MAX_PACKET) return fail('Packet too big');
          need = { flags, aux, size };
          buf = buf.subarray(12);
        }
        if (buf.length < need.size) return;
        const data = Buffer.from(buf.subarray(0, need.size));
        buf = buf.subarray(need.size);
        const { flags, aux } = need;
        need = null;
        if (data.length && (flags & 0x10000000)) {
          // Sound: 16-bit little-endian interleaved PCM; aux = (sample rate << 8) | channels.
          this.events.onPacket(id, { audio: true, rate: aux >>> 8, channels: aux & 0xff, data });
        } else if (data.length) {
          this.events.onPacket(id, { config: (flags & 0x80000000) !== 0, key: (flags & 0x40000000) !== 0, data });
        }
      }
    });
    const end = () => {
      clearTimeout(timer);
      if (id && this.clients.has(id)) { this.clients.delete(id); this.events.onLeave(id); }
    };
    sock.on('close', end);
    sock.on('error', () => {});
  }
}

module.exports = { IosServer };
