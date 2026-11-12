'use strict';
// Wi-Fi side: a secure page any phone or computer on the same network opens to share its screen
// (WebRTC) and send files, plus the screen code rule from the original (ScreenCodeCtrl::IpToPinCode).
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : ip.startsWith('169.254.') ? 9 : 5;
  const virtualName = /virtual|vmware|vbox|hyper-v|vethernet|loopback|docker|wsl/i;
  out.sort((a, b) => (rank(a.address) + (virtualName.test(a.name) ? 4 : 0)) - (rank(b.address) + (virtualName.test(b.name) ? 4 : 0)));
  return out;
}

// Same rule as the original: 192.168.x.y → hex of x and y; anything else → hex of all four bytes.
function ipToCode(ip) {
  const b = String(ip || '').split('.').map((n) => parseInt(n, 10));
  if (b.length !== 4 || b.some((n) => !(n >= 0 && n <= 255))) return '';
  const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return b[0] === 192 && b[1] === 168 ? hex(b[2]) + hex(b[3]) : b.map(hex).join('');
}

function codeToIp(code) {
  const c = String(code || '').trim();
  if (!/^[0-9a-f]+$/i.test(c)) return '';
  if (c.length === 4) return `192.168.${parseInt(c.slice(0, 2), 16)}.${parseInt(c.slice(2), 16)}`;
  if (c.length === 8) return [0, 2, 4, 6].map((i) => parseInt(c.slice(i, i + 2), 16)).join('.');
  return '';
}

function loadCert(dir, ips) {
  const certFile = path.join(dir, 'lan-cert.json');
  try {
    const saved = JSON.parse(fs.readFileSync(certFile, 'utf8'));
    if (saved.ips === ips.join(',')) return saved;
  } catch (_) { /* make one */ }
  const selfsigned = require('selfsigned');
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'MirrorDesk receiver' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }]
  });
  const saved = { ips: ips.join(','), key: pems.private, cert: pems.cert };
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(certFile, JSON.stringify(saved)); } catch (_) { /* ignore */ }
  return saved;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class LanServer {
  constructor({ dataDir, staticDir, getOutputDir, events }) {
    this.dataDir = dataDir;
    this.staticDir = staticDir;
    this.getOutputDir = getOutputDir;
    this.events = events; // { onSenderJoin, onSenderLeave, onSignal, onFileReceived }
    this.port = 0;
    this.server = null;
    this.senders = new Map();
    this.shared = new Map(); // id -> { name, file, size }
  }

  get code() { return ipToCode(this.address); }
  get address() { const a = lanAddresses()[0]; return a ? a.address : '127.0.0.1'; }
  get url() { return this.port ? `https://${this.address}:${this.port}/` : ''; }

  start(firstPort) {
    const ips = lanAddresses().map((a) => a.address);
    const { key, cert } = loadCert(this.dataDir, ips);
    return new Promise((resolve) => {
      const tryPort = (port, left) => {
        const srv = https.createServer({ key, cert }, (req, res) => this.handle(req, res));
        srv.once('error', () => { if (left > 0) tryPort(port + 1, left - 1); else resolve(0); });
        srv.listen(port, '0.0.0.0', () => {
          this.server = srv;
          this.port = port;
          this.wss = new WebSocketServer({ server: srv, path: '/ws' });
          this.wss.on('connection', (ws) => this.onSocket(ws));
          resolve(port);
        });
      };
      tryPort(firstPort, 10);
    });
  }

  stop() {
    try { this.wss && this.wss.close(); } catch (_) { /* ignore */ }
    try { this.server && this.server.close(); } catch (_) { /* ignore */ }
  }

  checkCode(c) { return String(c || '').toUpperCase() === this.code; }

  handle(req, res) {
    const u = new URL(req.url, 'https://x');
    const send = (status, body, type) => { res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) u.pathname = '/sender.html';
    if (req.method === 'GET' && /^\/(sender\.(html|js|css))$/.test(u.pathname)) {
      const file = path.join(this.staticDir, path.basename(u.pathname));
      return fs.readFile(file, (err, buf) => err ? send(404, 'Not found') : send(200, buf, MIME[path.extname(file)]));
    }
    if (u.pathname === '/files' && req.method === 'GET') {
      if (!this.checkCode(u.searchParams.get('code'))) return send(403, 'Wrong screen code');
      const list = [...this.shared.entries()].map(([id, f]) => ({ id, name: f.name, size: f.size }));
      return send(200, JSON.stringify(list), 'application/json');
    }
    if (u.pathname.startsWith('/download/') && req.method === 'GET') {
      if (!this.checkCode(u.searchParams.get('code'))) return send(403, 'Wrong screen code');
      const f = this.shared.get(u.pathname.slice('/download/'.length));
      if (!f) return send(404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (u.pathname === '/upload' && req.method === 'POST') {
      if (!this.checkCode(u.searchParams.get('code'))) { req.resume(); return send(403, 'Wrong screen code'); }
      const name = path.basename(u.searchParams.get('name') || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
      const dir = path.join(this.getOutputDir(), 'Received');
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      for (let i = 1; fs.existsSync(target); i++) {
        const ext = path.extname(name);
        target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
      }
      const out = fs.createWriteStream(target);
      req.pipe(out);
      out.on('finish', () => { send(200, 'ok'); this.events.onFileReceived(target, u.searchParams.get('from') || 'Browser'); });
      out.on('error', () => send(500, 'Could not save'));
      return;
    }
    send(404, 'Not found');
  }

  onSocket(ws) {
    let id = null;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === 'hello') {
        if (!this.checkCode(msg.code)) { ws.send(JSON.stringify({ type: 'denied', reason: 'Wrong screen code' })); return; }
        id = crypto.randomBytes(4).toString('hex');
        const name = String(msg.name || 'Browser').slice(0, 40);
        this.senders.set(id, { ws, name, kind: msg.kind || 'screen' });
        ws.send(JSON.stringify({ type: 'welcome', id }));
        this.events.onSenderJoin(id, name);
        return;
      }
      if (!id) return;
      if (['offer', 'ice', 'stop', 'audio'].includes(msg.type)) this.events.onSignal(id, msg);
    });
    ws.on('close', () => { if (id) { this.senders.delete(id); this.events.onSenderLeave(id); } });
    ws.on('error', () => {});
  }

  toSender(id, msg) {
    const s = this.senders.get(id);
    if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
  }

  shareFile(file) {
    const st = fs.statSync(file);
    const id = crypto.randomBytes(6).toString('hex');
    this.shared.set(id, { name: path.basename(file), file, size: st.size });
    for (const s of this.senders.values()) { try { s.ws.send(JSON.stringify({ type: 'files-changed' })); } catch (_) { /* ignore */ } }
    return id;
  }

  sharedList() { return [...this.shared.entries()].map(([id, f]) => ({ id, name: f.name, size: f.size })); }
  unshare(id) { this.shared.delete(id); }
}

module.exports = { LanServer, lanAddresses, ipToCode, codeToIp };
