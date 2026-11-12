'use strict';
// iPhone over USB, through Apple's usbmuxd (on Windows: "Apple Mobile Device Service", installed with
// iTunes / Apple Devices, listening on 127.0.0.1:27015; on macOS/Linux: /var/run/usbmuxd).
// usbmuxd can only open connections *to* a port on the phone, so the broadcast extension listens on
// USB_PORT and this module keeps trying to reach it while a phone is plugged in. Once connected, the
// socket carries the same protocol as Wi-Fi (src/ios.js) and is handed over with onSocket(sock).
//
// usbmuxd messages: 16-byte header (little-endian u32: total length, version 1, type 8 = plist, tag)
// followed by an XML plist. "Listen" streams Attached/Detached events; "Connect" answers with a
// Result (Number 0 = ok) and the socket then becomes a raw pipe to the phone's port.
const net = require('net');

const USB_PORT = 15488;     // must match SampleHandler.usbPort in ios-sender
const RETRY_MS = 1500;      // how often to try a plugged-in phone that isn't broadcasting yet
const RECONNECT_MS = 5000;  // how often to look for usbmuxd when it isn't running

function muxAddress() {
  return process.platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : { path: '/var/run/usbmuxd' };
}

// ---- tiny XML plist writer / reader (only what usbmuxd uses) --------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function toPlist(obj) {
  const val = (v) => {
    if (typeof v === 'number') return `<integer>${Math.trunc(v)}</integer>`;
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (v && typeof v === 'object') return '<dict>' + Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${val(x)}`).join('') + '</dict>';
    return `<string>${esc(v)}</string>`;
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + val(obj) + '</plist>\n';
}

function fromPlist(xml) {
  const tokens = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) tokens.push({ text: m[4] });
    else tokens.push({ close: !!m[1], name: m[2], empty: !!m[3] });
  }
  let i = 0;
  const textUntil = (name) => {
    let t = '';
    while (i < tokens.length && !(tokens[i].close && tokens[i].name === name)) { if (tokens[i].text) t += tokens[i].text; i++; }
    i++; // closing tag
    return unesc(t);
  };
  const value = () => {
    while (i < tokens.length && (tokens[i].text !== undefined || tokens[i].close || tokens[i].name === 'plist')) i++;
    const t = tokens[i++];
    if (!t) return undefined;
    if (t.empty) return t.name === 'true' ? true : t.name === 'false' ? false : t.name === 'dict' ? {} : t.name === 'array' ? [] : '';
    switch (t.name) {
      case 'dict': {
        const o = {};
        for (;;) {
          while (i < tokens.length && tokens[i].text !== undefined) i++;
          const k = tokens[i];
          if (!k || (k.close && k.name === 'dict')) { i++; return o; }
          i++;
          const key = textUntil('key');
          o[key] = value();
        }
      }
      case 'array': {
        const a = [];
        for (;;) {
          while (i < tokens.length && tokens[i].text !== undefined) i++;
          const k = tokens[i];
          if (!k || (k.close && k.name === 'array')) { i++; return a; }
          a.push(value());
        }
      }
      case 'integer': return parseInt(textUntil('integer'), 10);
      case 'real': return parseFloat(textUntil('real'));
      default: return textUntil(t.name); // string, data, date
    }
  };
  return value();
}

// ---- framing ------------------------------------------------------------------------------
function frame(obj, tag) {
  const body = Buffer.from(toPlist(obj), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4);  // version
  head.writeUInt32LE(8, 8);  // plist message
  head.writeUInt32LE(tag, 12);
  return Buffer.concat([head, body]);
}

/** Calls onMessage(plistObject, restOfBuffer) for each complete message; returns the unread part. */
function readFrames(buf, onMessage) {
  while (buf.length >= 16) {
    const len = buf.readUInt32LE(0);
    if (len < 16 || buf.length < len) break;
    const msg = fromPlist(buf.subarray(16, len).toString('utf8'));
    buf = buf.subarray(len);
    if (onMessage(msg, buf) === false) break;
  }
  return buf;
}

const swap16 = (p) => ((p & 0xff) << 8) | ((p >> 8) & 0xff); // usbmuxd wants the port in network order

class UsbMux {
  /** onSocket(sock, info): a live pipe to a broadcasting iPhone (paused; call sock.resume()). */
  constructor({ onSocket, port = USB_PORT, address = muxAddress() }) {
    this.onSocket = onSocket;
    this.port = port;
    this.address = address;
    this.devices = new Map(); // DeviceID -> { serial, busy, timer }
    this.listenSock = null;
    this.stopped = false;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.listen();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    for (const d of this.devices.values()) clearTimeout(d.timer);
    this.devices.clear();
    if (this.listenSock) this.listenSock.destroy();
    this.listenSock = null;
  }

  listen() {
    if (this.stopped) return;
    const sock = net.connect(this.address);
    this.listenSock = sock;
    let buf = Buffer.alloc(0);
    sock.on('connect', () => sock.write(frame({ MessageType: 'Listen', ClientVersionString: 'MirrorDesk', ProgName: 'MirrorDesk' }, 1)));
    sock.on('data', (d) => {
      buf = readFrames(Buffer.concat([buf, d]), (msg) => this.onEvent(msg || {}));
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.listenSock !== sock) return;
      this.listenSock = null;
      for (const d of this.devices.values()) clearTimeout(d.timer);
      this.devices.clear();
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.listen(), RECONNECT_MS);
    });
  }

  onEvent(msg) {
    if (msg.MessageType === 'Attached') {
      const props = msg.Properties || {};
      if (props.ConnectionType && props.ConnectionType !== 'USB') return; // Wi-Fi sync devices: use the Wi-Fi path
      if (this.devices.has(msg.DeviceID)) return;
      const dev = { id: msg.DeviceID, serial: props.SerialNumber || '', busy: false, timer: null };
      this.devices.set(dev.id, dev);
      this.tryDevice(dev);
    } else if (msg.MessageType === 'Detached') {
      const dev = this.devices.get(msg.DeviceID);
      if (dev) { clearTimeout(dev.timer); this.devices.delete(msg.DeviceID); }
    }
  }

  tryDevice(dev) {
    if (this.stopped || dev.busy || this.devices.get(dev.id) !== dev) return;
    dev.busy = true;
    const again = () => {
      dev.busy = false;
      if (!this.stopped && this.devices.get(dev.id) === dev) dev.timer = setTimeout(() => this.tryDevice(dev), RETRY_MS);
    };
    this.connect(dev.id).then((sock) => {
      sock.once('close', again);
      this.onSocket(sock, { serial: dev.serial });
    }, again);
  }

  /** Opens a pipe to this.port on the phone. Resolves with a paused socket. */
  connect(deviceId) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.address);
      let buf = Buffer.alloc(0);
      let done = false;
      const fail = (why) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(new Error(why)); };
      const timer = setTimeout(() => fail('usbmuxd timeout'), 5000);
      const onError = (e) => fail(e.message);
      const onClose = () => fail('closed');
      sock.on('error', onError);
      sock.on('close', onClose);
      sock.on('connect', () => sock.write(frame({
        MessageType: 'Connect', ClientVersionString: 'MirrorDesk', ProgName: 'MirrorDesk',
        DeviceID: deviceId, PortNumber: swap16(this.port)
      }, 2)));
      const onData = (d) => {
        buf = readFrames(Buffer.concat([buf, d]), (msg, rest) => {
          if (done) return false;
          if (!msg || msg.MessageType !== 'Result') return true;
          if (msg.Number !== 0) { fail('refused ' + msg.Number); return false; }
          done = true;
          clearTimeout(timer);
          sock.pause();
          sock.removeListener('data', onData);
          sock.removeListener('close', onClose);
          sock.removeListener('error', onError);
          sock.on('error', () => {});
          if (rest.length) sock.unshift(rest);
          resolve(sock);
          return false;
        });
      };
      sock.on('data', onData);
    });
  }
}

module.exports = { UsbMux, USB_PORT, toPlist, fromPlist };
