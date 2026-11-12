'use strict';
// AirPlay receiver: runs UxPlay (open source, GPL-3, https://github.com/FDH2/UxPlay) in the background
// so an iPhone can use its own Screen Mirroring (Control Centre) with no app installed.
// Stage 1: UxPlay shows the picture in its own window.
// The bundle (bin/uxplay.exe + DLLs, lib/gstreamer-1.0, libexec/gstreamer-1.0) comes from
// .github/workflows/build-uxplay-windows.yml: resources/uxplay when installed, app/vendor/uxplay when
// run with `npm start`.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RESTART_MS = 3000;
const MAX_QUICK_FAILS = 5;   // stop restarting after this many exits within 10 s of starting
const QUICK_MS = 10000;

function findBundle(appDir) {
  const places = [];
  if (process.resourcesPath) places.push(path.join(process.resourcesPath, 'uxplay'));
  places.push(path.join(appDir, 'vendor', 'uxplay'));
  return places.find((d) => fs.existsSync(path.join(d, 'bin', 'uxplay.exe'))) || null;
}

class AirPlay {
  /** dataDir: writable folder for the GStreamer registry and the log. onStatus(text) is optional. */
  constructor({ appDir, dataDir, name = 'MirrorDesk', onStatus = () => {}, platform = process.platform }) {
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.name = name;
    this.onStatus = onStatus;
    this.platform = platform;
    this.proc = null;
    this.stopped = false;
    this.quickFails = 0;
    this.timer = null;
    this.logFile = path.join(dataDir, 'uxplay.log');
  }

  /** Returns false when AirPlay can't run here (not Windows, or UxPlay isn't bundled). */
  start() {
    if (this.platform !== 'win32') return false;
    this.dir = findBundle(this.appDir);
    if (!this.dir) { this.onStatus('AirPlay receiver not installed'); return false; }
    this.stopped = false;
    this.launch();
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* gone */ } } // its exit handler closes the log
  }

  launch() {
    if (this.stopped) return;
    const d = this.dir;
    const env = {
      ...process.env,
      PATH: path.join(d, 'bin') + path.delimiter + (process.env.PATH || ''),
      // Use only the bundled plugins, not another GStreamer installed on the computer.
      GST_PLUGIN_SYSTEM_PATH_1_0: '',
      GST_PLUGIN_SYSTEM_PATH: '',
      GST_PLUGIN_PATH_1_0: path.join(d, 'lib', 'gstreamer-1.0'),
      GST_PLUGIN_PATH: path.join(d, 'lib', 'gstreamer-1.0'),
      GST_PLUGIN_SCANNER_1_0: path.join(d, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'),
      GST_REGISTRY_1_0: path.join(this.dataDir, 'uxplay-gst-registry.bin')
    };
    // -n name: shown in the iPhone's Screen Mirroring list as "MirrorDesk@<computer name>".
    // -fps 60: allow up to 60 frames per second (UxPlay's default is 30).
    const args = ['-n', this.name, '-fps', '60'];
    let log;
    try { log = fs.createWriteStream(this.logFile, { flags: 'a' }); } catch (_) { log = null; }
    const started = Date.now();
    if (log) log.write(`\n--- ${new Date().toISOString()} uxplay ${args.join(' ')}\n`);
    const proc = spawn(path.join(d, 'bin', 'uxplay.exe'), args, { cwd: path.join(d, 'bin'), env, windowsHide: true });
    this.proc = proc;
    if (log) { proc.stdout.pipe(log, { end: false }); proc.stderr.pipe(log, { end: false }); }
    else { proc.stdout.resume(); proc.stderr.resume(); }
    this.onStatus('AirPlay receiver running');
    const done = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (log) { log.write(`--- uxplay ended: ${why}\n`); log.end(); }
      if (this.stopped) return;
      this.quickFails = Date.now() - started < QUICK_MS ? this.quickFails + 1 : 0;
      if (this.quickFails >= MAX_QUICK_FAILS) {
        this.onStatus('AirPlay receiver keeps stopping; see ' + this.logFile);
        return;
      }
      this.timer = setTimeout(() => this.launch(), RESTART_MS);
    };
    proc.on('error', (e) => done(e.message));
    proc.on('exit', (code, sig) => done(`code ${code}${sig ? ' signal ' + sig : ''}`));
  }
}

module.exports = { AirPlay, findBundle };
