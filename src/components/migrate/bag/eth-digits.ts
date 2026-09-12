/**
 * Per-digit splitter for the ETH/token figure display, ported from `digits()`
 * in `_bagcore.js`.
 *
 * The figure is split into per-digit cells so it can be genuinely tabular
 * whatever the face ships — 1ch is the advance of "0" — and so a change can
 * animate only the digits that actually changed. The class alternates on
 * every change: re-applying the same class would not restart the keyframes
 * when a digit changes twice in a row.
 *
 * MEMOISED ON THE STRING, and that is the whole point. renderVals can run
 * more than once for a single interaction; recomputing from "what did I see
 * last time" meant the second run found nothing changed, handed back bare
 * cells, and React cleared the animation class before a single frame of it
 * had played. That is why some picks animated and others silently did not.
 * Same string in, same cells out, however many times it is asked.
 */

export interface DigitCell {
  ch: string;
  cls: string;
  delay: number;
}

export class EthDigits {
  private digStr: string | null = null;
  private digCells: DigitCell[] = [];
  private digTick = 0;

  next(str: string): DigitCell[] {
    if (this.digStr === str) return this.digCells;
    const prev = this.digStr;
    const first = prev == null;
    this.digTick += 1;
    const flip = this.digTick % 2 ? "ro-a" : "ro-b";
    const out: DigitCell[] = [];
    let run = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charAt(i);
      const sep = ch === ".";
      const hit = !first && !sep && prev!.charAt(i) !== ch;
      out.push({
        ch,
        cls: (sep ? "digpt" : "") + (hit ? " " + flip : ""),
        delay: hit ? run++ * 22 : 0,
      });
    }
    this.digStr = str;
    this.digCells = out;
    return out;
  }

  reset(): void {
    this.digStr = null;
    this.digCells = [];
    this.digTick = 0;
  }
}
