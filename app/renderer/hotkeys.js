// Hotkey strings use the original's format: "Ctrl+Q", "Alt+1", "Ctrl++", "RButton".
(function () {
  const LABELS = {
    screenshot: 'Screenshot',
    recording: 'Start / stop recording',
    whiteboard: 'Whiteboard',
    fullscreen: 'Full screen',
    topmost: 'Keep on top',
    rotate: 'Rotate',
    simpleMode: 'Hide toolbar',
    boss: 'Hide all windows',
    back: 'Back',
    home: 'Home',
    tasks: 'Recent apps',
    screenOff: 'Phone screen on / off',
    volumeUp: 'Volume up',
    volumeDown: 'Volume down',
    send: 'Send typed text',
    newLine: 'New line',
    pauseOrPlay: 'Pause or play'
  };

  function keyName(e) {
    const k = e.key;
    if (k === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return '+';
    if (k === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') return '-';
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^Numpad\d$/.test(e.code)) return e.code.slice(6);
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (k === 'Enter') return 'Enter';
    if (k === 'Escape') return 'Esc';
    if (k === ' ') return 'Space';
    if (/^F\d{1,2}$/.test(k)) return k;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return '';
    return k.length === 1 ? k.toUpperCase() : k;
  }

  function fromEvent(e) {
    const main = keyName(e);
    if (!main) return '';
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(main);
    return parts.join('+');
  }

  function normalize(s) {
    if (!s) return '';
    // "Ctrl++" ends in the plus key; split carefully.
    let rest = String(s);
    const mods = [];
    for (;;) {
      const m = rest.match(/^(Ctrl|Alt|Shift)\+(.+)$/i);
      if (!m) break;
      mods.push(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
      rest = m[2];
    }
    const order = ['Ctrl', 'Alt', 'Shift'].filter((x) => mods.includes(x));
    return [...order, rest.length === 1 ? rest.toUpperCase() : rest].join('+');
  }

  function matches(e, hotkey) {
    if (!hotkey || hotkey === 'RButton' || hotkey === 'MButton') return false;
    return fromEvent(e) === normalize(hotkey);
  }

  window.Hotkeys = { LABELS, fromEvent, normalize, matches };
})();
