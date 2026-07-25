/**
 * Tiny WebAudio synth: every effect is generated at play time from
 * oscillators / a cached noise buffer with short gain envelopes — no audio
 * files. A module singleton so scenes share one AudioContext and one
 * persisted mute flag.
 */

const STORAGE_KEY = 'bomberman.muted';

type OscType = OscillatorType;

class GameAudio {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted: boolean;
  private unlockInstalled = false;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable (private mode etc.) — default to unmuted */
    }
    this.muted = stored === '1';
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* non-persistent, still toggles for this session */
    }
  }

  /** Flips the mute flag and returns the new value. */
  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Browsers create AudioContexts suspended until a user gesture. Installs
   * one-time listeners that resume the context on the first pointer/key
   * input anywhere on the page.
   */
  installUnlock(): void {
    if (this.unlockInstalled) return;
    this.unlockInstalled = true;
    const resume = (): void => {
      const ctx = this.context();
      if (ctx.state === 'suspended') void ctx.resume();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  // --- effects ---

  /** Low ~100ms thump. */
  bombPlace(): void {
    this.tone({ freq: 140, endFreq: 55, duration: 0.1, type: 'sine', gain: 0.3 });
  }

  /** ~300ms noise burst through a falling lowpass. */
  explosion(): void {
    this.burst({ duration: 0.3, freq: 1200, endFreq: 120, gain: 0.3 });
  }

  /** Rising two-tone blip. */
  powerup(): void {
    this.tone({ freq: 520, duration: 0.08, type: 'square', gain: 0.15 });
    this.tone({ freq: 780, duration: 0.1, type: 'square', gain: 0.15, delay: 0.09 });
  }

  /** Descending tone. */
  death(): void {
    this.tone({ freq: 440, endFreq: 90, duration: 0.45, type: 'sawtooth', gain: 0.2 });
  }

  /** Three ascending notes (C5 E5 G5). */
  win(): void {
    this.tone({ freq: 523, duration: 0.12, type: 'triangle', gain: 0.22 });
    this.tone({ freq: 659, duration: 0.12, type: 'triangle', gain: 0.22, delay: 0.13 });
    this.tone({ freq: 784, duration: 0.22, type: 'triangle', gain: 0.22, delay: 0.26 });
  }

  /** Gun shot: a short crack of noise over a fast descending square. */
  gunShot(): void {
    this.burst({ duration: 0.08, freq: 3000, endFreq: 500, gain: 0.22 });
    this.tone({ freq: 900, endFreq: 160, duration: 0.09, type: 'square', gain: 0.16 });
  }

  /** Hammer impact: low sine thud plus a brief click of debris. */
  hammerHit(): void {
    this.tone({ freq: 180, endFreq: 45, duration: 0.18, type: 'sine', gain: 0.32 });
    this.burst({ duration: 0.06, freq: 1800, endFreq: 300, gain: 0.12 });
  }

  /** Two-tone alarm, twice. */
  suddenDeathWarning(): void {
    for (let i = 0; i < 2; i++) {
      const base = i * 0.32;
      this.tone({ freq: 880, duration: 0.15, type: 'square', gain: 0.18, delay: base });
      this.tone({ freq: 660, duration: 0.15, type: 'square', gain: 0.18, delay: base + 0.16 });
    }
  }

  // --- internals ---

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Context if audible right now; muted or still-suspended contexts skip the sound. */
  private ready(): AudioContext | null {
    if (this.muted) return null;
    const ctx = this.context();
    if (ctx.state === 'suspended') {
      // Attempt a resume (a user gesture may be in flight) but drop this sound
      // rather than queueing oscillators that would all fire at once later.
      void ctx.resume();
      return null;
    }
    return ctx;
  }

  private tone(opts: {
    freq: number;
    endFreq?: number;
    duration: number;
    type: OscType;
    gain: number;
    delay?: number;
  }): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(opts.endFreq, t0 + opts.duration);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + opts.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + opts.duration + 0.01);
  }

  /** Noise through a lowpass sweeping freq -> endFreq, with a decaying gain. */
  private burst(opts: { duration: number; freq: number; endFreq: number; gain: number }): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(opts.freq, t0);
    filter.frequency.exponentialRampToValueAtTime(opts.endFreq, t0 + opts.duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + opts.duration);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t0);
    source.stop(t0 + opts.duration);
  }

  /** Cached 0.3s white-noise buffer reused by every noise burst. */
  private noise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = Math.floor(ctx.sampleRate * 0.3);
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }
}

export const audio = new GameAudio();
