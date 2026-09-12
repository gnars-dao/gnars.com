"use client";

/**
 * React-facing lifecycle wrapper around a single `BagEngine` instance.
 *
 * The engine itself is framework-agnostic (see bag-engine.ts); this hook owns
 * the one instance for a given artboard (`variant`), mounts/tears it down as
 * the DOM nodes it needs come and go, and bridges the surrounding React state
 * (theme, layout size, per-token artwork) into it via its public API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { loadTokenArtOnce, tintFor } from "./bag-art";
import { BagEngine, type BagEvent, type BagVariant } from "./bag-engine";

export interface BagToken {
  id: string;
  mark: string;
  logoUrl: string | null;
  eth: number;
}

export interface UseBagResult {
  rootRef: (el: HTMLElement | null) => void;
  bagCanvasRef: (el: HTMLCanvasElement | null) => void;
  flightCanvasRef: (el: HTMLCanvasElement | null) => void;
  avatarRef: (tokenId: string) => (el: HTMLElement | null) => void;
  launch: (token: BagToken, dir: 1 | -1) => void;
  activate: () => void;
  syncArt: (tokens: BagToken[]) => void;
  clear: () => void;
  /** Subscribe to this engine's physical events (see `BagEvent`). Returns an
   *  unsubscribe. Used by the audio layer; the engine stays deaf itself. */
  on: (fn: (ev: BagEvent) => void) => () => void;
  setActive: (active: boolean) => void;
  /** 0..1 — how charged the bag looks while a run is in flight. */
  setCharge: (charge: number) => void;
  /** Fire the burst and brand the bag with the Gnars mark. */
  celebrate: () => void;
  /** Back to the resting, unmarked state. */
  resetCelebration: () => void;
  setView: (scale: number) => void;
  size: { w: number; h: number };
}

export function useBag(variant: BagVariant): UseBagResult {
  const { resolvedTheme } = useTheme();

  // The engine is created once per hook instance (lazy useState initializer,
  // not a ref read during render — react-hooks/refs forbids the latter) and
  // never recreated on re-render — `variant` is expected to be stable for
  // the lifetime of the component that calls this hook (desktop vs mobile
  // artboards are two separate component trees, not one that flips the prop).
  const [engine] = useState(
    () =>
      new BagEngine({
        variant,
        // `resolvedTheme` is undefined on the very first client render before
        // next-themes has read localStorage; default to dark (the prototype's
        // own default) and the theme effect below corrects it as soon as
        // next-themes resolves.
        theme: resolvedTheme === "light" ? "light" : "dark",
      }),
  );

  // ---- DOM node bookkeeping ----
  // Node identity lives in state (not a plain ref) so that the mount effect
  // below — which is what actually calls engine.mount()/engine.destroy() —
  // re-runs whenever a node attaches or detaches, INCLUDING the detach/attach
  // cycle React 19 StrictMode performs on every initial mount in dev to flush
  // out exactly this class of bug. A plain-ref + "mount from the ref callback
  // itself" approach would only mount once (refs only fire once) and never
  // re-mount after StrictMode's simulated remount tears the nodes down and
  // re-attaches them; doing the mount/destroy pairing entirely inside one
  // effect keyed on the node identities is what makes it StrictMode-safe.
  const [nodes, setNodes] = useState<{
    root: HTMLElement | null;
    bag: HTMLCanvasElement | null;
    flight: HTMLCanvasElement | null;
  }>({ root: null, bag: null, flight: null });

  const rootRef = useCallback((el: HTMLElement | null) => {
    setNodes((n) => (n.root === el ? n : { ...n, root: el }));
  }, []);
  const bagCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    setNodes((n) => (n.bag === el ? n : { ...n, bag: el }));
  }, []);
  const flightCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    setNodes((n) => (n.flight === el ? n : { ...n, flight: el }));
  }, []);

  // The one effect that owns engine.mount()/engine.destroy(). Runs whenever
  // all three nodes are present (mounts), and its cleanup (destroy: cancels
  // the RAF loop, clears pending setTimeouts) runs whenever any node detaches
  // OR the component unmounts OR — under StrictMode in dev — React replays
  // this effect's cleanup+setup pair a second time against the same node
  // identities. Because destroy() and mount() are each idempotent (destroy()
  // guards on `this.raf` being truthy before cancelling; mount() just refits
  // the canvases and redraws), that replay mounts fresh rather than leaking
  // a second RAF loop or double-registering listeners.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!nodes.root || !nodes.bag || !nodes.flight) return undefined;
    engine.mount({ root: nodes.root, bagCanvas: nodes.bag, flightCanvas: nodes.flight });
    return () => {
      alive.current = false;
      engine.destroy();
    };
  }, [engine, nodes.root, nodes.bag, nodes.flight]);

  // ---- theme ----
  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    engine.setTheme(resolvedTheme);
  }, [engine, resolvedTheme]);

  // ---- resize ----
  useEffect(() => {
    const root = nodes.root;
    if (!root || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        engine.resize();
      });
    });
    observer.observe(root);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [engine, nodes.root]);

  // ---- avatar refs, memoised per tokenId so React never detaches/reattaches
  //      the DOM node ref on re-render (which would lose the coin's launch
  //      origin mid-flight) ----
  const avatarCallbacks = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());
  const avatarRef = useCallback(
    (tokenId: string) => {
      let cb = avatarCallbacks.current.get(tokenId);
      if (!cb) {
        cb = (el: HTMLElement | null) => engine.registerAvatar(tokenId, el);
        avatarCallbacks.current.set(tokenId, cb);
      }
      return cb;
    },
    [engine],
  );

  // ---- art loading, idempotent per tokenId ----
  // `loadedArt` tracks tokenIds already requested so re-rendering with the
  // same token list (e.g. every keystroke elsewhere in the widget) never
  // re-fetches; `alive` guards the async resolution against a component that
  // unmounted mid-load, so a late-arriving image never writes into a dead
  // engine instance.
  const loadedArt = useRef<Set<string>>(new Set());
  const syncArt = useCallback(
    (tokens: BagToken[]) => {
      tokens.forEach((token) => {
        if (loadedArt.current.has(token.id)) return;
        loadedArt.current.add(token.id);
        loadTokenArtOnce(token.logoUrl, tintFor(token.id), token.id)
          .then((art) => {
            if (!alive.current) return;
            engine.setArt(token.id, art);
          })
          .catch(() => {
            // loadTokenArt never rejects, but guard anyway — a failure here
            // must never surface as an unhandled rejection or block render.
          });
      });
    },
    [engine],
  );

  const launch = useCallback(
    (token: BagToken, dir: 1 | -1) => {
      engine.launch(token.id, token.eth, token.mark, dir);
    },
    [engine],
  );

  const activate = useCallback(() => {
    engine.activate();
  }, [engine]);

  const clear = useCallback(() => {
    engine.clear();
  }, [engine]);

  const on = useCallback((fn: (ev: BagEvent) => void) => engine.on(fn), [engine]);

  // Both engines stay mounted (a display:none canvas has no box, so neither
  // can be unmounted without losing its geometry), but only the one on screen
  // should simulate. Without this the hidden breakpoint ran a full solver and
  // a page-sized canvas clear for an audience of nobody.
  const setActive = useCallback((on_: boolean) => engine.setActive(on_), [engine]);

  const setCharge = useCallback((charge: number) => engine.setCharge(charge), [engine]);
  const celebrate = useCallback(() => engine.celebrate(), [engine]);
  const resetCelebration = useCallback(() => engine.resetCelebration(), [engine]);
  const setView = useCallback((scale: number) => engine.setView(scale), [engine]);

  const [size] = useState(() => engine.size);

  return useMemo(
    () => ({
      rootRef,
      bagCanvasRef,
      flightCanvasRef,
      avatarRef,
      launch,
      activate,
      syncArt,
      clear,
      on,
      setActive,
      setCharge,
      celebrate,
      resetCelebration,
      setView,
      size,
    }),
    [
      rootRef,
      bagCanvasRef,
      flightCanvasRef,
      avatarRef,
      launch,
      activate,
      syncArt,
      clear,
      on,
      setActive,
      setCharge,
      celebrate,
      resetCelebration,
      setView,
      size,
    ],
  );
}
