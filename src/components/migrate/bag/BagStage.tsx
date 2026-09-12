"use client";

/**
 * BagStage — renders the migrate "bag" canvas stage, in the desktop
 * (`.gb-stage` / `.gb-bagcap`) and mobile (`.gb-bagbar` / `.gb-cap`) variants.
 * Markup mirrors `.stage` in Main.dc.html and `.bagbar` in Mobile.dc.html
 * respectively — see bag-engine.ts's header comment for the porting brief
 * this whole feature follows.
 *
 * The `BagEngine` instance (via `useBag`) lives in the PARENT component, not
 * here: the parent also needs `avatarRef` for the coin rows, which render in
 * a different subtree (the "what you hold" list), so the hook return value
 * is threaded in as the `bag` prop rather than instantiated locally.
 */
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EthDigits } from "./eth-digits";
import type { UseBagResult } from "./use-bag";

export interface BagStageProps {
  variant: "desktop" | "mobile";
  /** Has the user picked anything yet — drives the `.live` class. */
  live: boolean;
  /** Already-formatted ETH figure, e.g. "1.0521". */
  amount: string;
  /** "Available to deposit" (i18n, passed in). */
  label: string;
  /** The sub line under the label (i18n, passed in). */
  breakdown: string;
  /** The `useBag()` hook instance, owned by the parent. */
  bag: UseBagResult;
  /** Optional corner control (the sound toggle). Rendered by the parent so
   *  the stage stays a pure presentation of the pile. */
  action?: ReactNode;
}

export function BagStage({ variant, live, amount, label, breakdown, bag, action }: BagStageProps) {
  // Locally renamed (not a behavior change): eslint's react-hooks/refs rule
  // flags any identifier ending in "Ref" that reaches a JSX `ref=` prop as if
  // it were a `useRef().current` read, even though these are plain callback
  // functions from the hook's public API (verified: renaming alone silences
  // it). Renaming here avoids that false positive without touching the
  // `bagCanvasRef` name in useBag's contract.
  //
  // NOTE: the engine's ROOT and its flight canvas are deliberately NOT here.
  // The prototype attaches both to the whole artboard (Main.dc.html:220/376,
  // Mobile.dc.html:181/285) so the coin's arc from a holdings row to the bag
  // is drawn across the page. Scoping them to this stage put the whole arc at
  // negative coordinates on a canvas the width of the stage, and `overflow:
  // hidden` clipped whatever was left. `BagFlightLayer` in MigrationWidget
  // owns them now.
  const { bagCanvasRef: attachBagCanvas } = bag;

  // One EthDigits splitter per component instance: it is memoised on the
  // string it last saw, and creating a fresh instance every render would
  // defeat that memoisation (see eth-digits.ts's header comment). Held via
  // useState's lazy initializer (not useRef) so the read below isn't a
  // ref-during-render access.
  const [digits] = useState(() => new EthDigits());
  const cells = digits.next(amount);

  const digitRow = (
    <>
      {cells.map((cell, i) => (
        <span
          key={i}
          className={cn("gb-dig", cell.cls)}
          style={{ animationDelay: cell.delay + "ms" }}
        >
          {cell.ch}
        </span>
      ))}
      <span className="gb-u">ETH</span>
    </>
  );

  // The per-character cells are a rendering device, not content: a screen
  // reader walking them announces "zero, point, zero, four" one cell at a
  // time. Expose the figure once, as one string, and hide the cells.
  const amountLabel = `${amount} ETH`;

  if (variant === "mobile") {
    return (
      <div className={cn("gb-bagbar", live && "live")}>
        <div className="gb-bagbar__grid" />
        <div className="gb-bagbar__glow" />
        <div className="gb-bagbar__inner">
          <canvas ref={attachBagCanvas} className="gb-bagcanvas" aria-hidden="true" />
          <div className="gb-cap">
            <div className="gb-amt" role="img" aria-label={amountLabel}>
              <span aria-hidden="true">{digitRow}</span>
            </div>
            <div className="gb-lab">{label}</div>
            <div className="gb-sub">{breakdown}</div>
          </div>
          {action ? <div className="relative z-10 shrink-0 self-start pt-2">{action}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("gb-stage", live && "live")}>
      {action ? <div className="absolute right-2 top-2 z-20">{action}</div> : null}
      <div className="gb-stage__grid" />
      <div className="gb-stage__glow" />
      <canvas ref={attachBagCanvas} className="gb-bagcanvas" aria-hidden="true" />
      <div className="gb-bagcap">
        <div className="gb-amt" role="img" aria-label={amountLabel}>
          <span aria-hidden="true">{digitRow}</span>
        </div>
        <div className="gb-lab">{label}</div>
        <div className="gb-sub">{breakdown}</div>
      </div>
    </div>
  );
}
