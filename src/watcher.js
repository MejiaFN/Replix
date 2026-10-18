// Runs helper/watch.ps1 and turns its output into events:
//   'foreground' (window info) and 'pad' (XInput button bitmask).
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const readline = require('readline');

class Watcher extends EventEmitter {
  start() {
    const script = path.join(__dirname, 'helper', 'watch.ps1').replace('app.asar', 'app.asar.unpacked');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === 'fg') this.emit('foreground', m);
      else if (m.t === 'pad') this.emit('pad', m.b);
    });
    this.proc.on('exit', () => {
      this.proc = null;
      if (!this.stopped) setTimeout(() => this.start(), 5000); // restart if it crashes
    });
  }

  stop() {
    this.stopped = true;
    try { this.proc && this.proc.kill(); } catch {}
  }
}

// XInput button bits, for controller hotkeys.
const PAD = { up: 0x1, down: 0x2, left: 0x4, right: 0x8, start: 0x10, back: 0x20, ls: 0x40, rs: 0x80, lb: 0x100, rb: 0x200, a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000 };

// "back+a" -> bitmask
function comboMask(combo) {
  return (combo || '').split('+').reduce((m, k) => m | (PAD[k] || 0), 0);
}

module.exports = { Watcher, comboMask };
