"use client";

/**
 * React-facing lifecycle wrapper around the page's ONE `BagAudio` instance.
 *
 * The audio layer itself (bag-audio.ts) is framework-agnostic and deaf to
 * React: it knows how to voice a `BagEvent` and nothing else. This hook owns
 * its lifetime, its mute preference, and the subscription to whichever bag
 * engine is actually being heard.
 *
 * Two rules shape everything below:
 *  - Web Audio starts suspended until a user gesture resumes it, so `resume()`
 *    MUST be called from inside a click handler. Nothing here touches audio
 *    from an effect: a page that makes noise on load is a bug, not a feature.
 *  - This is a Next.js App Router client component tree, so it renders on the
 *    server first. Nothing may touch `window`/`AudioContext`/`localStorage`
 *    during render; the instance is created lazily on first use, and the
 *    persisted mute preference is reconciled in an effect (render always
 *    starts from the default, so there is no hydration mismatch).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBagAudio, type BagAudio } from "./bag-audio";
import type { BagEvent } from "./bag-engine";

const MUTE_STORAGE_KEY = "gnars.migrate.bag.muted";

/* When the demo driver sets `window.__gnarsAudioLog`, every audio call is
   recorded with its timestamp. The campaign recording renders its soundtrack
   offline from that log, so the track is what the page WOULD have played
   rather than a reconstruction of it — the two cannot drift apart. Costs one
   undefined check when the flag is absent, which is always in production. */
function logCall(entry: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __gnarsAudioLog?: Record<string, unknown>[] };
  if (w.__gnarsAudioLog) w.__gnarsAudioLog.push({ t: Math.round(performance.now()), ...entry });
}

/** Anything with the engine's `on()` shape. Kept structural rather than
 *  importing `BagEngine` so a caller can hand us a filtered proxy — which is
 *  exactly how MigrationWidget guarantees only the visible bag is heard. */
export interface BagEventSource {
  on: (fn: (ev: BagEvent) => void) => () => void;
}

export interface UseBagAudioResult {
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** false when Web Audio is unavailable — the UI hides the toggle entirely. */
  available: boolean;
  subscribe: (source: BagEventSource) => () => void;
  /** Call from a click handler, never from an effect. */
  resume: () => void;
  tick: (kind?: "on" | "off") => void;
  fanfare: () => void;
}

export function useBagAudio(): UseBagAudioResult {
  // `undefined` = not built yet, `null` = built and Web Audio is unavailable.
  // Two states, not one, so a null instance is never retried on every event.
  const audioRef = useRef<BagAudio | null | undefined>(undefined);
  const destroyedRef = useRef(false);
  const [available, setAvailable] = useState(true);
  const [muted, setMutedState] = useState(false);

  // The mute preference is also read by `ensure()` (which runs outside
  // render), so it needs a ref mirror of the state.
  const mutedRef = useRef(false);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // Lazy, gesture-time construction: building an AudioContext is what a
  // browser counts as "starting audio", so it happens on the first call that
  // originates from a click — not on mount, and never during render.
  const ensure = useCallback((): BagAudio | null => {
    if (destroyedRef.current) return null;
    if (audioRef.current === undefined) {
      const instance = createBagAudio();
      audioRef.current = instance;
      if (!instance) setAvailable(false);
      else instance.setMuted(mutedRef.current);
    }
    return audioRef.current;
  }, []);

  // Reconcile the persisted preference AFTER the first paint: reading
  // localStorage during render would make the server HTML and the client's
  // first render disagree.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(MUTE_STORAGE_KEY);
    } catch {
      // Private mode / storage disabled: fall back to the default (unmuted).
    }
    if (stored !== "1") return;
    mutedRef.current = true;
    setMutedState(true);
    audioRef.current?.setMuted(true);
  }, []);

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    setMutedState(m);
    audioRef.current?.setMuted(m);
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, m ? "1" : "0");
    } catch {
      // Preference is a nicety; failing to persist it must never throw.
    }
  }, []);

  // Teardown. React 19 StrictMode mounts, unmounts and re-mounts every
  // component in dev: the instance is dropped here AND the "built" marker is
  // reset, so the second mount builds a fresh one instead of holding a
  // destroyed handle or leaking the first mount's AudioContext.
  useEffect(() => {
    destroyedRef.current = false;
    return () => {
      destroyedRef.current = true;
      audioRef.current?.destroy();
      audioRef.current = undefined;
    };
  }, []);

  const subscribe = useCallback(
    (source: BagEventSource) =>
      source.on((ev) => {
        // Deliberately NOT `ensure()`: an event arriving before any click
        // (the breakpoint-switch replay, say) must not be what brings an
        // AudioContext into existence. Until a gesture has built one, the
        // bag is silent.
        logCall({ call: "ev", ev });
        audioRef.current?.handle(ev);
      }),
    [],
  );

  const resume = useCallback(() => {
    const audio = ensure();
    if (!audio) return;
    void audio.resume().catch(() => {
      // A rejected resume() just means the browser is not convinced this was
      // a gesture — silence, not an error the user should ever see.
    });
  }, [ensure]);

  const tick = useCallback(
    (kind?: "on" | "off") => {
      // Ticks only ever fire from a click handler, so building the instance
      // here is gesture-time construction, same as resume().
      logCall({ call: "tick", kind: kind ?? "on" });
      ensure()?.tick(kind);
    },
    [ensure],
  );

  // Fired from the success path of a run the user started with a click, so the
  // context already exists by then; ensure() is here only for the case where
  // the whole run happened without the user ever touching a coin row.
  const fanfare = useCallback(() => {
    logCall({ call: "fanfare" });
    ensure()?.fanfare();
  }, [ensure]);

  // Memoised: the subscription effect in MigrationWidget depends on this
  // object, and a fresh identity every render would tear down and re-attach
  // both engine listeners on every keystroke elsewhere in the widget.
  return useMemo(
    () => ({ muted, setMuted, available, subscribe, resume, tick, fanfare }),
    [muted, setMuted, available, subscribe, resume, tick, fanfare],
  );
}
