'use strict';
// iPhone over Wi-Fi when the broadcast can't read the screen code (App Group missing, e.g. apps
// installed with a free Apple ID). The iPhone app registers with the code (src/ios.js "register");
// from then on this module keeps trying to reach the broadcast on the iPhone (same port as USB) and
// hands the socket over with onSocket(sock), like src/usbmux.js does for the cable.
const net = require('net');

const PHONE_PORT = 15488;     // SampleHandler.usbPort: the broadcast listens here on Wi-Fi and USB
const RETRY_MS = 1500;
const CONNECT_TIMEOUT_MS = 1500;
const KEEP_MS = 10 * 60 * 1000; // forget a phone 10 minutes after its app last registered

class IosDialer {
  constructor({ onSocket, port = PHONE_PORT }) {
    this.onSocket = onSocket;
    this.port = port;
    this.phones = new Map(); // ip -> { ip, until, busy, timer }
    this.stopped = false;
  }

  register(ip) {
    if (this.stopped || !ip) return;
    let p = this.phones.get(ip);
    if (!p) {
      p = { ip, until: 0, busy: false, timer: null };
      this.phones.set(ip, p);
    }
    p.until = Date.now() + KEEP_MS;
    if (!p.busy && !p.timer) this.tryPhone(p);
  }

  stop() {
    this.stopped = true;
    for (const p of this.phones.values()) clearTimeout(p.timer);
    this.phones.clear();
  }

  tryPhone(p) {
    p.timer = null;
    if (this.stopped || this.phones.get(p.ip) !== p) return;
    if (Date.now() > p.until) { this.phones.delete(p.ip); return; }
    p.busy = true;
    const again = () => {
      p.busy = false;
      if (!this.stopped && this.phones.get(p.ip) === p) p.timer = setTimeout(() => this.tryPhone(p), RETRY_MS);
    };
    const sock = net.connect({ host: p.ip, port: this.port });
    let connected = false;
    const timer = setTimeout(() => sock.destroy(), CONNECT_TIMEOUT_MS);
    sock.on('error', () => {});
    sock.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      sock.once('close', again);
      this.onSocket(sock, { ip: p.ip });
    });
    sock.once('close', () => { clearTimeout(timer); if (!connected) again(); });
  }
}

module.exports = { IosDialer, PHONE_PORT };
