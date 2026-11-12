// Developer check: start the Wi-Fi share server, ask it for the page, a file list and an upload, then stop.
'use strict';
const { LanServer } = require('../src/lan');
const os = require('os');
const path = require('path');
const https = require('https');

const tmp = path.join(os.tmpdir(), 'mirrordesk-test');
const s = new LanServer({
  dataDir: tmp,
  staticDir: path.join(__dirname, '..', 'renderer', 'sender'),
  getOutputDir: () => tmp,
  events: { onSenderJoin() {}, onSenderLeave() {}, onSignal() {}, onFileReceived(f) { console.log('received', f); } }
});

function req(port, url, method, body) {
  return new Promise((resolve) => {
    const r = https.request(`https://127.0.0.1:${port}${url}`, { method: method || 'GET', rejectUnauthorized: false }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(`${res.statusCode} ${d.slice(0, 50).replace(/\s+/g, ' ')}`));
    });
    r.on('error', (e) => resolve('error ' + e.message));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const port = await s.start(15486);
  console.log('port', port, 'code', s.code, 'url', s.url);
  console.log('page:', await req(port, '/'));
  console.log('wrong code:', await req(port, '/files?code=ZZZZ'));
  console.log('files:', await req(port, `/files?code=${s.code}`));
  console.log('upload:', await req(port, `/upload?code=${s.code}&name=hello.txt`, 'POST', 'hi there'));
  s.stop();
  setTimeout(() => process.exit(0), 200);
})();
