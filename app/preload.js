'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  // app + settings
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetHotkeys: () => ipcRenderer.invoke('settings:resetHotkeys'),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  onSettings: on('settings:changed'),
  onToast: on('app:toast'),

  // windows
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  fullscreen: (v) => ipcRenderer.invoke('win:fullscreen', v),
  topmost: (v) => ipcRenderer.invoke('win:topmost', v),
  boss: () => ipcRenderer.send('win:boss'),
  fitAspect: (a) => ipcRenderer.send('win:aspect', a),

  // adb
  devices: () => ipcRenderer.invoke('adb:devices'),
  locateAdb: () => ipcRenderer.invoke('adb:locate'),
  browseAdb: () => ipcRenderer.invoke('adb:browse'),
  downloadAdb: () => ipcRenderer.invoke('adb:download'),
  onAdbProgress: on('adb:progress'),
  connect: (host) => ipcRenderer.invoke('adb:connect', host),
  pair: (host, code) => ipcRenderer.invoke('adb:pair', { host, code }),
  toWifi: (serial) => ipcRenderer.invoke('adb:toWifi', serial),
  disconnect: (serial) => ipcRenderer.invoke('adb:disconnect', serial),

  // mirroring
  openMirror: (opts) => ipcRenderer.send('mirror:open', opts),
  onMirrorList: on('mirror:list'),
  onSenders: on('senders:update'),
  onIos: on('ios:update'),
  startAndroid: () => ipcRenderer.invoke('mirror:startAndroid'),
  stopAndroid: () => ipcRenderer.send('mirror:stopAndroid'),
  onVideo: on('mirror:data'),
  onMirrorEvent: on('mirror:event'),

  // control
  tap: (x, y) => ipcRenderer.send('ctl:tap', { x, y }),
  swipe: (x1, y1, x2, y2, ms) => ipcRenderer.send('ctl:swipe', { x1, y1, x2, y2, ms }),
  key: (name) => ipcRenderer.send('ctl:key', name),
  text: (t) => ipcRenderer.send('ctl:text', t),
  onPacket: on('mirror:packet'),
  touch: (action, x, y, w, h) => ipcRenderer.send('ctl:touch', { action, x, y, w, h }),
  keycode: (code) => ipcRenderer.send('ctl:keycode', code),
  displayPower: (on) => ipcRenderer.send('ctl:displayPower', on),

  // files
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  pushFiles: (paths) => ipcRenderer.invoke('file:push', paths),
  phoneFiles: () => ipcRenderer.invoke('file:phoneList'),
  pullFile: (name) => ipcRenderer.invoke('file:pull', name),
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return file.path || ''; } },
  sharedList: () => ipcRenderer.invoke('share:list'),
  shareAdd: () => ipcRenderer.invoke('share:add'),
  shareRemove: (id) => ipcRenderer.invoke('share:remove', id),
  onFileReceived: on('file:received'),

  // captures
  saveImage: (data, format, title) => ipcRenderer.invoke('capture:image', { data, format, title }),
  saveVideo: (data, ext, title) => ipcRenderer.invoke('capture:video', { data, ext, title }),
  openFolder: (sub) => ipcRenderer.send('capture:openFolder', sub),
  showItem: (file) => ipcRenderer.send('shell:showItem', file),
  openUrl: (url) => ipcRenderer.send('shell:openUrl', url),

  // browser sender signalling
  toSender: (msg) => ipcRenderer.send('rtc:toSender', msg),
  onSender: on('rtc:fromSender')
});
