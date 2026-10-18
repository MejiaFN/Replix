// Converts the mixed stereo stream to interleaved 16-bit PCM chunks for FFmpeg.
class PcmWriter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 2400; // 50 ms at 48 kHz
    this.buf = new Int16Array(this.frames * 2);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const l = input[0];
    if (!l) return true;
    const r = input[1] || l;
    for (let i = 0; i < l.length; i++) {
      this.buf[this.pos++] = Math.max(-1, Math.min(1, l[i])) * 0x7fff;
      this.buf[this.pos++] = Math.max(-1, Math.min(1, r[i])) * 0x7fff;
      if (this.pos === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(this.frames * 2);
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-writer', PcmWriter);
