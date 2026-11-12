// Developer check: start the iPhone receiver, connect like the iPhone app (wrong code, then right code),
// send two packets cut into odd pieces, and confirm they arrive whole.
'use strict';
const net = require('net');
const { IosServer } = require('../src/ios');

const got = [];
const s = new IosServer({
  checkCode: (c) => String(c).toUpperCase() === 'ABCD',
  events: {
    onJoin: (id, info) => got.push(`join ${info.name} ${info.width}x${info.height}`),
    onPacket: (id, p) => got.push(`packet ${p.data.length} config=${p.config} key=${p.key}`),
    onLeave: () => got.push('leave')
  }
});

function client(port, code, packets) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(JSON.stringify({ type: 'hello', code, name: 'Test iPhone', width: 1170, height: 2532 }) + '\n');
    });
    let reply = '';
    c.on('data', (d) => {
      reply += d;
      if (!reply.includes('\n')) return;
      const msg = JSON.parse(reply.split('\n')[0]);
      if (msg.type !== 'welcome') { resolve(msg.type + ': ' + msg.reason); c.destroy(); return; }
      const out = Buffer.concat(packets.map(([flags, size]) => {
        const h = Buffer.alloc(12); h.writeUInt32BE(flags, 0); h.writeUInt32BE(size, 8);
        return Buffer.concat([h, Buffer.alloc(size, 7)]);
      }));
      let o = 0;
      const step = () => {
        if (o >= out.length) { setTimeout(() => { c.end(); resolve('welcome'); }, 100); return; }
        const n = 1 + Math.floor(Math.random() * 700);
        c.write(out.subarray(o, o + n)); o += n;
        setImmediate(step);
      };
      step();
    });
    c.on('close', () => resolve(reply.trim()));
  });
}

(async () => {
  const port = await s.start(15487);
  console.log('port', port);
  console.log('wrong code ->', await client(port, 'ZZZZ', []));
  console.log('right code ->', await client(port, 'abcd', [[0x80000000, 30], [0x40000000, 5000]]));
  await new Promise((r) => setTimeout(r, 200));
  console.log(got.join('\n'));
  s.stop();
  const ok = got.includes('packet 30 config=true key=false') && got.includes('packet 5000 config=false key=true');
  console.log(ok ? 'OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
})();
