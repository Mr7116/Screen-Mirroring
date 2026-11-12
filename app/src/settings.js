'use strict';
// Settings with the original's defaults (see MECHANICS.md). Stored as JSON in the user data folder.
const fs = require('fs');
const path = require('path');

const DEFAULT_HOTKEYS = {
  screenshot: 'Ctrl+Q',
  recording: 'Ctrl+R',
  whiteboard: 'Ctrl+B',
  fullscreen: 'Ctrl+F',
  topmost: 'Ctrl+P',
  rotate: 'Ctrl+Z',
  simpleMode: 'Ctrl+S',
  boss: 'Alt+A',
  back: 'RButton',
  home: 'Alt+1',
  tasks: 'Alt+2',
  screenOff: 'Ctrl+D',
  volumeUp: 'Ctrl++',
  volumeDown: 'Ctrl+-',
  send: 'Enter',
  newLine: 'Ctrl+Enter',
  pauseOrPlay: 'Ctrl+E'
};

function defaults(app) {
  return {
    theme: 'light',            // UIStyle 0 = Light
    topmost: false,            // Main/Topmost
    closeAction: 'quit',
    language: 'en',
    adbPath: '',
    displaySize: 1080,         // DirectDisplaySize; DeviceControl ctor 0x438; allowed 540/720/1080/1440 (SetDisplaySize 0x100215a0)
    frameRate: 30,             // DirectFrameRate (the DLL's own default is 60, ctor 0x100182f0)
    controlMode: 'helper',     // live helper like the original; 'basic' = screenrecord + input
    bitRate: 7581600,          // DirectABitRate
    receiverQuality: '1080P',  // AirplayQuality
    imageFormat: 'PNG',        // Output/ImageFileFormat
    imageTo: 'Computer',       // Output/ImageTo
    videoFormat: 'MP4',        // Output/VideoFileFormat
    videoQuality: 'Standard',  // Rec/VideoQuality
    recFrameRate: 30,          // Rec/RecHighFPS
    recAudio: 'None',          // Rec/AudioInput
    openFolderOnFinish: false, // Rec/OpenFolderOnFinish
    scrollFactorX: 20,         // Control/ScrollFactorX
    scrollFactorY: 10,         // Control/ScrollFactorY
    autoFullscreen: false,     // Main/AutoFullscreen
    hotkeysEnabled: true,
    hotkeys: { ...DEFAULT_HOTKEYS },
    outputDir: path.join(app.getPath('videos'), 'MirrorDesk'),
    lanPort: 15486
  };
}

class Settings {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = defaults(app);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, hotkeys: { ...DEFAULT_HOTKEYS, ...(saved.hotkeys || {}) } };
    } catch (_) { /* first run */ }
  }
  get(key) { return key ? this.data[key] : { ...this.data }; }
  set(patch) {
    this.data = { ...this.data, ...patch };
    if (patch.hotkeys) this.data.hotkeys = { ...DEFAULT_HOTKEYS, ...patch.hotkeys };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) { /* ignore */ }
    return this.get();
  }
  resetHotkeys() { return this.set({ hotkeys: { ...DEFAULT_HOTKEYS } }); }
}

module.exports = { Settings, DEFAULT_HOTKEYS };
