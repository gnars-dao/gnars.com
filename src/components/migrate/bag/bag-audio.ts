/**
 * BagAudio — the voice of the bag, as an arcade coin pickup.
 *
 * Everything here is synthesised at runtime with the Web Audio API: no files,
 * no network, no dependencies, zero KB of payload. The sound is deliberately
 * 8-bit — square and pulse waves, pitches quantised to a scale, hard
 * envelopes — because the bag is a game object, not a physical object. The
 * physics the engine reports (`impact`, `fill`) is spent on loudness and on
 * TRANSPOSITION, never on filtering: retro hardware had no filter sweep, and
 * imitating one is what makes a chiptune voice sound fake.
 *
 * Cost is a design constraint, not an afterthought. A land is at most two
 * oscillators and two gains, and a coin after the first in a volley is one of
 * each — the page stutters if audio allocates a dozen nodes twelve times in
 * 700ms.
 *
 * The module is deliberately framework-free (it imports only the `BagEvent`
 * type) and touches no browser global until `resume()` is called from inside a
 * user gesture — constructing an AudioContext earlier gets it created in the
 * `suspended` state by every current browser and leaks it if the user never
 * interacts.
 */
import type { BagEvent } from "./bag-engine";

export interface BagAudio {
  /** Must be called from inside a user-gesture handler. Safe to call repeatedly. */
  resume(): Promise<void>;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Route an engine event to a voice. Cheap; may be called ~12x in 700ms. */
  handle(ev: BagEvent): void;
  /** The 2-3s completion jingle, once, when the deposit succeeds. */
  fanfare(): void;
  /** A UI click — selecting/deselecting a row, pressing select-all. */
  tick(kind?: "on" | "off"): void;
  destroy(): void;
}

type AudioCtor = typeof AudioContext;

/** The pickup motif: B5 then E6, a fourth up — the two notes every 2D
 *  platformer uses for a coin. */
const MOTIF_LOW = 83;
const MOTIF_HIGH = 88;

/** Major pentatonic, in semitones from E6. A run of coins walks UP this and
 *  wraps, the way a chain of rings sounds when you collect them in a row.
 *  It stops at +9 and starts over: a 12-coin volley that kept climbing hit
 *  3.5 kHz by the eighth coin, which is a shriek, not a pickup. */
const RUN_STEPS = [0, 2, 4, 7, 9];

/** Another land within this gap belongs to the same volley and continues the
 *  ascending run; after it, the next coin starts a fresh motif. */
const VOLLEY_GAP = 0.4;

const MAX_VOICES = 7;
/** Two lands closer than this collapse into one smeared, clipping mess; nudging
 *  the second one forward makes them read as a single thicker hit instead. */
const MIN_LAND_GAP = 0.025;
const PILE_CAP = 60;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** MIDI note -> Hz. Every pitch in this module goes through here, so nothing
 *  can accidentally end up between semitones. */
function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Cheap deterministic string hash (FNV-1a). Used only to pick a pitch. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createBagAudio(): BagAudio | null {
  // SSR and old/blocked browsers: hand the caller a null it can no-op on,
  // rather than throwing during render.
  if (typeof window === "undefined") return null;
  const found: AudioCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!found) return null;
  const Ctor: AudioCtor = found;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let comp: DynamicsCompressorNode | null = null;
  /** The 25%-duty pulse — that thin, nasal NES timbre. Built once per context
   *  and shared by every voice that uses it; a PeriodicWave is expensive to
   *  compute and completely immutable, so there is never a reason for two. */
  let pulse: PeriodicWave | null = null;
  /** The bus the current jingle plays on, so a second call can supersede it. */
  let fanGain: GainNode | null = null;
  let muted = false;
  let dead = false;
  /** End times of the voices currently sounding; pruned lazily so the voice
   *  cap costs no timers. */
  let voices: number[] = [];
  /** Live sources, so destroy() can silence a tail that is still ringing. */
  const live = new Set<AudioScheduledSourceNode>();
  let lastLand = -1;
  /** How far up the run the current volley has walked. Reset by a gap. */
  let runStep = 0;

  function ensure(): AudioContext | null {
    if (dead) return null;
    if (ctx) return ctx;
    let made: AudioContext;
    try {
      made = new Ctor();
    } catch {
      // No audio device, or the context limit was hit — stay silent forever
      // rather than retrying on every event.
      dead = true;
      return null;
    }
    const g = made.createGain();
    // Low by design: twelve voices land inside 700ms and the compressor should
    // be shaping the sum, not rescuing it.
    g.gain.value = muted ? 0 : 0.22;
    const c = made.createDynamicsCompressor();
    c.threshold.value = -18;
    c.knee.value = 24;
    c.ratio.value = 8;
    c.attack.value = 0.003;
    c.release.value = 0.14;
    g.connect(c);
    c.connect(made.destination);
    ctx = made;
    master = g;
    comp = c;
    return ctx;
  }

  /** Fourier series of a 25%-duty pulse: a_n = (2/nπ)·sin(nπd). */
  function pulseWave(ac: AudioContext): PeriodicWave {
    if (pulse) return pulse;
    const n = 24;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      imag[k] = ((2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25)) / 1.2;
    }
    pulse = ac.createPeriodicWave(real, imag, { disableNormalization: false });
    return pulse;
  }

  /** Reserve a slot, or refuse. Past the cap we DROP the voice — queueing it
   *  would only make the pile-up audible a beat later. */
  function take(now: number, until: number): boolean {
    if (voices.length) voices = voices.filter((t) => t > now);
    if (voices.length >= MAX_VOICES) return false;
    voices.push(until);
    return true;
  }

  function track(node: AudioScheduledSourceNode): void {
    live.add(node);
    node.onended = () => {
      live.delete(node);
      node.disconnect();
    };
  }

  /**
   * One quantised note: an oscillator and a gain, nothing else.
   *
   * The envelope is hard on purpose — instant attack, a flat hold, then an
   * exponential drop — which is what a 4-bit volume register actually did. It
   * still ends at a TRUE zero before the node stops: a source stopped at
   * non-zero amplitude is an audible click, and twelve of those in a volley is
   * the whole illusion gone.
   */
  function note(
    ac: AudioContext,
    out: AudioNode,
    midi: number,
    t0: number,
    dur: number,
    peak: number,
    hold: number,
    thin: boolean,
  ): number {
    const osc = ac.createOscillator();
    if (thin) osc.setPeriodicWave(pulseWave(ac));
    else osc.type = "square";
    osc.frequency.value = hz(midi);
    const g = ac.createGain();
    osc.connect(g);
    g.connect(out);

    const end = t0 + dur;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.0012);
    g.gain.setValueAtTime(peak, t0 + dur * hold);
    g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.0006, 1e-5), end);
    g.gain.linearRampToValueAtTime(0, end + 0.006);

    const stop = end + 0.01;
    track(osc);
    osc.start(t0);
    osc.stop(stop);
    return stop;
  }

  function land(ev: Extract<BagEvent, { type: "land" }>): void {
    const ac = ensure();
    if (!ac || !master) return;

    // Impact is the landing speed in px/s (~150 soft, ~900 hard): a coin that
    // barely drops is a quieter blip, nothing more.
    const hit = clamp((ev.impact - 140) / 720, 0, 1);
    // A fuller bag TRANSPOSES the run down — up to an octave — rather than
    // being muffled. Filtering it would stop sounding like a game.
    const load = clamp(ev.fill / PILE_CAP, 0, 1);
    const drop = Math.round(load * 12);
    const amp = 0.12 + 0.3 * hit;

    const now = ac.currentTime;
    const start = Math.max(now + 0.001, lastLand + MIN_LAND_GAP);
    // A gap means this coin opens a new volley; inside a volley the run keeps
    // climbing from wherever the last coin left it.
    const fresh = lastLand < 0 || start - lastLand > VOLLEY_GAP;

    if (fresh) {
      if (!take(now, start + 0.42)) return;
      lastLand = start;
      runStep = 0;
      // The pickup itself: a short low note, then the fourth above it ringing
      // out. The high note is the thin pulse — it is the one you hear.
      const first = 0.08;
      note(ac, master, MOTIF_LOW - drop, start, first, amp * 0.85, 0.5, false);
      note(ac, master, MOTIF_HIGH - drop, start + first * 0.9, 0.26, amp, 0.28, true);
      return;
    }

    if (!take(now, start + 0.16)) return;
    lastLand = start;
    runStep += 1;
    // Every coin after the first is a single blip a step further up the
    // pentatonic — the sound of collecting a row, not twelve motifs at once.
    const step = RUN_STEPS[runStep % RUN_STEPS.length];
    // The token id only offsets WHICH rung the run starts on, so two different
    // tokens picked in sequence do not sound like the same run replayed.
    const bias = hash(ev.tokenId) % 3;
    note(ac, master, MOTIF_HIGH + step + bias - drop, start, 0.09, amp * 0.9, 0.42, true);
  }

  function throwAir(ev: Extract<BagEvent, { type: "throw" }>): void {
    const ac = ensure();
    if (!ac || !master) return;
    const t0 = ac.currentTime + 0.001;
    if (!take(ac.currentTime, t0 + 0.1)) return;
    // One note, stepped rather than glided (hardware could not glide): up on
    // the way out, down on the way back. It fires as often as a land, so it
    // sits ~11 dB under one — present, never competing.
    const base = ev.dir > 0 ? 76 : 83;
    const osc = ac.createOscillator();
    osc.type = "square";
    const dur = 0.05;
    osc.frequency.setValueAtTime(hz(base), t0);
    osc.frequency.setValueAtTime(hz(ev.dir > 0 ? base + 5 : base - 5), t0 + dur * 0.5);
    const g = ac.createGain();
    osc.connect(g);
    g.connect(master);
    const end = t0 + dur;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.0012);
    g.gain.setValueAtTime(0.16, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(1e-4, end);
    g.gain.linearRampToValueAtTime(0, end + 0.006);
    track(osc);
    osc.start(t0);
    osc.stop(end + 0.01);
  }

  function leave(ev: Extract<BagEvent, { type: "leave" }>): void {
    const ac = ensure();
    if (!ac || !master) return;
    const t0 = ac.currentTime + 0.001;
    if (!take(ac.currentTime, t0 + 0.3)) return;
    // "Lost a coin": the pickup run played backwards. The engine emits this
    // once per recall, not per coin, so it is one gesture for the whole volley.
    const drop = Math.round(clamp(ev.fill / PILE_CAP, 0, 1) * 5);
    const seqNotes = [MOTIF_HIGH - drop, MOTIF_HIGH - 5 - drop, MOTIF_LOW - 5 - drop];
    let t = t0;
    for (let i = 0; i < seqNotes.length; i++) {
      const last = i === seqNotes.length - 1;
      const dur = last ? 0.18 : 0.07;
      note(ac, master, seqNotes[i], t, dur, last ? 0.2 : 0.17, last ? 0.3 : 0.6, false);
      t += dur * 0.9;
    }
    // A recall empties the pile, so the next coin in must open a fresh motif.
    lastLand = -1;
    runStep = 0;
  }

  /* The payoff at the end of the whole flow. Every note is scheduled ahead on
     the audio clock as one block rather than fired from timers: transaction
     confirmation is exactly when the main thread janks, and a jingle whose
     rhythm falls apart at that moment is worse than no jingle. */
  function fanfareVoice(): void {
    const ac = ensure();
    if (!ac || !master) return;

    // Supersede rather than stack — two overlapping fanfares read as a fault.
    if (fanGain) {
      const old = fanGain;
      const now = ac.currentTime;
      old.gain.cancelScheduledValues(now);
      old.gain.setValueAtTime(old.gain.value, now);
      old.gain.linearRampToValueAtTime(0, now + 0.05);
    }
    const bus = ac.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    fanGain = bus;

    const t0 = ac.currentTime + 0.02;
    // Ascending run, dotted rather than four even notes: the held fourth note
    // and the B-C lift are what make it read as arrival instead of a scale.
    const run: [number, number, number][] = [
      [72, 0.1, 0.0], // C5
      [76, 0.1, 0.09],
      [79, 0.1, 0.18],
      [84, 0.17, 0.27], // C6, held a touch longer
      [83, 0.08, 0.45], // B5 — the lean before the resolve
      [84, 0.12, 0.53],
    ];
    for (const [midi, dur, at] of run) {
      note(ac, bus, midi, t0 + at, dur, 0.34, 0.55, at >= 0.45);
    }
    // Held major triad. Three voices at once, so each sits well below a single
    // note's level; together they are still the loudest thing the bag plays.
    for (const midi of [84, 88, 91]) {
      note(ac, bus, midi, t0 + 0.63, 1.68, 0.2, 0.42, true);
    }
  }

  function click(kind: "on" | "off"): void {
    const ac = ensure();
    if (!ac || !master) return;
    const t0 = ac.currentTime + 0.001;
    // Menu blip: "on" a fourth above "off", both far too short to have pitch
    // presence — they read as a click with a colour.
    note(ac, master, kind === "on" ? 93 : 88, t0, kind === "on" ? 0.026 : 0.032, 0.5, 0.6, true);
  }

  return {
    async resume() {
      // Runs even while muted: the gesture is the only moment a context can be
      // created unsuspended, and unmuting later is not a gesture.
      const ac = ensure();
      if (!ac) return;
      if (ac.state !== "running") {
        try {
          await ac.resume();
        } catch {
          /* the gesture was not trusted; the next one will try again */
        }
      }
    },
    setMuted(next: boolean) {
      muted = next;
      if (master && ctx) {
        // Ramp rather than jump: a gain step lands as a click of its own.
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(next ? 0 : 0.22, t + 0.04);
      }
    },
    isMuted() {
      return muted;
    },
    handle(ev: BagEvent) {
      // Muted means silent AND idle — nothing is scheduled at all.
      if (muted || dead) return;
      if (ev.type === "land") land(ev);
      else if (ev.type === "throw") throwAir(ev);
      else leave(ev);
    },
    fanfare() {
      // Exempt from the voice cap like `tick`: it is a deliberate one-shot at
      // the end of the flow, never spammed, and dropping it because coins are
      // still settling would lose the one moment that earns a sound.
      if (muted || dead) return;
      fanfareVoice();
    },
    tick(kind: "on" | "off" = "on") {
      if (muted || dead) return;
      click(kind);
    },
    destroy() {
      dead = true;
      for (const node of live) {
        try {
          node.onended = null;
          node.stop();
        } catch {
          /* already stopped */
        }
        try {
          node.disconnect();
        } catch {
          /* already detached */
        }
      }
      live.clear();
      voices = [];
      fanGain = null;
      lastLand = -1;
      runStep = 0;
      try {
        master?.disconnect();
        comp?.disconnect();
      } catch {
        /* already detached */
      }
      const closing = ctx;
      ctx = null;
      master = null;
      comp = null;
      pulse = null;
      void closing?.close().catch(() => {});
    },
  };
}
