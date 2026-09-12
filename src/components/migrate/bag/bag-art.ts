/**
 * Coin-face artwork for the migration "bag" canvas.
 *
 * Ported from the prototype's `_bagcore.js` (`seeded`, `shade`,
 * `makeTokenArt`). Production strikes each coin with the token's own image —
 * `coin.logoUrl` off the Zora SDK, the same source the list avatars already
 * use. An artboard has no network, so the prototype generates stand-in
 * artwork per token instead: same pipeline, same draw call, only the pixels
 * differ. `loadTokenArt` is that swap: it loads `logoUrl` into an <img> and
 * draws it into the same 88x88 canvas the procedural pipeline builds, and
 * falls back to `proceduralArt` on any failure so a coin never renders blank.
 */

const ART_SIZE = 88;
const LOAD_TIMEOUT_MS = 6000;

/** Seeded PRNG (FNV-1a hash seed, xorshift32 stream), verbatim from the prototype. */
function seeded(str: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/** Lighten (amt > 0) or darken (amt < 0) a `#rrggbb` hex colour, verbatim from the prototype. */
function shade(hex: string, amt: number): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255,
    g = (v >> 8) & 255,
    b = v & 255;
  const t = amt > 0 ? 255 : 0,
    k = Math.abs(amt);
  return (
    "rgb(" +
    Math.round(r + (t - r) * k) +
    "," +
    Math.round(g + (t - g) * k) +
    "," +
    Math.round(b + (t - b) * k) +
    ")"
  );
}

/**
 * Procedural stand-in coin art: a tinted gradient disc stamped with 2-3
 * random marks (blob, ring, band, or triangle), seeded off `key` so the same
 * token always renders the same art. Ported verbatim from `makeTokenArt` in
 * `_bagcore.js` — do not restyle or re-derive the numeric constants below.
 */
export function proceduralArt(tint: string, key: string): HTMLCanvasElement | null {
  try {
    const S = ART_SIZE;
    const cv = document.createElement("canvas");
    cv.width = S;
    cv.height = S;
    const x = cv.getContext("2d");
    if (!x) return null;
    const rnd = seeded(key || tint);
    const bg = x.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, shade(tint, 0.4));
    bg.addColorStop(0.55, tint);
    bg.addColorStop(1, shade(tint, -0.45));
    x.fillStyle = bg;
    x.fillRect(0, 0, S, S);
    const marks = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < marks; i++) {
      const kind = Math.floor(rnd() * 4);
      x.save();
      x.translate(S / 2, S / 2);
      x.rotate(rnd() * 6.2832);
      x.globalAlpha = 0.34 + rnd() * 0.5;
      x.fillStyle = rnd() > 0.5 ? shade(tint, 0.85) : shade(tint, -0.8);
      x.strokeStyle = x.fillStyle;
      if (kind === 0) {
        x.beginPath();
        x.arc((rnd() - 0.5) * 34, (rnd() - 0.5) * 34, 10 + rnd() * 20, 0, 6.2832);
        x.fill();
      } else if (kind === 1) {
        x.lineWidth = 4 + rnd() * 7;
        x.beginPath();
        x.arc(0, 0, 16 + rnd() * 18, 0, 3.6);
        x.stroke();
      } else if (kind === 2) {
        x.fillRect(-S, -6 - rnd() * 10, S * 2, 8 + rnd() * 14);
      } else {
        x.beginPath();
        x.moveTo(0, -14 - rnd() * 16);
        x.lineTo(16 + rnd() * 12, 14 + rnd() * 10);
        x.lineTo(-16 - rnd() * 12, 14 + rnd() * 10);
        x.closePath();
        x.fill();
      }
      x.restore();
    }
    return cv;
  } catch {
    return null;
  }
}

/**
 * Stable, pleasant, saturated hue derived from a key (address/id) — the
 * production replacement for the prototype's hand-picked per-sample tint.
 *
 * MUST return `#rrggbb`: `shade()` above is ported verbatim and parses the
 * string with `parseInt(hex.slice(1), 16)`. Returning `hsl(...)` here made
 * that NaN, which made every gradient stop `rgb(NaN,NaN,NaN)`, which threw
 * inside `proceduralArt` and left every fallback coin blank.
 */
export function tintFor(key: string): string {
  const rnd = seeded(key);
  const hue = Math.floor(rnd() * 360);
  return hslToHex(hue, 0.62, 0.52);
}

/** HSL (h in degrees, s/l in 0..1) to a `#rrggbb` string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number) =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Draw `img` cover-fit and circularly clipped into an 88x88 canvas. */
function drawCoverClipped(img: HTMLImageElement): HTMLCanvasElement | null {
  const S = ART_SIZE;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  const scale = Math.max(S / iw, S / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (S - dw) / 2;
  const dy = (S - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
  return cv;
}

/** Load one image, resolving null on error/timeout instead of rejecting. */
function tryLoadImage(url: string, crossOrigin: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (result: HTMLImageElement | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), LOAD_TIMEOUT_MS);
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/**
 * Resolve an 88x88 canvas for a coin face: the token's real logo when it can
 * be loaded, cover-fit and circularly clipped; the procedural fallback
 * otherwise. Never rejects and never resolves blank.
 *
 * Tries `crossOrigin: "anonymous"` first (needed if the canvas is ever read
 * back), then retries once without it — many IPFS gateways omit CORS
 * headers, and this pipeline never calls `getImageData`/`toDataURL`, so a
 * tainted canvas is harmless here.
 */
export async function loadTokenArt(
  logoUrl: string | null,
  tint: string,
  key: string,
): Promise<HTMLCanvasElement | null> {
  if (!logoUrl) return proceduralArt(tint, key);
  try {
    const img = (await tryLoadImage(logoUrl, true)) ?? (await tryLoadImage(logoUrl, false));
    if (!img) return proceduralArt(tint, key);
    const canvas = drawCoverClipped(img);
    return canvas ?? proceduralArt(tint, key);
  } catch {
    return proceduralArt(tint, key);
  }
}

/**
 * Process-wide memo of `loadTokenArt` keyed by token id.
 *
 * Two `BagEngine` instances (desktop + mobile artboards) want the same coin
 * face, and each used to run its own `loadTokenArt` — two network fetches and
 * two 88x88 canvases per coin. Sharing the promise makes it one of each.
 */
const tokenArtCache = new Map<string, Promise<HTMLCanvasElement | null>>();

export function loadTokenArtOnce(
  logoUrl: string | null,
  tint: string,
  key: string,
): Promise<HTMLCanvasElement | null> {
  let pending = tokenArtCache.get(key);
  if (!pending) {
    pending = loadTokenArt(logoUrl, tint, key);
    tokenArtCache.set(key, pending);
  }
  return pending;
}
