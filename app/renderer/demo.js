// A pretend phone, so the mirror window, control, whiteboard, recording and screenshots can be
// tried without a real device. It draws a simple home screen and answers taps, swipes and keys.
(function () {
  const W = 720, H = 1520;
  const APPS = [
    ['Gallery', '#ff7a59'], ['Camera', '#5b6cff'], ['Music', '#ff4f8b'], ['Maps', '#2bc48a'],
    ['Notes', '#ffb020'], ['Clock', '#3fa9f5'], ['Mail', '#7a5cff'], ['Files', '#22b5c9'],
    ['Weather', '#4fa3ff'], ['Videos', '#f2555a'], ['Chat', '#19b36b'], ['Store', '#ff8f3f']
  ];

  class DemoPhone {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W; this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d');
      this.screen = 'home';
      this.app = null;
      this.scroll = 0;
      this.ripples = [];
      this.typed = '';
      this.volume = 0.6;
      this.volShow = 0;
      this.dark = false;
      this.width = W; this.height = H;
    }

    tap(x, y) {
      this.ripples.push({ x, y, t: performance.now() });
      if (this.dark) { this.dark = false; return; }
      if (this.screen === 'home') {
        const hit = this.tileAt(x, y);
        if (hit != null) { this.app = APPS[hit]; this.screen = 'app'; this.scroll = 0; this.typed = ''; }
      } else if (y < 220 && x < 160) {
        this.key('back');
      }
    }
    swipe(x1, y1, x2, y2) {
      this.ripples.push({ x: x2, y: y2, t: performance.now() });
      if (this.screen === 'app') this.scroll = Math.max(0, Math.min(2400, this.scroll + (y1 - y2)));
      if (this.screen === 'home' && y1 > H - 120 && y2 < y1 - 200) this.screen = 'home';
    }
    key(name) {
      if (name === 'back' || name === 'home') { this.screen = 'home'; this.app = null; }
      if (name === 'tasks') this.screen = this.screen === 'tasks' ? 'home' : 'tasks';
      if (name === 'volumeUp') { this.volume = Math.min(1, this.volume + 0.1); this.volShow = performance.now(); }
      if (name === 'volumeDown') { this.volume = Math.max(0, this.volume - 0.1); this.volShow = performance.now(); }
      if (name === 'power' || name === 'sleep') this.dark = !this.dark;
      if (name === 'backspace') this.typed = this.typed.slice(0, -1);
      if (name === 'enter') this.typed += '\n';
    }
    text(t) { this.typed = (this.typed + t).slice(-200); if (this.screen === 'home') { this.app = APPS[3 + 1]; this.screen = 'app'; } }

    tileAt(x, y) {
      for (let i = 0; i < APPS.length; i++) {
        const { tx, ty, s } = this.tilePos(i);
        if (x >= tx && x <= tx + s && y >= ty && y <= ty + s + 40) return i;
      }
      return null;
    }
    tilePos(i) {
      const col = i % 4, row = Math.floor(i / 4);
      const s = 120, gap = (W - 4 * s) / 5;
      return { tx: gap + col * (s + gap), ty: 640 + row * 210, s };
    }

    rr(x, y, w, h, r) { const c = this.ctx; c.beginPath(); c.roundRect(x, y, w, h, r); }

    render(now) {
      const c = this.ctx;
      const t = now / 1000;
      if (this.dark) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); this.drawRipples(now); return this.canvas; }
      if (this.screen === 'home' || this.screen === 'tasks') {
        const g = c.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, `hsl(${210 + Math.sin(t * 0.3) * 15}, 85%, 62%)`);
        g.addColorStop(1, `hsl(${265 + Math.cos(t * 0.25) * 15}, 70%, 52%)`);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        // soft waves
        for (let k = 0; k < 3; k++) {
          c.beginPath();
          c.moveTo(0, H);
          for (let x = 0; x <= W; x += 20) c.lineTo(x, 1180 + k * 70 + Math.sin(x / 120 + t * (0.8 + k * 0.3)) * 26);
          c.lineTo(W, H); c.closePath();
          c.fillStyle = `rgba(255,255,255,${0.08 + k * 0.04})`; c.fill();
        }
        this.statusBar('#fff');
        const d = new Date();
        c.fillStyle = '#fff'; c.textAlign = 'center';
        c.font = '300 150px "Segoe UI", Arial'; c.fillText(d.toTimeString().slice(0, 5), W / 2, 360);
        c.font = '400 34px "Segoe UI", Arial';
        c.fillText(d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }), W / 2, 420);
        APPS.forEach(([name, col], i) => {
          const { tx, ty, s } = this.tilePos(i);
          c.fillStyle = col; this.rr(tx, ty, s, s, 32); c.fill();
          c.fillStyle = 'rgba(255,255,255,.9)'; this.rr(tx + 38, ty + 38, 44, 44, 10); c.fill();
          c.fillStyle = '#fff'; c.font = '500 26px "Segoe UI", Arial'; c.fillText(name, tx + s / 2, ty + s + 38);
        });
        // dock search
        c.fillStyle = 'rgba(255,255,255,.92)'; this.rr(60, H - 230, W - 120, 92, 46); c.fill();
        c.fillStyle = '#8592a3'; c.font = '400 32px "Segoe UI", Arial'; c.textAlign = 'left';
        c.fillText(this.typed ? this.typed.split('\n').pop().slice(-26) : 'Search', 120, H - 172);
        if (this.screen === 'tasks') {
          c.fillStyle = 'rgba(15,20,30,.55)'; c.fillRect(0, 0, W, H);
          [0, 1].forEach((k) => { c.fillStyle = '#f5f7fa'; this.rr(110 + k * 40, 380 + k * 60, 500, 760, 36); c.fill(); });
          c.fillStyle = '#1f2d3d'; c.textAlign = 'center'; c.font = '500 34px "Segoe UI", Arial'; c.fillText('Recent apps', W / 2, 330);
        }
      } else {
        const [name, col] = this.app;
        c.fillStyle = '#f5f7fa'; c.fillRect(0, 0, W, H);
        c.fillStyle = col; c.fillRect(0, 0, W, 220);
        this.statusBar('#fff');
        c.fillStyle = '#fff'; c.font = '600 46px "Segoe UI", Arial'; c.textAlign = 'left';
        c.fillText('‹  ' + name, 36, 170);
        c.save(); c.beginPath(); c.rect(0, 220, W, H - 220); c.clip();
        for (let i = 0; i < 20; i++) {
          const y = 260 + i * 150 - this.scroll;
          if (y < 100 || y > H) continue;
          c.fillStyle = '#fff'; this.rr(30, y, W - 60, 128, 22); c.fill();
          c.fillStyle = col; c.globalAlpha = 0.85; this.rr(56, y + 24, 80, 80, 18); c.fill(); c.globalAlpha = 1;
          c.fillStyle = '#1f2d3d'; c.font = '600 32px "Segoe UI", Arial'; c.fillText(`${name} item ${i + 1}`, 160, y + 58);
          c.fillStyle = '#8592a3'; c.font = '400 26px "Segoe UI", Arial'; c.fillText('Tap, drag or scroll to try control', 160, y + 98);
        }
        c.restore();
        if (this.typed) {
          c.fillStyle = '#fff'; this.rr(30, H - 260, W - 60, 120, 24); c.fill();
          c.fillStyle = '#1f2d3d'; c.font = '400 32px "Segoe UI", Arial';
          c.fillText(this.typed.split('\n').pop().slice(-30) || ' ', 60, H - 188);
        }
      }
      // navigation pill
      c.fillStyle = this.screen === 'app' ? 'rgba(31,45,61,.5)' : 'rgba(255,255,255,.8)';
      this.rr(W / 2 - 110, H - 40, 220, 12, 6); c.fill();
      if (now - this.volShow < 1500) {
        c.fillStyle = 'rgba(31,45,61,.85)'; this.rr(W - 90, 420, 50, 360, 25); c.fill();
        c.fillStyle = '#fff'; this.rr(W - 82, 428 + 344 * (1 - this.volume), 34, 344 * this.volume, 17); c.fill();
      }
      this.drawRipples(now);
      return this.canvas;
    }

    statusBar(col) {
      const c = this.ctx;
      const d = new Date();
      c.fillStyle = col; c.font = '600 28px "Segoe UI", Arial'; c.textAlign = 'left';
      c.fillText(d.toTimeString().slice(0, 5), 40, 56);
      c.textAlign = 'right'; c.fillText('100%', W - 40, 56);
      c.textAlign = 'center';
    }

    drawRipples(now) {
      const c = this.ctx;
      this.ripples = this.ripples.filter((r) => now - r.t < 450);
      for (const r of this.ripples) {
        const k = (now - r.t) / 450;
        c.beginPath(); c.arc(r.x, r.y, 20 + k * 70, 0, Math.PI * 2);
        c.fillStyle = `rgba(255,255,255,${0.45 * (1 - k)})`; c.fill();
        c.strokeStyle = `rgba(47,123,255,${0.6 * (1 - k)})`; c.lineWidth = 4; c.stroke();
      }
    }
  }
  window.DemoPhone = DemoPhone;
})();
