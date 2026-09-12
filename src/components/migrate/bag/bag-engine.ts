/**
 * BagEngine — framework-agnostic canvas renderer + physics solver for the
 * migration "bag" interaction.
 *
 * This is a MECHANICAL PORT of scratchpad/migrate-design/_bagcore.js (the
 * shared core injected into both the desktop and mobile Data Components
 * artboards), with the per-artboard scale constants and geom() folded in
 * from Main.dc.html / Mobile.dc.html's constructors.
 *
 * The physics and rendering below took multiple rounds of numeric debugging
 * to stabilise (an endless-spin bug with three stacked causes, a RAF loop
 * that never parked, a ballistic-arc rewrite). Do NOT "improve", refactor,
 * rename, restructure, or re-derive any of it — every constant and every
 * comment is preserved verbatim from the prototype. The only changes from
 * the source are the framework-glue substitutions called out in the porting
 * brief (this.props -> this.cfg, setState/digits/art-generation/avRef
 * removed or replaced) and the minimal casts needed to satisfy TypeScript
 * strict mode on what was originally untyped, dynamically-keyed JS.
 */

export type BagVariant = "desktop" | "mobile";

export interface BagEngineConfig {
  variant: BagVariant;
  theme: "light" | "dark";
  coinDensity?: number;
  flightMs?: number;
}

/** What the bag reports as it happens. `fill` is how many coins are in the
 *  pile AFTER the event, so a listener can voice a fuller bag differently;
 *  `impact` is the landing speed in px/s, which is what makes one coin land
 *  hard and the next one barely tick. */
export type BagEvent =
  | { type: "throw"; tokenId: string; dir: 1 | -1; index: number; count: number }
  | { type: "land"; tokenId: string; fill: number; impact: number; count: number }
  | { type: "leave"; tokenId: string; fill: number };

export interface BagEngineMountOptions {
  root: HTMLElement;
  bagCanvas: HTMLCanvasElement;
  flightCanvas: HTMLCanvasElement;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the physics/render
   internals below are ported 1:1 from untyped JS; typing them precisely
   would mean re-deriving logic the porting brief explicitly forbids. */

const SCALE = {
  desktop: {
    SC: 1,
    PERSP: 940,
    FLY: {
      ms: 1040,
      rise: 175,
      riseBack: 125,
      riseVar: 90,
      zp: 190,
      zpBack: 100,
      jitter: 34,
      ceil: 26,
    },
    BW: 268,
    BH: 342,
  },
  mobile: {
    SC: 0.565,
    PERSP: 820,
    FLY: {
      ms: 950,
      rise: 120,
      riseBack: 85,
      riseVar: 60,
      zp: 150,
      zpBack: 80,
      jitter: 26,
      ceil: 20,
    },
    BW: 151,
    BH: 193,
  },
} as const;

const MAT = {
  gold: {
    a: "#fff8dd",
    b: "#ffd86e",
    c: "#f0a92c",
    d: "#b8740e",
    e: "#7a4a05",
    f: "#4a2c02",
    ring: "#cf9019",
    txt: "#6b3f04",
  },
  silver: {
    a: "#ffffff",
    b: "#e6eaf1",
    c: "#b8bec9",
    d: "#7f8691",
    e: "#4f555e",
    f: "#2e333a",
    ring: "#949aa5",
    txt: "#474d56",
  },
} as const;

export class BagEngine {
  private readonly variant: BagVariant;
  private cfg: { theme: "light" | "dark"; coinDensity?: number; flightMs?: number };

  readonly SC: number;
  readonly PERSP: number;
  readonly FLY: {
    ms: number;
    rise: number;
    riseBack: number;
    riseVar: number;
    zp: number;
    zpBack: number;
    jitter: number;
    ceil: number;
  };
  readonly BW: number;
  readonly BH: number;
  readonly MAT = MAT;

  // ---- dom / canvas ----
  private rootEl: HTMLElement | null = null;
  private bagCanvas: HTMLCanvasElement | null = null;
  private flightCanvas: HTMLCanvasElement | null = null;
  private bctx: CanvasRenderingContext2D | null = null;
  private bctxW = 0;
  private bctxH = 0;
  private fctx: CanvasRenderingContext2D | null = null;
  private fctxW = 0;
  private fctxH = 0;
  private bagOff: { x: number; y: number } | null = null;
  private weave: CanvasPattern | null = null;

  // ---- injected per-token data (art generation / refs live outside the engine) ----
  private avatarEls: Record<string, HTMLElement | null> = {};
  private artCache: Record<string, HTMLCanvasElement | null> = {};

  // ---- physics state ----
  private pile: any[] = [];
  private flights: any[] = [];
  private bands: number[] | null = null;
  private dem: number[] = [];
  private since = 0;

  // ---- animation loop state ----
  private live = false;
  private lit = 0;
  private sq = 0;
  private sqv = 0;
  private acc = 0;
  private raf = 0;
  private awake = 0;
  private last = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Set by destroy(), cleared by mount(). Hard-stops wake()/later() so a
   *  launch arriving after unmount can never restart a RAF loop or queue new
   *  timers against detached canvases. */
  private dead = false;
  private gen: Record<string, number> = {};
  private listeners: ((ev: BagEvent) => void)[] = [];
  /** Bounding box of what the flight canvas painted last frame, or null when
   *  it painted nothing. The flight canvas spans the whole widget — on a
   *  desktop it is ~2800x4000 device pixels — so clearing all of it every
   *  frame cost more than the entire physics step. Clear only what was
   *  actually drawn. */
  private fdirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private fbox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** A hidden breakpoint's engine must not simulate. Both the desktop and the
   *  phone engine are mounted at once (a display:none canvas has no box, so
   *  neither can be unmounted without losing its geometry), and before this
   *  the invisible one ran a full solver and a full-page canvas clear for
   *  nobody. */
  private active = true;

  /* ---- celebration: charge -> burst -> brand mark ----------------------
     Purely additive rendering. None of it touches the solver, the flight
     geometry or geom(); the only physics it does is nudge already-existing
     pile coins so the heap stirs while the bag charges. */
  /** Target set by setCharge(). `chargeShown` eases toward it, so a step in
   *  the run's progress reads as the bag swelling rather than as a jump. */
  private charge = 0;
  private chargeShown = 0;
  /** How long since the last stir impulse, in seconds. */
  private stir = 0;
  /** performance.now() when celebrate() fired; 0 when no burst is playing. */
  private burst0 = 0;
  /** 0..1 reveal of the brand mark. Sticky at 1 until resetCelebration(). */
  private marked = 0;
  private sparks: any[] = [];
  /** How big the bag is drawn on screen relative to its canvas (the hero
   *  lift scales it with a CSS transform). Bag-local geometry has to be
   *  multiplied by this to land in the right place on the page-sized flight
   *  canvas, or the burst fires off to one side of a scaled-up bag. */
  private view = 1;
  /** Latest frame time, so draw() can drive the shimmer without a parameter
   *  (draw() is also called from mount/resize/theme, outside the loop). */
  private tnow = 0;
  /** The noggles artwork, re-inked for cloth: see inkMark(). */
  private markInk: HTMLCanvasElement | null = null;
  private markLoading = false;
  /** The print at its on-bag size, with the cloth's light baked in. Rebuilt
   *  only when the size or the theme changes, not per frame. */
  private print: HTMLCanvasElement | null = null;
  private printKey = "";

  constructor(cfg: BagEngineConfig) {
    this.variant = cfg.variant;
    this.cfg = { theme: cfg.theme, coinDensity: cfg.coinDensity, flightMs: cfg.flightMs };
    const s = SCALE[cfg.variant];
    this.SC = s.SC;
    this.PERSP = s.PERSP;
    this.FLY = s.FLY;
    this.BW = s.BW;
    this.BH = s.BH;
    this.frame = this.frame.bind(this);
  }

  // ============================== public API ==============================

  get size(): { w: number; h: number } {
    return { w: this.BW, h: this.BH };
  }

  /** Park everything for a breakpoint that is not on screen. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.sparks = [];
      this.clearFlightCanvas();
    } else {
      this.wake();
    }
  }

  /** Tell the engine the CSS scale its bag canvas is being drawn at. */
  setView(scale: number): void {
    this.view = scale > 0 ? scale : 1;
  }

  setTheme(theme: "light" | "dark"): void {
    this.cfg.theme = theme;
    this.print = null;
    this.draw();
  }

  /** 0..1 — how charged the bag looks. Drives the build-up: the glow swells,
   *  a band of light climbs the cloth faster, the bag breathes, and the pile
   *  stirs. Under prefers-reduced-motion this is inert. */
  setCharge(charge: number): void {
    var c = charge > 1 ? 1 : charge < 0 ? 0 : charge;
    if (c > 0) this.loadMark(); // have the artwork ready before the burst
    // Under reduced motion there is no build-up at all, so the charge is never
    // even stored: storing it would leave frame() easing toward it forever and
    // the loop would never park.
    if (this.reduced()) {
      this.charge = 0;
      this.chargeShown = 0;
      return;
    }
    if (c === this.charge) return;
    this.charge = c;
    this.wake();
  }

  /** Fire the burst and brand the bag. Idempotent while one is playing. */
  celebrate(): void {
    if (this.burst0) return;
    this.loadMark();
    if (this.reduced() || !this.active) {
      // No sparks, no shimmer: straight to the marked state. Same for the
      // breakpoint that is parked off screen — it has no canvas anyone can
      // see, but it must already carry the mark if the user switches to it.
      this.marked = 1;
      this.charge = 0;
      this.chargeShown = 0;
      this.draw();
      return;
    }
    this.burst0 = performance.now();
    this.tnow = this.burst0;
    this.spawnSparks();
    this.bump(1.7);
    this.rouse();
    this.wake();
  }

  /** Back to the resting, unmarked state. */
  resetCelebration(): void {
    this.charge = 0;
    this.chargeShown = 0;
    this.burst0 = 0;
    this.marked = 0;
    this.sparks = [];
    this.draw();
    this.wake();
  }

  /** Subscribe to physical events worth hearing. The engine stays deaf and
   *  framework-agnostic: it reports what happened and by how much, and the
   *  audio layer decides whether that is a sound. Returns an unsubscribe. */
  on(fn: (ev: BagEvent) => void): () => void {
    this.listeners.push(fn);
    const self = this;
    return function () {
      self.listeners = self.listeners.filter((l) => l !== fn);
    };
  }

  private emit(ev: BagEvent): void {
    for (var i = 0; i < this.listeners.length; i++) {
      // A throwing listener must never take the render loop down with it.
      try {
        this.listeners[i](ev);
      } catch {
        /* noop */
      }
    }
  }

  registerAvatar(tokenId: string, el: HTMLElement | null): void {
    this.avatarEls[tokenId] = el;
  }

  setArt(tokenId: string, art: HTMLCanvasElement | null): void {
    this.artCache[tokenId] = art;
  }

  mount(opts: BagEngineMountOptions): void {
    this.dead = false;
    this.rootEl = opts.root;
    this.bagCanvas = opts.bagCanvas;
    this.flightCanvas = opts.flightCanvas;
    this.fitCanvas(this.bagCanvas, this.BW, this.BH, "bctx");
    if (this.rootEl && this.flightCanvas) {
      this.fitCanvas(this.flightCanvas, this.rootEl.offsetWidth, this.rootEl.offsetHeight, "fctx");
    }
    this.weave = this.makeWeave();
    this.draw();
    const self = this;
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
          self.draw();
        });
      }
    } catch {
      /* noop — matches the prototype's silent catch */
    }
  }

  destroy(): void {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.timers.forEach(function (t) {
      clearTimeout(t);
    });
    this.timers = [];
    // Drop the DOM references too: without this, a recall timer that fires
    // after unmount still found non-null nodes, built flights against a
    // detached bitmap and restarted the RAF loop for about a second.
    this.rootEl = null;
    this.bagCanvas = null;
    this.flightCanvas = null;
    this.bctx = null;
    this.fctx = null;
  }

  resize(): void {
    if (!this.bagCanvas) return;
    this.fitCanvas(this.bagCanvas, this.BW, this.BH, "bctx");
    if (this.rootEl && this.flightCanvas) {
      this.fitCanvas(this.flightCanvas, this.rootEl.offsetWidth, this.rootEl.offsetHeight, "fctx");
    }
    this.weave = this.makeWeave();
    this.draw();
  }

  /** The prototype's `activate()`: flips `state.live` and wakes the loop BEFORE
   *  the first coins are scheduled, so the bag's flat->lit crossfade leads the
   *  flight instead of starting with it (Main.dc.html:1446-1450). */
  activate(): void {
    if (this.live) return;
    this.live = true;
    this.wake();
  }

  clear(): void {
    this.pile = [];
    this.flights = [];
    this.gen = {};
    this.live = false;
    this.rouse();
    this.wake();
  }

  /** Wraps the core launch(): resolves the source element, computes the coin
   * count for this ETH amount, and defers to the ported physics/flight code. */
  launch(tokenId: string, eth: number, mark: string, dir: 1 | -1): void {
    if (!this.live) this.live = true;
    const srcEl = this.avatarEls[tokenId] || null;
    // A recall takes out exactly what the bag is holding for this token, not
    // what `coinCount(eth)` would produce now: quotes refresh between the
    // launch and the recall, and deriving n from the newer ETH left the
    // difference stranded in the pile forever. Inbound coins still in the air
    // need no recall - launchCore drops this token's flights outright.
    const n = dir > 0 ? this.coinCount(eth) : this.countInPile(tokenId);
    this.launchCore(srcEl, n, this.MAT.gold, mark, tokenId, dir);
  }

  private countInPile(tokenId: string): number {
    let n = 0;
    for (let i = 0; i < this.pile.length; i++) if (this.pile[i].tokenId === tokenId) n++;
    return n;
  }

  /* ============================ BAG CORE (ported) ============================
     Everything below is ported from _bagcore.js. Edit with the same care the
     original comment asks for: this file is now the canonical copy.
     ========================================================================= */

  private fitCanvas(el: HTMLCanvasElement | null, w: number, h: number, key: "bctx" | "fctx") {
    if (!el) return;
    // The bag is a still object and wants the full 2x. The flight canvas is
    // page-sized and only ever shows a coin in motion under a glow, where 1.5x
    // is indistinguishable and costs 2.25x fewer pixels to clear and fill.
    var cap = key === "fctx" ? 1.5 : 2;
    var dpr = Math.min(cap, window.devicePixelRatio || 1);
    el.style.width = w + "px";
    el.style.height = h + "px";
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    var ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    (this as any)[key] = ctx;
    (this as any)[key + "W"] = w;
    (this as any)[key + "H"] = h;
  }

  /* A two-way thread, stamped over the cloth. It is what makes the bag read
     as an open weave you can see coins through rather than as glass. */
  private makeWeave() {
    try {
      var p = document.createElement("canvas");
      p.width = 4;
      p.height = 4;
      var c = p.getContext("2d")!;
      c.strokeStyle = "rgba(0,0,0,0.26)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(0, 4);
      c.stroke();
      c.beginPath();
      c.moveTo(0, 2);
      c.lineTo(4, 2);
      c.stroke();
      c.strokeStyle = "rgba(255,244,222,0.11)";
      c.beginPath();
      c.moveTo(1, 0);
      c.lineTo(1, 4);
      c.stroke();
      c.beginPath();
      c.moveTo(0, 3);
      c.lineTo(4, 3);
      c.stroke();
      return this.bctx ? this.bctx.createPattern(p, "repeat") : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------ the mark */

  /* The Gnars noggles, loaded once and cached. Same origin, so no CORS
     dance; lazily, because a bag that is never celebrated never needs it. */
  private loadMark() {
    if (this.markInk || this.markLoading || typeof Image === "undefined") return;
    this.markLoading = true;
    var self = this;
    var img = new Image();
    img.onload = function () {
      try {
        self.markInk = self.inkMark(img);
      } catch {
        self.markInk = null;
      }
      self.markLoading = false;
      self.print = null;
      self.draw();
      self.wake();
    };
    img.onerror = function () {
      self.markLoading = false;
    };
    img.src = "/red_noggles.png";
  }

  /* Flat screen-bright pixels blitted onto a lit cloth bag read as a sticker.
     The artwork is pixel art in exactly three inks over transparency, so take
     it as three SHAPES — frame, lens, pupil — and refill each with a colour
     chosen for this cloth: the brand red deepened and warmed so it sits in the
     bag's light, a bone white instead of paper white, and a warm near-black.
     All three land in ONE canvas at full resolution: masks composited after
     being scaled down separately would leave hairlines between them. */
  private inkMark(img: HTMLImageElement) {
    var W = img.naturalWidth || 800;
    var H = img.naturalHeight || 300;
    var src = document.createElement("canvas");
    src.width = W;
    src.height = H;
    var sx = src.getContext("2d", { willReadFrequently: true });
    if (!sx) return null;
    sx.imageSmoothingEnabled = false;
    sx.drawImage(img, 0, 0);
    var data = sx.getImageData(0, 0, W, H).data;
    // Chosen to survive what the cloth does to the print AFTER it is laid
    // down — in particular the gold pile glow, which is composited "lighter"
    // over the whole bag and adds roughly +45R/+30G to everything under it.
    // A merely dark pupil lands at cloth value under that and reads as a hole
    // punched through the print rather than as the black of the noggles, so
    // the pupil goes near-black and the lens goes brighter to keep the pair
    // legible once the glow has had its way with both.
    var INK = ["#9c2419", "#f0e6cf", "#0a0806"];
    var out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    var ox = out.getContext("2d");
    if (!ox) return null;
    var layer = document.createElement("canvas");
    layer.width = W;
    layer.height = H;
    var lx = layer.getContext("2d");
    if (!lx) return null;
    for (var k = 0; k < 3; k++) {
      var id = lx.createImageData(W, H);
      var d = id.data;
      var any = false;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        var lum = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
        var bucket = lum > 200 ? 1 : lum < 60 ? 2 : 0;
        if (bucket !== k) continue;
        d[i + 3] = 255;
        any = true;
      }
      if (!any) continue;
      lx.globalCompositeOperation = "source-over";
      lx.clearRect(0, 0, W, H);
      lx.putImageData(id, 0, 0);
      // The PNG is only ever a stencil: source-in throws its own colours away
      // and keeps the shape, so the ink is entirely ours.
      lx.globalCompositeOperation = "source-in";
      lx.fillStyle = INK[k];
      lx.fillRect(0, 0, W, H);
      ox.drawImage(layer, 0, 0);
    }
    return out;
  }

  /* The print at its on-bag size: inked, lit, and wrapped around the belly.
     All three are baked once into a cached canvas — the bag does not move, so
     none of it costs anything per frame.

     Lighting first, via source-atop so it only ever touches the ink: the body
     gradient runs upper-left to lower-right, and the cloth turns away at both
     sides, so a diagonal pass gives the print the bag's key light and a
     horizontal pass rolls it off into the two edges.

     Then the wrap: a flat rectangle stamped on a round bag is exactly what
     reads as a sticker. Resample it in vertical strips whose screen positions
     come from sin(), so the artwork compresses toward the turn of the cloth,
     and drop each strip on a shallow parabola so the band follows the belly
     rather than cutting straight across it. */
  private printAt(pw: number, ph: number) {
    var key = Math.round(pw) + ":" + this.cfg.theme;
    if (this.print && this.printKey === key) return this.print;
    var ink = this.markInk;
    if (!ink) return null;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var bow = ph * 0.09;
    var flat = document.createElement("canvas");
    flat.width = Math.max(1, Math.round(pw * dpr));
    flat.height = Math.max(1, Math.round(ph * dpr));
    var fx = flat.getContext("2d");
    if (!fx) return null;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.drawImage(ink, 0, 0, pw, ph);
    fx.globalCompositeOperation = "source-atop";
    var lg = fx.createLinearGradient(-pw * 0.3, -ph * 0.8, pw * 1.15, ph * 1.8);
    // Kept modest: a heavier lift bleached the frame from Gnars red to a rosy
    // pink and washed the pupil up toward the cloth.
    lg.addColorStop(0, "rgba(255,240,206,0.20)");
    lg.addColorStop(0.38, "rgba(255,226,172,0.05)");
    lg.addColorStop(1, "rgba(14,9,3,0.5)");
    fx.fillStyle = lg;
    fx.fillRect(0, 0, pw, ph);
    var hg = fx.createLinearGradient(0, 0, pw, 0);
    hg.addColorStop(0, "rgba(8,5,2,0.40)");
    hg.addColorStop(0.24, "rgba(255,238,200,0.11)");
    hg.addColorStop(0.7, "rgba(0,0,0,0)");
    hg.addColorStop(1, "rgba(6,4,1,0.36)");
    fx.fillStyle = hg;
    fx.fillRect(0, 0, pw, ph);
    fx.globalCompositeOperation = "source-over";

    var c = document.createElement("canvas");
    c.width = flat.width;
    c.height = Math.max(1, Math.round((ph + bow) * dpr));
    var x = c.getContext("2d");
    if (!x) return null;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    var N = 56;
    var K = 0.92; // how far round the cloth the print is taken to sit
    var sinK = Math.sin(K);
    for (var i = 0; i < N; i++) {
      var u0 = i / N;
      var u1 = (i + 1) / N;
      var p0 = (Math.sin((u0 * 2 - 1) * K) / sinK + 1) / 2;
      var p1 = (Math.sin((u1 * 2 - 1) * K) / sinK + 1) / 2;
      var mid = u0 + u1 - 1; // -1..1 across the print
      var dy = bow * (1 - mid * mid);
      // +1 of overlap: adjacent strips must not leave a seam of bare cloth.
      x.drawImage(
        flat,
        u0 * flat.width,
        0,
        (u1 - u0) * flat.width,
        flat.height,
        p0 * pw,
        dy,
        (p1 - p0) * pw + 1 / dpr,
        ph,
      );
    }
    this.print = c;
    this.printKey = key;
    return c;
  }

  /* Where the print sits in drawLit's stack: after the coins, BEFORE the veil
     and the weave. That is what makes it a print rather than a decal — the
     cloth in front of the coins carries it, the veil sinks it toward the
     floor, the weave crosses it, the fold shadows run over it and the edge
     roll darkens it as the bag turns away. */
  private drawMark(ctx: CanvasRenderingContext2D, g: any) {
    if (this.marked <= 0.002) return;
    var H = g.yBot - g.yRim;
    // On the belly, where the cloth is widest and squarest to the camera, and
    // inset from the wall so the print never runs off the turn of the fabric.
    var yc = g.yRim + 0.52 * H;
    var hw = this.profileW(yc, g) * 0.76;
    var hh = hw * (300 / 800);
    var p = this.printAt(hw * 2, hh * 2);
    if (!p) return;
    // printAt adds the bow to the bottom of its canvas; keep its aspect.
    var dh = (hw * 2 * p.height) / p.width;
    var e = this.marked;
    // Land with a small overshoot, so the burst reads as having stamped it on.
    var pop = 1 + 0.26 * Math.sin(Math.PI * e) * (1 - e);
    ctx.save();
    // Held just under full opacity so the weave beneath is never quite gone.
    ctx.globalAlpha = ctx.globalAlpha * 0.94 * Math.min(1, e * 1.6);
    ctx.translate(g.cx, yc);
    ctx.scale(pop, pop);
    ctx.drawImage(p, -hw, -dh / 2, hw * 2, dh);
    ctx.restore();
  }

  /* ------------------------------------------------------------- sparks */

  private spawnSparks() {
    var m = this.mouthPoint();
    if (!m || !this.fctx) return;
    // Scale the whole puff with the bag: a hero-sized bag firing coin-sized
    // sparks reads as a bug, not as restraint.
    var S = this.SC * this.view;
    var i;
    for (i = 0; i < 44; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      // Kept short: this is a flourish over a receipt the user still has to
      // read, so the sparks must stay a puff around the bag, not a firework.
      var sp = (190 + Math.random() * 340) * S;
      this.sparks.push({
        x: m.x + (Math.random() - 0.5) * 30 * S,
        y: m.y + (Math.random() - 0.5) * 10 * S,
        vx: Math.cos(a) * sp * (0.85 + Math.random() * 0.5),
        vy: Math.sin(a) * sp,
        r: (1.4 + Math.random() * 2.4) * S,
        life: 0,
        ttl: 0.3 + Math.random() * 0.26,
        hot: Math.random(),
      });
    }
    // A low ring off the belly, so the whole bag reads as having fired rather
    // than just the mouth.
    var g = this.geom();
    var off = this.bagOff || { x: 0, y: 0 };
    for (i = 0; i < 18; i++) {
      var ang = Math.random() * 6.2832;
      this.sparks.push({
        x: off.x + (g.cx + Math.cos(ang) * g.Wmax * 0.62) * this.view,
        y: off.y + (g.yRim + 0.52 * (g.yBot - g.yRim)) * this.view + Math.sin(ang) * 26 * S,
        vx: Math.cos(ang) * 230 * S,
        vy: Math.sin(ang) * 170 * S - 90 * S,
        r: (1.1 + Math.random() * 1.7) * S,
        life: 0,
        ttl: 0.28 + Math.random() * 0.24,
        hot: Math.random(),
      });
    }
  }

  private updateSparks(dt: number) {
    if (!this.sparks.length) return;
    var keep = [];
    for (var i = 0; i < this.sparks.length; i++) {
      var s = this.sparks[i];
      s.life += dt;
      if (s.life >= s.ttl) continue;
      s.vy += 640 * this.SC * dt;
      s.vx *= Math.pow(0.2, dt);
      s.vy *= Math.pow(0.5, dt);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      keep.push(s);
    }
    this.sparks = keep;
  }

  /* Lives on the flight canvas, which is page-sized and cleared only where it
     painted: every spark reports its box through mark(), exactly as
     paintFlight does. */
  private drawSparks(ctx: CanvasRenderingContext2D) {
    for (var i = 0; i < this.sparks.length; i++) {
      var s = this.sparks[i];
      var u = s.life / s.ttl;
      var a = u < 0.06 ? u / 0.06 : Math.pow(1 - u, 1.4);
      var r = s.r * (1.3 - 0.6 * u);
      var R = r * 5.2;
      this.mark(s.x - R - 1, s.y - R - 1, s.x + R + 1, s.y + R + 1);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.max(0, a);
      // halo first, then a hard core — a gradient alone puts the white on a
      // single pixel and the spark reads as a smudge rather than an ember
      var gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R);
      gr.addColorStop(0, s.hot > 0.5 ? "rgba(255,206,128,0.95)" : "rgba(252,128,86,0.9)");
      gr.addColorStop(0.45, s.hot > 0.5 ? "rgba(255,166,70,0.34)" : "rgba(236,86,64,0.3)");
      gr.addColorStop(1, "rgba(255,124,40,0)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = "rgba(255,250,234,0.95)";
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 1.05, 0, 6.2832);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 0 when nothing is playing, otherwise 0..1 through the burst window. */
  private burstP() {
    if (!this.burst0) return 0;
    var p = (this.tnow - this.burst0) / 620;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  private reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {
      return false;
    }
  }

  private later(fn: () => void, ms: number) {
    if (this.dead) return;
    this.timers.push(setTimeout(fn, ms));
  }

  /* ---------------------------------------------------------- geometry */

  /* Desktop's geom() times this.SC (1 on desktop, 0.565 on the phone) —
     verified against both artboards: Mobile.dc.html's own geom() is this
     same formula with every constant pre-multiplied by SC, so a single
     implementation reproduces both without drift. */
  geom() {
    var S = this.SC;
    var fill = Math.min(1.2, this.pile.length / 30);
    var f1 = Math.min(1, fill);
    var Wmax = 95 * S;
    return {
      cx: 134 * S,
      yRim: 104 * S,
      yBot: 292 * S, // fixed: the bag only ever grows sideways
      Wmax: Wmax,
      slim: 0.7 + 0.3 * f1, // empty, the cloth hangs slack and narrow
      maxSwell: 1.16, // how far the coins may stretch one band
      nr: 0.42,
      neck: Wmax * 0.42 * (0.7 + 0.3 * f1),
      collarH: 30 * S,
      flare: 1.3,
      fs: 0.64,
      fill: f1,
    };
  }

  /* The empty bag's own shape, before any coin leans on it. Above the cinch
     the cloth gathers into the mouth; below it swells to the belly on a
     smoothstep and closes on a circular floor, so there are no corners. */
  private baseW(y: number, g: any) {
    if (y <= g.yRim) {
      var u = Math.min(1, Math.max(0, (g.yRim - y) / g.collarH));
      return g.neck * (1 + (g.flare - 1) * Math.pow(u, 0.62));
    }
    var H = g.yBot - g.yRim;
    var t = (y - g.yRim) / H;
    if (t > 1) t = 1;
    var x = Math.min(1, t / 0.5);
    var rise = g.nr + (1 - g.nr) * (x * x * x * (x * (x * 6 - 15) + 10));
    var u2 = (t - g.fs) / (1 - g.fs);
    if (u2 > 0) return g.Wmax * g.slim * rise * Math.sqrt(Math.max(0, 1 - u2 * u2));
    // Cloth is not machined: a low, fixed wobble keeps the edge from reading
    // as a turned vessel. The physics sees the same wall.
    var wob = 1 + 0.015 * Math.sin(t * 7.3 + 1.1) + 0.008 * Math.sin(t * 13.7 + 0.4);
    return g.Wmax * g.slim * rise * wob;
  }

  /* The wall the coins actually meet: the empty shape, pushed outward band by
     band by whatever is leaning on it. An empty bag hangs slack and narrow; a
     loaded one is stretched wherever the weight sits. The solver reads this
     same function, so the coins genuinely shove the cloth rather than being
     drawn inside a shape that was decided without them. */
  private profileW(y: number, g: any) {
    var base = this.baseW(y, g);
    if (y <= g.yRim || !this.bands) return base;
    var t = (y - g.yRim) / (g.yBot - g.yRim);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var NB = this.bands.length;
    var f = t * NB - 0.5;
    var i = Math.floor(f);
    var frac = f - i;
    if (i < 0) {
      i = 0;
      frac = 0;
    }
    if (i >= NB - 1) {
      i = NB - 2;
      frac = 1;
    }
    return base * (this.bands[i] * (1 - frac) + this.bands[i + 1] * frac);
  }

  /* How hard the pile presses on each band, relaxed over time so the cloth
     gives the way cloth does — late, and smoothly. */
  private updateBands(g: any) {
    var NB = 16,
      i;
    if (!this.bands) {
      this.bands = [];
      for (i = 0; i < NB; i++) this.bands.push(1);
      this.dem = [];
    }
    var H = g.yBot - g.yRim;
    for (i = 0; i < NB; i++) this.dem[i] = 0;
    for (var k = 0; k < this.pile.length; k++) {
      var c = this.pile[k];
      var t = (c.y - g.yRim) / H;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      var bi = Math.min(NB - 1, Math.floor(t * NB));
      var want = Math.abs(c.x - g.cx) + c.r * 0.92;
      if (want > this.dem[bi]) this.dem[bi] = want;
    }
    for (i = 0; i < NB; i++) {
      var y = g.yRim + ((i + 0.5) / NB) * H;
      var base = this.baseW(y, g);
      var mult = base > 1 ? this.dem[i] / base : 1;
      if (mult < 1) mult = 1;
      if (mult > g.maxSwell) mult = g.maxSwell;
      this.bands[i] += (mult - this.bands[i]) * 0.05;
    }
    for (var pass = 0; pass < 6; pass++) {
      var prev = this.bands[0];
      for (i = 1; i < NB - 1; i++) {
        var cur = this.bands[i];
        this.bands[i] = (prev + cur * 2 + this.bands[i + 1]) * 0.25;
        prev = cur;
      }
      this.bands[0] = this.bands[0] * 0.5 + this.bands[1] * 0.5;
      this.bands[NB - 1] = this.bands[NB - 1] * 0.6 + this.bands[NB - 2] * 0.4;
    }
  }

  /* The mouth is gathered cloth, so its rim ripples rather than describing a
     perfect ellipse. Everything that touches the rim samples this. */
  private mouthArc(
    ctx: CanvasRenderingContext2D,
    g: any,
    mw: number,
    a0: number,
    a1: number,
    move: boolean,
  ) {
    var yTop = g.yRim - g.collarH;
    var N = 40,
      i,
      a,
      w,
      px,
      py;
    for (i = 0; i <= N; i++) {
      a = a0 + (a1 - a0) * (i / N);
      w = 1 + 0.042 * Math.sin(a * 5 + 0.6) + 0.02 * Math.sin(a * 9 - 1.2);
      px = g.cx + Math.cos(a) * mw * w;
      py = yTop + Math.sin(a) * mw * 0.31 * w;
      if (i === 0 && move) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }

  private bagPath(ctx: CanvasRenderingContext2D, g: any) {
    var yTop = g.yRim - g.collarH;
    var mw = this.profileW(yTop, g);
    var N = 72,
      i,
      y;
    ctx.beginPath();
    this.mouthArc(ctx, g, mw, Math.PI, Math.PI * 2, true);
    for (i = 0; i <= N; i++) {
      y = yTop + (i / N) * (g.yBot - yTop);
      ctx.lineTo(g.cx + Math.max(0, this.profileW(y, g)), y);
    }
    for (i = N; i >= 0; i--) {
      y = yTop + (i / N) * (g.yBot - yTop);
      ctx.lineTo(g.cx - Math.max(0, this.profileW(y, g)), y);
    }
    ctx.closePath();
  }

  /* ----------------------------------------------------------- physics */

  private constrain(c: any, g: any) {
    var H = g.yBot - g.yRim;
    var eyC = g.yRim + g.fs * H;
    var eb = (1 - g.fs) * H;
    var yTop = g.yRim - g.collarH;
    if (c.y > eyC) {
      var a = this.profileW(eyC, g) - c.r,
        b = eb - c.r;
      if (a > 1 && b > 1) {
        var nx = (c.x - g.cx) / a,
          ny = (c.y - eyC) / b;
        var d = Math.sqrt(nx * nx + ny * ny);
        if (d > 1) {
          c.x = g.cx + (nx / d) * a;
          c.y = eyC + (ny / d) * b;
          var ux = nx / d,
            uy = ny / d;
          var vn = c.vx * ux + c.vy * uy;
          if (vn > 0) {
            c.vx -= vn * ux * 1.22;
            c.vy -= vn * uy * 1.22;
          }
          c.vx *= 0.84;
          c.vy *= 0.84;
          c.vrot *= 0.86;
        }
      }
    } else {
      var w = this.profileW(c.y, g) - c.r;
      if (w > 1) {
        if (c.x < g.cx - w) {
          c.x = g.cx - w;
          if (c.vx < 0) c.vx *= -0.18;
          c.vy *= 0.92;
        }
        if (c.x > g.cx + w) {
          c.x = g.cx + w;
          if (c.vx > 0) c.vx *= -0.18;
          c.vy *= 0.92;
        }
      }
    }
    var ceil = yTop + 9 * this.SC;
    if (c.y < ceil) {
      c.y = ceil;
      if (c.vy < 0) c.vy = 0;
    }
  }

  private step(dt: number) {
    var P = this.pile,
      g = this.geom(),
      i,
      j,
      c;
    this.updateBands(g);
    var G = 1500 * this.SC;
    // A heap of equal discs never reaches exact equilibrium — it keeps
    // shuffling by fractions of a pixel. Once nothing has entered or left for
    // a moment, ramp a damper until the pile is genuinely still.
    this.since = (this.since || 0) + dt;
    var calm = this.since > 0.5 ? Math.pow(0.015, dt * Math.min(8, (this.since - 0.5) * 2)) : 1;
    var SLEEP = 40; // quiet substeps before a coin parks (~1/3 s)
    var spinFloor = 0.3; // below this a coin is simply not turning

    for (i = 0; i < P.length; i++) {
      c = P[i];
      if (c.sleep > SLEEP) continue; // parked: no gravity, no creep, no spin
      c.vy += G * dt;
      c.vx *= calm;
      c.vy *= calm;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.vrot * dt;
      c.vrot *= Math.pow(0.06, dt) * calm;
      if (c.vrot < spinFloor && c.vrot > -spinFloor) c.vrot = 0;
      c.face += (c.faceT - c.face) * Math.min(1, dt * 5);
    }

    // Slop and zero restitution are what let a heap come to rest: correcting
    // every last fraction of a pixel, and bouncing off it, is a solver arguing
    // with itself forever.
    var slop = 0.4 * this.SC;
    for (var it = 0; it < 7; it++) {
      for (i = 0; i < P.length; i++) {
        var a = P[i];
        for (j = i + 1; j < P.length; j++) {
          var b = P[j];
          if (a.sleep > SLEEP && b.sleep > SLEEP) continue;
          var dx = b.x - a.x,
            dy = b.y - a.y;
          var min = a.r + b.r;
          var d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 === 0) continue;
          var d = Math.sqrt(d2);
          var over = min - d;
          if (over <= slop) continue;
          var nx = dx / d,
            ny = dy / d;
          var push = (over - slop) * 0.45;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
          var rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rvn < 0) {
            var imp = -rvn * 0.5; // restitution 0: coins do not bounce
            a.vx -= imp * nx;
            a.vy -= imp * ny;
            b.vx += imp * nx;
            b.vy += imp * ny;
            a.vx *= 0.94;
            a.vy *= 0.94;
            b.vx *= 0.94;
            b.vy *= 0.94;
          }
        }
      }
      for (i = 0; i < P.length; i++) this.constrain(P[i], g);
    }

    // A coin that did not move is given no velocity to keep. Without this,
    // gravity pours ~12 px/s into every resting coin each substep, the contact
    // chain only partly absorbs it, and the pile sits on a reservoir of
    // velocity it works off as a permanent shuffle — which is what kept the
    // coins turning forever. Zeroing on the spot caps the reservoir at one
    // substep of gravity, which the wall and its neighbours absorb entirely.
    var quiet = 0.13 * this.SC;
    for (i = 0; i < P.length; i++) {
      c = P[i];
      var moved = Math.abs(c.x - c.px) + Math.abs(c.y - c.py);
      c.px = c.x;
      c.py = c.y;
      if (moved < quiet) {
        c.vx = 0;
        c.vy = 0;
        c.vrot = 0;
        c.sleep = (c.sleep || 0) + 1;
      } else {
        c.sleep = 0;
      }
    }
  }

  /* Anything entering or leaving the bag makes the whole pile live again. */
  private rouse() {
    for (var i = 0; i < this.pile.length; i++) {
      var c = this.pile[i];
      c.sleep = 0;
      c.tick = 0;
      c.px = c.x;
      c.py = c.y;
    }
    this.since = 0;
  }

  private settle(steps?: number) {
    for (var i = 0; i < (steps || 220); i++) this.step(1 / 120);
  }

  /* ------------------------------------------------------------- coins */

  /* Coins per token: proportional to the ETH, square-rooted so a whale does
     not bury the screen, and hard-capped at twelve. */
  private coinCount(eth: number) {
    var d = this.cfg.coinDensity == null ? 1 : Number(this.cfg.coinDensity);
    var n = Math.round((2 + Math.sqrt(Math.max(eth, 0)) * 9) * d);
    return Math.max(3, Math.min(12, n));
  }

  private coinR() {
    return (12.2 + Math.random() * 1.4) * this.SC;
  }

  /* Production strikes each coin with the token's own image, injected via
     setArt() (see the class doc comment). */
  private artFor(tokenId: string): HTMLCanvasElement | null {
    return (this.artCache && this.artCache[tokenId]) || null;
  }

  private makePileCoin(
    x: number,
    y: number,
    vx: number,
    vy: number,
    mat: any,
    mark: string,
    tokenId: string,
  ) {
    return {
      x: x,
      y: y,
      vx: vx,
      vy: vy,
      r: this.coinR(),
      rot: Math.random() * 6.2832,
      vrot: (Math.random() - 0.5) * 8,
      face: 0.5,
      faceT: 0.4 + Math.random() * 0.58,
      mat: mat,
      mark: mark,
      tokenId: tokenId,
      sleep: 0,
      tick: 0,
      px: x,
      py: y,
      depth: Math.random(),
    };
  }

  /* Take n of this token's coins back out, topmost first, and return them.
     The prototype's dropFrom() returned only the last one and did its own
     rouse()/bump(); callers now do both, so the pile mutation can be a single
     up-front step while the shake stays per departing coin. */
  private dropFrom(tokenId: string, n: number) {
    var self = this,
      idx: number[] = [],
      i;
    for (i = 0; i < this.pile.length; i++) if (this.pile[i].tokenId === tokenId) idx.push(i);
    idx.sort(function (a, b) {
      return self.pile[a].y - self.pile[b].y;
    });
    var kill = idx.slice(0, n);
    kill.sort(function (a, b) {
      return b - a;
    });
    var taken: any[] = [];
    for (i = 0; i < kill.length; i++) taken.push(this.pile.splice(kill[i], 1)[0]);
    return taken;
  }

  private bump(k?: number) {
    this.sqv += 11 * (k == null ? 1 : k);
  }

  private paintCoin(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    face: number,
    rot: number,
    m: any,
    mark: string,
    shade: number,
    art: HTMLCanvasElement | null,
  ) {
    var f = Math.max(0.11, face);
    var ry = r * f;
    var th = r * (0.26 * (1 - f) + 0.11);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    var eg = ctx.createLinearGradient(-r, 0, r, 0);
    eg.addColorStop(0, m.d);
    eg.addColorStop(0.42, m.e);
    eg.addColorStop(1, m.f);
    ctx.beginPath();
    ctx.ellipse(0, th, r, ry, 0, 0, 6.2832);
    ctx.rect(-r, 0, r * 2, th);
    ctx.fillStyle = eg;
    ctx.fill();

    var fg = ctx.createRadialGradient(-r * 0.3, -ry * 0.44, r * 0.04, 0, 0, r * 1.14);
    fg.addColorStop(0, m.a);
    fg.addColorStop(0.24, m.b);
    fg.addColorStop(0.56, m.c);
    fg.addColorStop(0.85, m.d);
    fg.addColorStop(1, m.e);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, ry, 0, 0, 6.2832);
    ctx.fillStyle = fg;
    ctx.fill();

    ctx.lineWidth = Math.max(0.7, r * 0.085);
    ctx.strokeStyle = m.ring;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.87, ry * 0.87, 0, 0, 6.2832);
    ctx.stroke();

    ctx.lineWidth = Math.max(0.7, r * 0.1);
    ctx.strokeStyle = "rgba(255,255,255,0.52)";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.91, ry * 0.91, 0, Math.PI * 1.06, Math.PI * 1.64);
    ctx.stroke();

    if (art && f > 0.34 && r > 5) {
      var ar = r * 0.74,
        ay = ry * 0.74;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, ar, ay, 0, 0, 6.2832);
      ctx.clip();
      ctx.globalAlpha = ctx.globalAlpha * Math.min(1, (f - 0.34) / 0.2);
      ctx.drawImage(art, -ar, -ay, ar * 2, ay * 2);
      ctx.fillStyle = "rgba(255,203,104,0.13)"; // struck into the metal
      ctx.fillRect(-ar, -ay, ar * 2, ay * 2);
      ctx.restore();
      ctx.lineWidth = Math.max(0.6, r * 0.06);
      ctx.strokeStyle = "rgba(86,52,6,0.5)";
      ctx.beginPath();
      ctx.ellipse(0, 0, ar, ay, 0, 0, 6.2832);
      ctx.stroke();
    } else if (mark && f > 0.52 && r > 9) {
      ctx.save();
      ctx.scale(1, f);
      ctx.globalAlpha = ctx.globalAlpha * Math.min(1, (f - 0.52) / 0.22);
      ctx.fillStyle = m.txt;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "700 " + (r * 0.56).toFixed(1) + "px Geist, ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(mark, 0, r * 0.03);
      ctx.restore();
    }

    if (shade > 0.004) {
      ctx.beginPath();
      ctx.ellipse(0, th * 0.5, r * 1.03, ry * 1.03 + th * 0.6, 0, 0, 6.2832);
      ctx.fillStyle = "rgba(8,5,2," + shade.toFixed(3) + ")";
      ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ flight */

  private mouthPoint() {
    if (!this.rootEl || !this.bagCanvas) return null;
    var R = this.rootEl.getBoundingClientRect();
    var B = this.bagCanvas.getBoundingClientRect();
    var g = this.geom();
    this.bagOff = { x: B.left - R.left, y: B.top - R.top };
    var V = this.view;
    return {
      x: this.bagOff.x + g.cx * V,
      y: this.bagOff.y + (g.yRim - g.collarH + 6 * this.SC) * V,
    };
  }

  /* Ported from _bagcore.js's launch(); renamed launchCore because the
     public launch(tokenId, eth, mark, dir) wraps it under the same name the
     porting brief specifies for the public API. */
  private launchCore(
    srcEl: HTMLElement | null,
    n: number,
    mat: any,
    mark: string,
    tokenId: string,
    dir: 1 | -1,
  ) {
    var self = this;

    // Toggling a token twice in under a second used to leave the first
    // decision's coins in the air; they landed afterwards and the bag kept
    // coins for a token that was no longer selected. A per-token generation
    // voids them: still-flying coins are dropped and pending throws abort.
    // The bump happens FIRST, before any early return, so a call that cannot
    // animate still supersedes whatever was scheduled before it.
    this.gen = this.gen || {};
    var myGen = (this.gen[tokenId] || 0) + 1;
    this.gen[tokenId] = myGen;
    this.flights = this.flights.filter(function (f) {
      return f.tokenId !== tokenId;
    });

    // A recall empties the pile UP FRONT, in one mutation, and only the
    // visual return trip is staggered from the coins it took. Staggering the
    // pile mutation itself (one dropFrom per throw) meant a newer launch for
    // the same token bumped `gen`, the pending throws aborted before their
    // dropFrom, and the coins they would have removed were orphaned in the
    // bag with nothing left that knew about them.
    var takenList: any[] = dir < 0 ? this.dropFrom(tokenId, n) : [];
    if (takenList.length) {
      this.emit({ type: "leave", tokenId: tokenId, fill: this.pile.length });
    }
    if (takenList.length) this.rouse();

    var m = this.mouthPoint();
    // No geometry (engine unmounted) or no source row (the holdings list
    // dropped it - a wallet switch, a refetch, an error card): the pile is
    // already correct for a recall, so settle it rather than returning with
    // the coins still in the bag. An inbound launch has nowhere to fly FROM,
    // so it is simply skipped, as before.
    if (!m || !this.fctx || !this.rootEl || !srcEl) {
      if (takenList.length) {
        this.settle(280);
        this.wake();
      }
      return;
    }
    var R = this.rootEl.getBoundingClientRect();
    var S = srcEl.getBoundingClientRect();
    var sx = S.left - R.left + S.width / 2;
    var sy = S.top - R.top + S.height / 2;
    var base = this.cfg.flightMs == null ? this.FLY.ms : Number(this.cfg.flightMs);
    var g = this.geom();

    if (this.reduced()) {
      if (dir > 0) {
        for (var q = 0; q < n; q++) {
          this.pile.push(
            this.makePileCoin(
              g.cx + (Math.random() - 0.5) * g.neck,
              g.yRim - 20 * this.SC,
              0,
              0,
              mat,
              mark,
              tokenId,
            ),
          );
        }
      }
      // dir < 0 already left the pile above.
      this.settle(280);
      this.wake();
      return;
    }
    var takenIdx = 0;
    // make() runs from timers, so the loop's `var i` has already reached n by
    // the time the deferred throws fire; count the throws as they happen.
    var thrown = 0;

    var make = function () {
      if (self.gen[tokenId] !== myGen) return; // superseded by a later pick
      var jx = (Math.random() - 0.5) * self.FLY.jitter;
      var jy = (Math.random() - 0.5) * 18;
      var spin0 = Math.random() * 6.2832;
      var turns = dir > 0 ? 1.75 + Math.random() * 0.9 : 1.2 + Math.random() * 0.6;
      // Land face-on: snap the end of the turn to a half-rotation so the coin
      // always arrives showing its face, whatever angle it was born at.
      var endAng = Math.round((spin0 + turns * 6.2832) / Math.PI) * Math.PI + 0.2;
      var yA = dir > 0 ? sy + jy : m!.y;
      var yB = dir > 0 ? m!.y : sy;
      // A real throw is defined by how high it peaks, not by a bend factor.
      // Bending a curve between two endpoints put the apex at ~3/4 of the
      // flight, so the coin climbed nearly the whole way and barely dropped.
      // Pin the vertex instead and the timing falls out of the geometry, the
      // way it does for something actually thrown: rise above the destination
      // sets how long the fall lasts, and the fall is what reads as weight.
      var rise = (dir > 0 ? self.FLY.rise : self.FLY.riseBack) + Math.random() * self.FLY.riseVar;
      var yv = Math.min(yA, yB) - rise;
      if (yv < self.FLY.ceil) yv = self.FLY.ceil; // keep the apex in frame
      var h0 = Math.max(1, yA - yv);
      var h1 = Math.max(1, yB - yv);
      var s0 = Math.sqrt(h0),
        s1 = Math.sqrt(h1);
      var pk = s0 / (s0 + s1); // apex as a fraction of the flight
      var f: any = {
        x0: dir > 0 ? sx + jy * 0.6 : m!.x + jx,
        y0: yA,
        x1: dir > 0 ? m!.x + jx : sx + jx * 0.4,
        y1: yB,
        yv: yv,
        pk: pk,
        A: h0 / (pk * pk),
        zp: (dir > 0 ? self.FLY.zp : self.FLY.zpBack) + Math.random() * 110,
        dur: base + Math.random() * 240,
        t0: performance.now(),
        spin0: spin0,
        endAng: endAng,
        r: (12.8 + Math.random() * 1.4) * (0.45 + 0.55 * self.SC),
        mat: mat,
        mark: mark,
        tokenId: tokenId,
        back: dir < 0,
        // How many coins this token threw. A listener that wants to count the
        // value in the bag coin by coin needs the denominator, and by the time
        // the coin lands the volley that produced it is long out of scope.
        count: n,
        // Where the mouth was when this coin was thrown. The artboard could
        // not scroll, so the prototype froze both endpoints and was right to.
        // Here the bag sits in a sticky column (`lg:sticky` on desktop, a
        // `sticky bottom-0` bar on the phone), so it slides against the root
        // mid-flight and a frozen endpoint would land the coins where the bag
        // used to be. drawFlights re-reads the mouth each frame and carries
        // the difference; landCoin un-maps with the offset from THIS moment,
        // so the coin enters the pile at the same place either way.
        m0: { x: m!.x, y: m!.y },
        off0: { x: self.bagOff!.x, y: self.bagOff!.y },
        view0: self.view,
      };
      // A coin flying back left the pile up front (see takenList above); this
      // only picks up the rotation it had while it sat there, so the return
      // trip starts from the pose the coin was actually in.
      if (dir < 0) {
        var taken = takenList[takenIdx++];
        if (!taken) return;
        f.spin0 = taken.rot;
        self.bump(0.5);
      }
      self.flights.push(f);
      self.emit({ type: "throw", tokenId: tokenId, dir: dir, index: thrown++, count: n });
      self.wake();
    };

    for (var i = 0; i < n; i++) {
      if (i === 0) make();
      else this.later(make, i * (dir > 0 ? 62 : 52));
    }
  }

  private updateFlights(now: number) {
    var keep = [],
      i;
    for (i = 0; i < this.flights.length; i++) {
      var f = this.flights[i];
      if ((now - f.t0) / f.dur >= 1) {
        if (!f.back) this.landCoin(f);
        continue;
      }
      keep.push(f);
    }
    this.flights = keep;
  }

  private landCoin(f: any) {
    var g = this.geom();
    var off = f.off0 || this.bagOff || { x: 0, y: 0 };
    var V = f.view0 || 1;
    var sec = f.dur / 1000;
    var vy = (2 * f.A * (1 - f.pk)) / sec;
    var vx = (f.x1 - f.x0) / sec;
    var c = this.makePileCoin(
      (f.x1 - off.x) / V + (Math.random() - 0.5) * 12 * this.SC,
      (f.y1 - off.y) / V,
      (vx * 0.12 + (Math.random() - 0.5) * 50) * this.SC,
      Math.max(150 * this.SC, vy * 0.3 * this.SC),
      f.mat,
      f.mark,
      f.tokenId,
    );
    c.rot = f.endAng;
    c.face = Math.abs(Math.cos(f.endAng));
    var ceil = g.yRim - g.collarH + 10 * this.SC;
    if (c.y < ceil) c.y = ceil;
    if (this.pile.length > 60) this.pile.shift();
    this.pile.push(c);
    this.rouse();
    this.bump();
    this.emit({
      type: "land",
      tokenId: f.tokenId,
      fill: this.pile.length,
      impact: Math.abs(c.vy),
      count: f.count,
    });
  }

  /** Clears only the region the flight canvas last painted. */
  private clearFlightCanvas() {
    var ctx = this.fctx;
    if (!ctx || !this.fdirty) return;
    var d = this.fdirty;
    ctx.clearRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
    this.fdirty = null;
  }

  /** Grows this frame's painted box; paintFlight reports into it. */
  private mark(x0: number, y0: number, x1: number, y1: number) {
    var b = this.fbox;
    if (!b) {
      this.fbox = { x0: x0, y0: y0, x1: x1, y1: y1 };
      return;
    }
    if (x0 < b.x0) b.x0 = x0;
    if (y0 < b.y0) b.y0 = y0;
    if (x1 > b.x1) b.x1 = x1;
    if (y1 > b.y1) b.y1 = y1;
  }

  private drawFlights(now: number) {
    var ctx = this.fctx;
    if (!ctx) return;
    // Nothing in the air and nothing left over: touch no pixels at all. Most
    // frames of a settling pile are exactly this case.
    if (!this.flights.length && !this.sparks.length && !this.fdirty) return;
    this.clearFlightCanvas();
    this.fbox = null;
    // One measurement per frame, shared by every coin in the air; it also
    // refreshes bagOff for landCoin.
    var mNow = this.mouthPoint();
    for (var i = 0; i < this.flights.length; i++) {
      var f = this.flights[i];
      var p = (now - f.t0) / f.dur;
      if (p < 0) continue;
      if (p > 1) p = 1;
      var dx = mNow && f.m0 ? mNow.x - f.m0.x : 0;
      var dy = mNow && f.m0 ? mNow.y - f.m0.y : 0;
      this.paintFlight(ctx, f, p, 1, dx, dy);
      if (p > 0.05) this.paintFlight(ctx, f, p - 0.035, 0.2, dx, dy);
      if (p > 0.09) this.paintFlight(ctx, f, p - 0.07, 0.09, dx, dy);
    }
    this.drawSparks(ctx);
    // Read through a local: mark() mutates this.fbox inside paintFlight, which
    // the compiler cannot see from the `= null` above.
    var box = this.fbox as { x0: number; y0: number; x1: number; y1: number } | null;
    if (box) {
      // One pixel of slack absorbs the sub-pixel rounding of a clearRect.
      this.fdirty = {
        x0: Math.max(0, Math.floor(box.x0) - 1),
        y0: Math.max(0, Math.floor(box.y0) - 1),
        x1: Math.min(this.fctxW, Math.ceil(box.x1) + 1),
        y1: Math.min(this.fctxH, Math.ceil(box.y1) + 1),
      };
    }
  }

  private paintFlight(
    ctx: CanvasRenderingContext2D,
    f: any,
    p: number,
    alpha: number,
    dx?: number,
    dy?: number,
  ) {
    // Only the bag end of the arc has moved; the avatar it was thrown from
    // scrolls with the root. Weighting by progress leaves the throw's origin
    // pinned and bends the rest of the path onto the bag's new position.
    var w = f.back ? 1 - p : p;
    var x = f.x0 + (f.x1 - f.x0) * p + (dx || 0) * w;
    var y = f.A * (p - f.pk) * (p - f.pk) + f.yv + (dy || 0) * w;
    // Come closest to the camera at the top of the arc, not at half time.
    var q = p < f.pk ? p / (2 * f.pk) : 0.5 + (p - f.pk) / (2 * (1 - f.pk));
    var z = f.zp * Math.sin(Math.PI * q);
    var s = this.PERSP / (this.PERSP - z);
    var ang = f.spin0 + (f.endAng - f.spin0) * p;
    var face = Math.abs(Math.cos(ang));
    var fade = p < 0.06 ? p / 0.06 : p > 0.965 ? (1 - p) / 0.035 : 1;
    // Report what this touches so drawFlights can clear just that next frame.
    // The pad covers the coin, its 15*s glow and the ring stroke.
    var pad = f.r * s + 22 * s;
    this.mark(x - pad, y - pad, x + pad, y + pad);
    ctx.save();
    ctx.globalAlpha = alpha * Math.max(0, fade);
    if (alpha === 1) {
      ctx.shadowColor =
        f.mat === this.MAT.gold ? "rgba(255,180,60,0.55)" : "rgba(200,212,230,0.45)";
      ctx.shadowBlur = 15 * s;
    }
    this.paintCoin(
      ctx,
      x,
      y,
      f.r * s,
      face,
      ang * 0.35,
      f.mat,
      f.mark,
      Math.max(0, 0.22 * (1 - z / 300)),
      this.artFor(f.tokenId),
    );
    ctx.restore();
  }

  /* ------------------------------------------------------------ render */

  private pal() {
    var light = this.cfg.theme === "light";
    return {
      line: light ? "rgba(10,10,10,0.72)" : "rgba(250,250,250,0.5)",
      body0: light ? "#d3c4a3" : "#8a7f6b",
      body1: light ? "#a8977a" : "#5a5245",
      body2: light ? "#5f5340" : "#2a241d",
      inside: light ? "#3a2f1c" : "#171309",
      veil0: "rgba(30,24,14,0.00)",
      veil1: "rgba(30,24,14,0.13)",
      veil2: light ? "rgba(40,31,18,0.36)" : "rgba(22,17,10,0.48)",
      cord: light ? "#d6c49c" : "#c4b189",
      cordDark: light ? "#867a5d" : "#75684d",
      rimLight: "rgba(255,222,158,0.30)",
      shadow0: light ? "rgba(90,74,44,0.34)" : "rgba(0,0,0,0.66)",
      shadow1: light ? "rgba(90,74,44,0.12)" : "rgba(0,0,0,0.26)",
      shadow2: light ? "rgba(90,74,44,0)" : "rgba(0,0,0,0)",
    };
  }

  private draw() {
    var ctx = this.bctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.BW, this.BH);
    var g = this.geom();
    ctx.save();
    ctx.translate(g.cx, g.yBot);
    // The cloth breathes while it charges — on top of the squash spring, never
    // replacing it, and faster the fuller the charge.
    var br =
      this.chargeShown > 0.002
        ? 0.017 * this.chargeShown * Math.sin((this.tnow / 1000) * (3.2 + 5.4 * this.chargeShown))
        : 0;
    ctx.scale(1 + this.sq * 0.055 + br, 1 - this.sq * 0.045 - br * 0.8);
    ctx.translate(-g.cx, -g.yBot);
    if (this.lit < 0.999) {
      ctx.save();
      ctx.globalAlpha = (1 - this.lit) * 0.85;
      this.drawFlat(ctx, g);
      ctx.restore();
    }
    if (this.lit > 0.001) {
      ctx.save();
      ctx.globalAlpha = this.lit;
      this.drawLit(ctx, g);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawFlat(ctx: CanvasRenderingContext2D, g: any) {
    var P = this.pal(),
      S = this.SC;
    var yTop = g.yRim - g.collarH;
    var mw = this.profileW(yTop, g);
    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1.6 * S;
    ctx.lineJoin = "round";
    this.bagPath(ctx, g);
    ctx.stroke();
    ctx.beginPath();
    this.mouthArc(ctx, g, mw, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.cx - g.neck - 3 * S, g.yRim - 2 * S);
    ctx.bezierCurveTo(
      g.cx - g.neck * 0.5,
      g.yRim + 7 * S,
      g.cx + g.neck * 0.5,
      g.yRim + 7 * S,
      g.cx + g.neck + 3 * S,
      g.yRim - 2 * S,
    );
    ctx.stroke();
    ctx.globalAlpha = ctx.globalAlpha * 0.55;
    for (var k = -2; k <= 2; k++) {
      var f = k / 2.6;
      ctx.beginPath();
      ctx.moveTo(g.cx + g.neck * f * 0.9, g.yRim - 1 * S);
      ctx.quadraticCurveTo(
        g.cx + (g.neck * f * 0.9 + mw * f) * 0.5,
        yTop + g.collarH * 0.55,
        g.cx + mw * f * 0.97,
        yTop + mw * 0.31 * Math.sqrt(Math.max(0, 1 - f * f * 0.94)),
      );
      ctx.stroke();
    }
  }

  private drawLit(ctx: CanvasRenderingContext2D, g: any) {
    var P = this.pal(),
      S = this.SC;
    var yTop = g.yRim - g.collarH;
    var mw = this.profileW(yTop, g);
    var i, k, f;

    /* ---- ground shadow ---- */
    var shR = g.Wmax * g.slim * 1.15;
    ctx.save();
    ctx.translate(g.cx, g.yBot + 7 * S);
    ctx.scale(1, 0.17);
    var sh = ctx.createRadialGradient(0, 0, 2, 0, 0, shR);
    sh.addColorStop(0, P.shadow0);
    sh.addColorStop(0.55, P.shadow1);
    sh.addColorStop(1, P.shadow2);
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(0, 0, shR, 0, 6.2832);
    ctx.fill();
    ctx.restore();

    /* ---- the cloth ---- */
    this.bagPath(ctx, g);
    var bg = ctx.createLinearGradient(g.cx - g.Wmax * 1.05, g.yRim - 40 * S, g.cx + g.Wmax, g.yBot);
    bg.addColorStop(0, P.body0);
    bg.addColorStop(0.26, P.body1);
    bg.addColorStop(0.72, P.body2);
    bg.addColorStop(1, P.body2);
    ctx.fillStyle = bg;
    ctx.fill();

    /* ---- interior: coins, then the cloth over them ---- */
    ctx.save();
    this.bagPath(ctx, g);
    ctx.clip();

    ctx.fillStyle = P.inside;
    ctx.fillRect(0, 0, this.BW, this.BH);

    // daylight falling in through the open mouth
    var bleed = ctx.createRadialGradient(g.cx, yTop + 6 * S, 4, g.cx, yTop + 6 * S, g.Wmax * 1.7);
    bleed.addColorStop(0, "rgba(255,226,164,0.20)");
    bleed.addColorStop(0.45, "rgba(180,140,70,0.07)");
    bleed.addColorStop(1, "rgba(120,90,40,0)");
    ctx.fillStyle = bleed;
    ctx.fillRect(0, 0, this.BW, this.BH);

    var sorted = this.pile.slice().sort(function (a, b) {
      return a.depth - b.depth;
    });
    var px = 0,
      py = 0;
    for (i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      px += c.x;
      py += c.y;
      this.paintCoin(
        ctx,
        c.x,
        c.y,
        c.r,
        c.face,
        c.rot,
        c.mat,
        c.mark,
        0.4 * (1 - c.depth),
        this.artFor(c.tokenId),
      );
    }

    // the brand mark, printed on the cloth face that stands in front of the
    // coins — so everything the cloth does from here down happens to it too
    this.drawMark(ctx, g);

    // the cloth in front of the coins: nearly clear at the mouth, heavy at the floor
    var veil = ctx.createLinearGradient(0, yTop, 0, g.yBot + 10 * S);
    veil.addColorStop(0, P.veil0);
    veil.addColorStop(0.34, P.veil1);
    veil.addColorStop(1, P.veil2);
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, this.BW, this.BH);

    if (this.weave) {
      ctx.globalAlpha = ctx.globalAlpha * 0.62;
      ctx.fillStyle = this.weave;
      ctx.fillRect(0, 0, this.BW, this.BH);
      ctx.globalAlpha = this.lit;
    }

    // gold bouncing back onto the cloth — the bag warms up as it fills
    if (sorted.length > 0) {
      px /= sorted.length;
      py /= sorted.length;
      ctx.globalCompositeOperation = "lighter";
      var glow = ctx.createRadialGradient(px, py, 4, px, py, g.Wmax * 1.6);
      glow.addColorStop(0, "rgba(255,168,52," + (0.22 * g.fill + 0.05).toFixed(3) + ")");
      glow.addColorStop(0.6, "rgba(255,150,40," + (0.07 * g.fill).toFixed(3) + ")");
      glow.addColorStop(1, "rgba(255,150,40,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.BW, this.BH);
      ctx.globalCompositeOperation = "source-over";
    }

    /* ---- charging: the bag gathering power ---- */
    var ch = this.chargeShown;
    if (ch > 0.002) {
      var tt = this.tnow / 1000;
      ctx.globalCompositeOperation = "lighter";
      // a core that swells and beats faster as the charge builds
      var gy = g.yRim + 0.46 * (g.yBot - g.yRim);
      var beat = 0.76 + 0.24 * Math.sin(tt * (5 + 8 * ch));
      var cg = ctx.createRadialGradient(g.cx, gy, 2, g.cx, gy, g.Wmax * (0.85 + 1.15 * ch));
      cg.addColorStop(0, "rgba(255,216,132," + (0.34 * ch * beat).toFixed(3) + ")");
      cg.addColorStop(0.5, "rgba(255,150,50," + (0.15 * ch * beat).toFixed(3) + ")");
      cg.addColorStop(1, "rgba(255,130,40,0)");
      ctx.fillStyle = cg;
      ctx.fillRect(0, 0, this.BW, this.BH);
      // a band of light climbing the cloth, quicker and wider the fuller it is
      var span = g.yBot - yTop;
      var by = g.yBot - ((tt * (0.36 + 0.8 * ch)) % 1) * span * 1.12;
      var bh = (24 + 30 * ch) * S;
      var sgr = ctx.createLinearGradient(0, by - bh, 0, by + bh);
      sgr.addColorStop(0, "rgba(255,230,174,0)");
      sgr.addColorStop(0.5, "rgba(255,234,188," + (0.18 * ch).toFixed(3) + ")");
      sgr.addColorStop(1, "rgba(255,230,174,0)");
      ctx.fillStyle = sgr;
      ctx.fillRect(0, by - bh, this.BW, bh * 2);
      ctx.globalCompositeOperation = "source-over";
    }

    /* ---- the burst's own light on the cloth, from the inside ---- */
    var bp = this.burstP();
    if (bp > 0 && bp < 1) {
      var fl = Math.pow(1 - bp, 2.4);
      ctx.globalCompositeOperation = "lighter";
      var fy = yTop + 10 * S;
      var fr = (0.6 + 2.2 * bp) * g.Wmax;
      var fg2 = ctx.createRadialGradient(g.cx, fy, 2, g.cx, fy, fr);
      fg2.addColorStop(0, "rgba(255,252,238," + (0.85 * fl).toFixed(3) + ")");
      fg2.addColorStop(0.34, "rgba(255,196,110," + (0.34 * fl).toFixed(3) + ")");
      fg2.addColorStop(1, "rgba(255,140,50,0)");
      ctx.fillStyle = fg2;
      ctx.fillRect(0, 0, this.BW, this.BH);
      ctx.globalCompositeOperation = "source-over";
    }

    /* ---- folds, and the pucker where the weight gathers the cloth ---- */
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth = 11 * S;
    ctx.beginPath();
    ctx.moveTo(g.cx - g.neck * 0.62, g.yRim + 2 * S);
    ctx.bezierCurveTo(
      g.cx - g.Wmax * 0.78,
      g.yRim + 66 * S,
      g.cx - g.Wmax * 0.56,
      g.yBot - 42 * S,
      g.cx - g.Wmax * 0.22,
      g.yBot - 6 * S,
    );
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.cx + g.neck * 0.58, g.yRim + 4 * S);
    ctx.bezierCurveTo(
      g.cx + g.Wmax * 0.82,
      g.yRim + 72 * S,
      g.cx + g.Wmax * 0.6,
      g.yBot - 36 * S,
      g.cx + g.Wmax * 0.26,
      g.yBot - 4 * S,
    );
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,238,208,0.030)";
    ctx.lineWidth = 44 * S;
    ctx.beginPath();
    ctx.moveTo(g.cx - g.neck * 0.4, g.yRim + 8 * S);
    ctx.bezierCurveTo(
      g.cx - g.Wmax * 0.54,
      g.yRim + 74 * S,
      g.cx - g.Wmax * 0.48,
      g.yBot - 44 * S,
      g.cx - g.Wmax * 0.26,
      g.yBot - 14 * S,
    );
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 5 * S;
    for (k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(g.cx + k * g.Wmax * 0.3, g.yBot - (30 + Math.abs(k) * 5) * S);
      ctx.quadraticCurveTo(
        g.cx + k * g.Wmax * 0.2,
        g.yBot - 9 * S,
        g.cx + k * g.Wmax * 0.07,
        g.yBot - 1 * S,
      );
      ctx.stroke();
    }

    // the cloth curving away at the edges
    this.bagPath(ctx, g);
    ctx.strokeStyle = "rgba(0,0,0,0.42)";
    ctx.lineWidth = 24 * S;
    ctx.stroke();
    ctx.restore();

    /* ---- gathered collar ---- */
    ctx.save();
    this.bagPath(ctx, g);
    ctx.clip();
    for (k = -3; k <= 3; k++) {
      f = k / 3.4;
      var ey = yTop + mw * 0.31 * Math.sqrt(Math.max(0, 1 - f * f * 0.94));
      ctx.beginPath();
      ctx.moveTo(g.cx + g.neck * f * 0.88, g.yRim + 1 * S);
      ctx.quadraticCurveTo(
        g.cx + (g.neck * f * 0.88 + mw * f) * 0.5 - 3 * S,
        yTop + g.collarH * 0.58,
        g.cx + mw * f * 0.97,
        ey,
      );
      ctx.strokeStyle = "rgba(0,0,0,0.34)";
      ctx.lineWidth = 3 * S;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g.cx + g.neck * f * 0.88 + 3 * S, g.yRim + 1 * S);
      ctx.quadraticCurveTo(
        g.cx + (g.neck * f * 0.88 + mw * f) * 0.5 + 1 * S,
        yTop + g.collarH * 0.58,
        g.cx + mw * f * 0.97 + 3 * S,
        ey,
      );
      ctx.strokeStyle = "rgba(255,238,206,0.09)";
      ctx.lineWidth = 2.4 * S;
      ctx.stroke();
    }
    ctx.restore();

    /* ---- the mouth ---- */
    ctx.beginPath();
    this.mouthArc(ctx, g, mw, Math.PI, Math.PI * 2, true);
    ctx.strokeStyle = "rgba(0,0,0,0.42)";
    ctx.lineWidth = 3 * S;
    ctx.stroke();
    ctx.beginPath();
    this.mouthArc(ctx, g, mw, 0, Math.PI, true);
    var lip = ctx.createLinearGradient(g.cx - mw, 0, g.cx + mw, 0);
    lip.addColorStop(0, "#b0a289");
    lip.addColorStop(0.42, "#776c58");
    lip.addColorStop(1, "#3f3830");
    ctx.strokeStyle = lip;
    ctx.lineWidth = 3.4 * S;
    ctx.stroke();

    /* ---- rim light, lit side only: a hard ring all the way round reads as
           a rigid vessel ---- */
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, g.cx - g.Wmax * 0.18, this.BH);
    ctx.clip();
    this.bagPath(ctx, g);
    ctx.strokeStyle = P.rimLight;
    ctx.lineWidth = 1.4 * S;
    ctx.stroke();
    ctx.restore();
    this.bagPath(ctx, g);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1 * S;
    ctx.stroke();

    /* ---- the charge running the seam, and the burst's ring ---- */
    if (ch > 0.002 || (bp > 0 && bp < 1)) {
      var edge = Math.max(ch, bp > 0 && bp < 1 ? Math.pow(1 - bp, 1.6) : 0);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      this.bagPath(ctx, g);
      ctx.strokeStyle = "rgba(255,200,116," + (0.44 * edge).toFixed(3) + ")";
      ctx.lineWidth = (1.5 + 2.4 * edge) * S;
      ctx.shadowColor = "rgba(255,172,62,0.9)";
      ctx.shadowBlur = 15 * S * edge;
      ctx.stroke();
      ctx.restore();
    }

    /* ---- drawstring at the cinch ---- */
    ctx.lineCap = "round";
    var cw = g.neck + 4 * S;
    ctx.strokeStyle = P.cordDark;
    ctx.lineWidth = 5.2 * S;
    ctx.beginPath();
    ctx.moveTo(g.cx - cw, g.yRim - 3 * S);
    ctx.bezierCurveTo(
      g.cx - cw * 0.5,
      g.yRim + 8 * S,
      g.cx + cw * 0.5,
      g.yRim + 8 * S,
      g.cx + cw,
      g.yRim - 3 * S,
    );
    ctx.stroke();
    ctx.strokeStyle = P.cord;
    ctx.lineWidth = 4.4 * S;
    ctx.beginPath();
    ctx.moveTo(g.cx - cw, g.yRim - 3 * S);
    ctx.bezierCurveTo(
      g.cx - cw * 0.5,
      g.yRim + 5 * S,
      g.cx + cw * 0.5,
      g.yRim + 5 * S,
      g.cx + cw,
      g.yRim - 3 * S,
    );
    ctx.stroke();
    ctx.lineWidth = 3.2 * S;
    ctx.beginPath();
    ctx.moveTo(g.cx + cw - 2 * S, g.yRim - 1 * S);
    ctx.bezierCurveTo(
      g.cx + cw + 12 * S,
      g.yRim + 2 * S,
      g.cx + cw + 14 * S,
      g.yRim + 13 * S,
      g.cx + cw + 7 * S,
      g.yRim + 20 * S,
    );
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.cx + cw - 1 * S, g.yRim + 1 * S);
    ctx.bezierCurveTo(
      g.cx + cw + 8 * S,
      g.yRim + 9 * S,
      g.cx + cw + 16 * S,
      g.yRim + 16 * S,
      g.cx + cw + 19 * S,
      g.yRim + 24 * S,
    );
    ctx.stroke();
    ctx.fillStyle = P.cord;
    ctx.beginPath();
    ctx.ellipse(g.cx + cw - 1 * S, g.yRim + 1 * S, 5 * S, 4 * S, 0.3, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(g.cx + cw - 1 * S, g.yRim + 2.6 * S, 5 * S, 2 * S, 0.3, 0, 6.2832);
    ctx.fill();
  }

  /* -------------------------------------------------------------- loop */

  private wake() {
    if (this.dead || !this.active) return;
    this.awake = 46;
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame(now: number) {
    var dt = this.last ? Math.min(0.034, (now - this.last) / 1000) : 0.016;
    this.last = now;
    this.tnow = now;

    // Charge eases toward its target, so a step of the run swells the bag
    // instead of snapping it.
    if (Math.abs(this.chargeShown - this.charge) > 0.001) {
      this.chargeShown += (this.charge - this.chargeShown) * Math.min(1, dt * 3.4);
    } else {
      this.chargeShown = this.charge;
    }
    // The mark comes in with the burst and stays: marked only ever rises here,
    // and only resetCelebration() puts it back.
    if (this.burst0) {
      var bpr = (now - this.burst0) / 620;
      var rev = (bpr - 0.08) / 0.42;
      if (rev > this.marked) this.marked = rev > 1 ? 1 : rev;
      if (bpr >= 1) this.burst0 = 0;
    }
    this.updateSparks(dt);
    // The pile stirs while the bag charges — an impulse on one existing coin,
    // never a change to the solver.
    if (this.chargeShown > 0.05 && this.pile.length) {
      this.stir += dt;
      if (this.stir > 0.09) {
        this.stir = 0;
        var q = this.pile[(Math.random() * this.pile.length) | 0];
        q.sleep = 0;
        q.vy -= (30 + 130 * this.chargeShown) * this.SC;
        q.vx += (Math.random() - 0.5) * 70 * this.chargeShown * this.SC;
        this.since = 0;
      }
    }

    var target = this.live ? 1 : 0;
    if (Math.abs(this.lit - target) > 0.001) {
      var stepL = dt / 0.6;
      this.lit +=
        target > this.lit
          ? Math.min(stepL, target - this.lit)
          : -Math.min(stepL, this.lit - target);
      this.awake = 46;
    }

    this.sqv += (-215 * this.sq - 15.5 * this.sqv) * dt;
    this.sq += this.sqv * dt;

    this.acc += dt;
    var n = 0;
    while (this.acc >= 1 / 120 && n < 5) {
      this.step(1 / 120);
      this.acc -= 1 / 120;
      n++;
    }

    this.updateFlights(now);
    this.draw();
    this.drawFlights(now);

    // A coin with no velocity moves nothing, whatever its sleep counter says:
    // the loop must be able to park even if one coin sits on the threshold.
    var moving = 0;
    for (var i = 0; i < this.pile.length; i++) {
      var pc = this.pile[i];
      if (pc.sleep > 40) continue;
      if (Math.abs(pc.vx) + Math.abs(pc.vy) + Math.abs(pc.vrot) > 0.001) moving++;
    }
    if (this.flights.length || moving > 0 || Math.abs(this.sq) > 0.004) this.awake = 46;
    // Charging and bursting hold the loop open; a settled, marked bag is a
    // still image, so once charge is back at 0 and the sparks are gone the
    // loop parks exactly as it did before.
    else if (this.chargeShown > 0.002 || this.charge > 0 || this.burst0 || this.sparks.length)
      this.awake = 46;
    else this.awake--;

    if (this.awake > 0) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0;
      this.draw();
      this.clearFlightCanvas();
    }
  }

  /* ========================== END BAG CORE ========================== */
}
