// Drives FFmpeg: a rolling replay buffer of short .ts segments, optional
// full-session recording (tee'd off the same encode), clip export and trim.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');

const SEG_SECONDS = 2;
const QUALITY = { ultra: 15, high: 18, medium: 22, low: 27 };
const VENDOR_ORDER = ['nvenc', 'amf', 'qsv', 'cpu'];
const TRACK_TITLES = { mix: 'Game + Mic', sys: 'Game', mic: 'Mic' };

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

const codecProfile = (enc) => (enc.startsWith('hevc') ? 'main' : 'high');

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
    this.emit('log', 'recording stop');
    this.audioKeys = []; // output tracks, e.g. ['mix'] or ['mix', 'sys', 'mic']
    this.pipes = {}; // audio input key -> { name, server, socket }
    this.wantRunning = false;
  }

  // Returns an FFmpeg encoder name for the chosen vendor + codec, probing the GPU
  // the first time so a missing NVENC/AMF/QSV falls back cleanly.
  async detectEncoder(s) {
    let vendor = s.encoder || 'auto';
    const legacy = /^h264_(\w+)$/.exec(vendor); // settings saved by v1.0/1.1
    if (legacy) vendor = legacy[1];
    if (vendor === 'libx264') vendor = 'cpu';
    const codec = s.codec === 'hevc' ? 'hevc' : 'h264';
    const name = (v) => (v === 'cpu' ? (codec === 'hevc' ? 'libx265' : 'libx264') : `${codec}_${v}`);
    const candidates = vendor === 'auto' ? VENDOR_ORDER : [vendor, 'cpu'];
    this._probed = this._probed || {};
    for (const v of candidates) {
      const enc = name(v);
      if (this._probed[enc] === undefined) {
        try {
          await run(this.ffmpeg, ['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '5', '-pix_fmt', 'yuv420p', '-c:v', enc, '-f', 'null', '-']);
          this._probed[enc] = true;
        } catch { this._probed[enc] = false; }
      }
      if (this._probed[enc]) return enc;
    }
    return name('cpu');
  }

  get status() {
    return {
      buffering: !!this.proc,
      recording: !!this.recordingFile,
      recordingStarted: this.recordingStarted,
      encoder: this.encoder,
      captureMode: this.captureMode,
      audioTracks: this.audioKeys.map((k) => TRACK_TITLES[k]),
    };
  }

  videoInputArgs(s, display) {
    // Convert with the BT.709 matrix (what players assume for HD video) so colors match the screen,
    // and downscale with lanczos for a sharper picture.
    // Never upscale: a cropped game window smaller than the target keeps its own size.
    const size = s.resolution === 'native' ? '' : `w=-2:h='min(ih,${s.resolution})':`;
    const scale = `,scale=${size}flags=lanczos:out_color_matrix=bt709:out_range=tv`;
    this.gpuPath = false;
    if (this.captureMode === 'ddagrab') {
      let grab = `ddagrab=output_idx=${s.monitor}:framerate=${s.fps}:draw_mouse=${s.captureCursor === false ? 0 : 1}`;
      // Game-window capture: crop to the window (coordinates relative to its monitor, physical pixels).
      if (this.crop) grab += `:offset_x=${this.crop.x}:offset_y=${this.crop.y}:video_size=${this.crop.w}x${this.crop.h}`;
      // Zero-copy: at native size NVENC takes the captured GPU frames directly and does the
      // color conversion itself, so no frames are copied through the CPU (no dropped frames at 1440p+).
      if (s.resolution === 'native' && this.encoder.endsWith('_nvenc')) {
        this.gpuPath = true;
        return { input: ['-f', 'lavfi', '-i', grab], vf: [] };
      }
      return { input: ['-f', 'lavfi', '-i', `${grab},hwdownload,format=bgra${scale},format=yuv420p`], vf: [] };
    }
    const args = ['-f', 'gdigrab', '-framerate', String(s.fps), '-draw_mouse', s.captureCursor === false ? '0' : '1'];
    if (this.crop) {
      args.push('-offset_x', String(this.crop.absX), '-offset_y', String(this.crop.absY), '-video_size', `${this.crop.w}x${this.crop.h}`);
    } else if (display) {
      const b = display.bounds, f = display.scaleFactor || 1;
      args.push('-offset_x', String(Math.round(b.x * f)), '-offset_y', String(Math.round(b.y * f)),
        '-video_size', `${Math.round(b.width * f)}x${Math.round(b.height * f)}`);
    }
    args.push('-i', 'desktop');
    return { input: args, vf: ['-vf', `${scale.slice(1)},format=yuv420p`] };
  }

  encoderArgs(s, live = true) {
    const enc = this.encoder;
    const q = String(QUALITY[s.quality] ?? 23);
    const sp = s.encoderPreset || 'balanced'; // speed | balanced | quality
    const cbr = s.rateControl === 'bitrate';
    const mbps = Number(s.bitrateMbps) || 20;
    const rate = ['-b:v', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`];
    const vendor = enc.startsWith('lib') ? 'cpu' : enc.split('_')[1];
    const args = ['-c:v', enc, '-g', String(s.fps)];
    if (vendor === 'nvenc') {
      args.push('-preset', { speed: 'p2', balanced: 'p5', quality: 'p7' }[sp], '-tune', 'hq', '-profile:v', codecProfile(enc),
        '-spatial-aq', '1', '-temporal-aq', '1', '-aq-strength', '8', '-bf', sp === 'speed' ? '0' : '2',
        ...(sp === 'quality' ? ['-multipass', 'qres', '-rc-lookahead', '20'] : []),
        ...(cbr ? ['-rc', 'cbr', ...rate] : ['-rc', 'vbr', '-cq', q, '-b:v', '0']));
    } else if (vendor === 'amf') {
      args.push('-quality', sp, ...(cbr ? ['-rc', 'cbr', ...rate] : ['-rc', 'cqp', '-qp_i', q, '-qp_p', q]));
    } else if (vendor === 'qsv') {
      args.push('-preset', { speed: 'veryfast', balanced: 'faster', quality: 'medium' }[sp], ...(cbr ? rate : ['-global_quality', q]));
    } else {
      args.push('-preset', { speed: 'superfast', balanced: 'veryfast', quality: 'fast' }[sp], '-pix_fmt', 'yuv420p', ...(cbr ? rate : ['-crf', q]));
      if (enc === 'libx264') args.push('-profile:v', 'high');
    }
    // CPU path converts with BT.709 above, so tag it; on the zero-copy path NVENC tags its own conversion.
    if (live && !this.gpuPath) args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
    if (enc.startsWith('hevc') || enc === 'libx265') args.push('-tag:v', 'hvc1');
    return args;
  }

  trackTitleArgs() {
    return this.audioKeys.flatMap((k, i) => [`-metadata:s:a:${i}`, `title=${TRACK_TITLES[k]}`, `-metadata:s:a:${i}`, `handler_name=${TRACK_TITLES[k]}`]);
  }

  // Which PCM streams the audio window should send: one pre-mixed stream, or
  // game and mic separately so they can be saved as their own tracks.
  audioInputs(s) {
    const src = [s.systemAudio && 'sys', s.mic && 'mic'].filter(Boolean);
    if (s.splitAudio && src.length === 2) return src;
    // Always at least one stream (silent if audio is off): closing it is how FFmpeg is stopped cleanly.
    return ['mix'];
  }

  // Each audio stream reaches FFmpeg through its own Windows named pipe.
  async _openPipes(keys) {
    this._closePipes();
    const id = Date.now().toString(36);
    await Promise.all(keys.map((key) => new Promise((resolve, reject) => {
      const entry = { name: `\\\\.\\pipe\\replix-${key}-${process.pid}-${id}`, socket: null };
      entry.server = net.createServer((sock) => {
        entry.socket = sock;
        sock.on('error', () => {});
        sock.on('close', () => { if (entry.socket === sock) entry.socket = null; });
      });
      entry.server.on('error', reject);
      entry.server.listen(entry.name, resolve);
      this.pipes[key] = entry;
    })));
  }

  _closePipes() {
    for (const p of Object.values(this.pipes)) {
      try { if (p.socket) p.socket.destroy(); } catch {}
      try { p.server.close(); } catch {}
    }
    this.pipes = {};
  }

  async start(settings, display) {
    this.settings = settings;
    this.display = display;
    this.wantRunning = true;
    this.encoder = await this.detectEncoder(settings);
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

    const inputs = this.audioInputs(s);
    await this._openPipes(inputs);
    this.audioKeys = inputs.length === 2 ? ['mix', ...inputs] : inputs;
    // A single track is named after what is actually in it.
    if (inputs.length === 1) this.audioKeys = s.systemAudio && s.mic ? ['mix'] : s.systemAudio ? ['sys'] : s.mic ? ['mic'] : [];
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
    for (const key of inputs) {
      // Audio timestamps come from the sample count (no wallclock stamping or resampling):
      // stamping each IPC chunk with the clock made FFmpeg stretch and drop audio, which crackled.
      args.push('-thread_queue_size', '4096',
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', this.pipes[key].name);
    }
    args.push('-map', '0:v', ...video.vf);
    if (inputs.length === 1) {
      args.push('-filter_complex', '[1:a]anull[a0]', '-map', '[a0]');
    } else if (inputs.length === 2) {
      // Track 1 = game + mic mixed (what normal players play), 2 = game only, 3 = mic only.
      args.push('-filter_complex',
        '[1:a]asplit[g1][g2];[2:a]asplit[m1][m2];[g1][m1]amix=inputs=2:normalize=0:dropout_transition=0[mix]',
        '-map', '[mix]', '-map', '[g2]', '-map', '[m2]');
    }
    // -shortest: when the audio pipes close, FFmpeg finishes the files and exits.
    args.push('-c:a', 'aac', '-b:a', `${s.audioBitrate || 160}k`, ...this.trackTitleArgs(), '-shortest');
    args.push(...this.encoderArgs(s));

    if (this.recordingFile) {
      args.push('-flags', '+global_header', '-f', 'tee',
        `[f=segment:${segOpts}]${segPath}|[f=matroska]${fwd(this.recordingFile)}`);
    } else {
      args.push('-f', 'segment', ...segOpts.split(':').flatMap((kv) => { const [k, v] = kv.split('='); return [`-${k}`, v]; }), segPath);
    }

    this.emit('log', `ffmpeg ${args.join(' ')}`);
    const startedAt = Date.now();
    const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); this.emit('log', d.toString().trim()); });
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

  writeAudio(key, buf) {
    const p = this.pipes[key];
    if (this.proc && p && p.socket && p.socket.writable) p.socket.write(buf);
  }

  _kill() {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.proc = null;
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 4000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      // Ending the audio pipes stops FFmpeg gracefully (see -shortest) so files are finalized.
      for (const p of Object.values(this.pipes)) { try { if (p.socket) p.socket.end(); } catch {} }
      try { proc.stdin.write('q'); proc.stdin.end(); } catch {}
    }).then(() => this._closePipes());
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
    this.encoder = await this.detectEncoder(settings);
    this.captureMode = 'ddagrab';
    if (this.wantRunning) { await this._kill(); this._clearBuffer(); await this._spawn(); }
  }

  async saveClip(seconds, prefix = 'Replix') {
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
    const out = path.join(s.outputDir, `${prefix}_Clip_${id}.mp4`);
    fs.writeFileSync(list, pick.map((x) => `file '${fwd(x.p)}'`).join('\n'));
    try {
      await run(this.ffmpeg, ['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', joined]);
      await run(this.ffmpeg, ['-sseof', `-${seconds}`, '-i', joined, '-map', '0', '-c', 'copy',
        ...this.trackTitleArgs(), '-movflags', '+faststart', out]);
    } finally {
      for (const f of [list, joined]) { try { fs.unlinkSync(f); } catch {} }
    }
    return out;
  }

  async startRecording(prefix = 'Replix') {
    if (this.recordingFile) return;
    if (!this.wantRunning) throw new Error('Start capture first');
    this.recordingFile = path.join(this.settings.outputDir, `${prefix}_Recording_${stamp()}.mkv`);
    this.recordingStarted = Date.now();
    this.emit('log', 'recording start');
    await this._spawn();
  }

  async stopRecording() {
    const mkv = this.recordingFile;
    if (!mkv) return null;
    this.recordingFile = null;
    this.recordingStarted = 0;
    this.emit('log', 'recording stop');
    if (this.wantRunning) await this._spawn(); else await this._kill();
    const mp4 = mkv.replace(/\.mkv$/, '.mp4');
    try {
      await run(this.ffmpeg, ['-i', mkv, '-map', '0', '-c', 'copy', '-movflags', '+faststart', mp4]);
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
    await run(this.ffmpeg, ['-ss', String(start), '-to', String(end), '-i', input, '-map', '0:v:0', '-map', '0:a?',
      ...this.encoderArgs(this.settings, false), '-c:a', 'aac', '-b:a', `${this.settings.audioBitrate || 160}k`,
      '-movflags', '+faststart', out]);
    return out;
  }

  // Editor export. opts: { start, end, gameVol, micVol, crop: 'none'|'vertical', cropX (0..1),
  // format: 'mp4'|'gif', targetMB (0 = no limit), tracks (number of audio tracks in the input) }
  async exportClip(input, opts) {
    const s = this.settings;
    const dur = Math.max(0.5, opts.end - opts.start);
    const tag = opts.format === 'gif' ? 'gif' : opts.targetMB ? `${opts.targetMB}MB` : opts.crop === 'vertical' ? 'vertical' : 'edit';
    let out = input.replace(/(\.\w+)$/, `_${tag}_${stamp()}.${opts.format === 'gif' ? 'gif' : 'mp4'}`);
    if (opts.outDir) out = path.join(opts.outDir, path.basename(out)); // e.g. a temp copy for uploading
    const vf = [];
    if (opts.crop === 'vertical') {
      // 9:16 window across the frame; cropX picks its horizontal position.
      const x = Math.min(1, Math.max(0, opts.cropX ?? 0.5));
      vf.push(`crop=trunc(ih*9/16/2)*2:ih:trunc((iw-ih*9/16)*${x.toFixed(3)}/2)*2:0`, 'scale=1080:1920:flags=lanczos');
    }
    const seek = ['-ss', String(opts.start), '-t', String(dur), '-i', input];

    if (opts.format === 'gif') {
      const g = [...vf, 'fps=15', `scale=${opts.crop === 'vertical' ? 360 : 640}:-2:flags=lanczos`].join(',');
      await run(this.ffmpeg, [...seek, '-filter_complex', `[0:v]${g},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', out]);
      return out;
    }

    // Audio: with split tracks (Game+Mic, Game, Mic) remix Game and Mic at their own volumes.
    const gv = opts.gameVol ?? 1, mv = opts.micVol ?? 1;
    let af = [];
    if (opts.tracks >= 3) af = ['-filter_complex', `[0:a:1]volume=${gv}[g];[0:a:2]volume=${mv}[m];[g][m]amix=inputs=2:normalize=0[aout]`, '-map', '[aout]'];
    else if (opts.tracks >= 1) af = ['-filter_complex', `[0:a:0]volume=${gv}[aout]`, '-map', '[aout]'];
    const audioKbps = opts.targetMB ? 128 : (s.audioBitrate || 192);

    let video;
    if (opts.targetMB) {
      // Fit to size: spread the budget over the duration (5% headroom for container overhead).
      const totalKbps = (opts.targetMB * 8192 * 0.95) / dur;
      const vk = Math.max(150, Math.floor(totalKbps - (opts.tracks ? audioKbps : 0)));
      if (vk < 1500) vf.push(`scale=-2:${vk < 700 ? 480 : 720}:flags=lanczos`);
      video = ['-c:v', 'libx264', '-preset', 'medium', '-b:v', `${vk}k`, '-maxrate', `${vk}k`, '-bufsize', `${vk * 2}k`, '-pix_fmt', 'yuv420p'];
    } else {
      video = this.encoderArgs(s, false);
    }
    await run(this.ffmpeg, [...seek, '-map', '0:v:0', ...af, ...(vf.length ? ['-vf', vf.join(',')] : []), ...video,
      ...(opts.tracks ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`] : []), '-movflags', '+faststart', out]);
    return out;
  }

  // Number of audio tracks in a file.
  async audioTrackCount(input) {
    return new Promise((resolve) => {
      execFile(this.ffmpeg, ['-hide_banner', '-i', input], { windowsHide: true }, (_e, _o, err) => {
        resolve(((err || '').match(/Stream #\d+:\d+.*?: Audio:/g) || []).length);
      });
    });
  }

  async thumbnail(input, out) {
    await run(this.ffmpeg, ['-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out])
      .catch(() => run(this.ffmpeg, ['-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]));
    return out;
  }
}

module.exports = { Recorder };
