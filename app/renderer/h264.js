// Turns the phone's raw H.264 byte stream (Annex B) into pictures with the built-in decoder.
(function () {
  class H264Player {
    constructor(onFrame, onInfo) {
      this.onFrame = onFrame;
      this.onInfo = onInfo || (() => {});
      this.buf = new Uint8Array(0);
      this.prefix = [];   // SPS/PPS/SEI waiting for the next picture
      this.frame = [];    // NAL units of the picture being collected
      this.frameKey = false;
      this.codec = '';
      this.decoder = null;
      this.waitKey = true;
      this.ts = 0;
      this.timer = null;
      this.frames = 0;
    }

    push(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const merged = new Uint8Array(this.buf.length + data.length);
      merged.set(this.buf, 0);
      merged.set(data, this.buf.length);
      this.buf = merged;
      this.parse(false);
      clearTimeout(this.timer);
      // The encoder writes whole pictures; if nothing follows shortly, the tail is complete.
      this.timer = setTimeout(() => this.parse(true), 12);
    }

    // A whole packet from the phone helper (its header gave the length, like startReceive in the
    // original), so no waiting is needed to know where it ends.
    pushPacket(data) {
      const d = data instanceof Uint8Array ? data : new Uint8Array(data);
      const merged = new Uint8Array(this.buf.length + d.length);
      merged.set(this.buf, 0);
      merged.set(d, this.buf.length);
      this.buf = merged;
      this.parse(true);
    }

    static findStart(b, from) {
      for (let i = from; i + 2 < b.length; i++) {
        if (b[i] === 0 && b[i + 1] === 0) {
          if (b[i + 2] === 1) return { at: i, len: 3 };
          if (b[i + 2] === 0 && i + 3 < b.length && b[i + 3] === 1) return { at: i, len: 4 };
        }
      }
      return null;
    }

    parse(flushTail) {
      const b = this.buf;
      let s = H264Player.findStart(b, 0);
      if (!s) return;
      let consumed = s.at;
      for (;;) {
        const next = H264Player.findStart(b, s.at + s.len);
        if (!next) {
          if (flushTail && b.length > s.at + s.len) {
            this.nal(b.subarray(s.at + s.len));
            consumed = b.length;
            this.flushFrame();
          }
          break;
        }
        this.nal(b.subarray(s.at + s.len, next.at));
        consumed = next.at;
        s = next;
      }
      this.buf = b.slice(consumed);
    }

    nal(n) {
      if (!n.length) return;
      const type = n[0] & 0x1f;
      if (type === 7) {
        const codec = 'avc1.' + [n[1], n[2], n[3]].map((x) => x.toString(16).padStart(2, '0')).join('');
        if (codec !== this.codec) { this.codec = codec; this.configure(); }
      }
      if (type === 1 || type === 5) {
        const firstMb = (n[1] & 0x80) !== 0; // ue(v) == 0 is a single 1 bit
        if (firstMb && this.frame.length) this.flushFrame();
        if (!this.frame.length) { this.frame.push(...this.prefix); this.prefix = []; }
        this.frame.push(n.slice());
        if (type === 5) this.frameKey = true;
      } else {
        if (this.frame.length) this.flushFrame();
        this.prefix.push(n.slice());
      }
    }

    configure() {
      try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch (_) { /* ignore */ }
      this.decoder = new VideoDecoder({
        output: (frame) => { this.frames++; this.onFrame(frame); },
        error: (e) => { this.onInfo({ type: 'decode-error', message: e.message }); this.waitKey = true; setTimeout(() => this.codec && this.configure(), 50); }
      });
      this.decoder.configure({ codec: this.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
      this.waitKey = true;
      this.onInfo({ type: 'codec', codec: this.codec });
    }

    flushFrame() {
      if (!this.frame.length) return;
      const nals = this.frame;
      const key = this.frameKey;
      this.frame = [];
      this.frameKey = false;
      if (!this.decoder || this.decoder.state !== 'configured') return;
      if (this.waitKey && !key) return;
      this.waitKey = false;
      let len = 0;
      for (const n of nals) len += n.length + 4;
      const out = new Uint8Array(len);
      let o = 0;
      for (const n of nals) { out.set([0, 0, 0, 1], o); o += 4; out.set(n, o); o += n.length; }
      try {
        // Drop pictures when the decoder falls behind, keep key pictures.
        if (!key && this.decoder.decodeQueueSize > 6) return;
        this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (this.ts += 33333), data: out }));
      } catch (e) {
        this.onInfo({ type: 'decode-error', message: e.message });
        this.waitKey = true;
      }
    }

    close() {
      clearTimeout(this.timer);
      try { this.decoder && this.decoder.close(); } catch (_) { /* ignore */ }
    }
  }
  window.H264Player = H264Player;
})();
