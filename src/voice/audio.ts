// Microphone capture and speaker playback for the Voice Agent API.
// The wire format is PCM16 mono at 24 kHz in both directions. Browsers may
// ignore a requested AudioContext rate (Safari always does), so both worklets
// resample from whatever rate the context actually runs at.

export const WIRE_RATE = 24_000

const CAPTURE = `
class ToteCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / ${WIRE_RATE};
    this.pos = 0;
    this.last = 0;
    this.buf = new Float32Array(0);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const n = ch.length;
    if (this.buf.length !== n + 1) this.buf = new Float32Array(n + 1);
    this.buf[0] = this.last;
    this.buf.set(ch, 1);
    const out = new Int16Array(Math.ceil(n / this.step) + 1);
    let k = 0;
    let p = this.pos;
    while (p < n) {
      const i = Math.floor(p);
      const f = p - i;
      const v = this.buf[i] + (this.buf[i + 1] - this.buf[i]) * f;
      const c = v < -1 ? -1 : v > 1 ? 1 : v;
      out[k++] = c < 0 ? c * 0x8000 : c * 0x7fff;
      p += this.step;
    }
    this.pos = p - n;
    this.last = ch[n - 1];
    if (k) {
      const pcm = out.slice(0, k);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('tote-capture', ToteCapture);
`

// One ring buffer instead of an AudioBufferSource per chunk: no drift, no
// clicks under network jitter, and 'flush' empties it instantly on barge-in.
const PLAYBACK = `
class TotePlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(sampleRate * 60);
    this.w = 0; this.r = 0; this.avail = 0;
    this.step = ${WIRE_RATE} / sampleRate;
    this.pos = 0; this.prev = 0; this.idle = true; this.tick = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.w = this.r = this.avail = 0; this.pos = 0; this.prev = 0; return; }
      const pcm = new Int16Array(e.data);
      const n = pcm.length;
      if (!n) return;
      if (this.idle) { this.prev = 0; this.pos = 0; }
      let p = this.pos;
      while (p < n) {
        const i = Math.floor(p);
        const f = p - i;
        const a = i === 0 ? this.prev : pcm[i - 1] / 32768;
        const b = pcm[i] / 32768;
        this.push(a + (b - a) * f);
        p += this.step;
      }
      this.pos = p - n;
      this.prev = pcm[n - 1] / 32768;
    };
  }
  push(v) {
    if (this.avail >= this.ring.length) return;
    this.ring[this.w] = v;
    this.w = (this.w + 1) % this.ring.length;
    this.avail++;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    let sum = 0;
    for (let i = 0; i < ch0.length; i++) {
      if (this.avail > 0) {
        ch0[i] = this.ring[this.r];
        this.r = (this.r + 1) % this.ring.length;
        this.avail--;
        sum += ch0[i] * ch0[i];
      } else ch0[i] = 0;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    const idle = this.avail === 0;
    if (idle !== this.idle || ++this.tick % 8 === 0) {
      this.port.postMessage({ idle, level: Math.sqrt(sum / ch0.length) });
    }
    this.idle = idle;
    return true;
  }
}
registerProcessor('tote-playback', TotePlayback);
`

async function worklet(ctx: AudioContext, code: string, name: string, opts?: AudioWorkletNodeOptions) {
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(ctx, name, opts)
}

export type AudioIO = {
  /** PCM16 @ 24 kHz chunks from the microphone. */
  onChunk: (fn: (pcm: ArrayBuffer) => void) => void
  play: (pcm: ArrayBuffer) => void
  flush: () => void
  micLevel: () => number
  onSpeaker: (fn: (s: { idle: boolean; level: number }) => void) => void
  close: () => Promise<void>
}

/** Must be called from a user gesture (click) so browsers allow audio. */
export async function openAudio(deviceId?: string): Promise<AudioIO> {
  const capCtx = new AudioContext({ sampleRate: WIRE_RATE })
  const playCtx = new AudioContext({ sampleRate: WIRE_RATE })
  await Promise.all([capCtx.resume(), playCtx.resume()])

  const player = await worklet(playCtx, PLAYBACK, 'tote-playback', { outputChannelCount: [2] })
  player.connect(playCtx.destination)

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId } : {}),
      channelCount: 1,
      // The browser's echo canceller keeps the agent from hearing itself.
      echoCancellation: true,
      // The server isolates the voice (voice_focus); a second denoiser hurts accuracy.
      noiseSuppression: false,
      autoGainControl: true,
    },
  })
  const src = capCtx.createMediaStreamSource(mic)
  const capture = await worklet(capCtx, CAPTURE, 'tote-capture')
  const analyser = capCtx.createAnalyser()
  analyser.fftSize = 512
  src.connect(analyser)
  src.connect(capture)
  const levelBuf = new Float32Array(analyser.fftSize)

  let chunkFn: ((pcm: ArrayBuffer) => void) | null = null
  let speakerFn: ((s: { idle: boolean; level: number }) => void) | null = null
  capture.port.onmessage = (e) => chunkFn?.(e.data as ArrayBuffer)
  player.port.onmessage = (e) => speakerFn?.(e.data)

  return {
    onChunk: (fn) => (chunkFn = fn),
    onSpeaker: (fn) => (speakerFn = fn),
    play: (pcm) => player.port.postMessage(pcm, [pcm]),
    flush: () => player.port.postMessage('flush'),
    micLevel: () => {
      analyser.getFloatTimeDomainData(levelBuf)
      let s = 0
      for (let i = 0; i < levelBuf.length; i++) s += levelBuf[i] * levelBuf[i]
      return Math.sqrt(s / levelBuf.length)
    },
    close: async () => {
      mic.getTracks().forEach((t) => t.stop())
      capture.port.onmessage = null
      player.port.onmessage = null
      await Promise.allSettled([capCtx.close(), playCtx.close()])
    },
  }
}

export function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  }
  return btoa(bin)
}

export function fromBase64(b64: string) {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

/** Coalesce the worklet's ~5 ms frames into ~50 ms messages for the socket. */
export function batcher(minSamples: number, send: (pcm: ArrayBuffer) => void) {
  let parts: Int16Array[] = []
  let count = 0
  return (buf: ArrayBuffer) => {
    const chunk = new Int16Array(buf)
    parts.push(chunk)
    count += chunk.length
    if (count < minSamples) return
    const out = new Int16Array(count)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    parts = []
    count = 0
    send(out.buffer)
  }
}
