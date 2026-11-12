// Drawing on top of the mirrored screen. Tools, colours and widths follow the original
// (DrawingEdit.EditMode, WhiteBoardColorForm::CreateColorRects, EditConfig::.cctor).
(function () {
  const COLORS = ['#FF0000', '#000000', '#FFFFFF', '#0000FF', '#FAF875', '#28D728'];
  const DEFAULT_LINE = '#FF0000';
  const DEFAULT_HIGHLIGHT = '#FFFF00';
  const LINE_WIDTH = 4;           // EditConfig DefaultLineWidth
  const HIGHLIGHT_ALPHA = 0.4;    // estimated
  const HIGHLIGHT_WIDTH = LINE_WIDTH * 5; // estimated: a marker is much wider than the pen
  const MIN_POINT_GAP = 2;        // PathElement::HandleDrawingMouseMove (Distance2D >= 2)

  class Whiteboard {
    constructor(canvas, onChange) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.onChange = onChange || (() => {});
      this.items = [];
      this.redoStack = [];
      this.tool = 'brush';
      this.lineColor = DEFAULT_LINE;
      this.highlightColor = DEFAULT_HIGHLIGHT;
      this.active = false;
      this.cur = null;
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
    }

    setActive(on) { this.active = on; this.c.classList.toggle('drawing', on); }
    setTool(t) { this.tool = t; }
    setColor(col) { if (this.tool === 'highlighter') this.highlightColor = col; else this.lineColor = col; }
    get color() { return this.tool === 'highlighter' ? this.highlightColor : this.lineColor; }

    resize(w, h) {
      if (this.c.width === w && this.c.height === h) return;
      this.c.width = w; this.c.height = h;
      this.draw();
    }

    pt(e) {
      const r = this.c.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }

    down(e) {
      if (!this.active || e.button !== 0) return;
      const p = this.pt(e);
      if (this.tool === 'text') { this.placeText(p, e); return; }
      this.c.setPointerCapture(e.pointerId);
      const hl = this.tool === 'highlighter';
      this.cur = {
        tool: this.tool,
        color: this.color,
        width: hl ? HIGHLIGHT_WIDTH : LINE_WIDTH,
        alpha: hl ? HIGHLIGHT_ALPHA : 1,
        pts: [p, p]
      };
    }

    move(e) {
      if (!this.cur) return;
      const p = this.pt(e);
      if (this.cur.tool === 'brush' || this.cur.tool === 'highlighter') {
        // PathElement::HandleDrawingMouseMove: keep a point only when it is at least 2 px
        // (on screen) away from the last kept one.
        const last = this.cur.pts[this.cur.pts.length - 1];
        const r = this.c.getBoundingClientRect();
        if (Math.hypot((p.x - last.x) * r.width, (p.y - last.y) * r.height) < MIN_POINT_GAP) return;
        this.cur.pts.push(p);
      } else this.cur.pts[1] = p;
      this.draw();
    }

    up() {
      if (!this.cur) return;
      const a = this.cur.pts[0], b = this.cur.pts[this.cur.pts.length - 1];
      const tiny = Math.hypot((a.x - b.x) * this.c.width, (a.y - b.y) * this.c.height) < 2 && this.cur.pts.length < 4;
      if (!tiny || this.cur.tool === 'brush') this.add(this.cur);
      this.cur = null;
      this.draw();
    }

    placeText(p, e) {
      const box = document.createElement('textarea');
      box.className = 'wb-text';
      box.style.left = e.clientX + 'px';
      box.style.top = (e.clientY - 12) + 'px';
      box.style.color = this.lineColor;
      document.body.appendChild(box);
      setTimeout(() => box.focus(), 0);
      const finish = () => {
        const text = box.value.trim();
        box.remove();
        if (text) this.add({ tool: 'text', color: this.lineColor, size: 0.045, pts: [p], text });
        this.draw();
      };
      box.addEventListener('blur', finish, { once: true });
      box.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { box.value = ''; box.blur(); }
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); box.blur(); }
      });
    }

    add(item) { this.items.push(item); this.redoStack = []; this.onChange(); }
    undo() { if (this.items.length) { this.redoStack.push(this.items.pop()); this.draw(); this.onChange(); } }
    redo() { if (this.redoStack.length) { this.items.push(this.redoStack.pop()); this.draw(); this.onChange(); } }
    clear() { if (this.items.length) { this.redoStack = []; this.items = []; this.draw(); this.onChange(); } }
    get canUndo() { return this.items.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    draw() {
      const { ctx, c } = this;
      ctx.clearRect(0, 0, c.width, c.height);
      const scale = Math.max(1, Math.min(c.width, c.height) / 500);
      for (const it of this.items) this.drawItem(it, scale);
      if (this.cur) this.drawItem(this.cur, scale);
    }

    drawItem(it, scale) {
      const { ctx, c } = this;
      const W = c.width, H = c.height;
      const P = (p) => [p.x * W, p.y * H];
      ctx.save();
      ctx.globalAlpha = it.alpha || 1;
      ctx.strokeStyle = it.color;
      ctx.fillStyle = it.color;
      ctx.lineWidth = (it.width || LINE_WIDTH) * scale;
      ctx.lineCap = it.tool === 'highlighter' ? 'butt' : 'round';
      ctx.lineJoin = 'round';
      const [a, b] = [it.pts[0], it.pts[it.pts.length - 1]];
      const [ax, ay] = P(a), [bx, by] = P(b);
      switch (it.tool) {
        case 'brush':
        case 'highlighter': {
          if (it.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';
          // PathElement::RecalculatePath: with 3+ points, pad the list to 3n+1 points and draw
          // cubic Béziers through them; with 2 points, a straight line.
          ctx.beginPath();
          const pts = it.pts.map(P);
          ctx.moveTo(pts[0][0], pts[0][1]);
          if (pts.length >= 3) {
            while ((pts.length - 1) % 3 !== 0) pts.push(pts[pts.length - 1]); // padding position estimated
            for (let i = 1; i + 2 < pts.length; i += 3) {
              ctx.bezierCurveTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], pts[i + 2][0], pts[i + 2][1]);
            }
          } else {
            ctx.lineTo(bx === ax && by === ay ? bx + 0.1 : bx, by);
          }
          ctx.stroke();
          break;
        }
        case 'line':
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); break;
        case 'arrow': {
          const ang = Math.atan2(by - ay, bx - ax);
          const head = Math.max(12, ctx.lineWidth * 4);
          ctx.beginPath(); ctx.moveTo(ax, ay);
          ctx.lineTo(bx - Math.cos(ang) * head * 0.6, by - Math.sin(ang) * head * 0.6); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
          ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
          break;
        }
        case 'rect':
          ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); break;
        case 'ellipse':
          ctx.beginPath();
          ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'text': {
          const px = Math.round(it.size * Math.min(W, H) * 1.6);
          ctx.font = `600 ${px}px "Segoe UI", Arial, sans-serif`;
          ctx.textBaseline = 'top';
          it.text.split('\n').forEach((line, i) => ctx.fillText(line, ax, ay + i * px * 1.25));
          break;
        }
      }
      ctx.restore();
    }
  }

  Whiteboard.COLORS = COLORS;
  window.Whiteboard = Whiteboard;
})();
