// Drives FFmpeg: a rolling replay buffer of short .ts segments, optional
// full-session recording (tee'd off the same encode), clip export and trim.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const SEG_SECONDS = 2;
const QUALITY = { high: 19, medium: 23, low: 28 };
const ENCODER_ORDER = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'];

const fwd = (p) => p.replace(/\\/g, '/');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function run(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 1 << 24 },
      (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

class Recorder extends EventEmitter {
  constructor(ffmpegPath, workDir) {
    super();
    this.ffmpeg = ffmpegPath;
    this.bufDir = path.join(workDir, 'buffer');
    this.proc = null;
    this.settings = null;
    this.encoder = null;
    this.captureMode = 'ddagrab';
    this.recordingFile = null;
    this.recordingStarted = 0;
    this.audioEnabled = false;
    this.wantRunning = false;
  }

  async detectEncoder(pref) {
    if (pref && pref !== 'auto') return pref;
    if (this._detected) return this._detected;
    for (const enc of ENCODER_ORDER) {
      try {
        await run(this.ffmpeg, ['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '5', '-pix_fmt', 'yuv420p', '-c:v', enc, '-f', 'null', '-']);
        this._detected = enc;
        return enc;
      } catch {}
    }
    return (this._detected = 'libx264');
  }

  get status() {
    return {
      buffering: !!this.proc,
      recording: !!this.recordingFile,
      recordingStarted: this.recordingStarted,
      encoder: this.encoder,
      captureMode: this.captureMode,
    };
  }

  videoInputArgs(s, display) {
    const scale = s.resolution === 'native' ? '' : `,scale=-2:${s.resolution}:flags=bicubic`;
    if (this.captureMode === 'ddagrab') {
      return { input: ['-f', 'lavfi', '-i', `ddagrab=output_idx=${s.monitor}:framerate=${s.fps}:draw_mouse=1,hwdownload,format=bgra${scale},format=yuv420p`], vf: [] };
    }
    const args = ['-f', 'gdigrab', '-framerate', String(s.fps), '-draw_mouse', '1'];
    if (display) {
      const b = display.bounds, f = display.scaleFactor || 1;
      args.push('-offset_x', String(Math.round(b.x * f)), '-offset_y', String(Math.round(b.y * f)),
        '-video_size', `${Math.round(b.width * f)}x${Math.round(b.height * f)}`);
    }
    args.push('-i', 'desktop');
    return { input: args, vf: ['-vf', `format=yuv420p${scale}`] };
  }

  encoderArgs(s) {
    const q = QUALITY[s.quality] ?? 23;
    const g = String(s.fps);
    switch (this.encoder) {
      case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-g', g, '-bf', '0'];
      case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q), '-g', g];
      case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', String(q), '-g', g];
      default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q), '-g', g, '-pix_fmt', 'yuv420p'];
    }
  }

  async start(settings, display) {
    this.settings = settings;
    this.display = display;
    this.wantRunning = true;
    this.encoder = await this.detectEncoder(settings.encoder);
    this._clearBuffer();
    await this._spawn();
  }

  // Old segments are kept across internal restarts (record start/stop) and
  // picked by mtime, so the buffer survives toggling a recording.
  _clearBuffer() {
    fs.mkdirSync(this.bufDir, { recursive: true });
    for (const f of fs.readdirSync(this.bufDir)) { try { fs.unlinkSync(path.join(this.bufDir, f)); } catch {} }
  }

  async _spawn() {
    await this._kill();
    const s = this.settings;
    fs.mkdirSync(this.bufDir, { recursive: true });

    this.audioEnabled = s.systemAudio || s.mic;
    const wrap = Math.ceil(s.bufferSeconds / SEG_SECONDS) + 3;
    const segOpts = `segment_time=${SEG_SECONDS}:segment_wrap=${wrap}:reset_timestamps=1:segment_format=mpegts`;
    // Unique name per FFmpeg run so a restart never overwrites older buffered footage;
    // segments from previous runs that fall outside the buffer window are pruned.
    const cutoff = Date.now() - (s.bufferSeconds + 10) * 1000;
    for (const f of fs.readdirSync(this.bufDir)) {
      const p = path.join(this.bufDir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
    const segPath = fwd(path.join(this.bufDir, `seg-${Date.now().toString(36)}-%03d.ts`));

    const video = this.videoInputArgs(s, this.display);
    const args = ['-hide_banner', '-loglevel', 'warning', '-y', ...video.input];
    if (this.audioEnabled) {
      args.push('-thread_queue_size', '4096', '-use_wallclock_as_timestamps', '1',
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0');
    }
    args.push('-map', '0:v', ...video.vf);
    // -shortest: closing the audio pipe ends FFmpeg gracefully (stdin is taken, so 'q' won't work).
    if (this.audioEnabled) args.push('-map', '1:a', '-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', '160k', '-shortest');
    args.push(...this.encoderArgs(s));

    if (this.recordingFile) {
      args.push('-flags', '+global_header', '-f', 'tee',
        `[f=segment:${segOpts}]${segPath}|[f=matroska]${fwd(this.recordingFile)}`);
    } else {
      args.push('-f', 'segment', ...segOpts.split(':').flatMap((kv) => { const [k, v] = kv.split('='); return [`-${k}`, v]; }), segPath);
    }

    const startedAt = Date.now();
    const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.emit('status');
      if (!this.wantRunning) return;
      // ddagrab can fail (old GPU driver, RDP session); fall back to GDI capture once.
      if (Date.now() - startedAt < 5000 && this.captureMode === 'ddagrab') {
        this.emit('log', `ddagrab failed, falling back to gdigrab:\n${errTail}`);
        this.captureMode = 'gdigrab';
        this._spawn();
      } else if (Date.now() - startedAt < 5000) {
        this.wantRunning = false;
        this.emit('error', `FFmpeg could not start capturing:\n${errTail}`);
      } else {
        this.emit('log', `FFmpeg exited (${code}), restarting:\n${errTail}`);
        setTimeout(() => this.wantRunning && this._spawn(), 1000);
      }
    });
    this.emit('status');
  }

  writeAudio(buf) {
    if (this.proc && this.audioEnabled && this.proc.stdin.writable) this.proc.stdin.write(buf);
  }

  _kill() {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.proc = null;
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 4000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      // Graceful stop so the matroska file is finalized: 'q' (no audio) or EOF on the audio pipe.
      try { if (!this.audioEnabled) proc.stdin.write('q'); proc.stdin.end(); } catch {}
    });
  }

  async stop() {
    this.wantRunning = false;
    if (this.recordingFile) await this.stopRecording();
    await this._kill();
    this.emit('status');
  }

  async restart(settings, display) {
    this.settings = settings;
    this.display = display;
    this.encoder = await this.detectEncoder(settings.encoder);
    this.captureMode = 'ddagrab';
    if (this.wantRunning) { await this._kill(); this._clearBuffer(); await this._spawn(); }
  }

  async saveClip(seconds) {
    const s = this.settings;
    if (!this.proc) throw new Error('Replay buffer is not running');
    seconds = seconds || s.bufferSeconds;
    const segs = fs.readdirSync(this.bufDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => { const p = path.join(this.bufDir, f); const st = fs.statSync(p); return { p, m: st.mtimeMs, size: st.size }; })
      .filter((x) => x.size > 0)
      .sort((a, b) => a.m - b.m);
    const need = Math.ceil(seconds / SEG_SECONDS) + 1;
    const pick = segs.slice(-need);
    if (!pick.length) throw new Error('Buffer is still empty, try again in a few seconds');

    const id = stamp();
    const list = path.join(this.bufDir, `list-${id}.txt`);
    const joined = path.join(this.bufDir, `joined-${id}.ts`);
    const out = path.join(s.outputDir, `Replix_Clip_${id}.mp4`);
    fs.writeFileSync(list, pick.map((x) => `file '${fwd(x.p)}'`).join('\n'));
    try {
      await run(this.ffmpeg, ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
      await run(this.ffmpeg, ['-sseof', `-${seconds}`, '-i', joined, '-c', 'copy', '-movflags', '+faststart', out]);
    } finally {
      for (const f of [list, joined]) { try { fs.unlinkSync(f); } catch {} }
    }
    return out;
  }

  async startRecording() {
    if (this.recordingFile) return;
    if (!this.wantRunning) throw new Error('Start capture first');
    this.recordingFile = path.join(this.settings.outputDir, `Replix_Recording_${stamp()}.mkv`);
    this.recordingStarted = Date.now();
    await this._spawn();
  }

  async stopRecording() {
    const mkv = this.recordingFile;
    if (!mkv) return null;
    this.recordingFile = null;
    this.recordingStarted = 0;
    if (this.wantRunning) await this._spawn(); else await this._kill();
    const mp4 = mkv.replace(/\.mkv$/, '.mp4');
    try {
      await run(this.ffmpeg, ['-i', mkv, '-c', 'copy', '-movflags', '+faststart', mp4]);
      fs.unlinkSync(mkv);
      return mp4;
    } catch (e) {
      this.emit('log', `Remux failed, keeping MKV: ${e.message}`);
      return mkv;
    }
  }

  async trim(input, start, end) {
    const out = input.replace(/(\.\w+)$/, `_trim_${stamp()}.mp4`);
    // Re-encode so cuts land exactly on the chosen frames.
    await run(this.ffmpeg, ['-ss', String(start), '-to', String(end), '-i', input,
      ...this.encoderArgs(this.settings), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    return out;
  }

  async thumbnail(input, out) {
    await run(this.ffmpeg, ['-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out])
      .catch(() => run(this.ffmpeg, ['-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]));
    return out;
  }
}

module.exports = { Recorder };
