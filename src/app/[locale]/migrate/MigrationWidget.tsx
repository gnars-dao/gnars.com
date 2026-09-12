"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { formatEther, parseEther } from "viem";
import { useBalance } from "wagmi";
import type { BagEvent } from "@/components/migrate/bag/bag-engine";
import { BagMuteToggle } from "@/components/migrate/bag/BagMuteToggle";
import { BagStage } from "@/components/migrate/bag/BagStage";
import { useBag, type BagToken } from "@/components/migrate/bag/use-bag";
import { useBagAudio } from "@/components/migrate/bag/use-bag-audio";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  EOA_GAS_RESERVE,
  SEQUENTIAL_PROMPTS_PER_COIN,
  useExecuteMigration,
  type CoinToMigrate,
  type MigrationStep,
} from "@/hooks/use-execute-migration";
import {
  buildRoute,
  formatCoinAmount,
  passesWalletValueFloor,
  useCoinQuotes,
  useMigrationHoldings,
  type CoinQuote,
  type MigratableCoin,
  type RouteHop,
} from "@/hooks/use-gnars-migration";
import { useOldGnarsPosition } from "@/hooks/use-old-gnars-position";
import { useUpgradeDeposit } from "@/hooks/use-upgrade-deposit";
import { useUpgraderPosition, type UpgraderPosition } from "@/hooks/use-upgrader-position";
import { useUserAddress } from "@/hooks/use-user-address";
import { useWriteAccount } from "@/hooks/use-write-account";
import {
  CHAIN,
  GNARS_CREATOR_COIN,
  IS_DEV,
  isMigrationDepositLive,
  MIGRATE_WALLET_TOKENS_ENABLED,
  MIGRATION_CONFIG_ERROR,
  UPGRADER_ADDRESS,
} from "@/lib/config";
import { normalizeDecimalInput } from "@/lib/decimal-input";
import { cn } from "@/lib/utils";
import { MIN_WALLET_TOKEN_USD } from "@/services/wallet-base-tokens";
import {
  DEMO_ADDRESS,
  DEMO_COINS,
  DEMO_QUOTES,
  DEMO_WALLET_WEI,
  isDemoMode,
} from "./demo-fixtures";

const OLD_GNARS_KEY = GNARS_CREATOR_COIN.toLowerCase();

// Matches Tailwind's `lg` breakpoint — the same one the desktop stage
// (`lg:block`) and the mobile bar (`lg:hidden`) switch on, so the engine
// that is actually being drawn to is always the one the CSS is showing.
const BAG_DESKTOP_QUERY = "(min-width: 1024px)";

/** SSR-safe breakpoint watcher: starts `false` (mobile) until the effect
 * reads the real value on mount, then tracks live viewport changes. */
function useIsDesktopBag(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(BAG_DESKTOP_QUERY);
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

/**
 * The migration as a ledger: what you hold on the left (the sources), the
 * deposit on the right (the destination). The right column carries the
 * arithmetic — wallet ETH plus the sells equals what can be deposited — and
 * never leaves the screen: sticky on desktop, first on mobile.
 */
export function MigrationWidget() {
  const t = useTranslations("migrate");
  // `?demo=1` in development only: seeded holdings and a stand-in wallet, so a
  // campaign recording is deterministic and puts nobody's real balances on
  // screen. See demo-fixtures.ts — it folds away in a production build.
  const [demo, setDemo] = React.useState(false);
  React.useEffect(() => setDemo(isDemoMode()), []);

  const real = useUserAddress();
  const address = demo ? DEMO_ADDRESS : real.address;
  const isConnected = demo ? true : real.isConnected;
  const { canSwitchView, viewMode, adminAddress } = real;
  const {
    zoraCoins: liveZoraCoins,
    walletCandidates,
    isLoading,
    isError,
    refetch,
    walletIsLoading,
    walletIsError,
    walletRefetch,
  } = useMigrationHoldings(address);
  // Override at the source so everything downstream — the merged list, the
  // quote set, Select all, the rendered rows — follows from one place.
  const zoraCoins = demo ? DEMO_COINS : liveZoraCoins;
  const position = useUpgraderPosition();
  const writer = useWriteAccount();
  const live = isMigrationDepositLive();

  // The bag: two engine instances (a canvas hidden by `display:none` has a
  // zero-size bounding box and its flight geometry breaks), gated visually by
  // the same Tailwind `lg` breakpoint this hook watches — see BagStage.tsx's
  // header comment and the reconciliation effect below for how only the
  // currently-visible one is actually driven.
  const bagDesktop = useBag("desktop");
  const bagMobile = useBag("mobile");
  const isDesktopBag = useIsDesktopBag();
  const activeBag = isDesktopBag ? bagDesktop : bagMobile;
  // Mirrors the prototype's `state.live`: false until the very first pick,
  // true forever after (never reset by clearAll).
  const [bagLive, setBagLive] = React.useState(false);
  const bagLiveRef = React.useRef(false);
  React.useEffect(() => {
    bagLiveRef.current = bagLive;
  }, [bagLive]);
  // Always launches on the engine that is CURRENTLY visible, even from a
  // setTimeout closure captured on an earlier render.
  const activeBagRef = React.useRef(activeBag);
  React.useEffect(() => {
    activeBagRef.current = activeBag;
    // Park the breakpoint that is not on screen: it is still mounted, but it
    // must not run a solver or clear a page-sized canvas for a hidden view.
    bagDesktop.setActive(isDesktopBag);
    bagMobile.setActive(!isDesktopBag);
  }, [activeBag, bagDesktop, bagMobile, isDesktopBag]);
  // ---- sound ----
  // ONE audio instance for the page, but TWO engines feeding it: both are
  // mounted at all times (see above) and both are driven by the same
  // selection, so subscribing to both naively would voice every coin twice.
  // `bagVoiceRef` names the single variant allowed to be heard right now —
  // the visible one — and each subscription filters on it, so exactly one
  // engine's events reach the audio layer at any instant.
  const audio = useBagAudio();
  const bagVoiceRef = React.useRef<"desktop" | "mobile">(isDesktopBag ? "desktop" : "mobile");
  React.useEffect(() => {
    bagVoiceRef.current = isDesktopBag ? "desktop" : "mobile";
  }, [isDesktopBag]);
  // A breakpoint switch replays the whole pile into the newly-visible engine
  // (see the reconciliation effect below). That is a resize, not a pick: the
  // user clicked nothing, so it must land silently. The replay sets this to a
  // timestamp a little past the longest flight, and the filter drops anything
  // arriving before it.
  const bagSilentUntilRef = React.useRef(0);
  React.useEffect(() => {
    const heard = (variant: "desktop" | "mobile", fn: (ev: BagEvent) => void) => (ev: BagEvent) => {
      if (bagVoiceRef.current !== variant) return;
      if (Date.now() < bagSilentUntilRef.current) return;
      fn(ev);
    };
    const offDesktop = audio.subscribe({ on: (fn) => bagDesktop.on(heard("desktop", fn)) });
    const offMobile = audio.subscribe({ on: (fn) => bagMobile.on(heard("mobile", fn)) });
    return () => {
      offDesktop();
      offMobile();
    };
  }, [audio, bagDesktop, bagMobile]);

  // ---- the ETH figure ticks with the coins ----
  // How many of each token's coins are actually sitting in the bag right now.
  // The figure is a pure FUNCTION of this rather than an accumulated delta:
  // summing increments would drift a hair off the true total and stay there,
  // whereas landed/count hits exactly 1 when a volley finishes, so the number
  // arrives on the real value with no snapping.
  const bagFillRef = React.useRef<Map<string, { landed: number; count: number }>>(new Map());
  const [bagTick, setBagTick] = React.useState(0);
  const bagRaf = React.useRef<number | null>(null);
  // Up to 12 coins land per 700ms per token and a select-all overlaps volleys;
  // one render per frame instead of one per coin.
  const bumpBagTick = React.useCallback(() => {
    if (bagRaf.current != null) return;
    bagRaf.current = requestAnimationFrame(() => {
      bagRaf.current = null;
      setBagTick((n) => n + 1);
    });
  }, []);
  React.useEffect(
    () => () => {
      if (bagRaf.current != null) cancelAnimationFrame(bagRaf.current);
    },
    [],
  );
  React.useEffect(() => {
    // A coin ENTERS on `land` and LEAVES on the staggered return throw. Not on
    // `leave`: that fires once, up front, when the whole group is lifted out of
    // the pile, which would drop the whole amount in a single step.
    const counted =
      (variant: "desktop" | "mobile") =>
      (ev: BagEvent): void => {
        if (bagVoiceRef.current !== variant) return;
        const map = bagFillRef.current;
        if (ev.type === "land") {
          const cur = map.get(ev.tokenId) ?? { landed: 0, count: ev.count };
          cur.count = ev.count;
          cur.landed = Math.min(cur.count, cur.landed + 1);
          map.set(ev.tokenId, cur);
          bumpBagTick();
        } else if (ev.type === "throw" && ev.dir === -1) {
          const cur = map.get(ev.tokenId);
          if (!cur) return;
          cur.landed = Math.max(0, cur.landed - 1);
          bumpBagTick();
        }
      };
    const offD = bagDesktop.on(counted("desktop"));
    const offM = bagMobile.on(counted("mobile"));
    return () => {
      offD();
      offM();
    };
  }, [bagDesktop, bagMobile, bumpBagTick]);

  // What the bag actually holds right now, keyed the same way `quoteByAddr`
  // is (lowercase coin address, or OLD_GNARS_KEY) — the reconciliation
  // effect below is the single source of truth for it.
  const presentInBagRef = React.useRef<Map<string, BagToken>>(new Map());
  // Set when a deposit succeeds. The coins were sold and the ETH is deposited,
  // so they must NOT fly back to the rows the way a deselect sends them — that
  // reads as the deposit being undone. The pile stays where it is, branded,
  // until the user starts a new selection.
  const bagSealedRef = React.useRef(false);
  // Per-token generation counter, one level up from the engine's own: a
  // scheduled launch/recall only fires if it is still the latest thing
  // decided for that token by the time its delay elapses, so a fast
  // re-toggle can never have a stale add fire after a newer recall (or vice
  // versa) — the same voiding guarantee bag-engine.ts's `gen` gives inside
  // one launch call, applied across separate calls.
  const bagTokenGenRef = React.useRef<Map<string, number>>(new Map());
  const bagTimersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  React.useEffect(
    () => () => {
      bagTimersRef.current.forEach(clearTimeout);
    },
    [],
  );
  // The engine ROOT is the whole widget, not the bag panel: the prototype
  // attaches setRoot to the artboard (Main.dc.html:220, Mobile.dc.html:181)
  // and hangs the page-sized flight canvas off it (:376 / :285), so a coin's
  // arc from a holdings row on the left to the bag on the right is drawn in
  // one coordinate space. Both engines share this one element; each gets its
  // own flight canvas over it (rendered at the bottom of the JSX below).
  const bagRootRef = React.useCallback(
    (el: HTMLElement | null) => {
      bagDesktop.rootRef(el);
      bagMobile.rootRef(el);
    },
    [bagDesktop, bagMobile],
  );

  // Wrapped (rather than read off the hook result during render) so the
  // react-hooks/refs rule does not classify the whole `bag` object as a ref
  // and then flag every other use of it; the wrappers are stable, so React
  // never detaches and re-attaches the canvas node.
  const attachDesktopFlight = React.useCallback(
    (el: HTMLCanvasElement | null) => bagDesktop.flightCanvasRef(el),
    [bagDesktop],
  );
  const attachMobileFlight = React.useCallback(
    (el: HTMLCanvasElement | null) => bagMobile.flightCanvasRef(el),
    [bagMobile],
  );

  // One merged ref callback per token id, registering the same DOM node as
  // that coin's launch origin with BOTH engines (only the active one is ever
  // launched into, but both need to know where the row sits so a resync after
  // a breakpoint switch — or simply becoming active later — has it). Memoised
  // per id the same way useBag's own avatarRef is, so React never sees a new
  // ref identity on every render (which would thrash registerAvatar).
  const mergedAvatarRefs = React.useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());
  const bagAvatarRef = React.useCallback(
    (tokenId: string) => {
      let cb = mergedAvatarRefs.current.get(tokenId);
      if (!cb) {
        cb = (el: HTMLElement | null) => {
          bagDesktop.avatarRef(tokenId)(el);
          bagMobile.avatarRef(tokenId)(el);
        };
        mergedAvatarRefs.current.set(tokenId, cb);
      }
      return cb;
    },
    [bagDesktop, bagMobile],
  );

  // Switching which artboard is visible (a resize across the `lg` breakpoint)
  // must not leave the newly-shown engine's pile stale or empty: it never ran
  // the launches that produced the current pile (only the previously-active
  // engine did), so resync it immediately, in full, no animation stagger —
  // correctness here matters more than a replayed flight.
  const prevIsDesktopBagRef = React.useRef(isDesktopBag);
  React.useEffect(() => {
    if (prevIsDesktopBagRef.current === isDesktopBag) return;
    prevIsDesktopBagRef.current = isDesktopBag;
    // Flush the React-side launch queue BEFORE replaying: a resize during a
    // Select All stagger otherwise let the still-pending timers fire after
    // the replay, onto the newly-active engine, double-adding those tokens.
    bagTimersRef.current.forEach(clearTimeout);
    bagTimersRef.current = [];
    // Nothing the user clicked caused this; the replay must be silent (the
    // window covers the longest flight plus its landing).
    bagSilentUntilRef.current = Date.now() + 2200;
    presentInBagRef.current.forEach((_tok, id) => {
      bagTokenGenRef.current.set(id, (bagTokenGenRef.current.get(id) || 0) + 1);
    });
    const next = isDesktopBag ? bagDesktop : bagMobile;
    next.clear();
    if (bagLiveRef.current) next.activate();
    presentInBagRef.current.forEach((tok) => next.launch(tok, 1));
  }, [isDesktopBag, bagDesktop, bagMobile]);

  // Selection is keyed by lowercase address.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Old $gnars is not in the Zora list (it is the coin being migrated away
  // from); the holder opts it into the sale explicitly from its own row, and
  // chooses how much — selling everything is the recommendation, not a rule.
  const [includeOldGnars, setIncludeOldGnars] = React.useState(false);
  // The portion to sell, as typed. Empty means "not chosen yet" and reads as
  // the whole balance, so opting in without touching the field sells it all.
  const [oldGnarsAmount, setOldGnarsAmount] = React.useState("");
  const typedOldGnars = React.useMemo(() => {
    const raw = oldGnarsAmount.trim();
    if (!raw) return undefined;
    try {
      const v = parseEther(raw);
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  }, [oldGnarsAmount]);
  const oldGnars = useOldGnarsPosition(address, typedOldGnars);

  // A different wallet is a different set of holdings: carrying the previous
  // account's selection (and its pile) across the switch showed coins that
  // are not in this wallet, and the holdings rows that would have recalled
  // them have already unmounted. Reset everything the bag derives from.
  const prevAddressRef = React.useRef(address);
  React.useEffect(() => {
    if (prevAddressRef.current === address) return;
    prevAddressRef.current = address;
    bagTimersRef.current.forEach(clearTimeout);
    bagTimersRef.current = [];
    bagTokenGenRef.current.clear();
    presentInBagRef.current = new Map();
    bagDesktop.clear();
    bagMobile.clear();
    bagLiveRef.current = false;
    setBagLive(false);
    setSelected(new Set());
    setIncludeOldGnars(false);
    setOldGnarsAmount("");
  }, [address, bagDesktop, bagMobile]);

  const wallet = useBalance({ address: address as `0x${string}` | undefined, chainId: CHAIN.id });
  // An EOA pays its own gas: "max" must leave a reserve or the deposit itself
  // cannot be mined. A sponsored smart account keeps the whole balance.
  const gasReserve = writer?.isEoaSigner ? EOA_GAS_RESERVE : 0n;
  // The wallet's own ETH is no longer forced into the total: the user picks
  // whether it counts and how much of it. Default is all of it, which is the
  // behaviour this replaces.
  const [walletOn, setWalletOn] = React.useState(true);
  const [walletPct, setWalletPct] = React.useState(100);
  const walletWei = demo ? DEMO_WALLET_WEI : wallet.data?.value;
  const usableWallet =
    walletWei !== undefined && walletWei > gasReserve ? walletWei - gasReserve : 0n;
  const walletContribution = walletOn ? (usableWallet * BigInt(walletPct)) / 100n : 0n;

  // Everything the wallet holds is quoted up front, not just what is picked:
  // the bag's flight is sized from a coin's ETH value, so that value has to
  // exist BEFORE the click (see the row gate in HoldingsList). Old $gnars is
  // the exception — its amount is typed, so its queryKey changes per keystroke
  // and it stays on-demand, quoted only once it is actually included.
  // Wallet candidates are in here because their quote is also what decides
  // whether they are shown at all — the value half of the spam filter.
  const quotableCoins = React.useMemo(() => {
    const all = [...zoraCoins, ...walletCandidates];
    if (includeOldGnars && oldGnars.sellAmount !== undefined && oldGnars.sellAmount > 0n) {
      all.push(oldGnarsAsCoin(oldGnars.sellAmount));
    }
    return all;
  }, [zoraCoins, walletCandidates, includeOldGnars, oldGnars.sellAmount]);

  const { quotes, refetchFailed } = useCoinQuotes(quotableCoins, address);

  const quoteByAddr = React.useMemo(
    () => new Map((demo ? DEMO_QUOTES : quotes).map((q) => [q.address.toLowerCase(), q])),
    [demo, quotes],
  );

  // Second half of the spam filter, and the reason wallet tokens are quoted
  // before they are rendered: an uncurated token has to prove a live route to
  // ETH worth more than the floor before it is offered to anyone. A quote that
  // FAILED is kept and labelled — an outage is not evidence against a token.
  const walletTokens = React.useMemo(
    () =>
      walletCandidates.filter((c) => {
        const q = quoteByAddr.get(c.address.toLowerCase());
        if (!q) return false; // still pricing
        if (q.status === "quote-failed") return true;
        return passesWalletValueFloor(q);
      }),
    [walletCandidates, quoteByAddr],
  );
  const walletPricing = React.useMemo(
    () => walletCandidates.some((c) => !quoteByAddr.has(c.address.toLowerCase())),
    [walletCandidates, quoteByAddr],
  );
  const walletHiddenCount = walletCandidates.length - walletTokens.length;

  /** Everything that is actually on screen and therefore actually selectable. */
  const coins = React.useMemo(() => [...zoraCoins, ...walletTokens], [zoraCoins, walletTokens]);

  const selectedZora = React.useMemo(
    () => coins.filter((c) => selected.has(c.address.toLowerCase())),
    [coins, selected],
  );
  const selectedCoins = React.useMemo(() => {
    const picked = [...selectedZora];
    // `sellAmount` is the clamped portion the quote was actually made for —
    // using the raw typed value here could send a sell larger than the balance.
    if (includeOldGnars && oldGnars.sellAmount !== undefined && oldGnars.sellAmount > 0n) {
      picked.push(oldGnarsAsCoin(oldGnars.sellAmount));
    }
    return picked;
  }, [selectedZora, includeOldGnars, oldGnars.sellAmount]);

  // The bag must always hold exactly what is currently selected AND priced.
  // Since a coin cannot be picked before its own quote has resolved, that
  // pairing now holds at the moment of the press and the coins fly with the
  // click. This effect stays as the invariant behind it: a quote that is
  // refetched or invalidated (or one that resolves after its coin was
  // deselected) is reconciled the same way a toggle is. Driving this off the
  // selection/quote state directly (rather than from the click handlers)
  // is what makes both of those true automatically: whatever changed to
  // produce this state — a toggle, Select All, Clear, a quote arriving, a
  // retry — is reconciled the same single way, so the pile can never drift
  // from the selection no matter which of those caused the change.
  React.useEffect(() => {
    const desired = new Map<string, BagToken>();
    for (const c of coins) {
      const key = c.address.toLowerCase();
      if (!selected.has(key)) continue;
      const q = quoteByAddr.get(key);
      if (!q?.routable || q.out <= 0n) continue;
      desired.set(key, {
        id: key,
        mark: c.symbol.slice(0, 2).toUpperCase(),
        logoUrl: c.logoUrl,
        eth: parseFloat(formatEther(q.out)),
      });
    }
    if (includeOldGnars) {
      const q = quoteByAddr.get(OLD_GNARS_KEY);
      if (q?.routable && q.out > 0n) {
        desired.set(OLD_GNARS_KEY, {
          id: OLD_GNARS_KEY,
          mark: "G",
          logoUrl: null,
          eth: parseFloat(formatEther(q.out)),
        });
      }
    }

    if (bagSealedRef.current) {
      if (desired.size === 0) {
        // Still sealed: `clearAll()` emptied the selection on success, but the
        // bag keeps what it holds. Forget the tokens so a later pick starts
        // clean, without recalling a single coin.
        presentInBagRef.current = new Map();
        return;
      }
      // A new pick breaks the seal and starts a fresh bag: the old contents
      // belong to a deposit that is already done, and leaving them would add
      // the next selection on top of a total that no longer applies.
      bagSealedRef.current = false;
      bagTimersRef.current.forEach(clearTimeout);
      bagTimersRef.current = [];
      bagDesktop.clear();
      bagMobile.clear();
      bagDesktop.resetCelebration();
      bagMobile.resetCelebration();
      bagFillRef.current.clear();
      presentInBagRef.current = new Map();
      bagLiveRef.current = false;
      setBagLive(false);
      bumpBagTick();
    }

    const present = presentInBagRef.current;
    const added: BagToken[] = [];
    const removed: BagToken[] = [];
    desired.forEach((tok, id) => {
      if (!present.has(id)) added.push(tok);
    });
    present.forEach((tok, id) => {
      if (!desired.has(id)) removed.push(tok);
    });
    presentInBagRef.current = desired;
    if (added.length === 0 && removed.length === 0) return;

    const wasLive = bagLiveRef.current;
    const firstActivation = !wasLive && added.length > 0;
    if (firstActivation) {
      bagLiveRef.current = true;
      setBagLive(true);
      // The prototype's activate() (Main.dc.html:1446-1450): the bag's own
      // flat->lit crossfade starts BEFORE the 140ms launch, not with it.
      activeBagRef.current.activate();
    }

    const scheduleLaunch = (tok: BagToken, dir: 1 | -1, delay: number) => {
      const nextGen = (bagTokenGenRef.current.get(tok.id) || 0) + 1;
      bagTokenGenRef.current.set(tok.id, nextGen);
      const timer = setTimeout(() => {
        if (bagTokenGenRef.current.get(tok.id) !== nextGen) return; // superseded
        activeBagRef.current.launch(tok, dir);
      }, delay);
      bagTimersRef.current.push(timer);
    };

    // A lone pick gets the prototype's toggle()/pickOld() timing (the stage
    // lights up before the first pick's coins fly); several at once (a
    // cached Select All, or a burst of quotes resolving together) stagger
    // the way selectAll() staggers its launches.
    added.forEach((tok, i) => {
      const delay =
        added.length === 1 ? (firstActivation ? 140 : 0) : (firstActivation ? 160 : 0) + i * 150;
      scheduleLaunch(tok, 1, delay);
    });
    // A single deselect recalls instantly, same as toggle()/pickOld(); several
    // at once (Clear) stagger 110ms apart, same as clearAll().
    removed.forEach((tok, i) => {
      scheduleLaunch(tok, -1, removed.length === 1 ? 0 : i * 110);
    });
  }, [coins, selected, includeOldGnars, quoteByAddr, bagDesktop, bagMobile, bumpBagTick]);

  // Coin art loads once per token id (idempotent inside the hook) regardless
  // of selection, so it is already resolved by the time a coin is picked.
  React.useEffect(() => {
    const tokens: BagToken[] = coins.map((c) => ({
      id: c.address.toLowerCase(),
      mark: c.symbol.slice(0, 2).toUpperCase(),
      logoUrl: c.logoUrl,
      eth: 0,
    }));
    if (oldGnars.balance !== undefined && oldGnars.balance > 0n) {
      tokens.push({ id: OLD_GNARS_KEY, mark: "G", logoUrl: null, eth: 0 });
    }
    bagDesktop.syncArt(tokens);
    bagMobile.syncArt(tokens);
  }, [coins, oldGnars.balance, bagDesktop, bagMobile]);
  // The receipt splits the sells into their two sources. The hook's own
  // `totalEthOut` is NOT usable for display any more: it sums every coin it was
  // given, which is now the whole wallet — the receipt, the bag figure and the
  // CTA all mean "what was picked", so that total is derived here instead.
  const zoraEthOut = React.useMemo(
    () =>
      selectedZora.reduce((sum, c) => {
        const q = quoteByAddr.get(c.address.toLowerCase());
        return sum + (q?.routable ? q.out : 0n);
      }, 0n),
    [selectedZora, quoteByAddr],
  );
  const oldGnarsQuote = quoteByAddr.get(OLD_GNARS_KEY);
  const oldGnarsEthOut = oldGnarsQuote?.routable ? oldGnarsQuote.out : 0n;
  /** The only total that may be shown: what the current selection is worth. */
  const selectedEthOut = zoraEthOut + (includeOldGnars ? oldGnarsEthOut : 0n);
  // Same reason the total is derived: the hook's `isLoading`/`failedCount` now
  // span every coin in the wallet, but the receipt speaks about the selection.
  const quotesLoading = React.useMemo(
    () => selectedCoins.some((c) => !quoteByAddr.has(c.address.toLowerCase())),
    [selectedCoins, quoteByAddr],
  );
  const failedCount = React.useMemo(
    () =>
      selectedCoins.filter(
        (c) => quoteByAddr.get(c.address.toLowerCase())?.status === "quote-failed",
      ).length,
    [selectedCoins, quoteByAddr],
  );

  const { execute, swapAndDeposit, isRunning, steps, canBatch, lastResult } = useExecuteMigration();

  // Only migrate coins that actually have a route (skip the dead-pool ones).
  const routableAddrs = React.useMemo(
    () =>
      new Set(
        [...quoteByAddr.values()].filter((q) => q.routable).map((q) => q.address.toLowerCase()),
      ),
    [quoteByAddr],
  );
  const providerByAddr = React.useMemo(
    () => new Map([...quoteByAddr.values()].map((q) => [q.address.toLowerCase(), q.provider])),
    [quoteByAddr],
  );
  const routableCoins: CoinToMigrate[] = selectedCoins
    .filter((c) => routableAddrs.has(c.address.toLowerCase()))
    .map((c) => ({
      address: c.address,
      symbol: c.symbol,
      balance: c.balance,
      provider: providerByAddr.get(c.address.toLowerCase()),
    }));
  // Count what the user PICKED, not what the wallet holds. Quoting became
  // eager (every coin is priced on load so a row can be clicked the instant
  // its value is known), which quietly turned `quotes` into "every coin in the
  // wallet" — leaving the CTA offering to sell coins nobody selected, and
  // `signatureCount` promising prompts for them too.
  const routableCount = routableCoins.length;
  const kyberCount = routableCoins.filter((c) => c.provider === "kyber").length;
  // Sequential: the Zora SDK may prompt up to three times per coin (approve,
  // permit signature, swap), then once for the deposit.
  const signatureCount = routableCount * SEQUENTIAL_PROMPTS_PER_COIN + (live ? 1 : 0);

  // The bag's own figure and copy: the same "available to deposit" total the
  // receipt shows, and a breakdown that mirrors the prototype's own —
  // `routableCount` here already counts old $gnars once it is included (its
  // quote is folded into `selectedCoins`/`quotes` above), so it is exactly
  // the prototype's `ctaCount`, not double-counted.
  // The prototype feeds digits() `fmt(v, 4)` = `toFixed(4)` — always exactly
  // six characters, always "." as the separator. formatCoinAmount is the
  // receipt's variable-precision formatter (it returns "0", "<0.0001", drops
  // trailing zeros and follows the browser locale), and feeding that to the
  // per-index digit diff made the row change width and animate every cell.
  // The wallet's own ETH is the constant floor — it is not coins in the bag and
  // must not animate. Only the sold value climbs, coin by coin.
  const bagAmount = React.useMemo(() => {
    void bagTick; // recomputed on each coalesced frame; the counts live in a ref
    let wei = walletContribution;
    bagFillRef.current.forEach((fill, id) => {
      if (fill.count <= 0 || fill.landed <= 0) return;
      const q = quoteByAddr.get(id);
      if (!q?.routable) return;
      // Exact at the ends: landed === count gives back q.out untruncated.
      wei += (q.out * BigInt(fill.landed)) / BigInt(fill.count);
    });
    return Math.max(0, Number(formatEther(wei))).toFixed(4);
  }, [bagTick, walletContribution, quoteByAddr]);

  // Safety net. A rapid re-toggle can have its in-flight coins voided by the
  // engine's per-token generation guard, and those coins never emit a `land` —
  // which would leave the figure parked below the truth. Once the dust has
  // settled, force every token the bag actually holds to its full count.
  React.useEffect(() => {
    const t = setTimeout(() => {
      // A sealed bag has no selection behind it any more; reconciling against
      // one would delete every entry and collapse the figure to the wallet.
      if (bagSealedRef.current) return;
      const map = bagFillRef.current;
      let changed = false;
      map.forEach((fill, id) => {
        if (!presentInBagRef.current.has(id)) {
          map.delete(id);
          changed = true;
        } else if (fill.landed !== fill.count) {
          fill.landed = fill.count;
          changed = true;
        }
      });
      if (changed) bumpBagTick();
    }, 1800);
    return () => clearTimeout(t);
  }, [selectedEthOut, bumpBagTick]);
  const bagWalletLabel = formatCoinAmount(walletContribution, 18, 4);
  const bagBreakdown =
    routableCount > 0
      ? t(routableCount === 1 ? "bag.breakdownSell" : "bag.breakdownSells", {
          count: routableCount,
          amount: bagWalletLabel,
        })
      : t("bag.breakdownEmpty", { amount: bagWalletLabel });
  // One control, rendered into whichever stage is on screen (only ever one
  // of them is: the desktop stage is `hidden lg:block`, the mobile bar
  // `lg:hidden`). Both live inside the `isConnected` branches below, so the
  // toggle is never on screen without a bag under it.
  const bagMuteToggle = (
    <BagMuteToggle
      muted={audio.muted}
      available={audio.available}
      onToggle={() => {
        // Unmuting is itself a gesture — prime the context on the way in, so
        // the very next coin is audible rather than the one after it.
        if (audio.muted) audio.resume();
        audio.setMuted(!audio.muted);
      }}
    />
  );

  const bagStageProps = {
    live: bagLive,
    amount: bagAmount,
    label: t("receipt.available"),
    breakdown: bagBreakdown,
  } as const;

  const toggle = (addr: string) => {
    const key = addr.toLowerCase();
    // Inside the row's click handler, so this IS the user gesture the browser
    // wants before it will let an AudioContext run. Doing it from an effect
    // instead would leave the context suspended and the bag mute forever.
    audio.resume();
    audio.tick(selected.has(key) ? "off" : "on");
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Selected coins the router cannot handle right now: a dead pool ("no-route")
  // and a quote service that fell over ("quote-failed") are different failures
  // and stay labelled apart per row, but neither can be sold in this run, so one
  // action clears both out of the selection.
  const unroutableSelected = React.useMemo(
    () =>
      selectedZora.filter((c) => {
        const q = quoteByAddr.get(c.address.toLowerCase());
        return q?.status === "no-route" || q?.status === "quote-failed";
      }),
    [selectedZora, quoteByAddr],
  );

  // Curated coins only. "Select all" must never sweep an uncurated wallet token
  // into a sale the user did not look at — those are picked one row at a time.
  const selectAll = () => {
    audio.resume();
    audio.tick("on");
    setSelected(new Set(zoraCoins.map((c) => c.address.toLowerCase())));
  };
  const deselectUnroutable = () => {
    audio.resume();
    audio.tick("off");
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of unroutableSelected) next.delete(c.address.toLowerCase());
      return next;
    });
  };
  // The old-$gnars row is a pick like any other: same gesture, same tick.
  const setOldGnarsIncluded = (next: boolean) => {
    audio.resume();
    audio.tick(next ? "on" : "off");
    setIncludeOldGnars(next);
  };

  const clearAll = () => {
    audio.resume();
    audio.tick("off");
    setSelected(new Set());
    setIncludeOldGnars(false);
    setOldGnarsAmount("");
  };

  // ---- local-only simulated run ----
  // Gated on IS_DEV (`process.env.NODE_ENV === "development"`) on purpose: in a
  // production build that constant folds to false and this whole branch is
  // eliminated from the bundle, so no misconfigured env var can ever expose a
  // fake deposit to a real user. NEXT_PUBLIC_MIGRATE_REAL=1 turns it back off
  // locally for anyone who needs to exercise the real path.
  const mockRun = IS_DEV && process.env.NEXT_PUBLIC_MIGRATE_REAL !== "1";
  const [mockSteps, setMockSteps] = React.useState<MigrationStep[]>([]);
  const [mockRunning, setMockRunning] = React.useState(false);
  const mockTimers = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  React.useEffect(() => {
    const timers = mockTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const runSimulated = async (deposit: boolean) => {
    // Same step shape the real run builds, so the step list, the CTA state and
    // anything watching them behave identically.
    const labels = [
      ...routableCoins.map((c) => `${c.symbol} → ETH${c.provider === "kyber" ? " · Kyber" : ""}`),
      ...(deposit ? [t("steps.deposit")] : []),
    ];
    setMockRunning(true);
    setMockSteps(labels.map((label, i) => ({ label, status: i === 0 ? "active" : "pending" })));
    for (let i = 0; i < labels.length; i++) {
      await new Promise<void>((resolve) => {
        mockTimers.current.push(setTimeout(resolve, 420));
      });
      setMockSteps((prev) =>
        prev.map((step, j) => ({
          ...step,
          status: j <= i ? "done" : j === i + 1 ? "active" : "pending",
        })),
      );
    }
    setMockRunning(false);
    return true;
  };

  const run = async (deposit: boolean) => {
    if (mockRun) {
      await runSimulated(deposit);
      celebrate();
      clearAll();
      return;
    }
    const result = deposit
      ? await swapAndDeposit(routableCoins)
      : await execute(routableCoins, { depositIntoMigration: false });
    if (!result) return;
    // Anything that ran changed balances: refresh regardless of outcome.
    position.refetch();
    void refetch();
    void oldGnars.refetchBalance();
    void wallet.refetch();
    // Keep the failed coins selected so the retry is one click, and keep the
    // step list on screen as the record of what failed.
    if (result.ok) {
      celebrate();
      clearAll();
    }
  };

  const hasSelection = selectedCoins.length > 0;
  const busy = isRunning || mockRunning;
  const ctaDisabled = quotesLoading || busy || routableCount === 0;
  const ctaLabel = busy
    ? t("preview.executing")
    : live
      ? t("preview.sellAndDepositCta", {
          count: routableCount,
          eth: formatCoinAmount(selectedEthOut, 18, 4),
        })
      : t("preview.migrateCta", { count: routableCount });
  // ---- the hero lift ----
  // While the run is executing the bag floats to the middle of the screen over
  // a dimmed page, plays its burst there, then snaps back a second later.
  // It is TRANSLATED, never `position: fixed`: taking it out of flow would
  // collapse the card behind the scrim and shift the page under the user.
  const HERO_SCALE = 2.1;
  const [hero, setHero] = React.useState(false);
  // Both breakpoints render a wrapper, but only one is visible; collect both
  // and measure whichever actually has a box.
  const heroStages = React.useRef<(HTMLDivElement | null)[]>([null, null]);
  const heroStageAt = React.useCallback(
    (i: number) => (el: HTMLDivElement | null) => {
      heroStages.current[i] = el;
    },
    [],
  );
  const heroTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set synchronously by celebrate(), so the idle branch below does not yank
  // the bag down in the same commit that the run finished — the success has a
  // second of its own up there before the snap.
  const heroHoldRef = React.useRef(false);
  const placeHero = React.useCallback(() => {
    const el = heroStages.current.find((n) => n && n.offsetParent !== null) ?? null;
    if (!el) return;
    // Measure against the untransformed box so repeated calls do not compound.
    const prev = el.style.transform;
    el.style.transform = "none";
    const r = el.getBoundingClientRect();
    el.style.transform = prev;
    const dx = window.innerWidth / 2 - (r.left + r.width / 2);
    const dy = window.innerHeight / 2 - (r.top + r.height / 2);
    el.style.setProperty("--gb-hero-x", `${Math.round(dx)}px`);
    el.style.setProperty("--gb-hero-y", `${Math.round(dy)}px`);
    el.style.setProperty("--gb-hero-k", String(HERO_SCALE));
  }, []);
  React.useEffect(() => {
    if (!hero) return;
    placeHero();
    let raf: number | null = null;
    const onMove = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        placeHero();
      });
    };
    window.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
    };
  }, [hero, placeHero]);
  React.useEffect(
    () => () => {
      if (heroTimer.current) clearTimeout(heroTimer.current);
    },
    [],
  );

  // The success flourish rests for a beat instead of snapping back, so the
  // moment is legible; the fanfare resolves inside the same window.
  const [justDone, setJustDone] = React.useState(false);
  const doneTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrate = React.useCallback(() => {
    setJustDone(true);
    // The bag's own flourish, fired at the same instant as the button's: a
    // mini burst out of the mouth, and the Gnars mark printed onto the cloth.
    // Both engines are told; the parked one takes the end state silently.
    // Seal BEFORE clearAll() lands: the selection is about to empty, and
    // without this the reconcile effect would read that as a deselect and
    // throw every coin back out of the bag.
    bagSealedRef.current = true;
    bagDesktop.celebrate();
    bagMobile.celebrate();
    // The burst plays up there, then it drops back. The user asked for a snap,
    // so the return has no transition — see .gb-stage--hero in globals.css.
    heroHoldRef.current = true;
    if (heroTimer.current) clearTimeout(heroTimer.current);
    heroTimer.current = setTimeout(() => {
      heroHoldRef.current = false;
      setHero(false);
      // The engine must learn the bag is small again, or its bag-local->screen
      // maths stays scaled and the next burst fires off to one side.
      bagDesktop.setView(1);
      bagMobile.setView(1);
      // Three seconds up there: the burst, the mark landing, and a beat to
      // actually look at it before the snap.
    }, 3000);
    // The jingle lands with the burst: its ascending run resolves onto the held
    // chord at ~630ms, inside the burst's own 620ms, so the two read as one
    // event rather than as a sound that arrives after the picture.
    audio.fanfare();
    if (doneTimer.current) clearTimeout(doneTimer.current);
    doneTimer.current = setTimeout(() => setJustDone(false), 3200);
  }, [bagDesktop, bagMobile, audio]);
  React.useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    },
    [],
  );

  const runSteps = mockRunning || mockSteps.length ? mockSteps : steps;
  const ctaProgress = busy
    ? runSteps.length
      ? runSteps.filter((st) => st.status === "done").length / runSteps.length
      : 0
    : null;

  // The bag gathers power in step with the run: `ctaProgress` is the fraction
  // of steps done, or null when nothing is running. Both engines are driven —
  // the parked one costs nothing (its wake() is a no-op) and is then already
  // correct if the breakpoint changes mid-run.
  const runningRef = React.useRef(false);
  React.useEffect(() => {
    if (ctaProgress === null) {
      runningRef.current = false;
      bagDesktop.setCharge(0);
      bagMobile.setCharge(0);
      // A run that ENDED WITHOUT SUCCEEDING has no celebration to hold the bag
      // up, and nothing else would ever bring it down: it would float over a
      // dimmed page for good. Only a live celebration keeps it aloft.
      if (!heroHoldRef.current) {
        setHero(false);
        bagDesktop.setView(1);
        bagMobile.setView(1);
      }
      return;
    }
    if (!runningRef.current) {
      // A fresh run wipes the previous celebration, so a second migration gets
      // its own burst rather than starting already branded.
      runningRef.current = true;
      bagDesktop.resetCelebration();
      bagMobile.resetCelebration();
    }
    bagDesktop.setCharge(ctaProgress);
    bagMobile.setCharge(ctaProgress);
    setHero(true);
    bagDesktop.setView(HERO_SCALE);
    bagMobile.setView(HERO_SCALE);
  }, [ctaProgress, bagDesktop, bagMobile]);

  const primaryCta = (
    <PrimaryCta
      label={ctaLabel}
      disabled={ctaDisabled}
      onClick={() => void run(live)}
      progress={ctaProgress}
      done={justDone}
      doneLabel={t("preview.doneCta")}
    />
  );

  const coinsElsewhereHint =
    canSwitchView && viewMode === "sa" && adminAddress
      ? t("coinsElsewhere", {
          address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
          button: t("deposit.switchButtonEoa"),
        })
      : undefined;

  return (
    // `relative` + the two flight canvases below: this element is the engines'
    // shared root, and the flight canvases are page-sized overlays on it (the
    // prototype's `.root` + `.flightcanvas`). The bag stages keep only their
    // own `overflow:hidden` bag canvas.
    <div ref={bagRootRef} className="relative">
      <div className="grid items-start gap-6 lg:grid-cols-12">
        {/* Destination first in the DOM: on mobile the deposit is never below
            the fold. On desktop it is placed back on the right by column start. */}
        <section
          className={cn(
            "flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:col-span-5 lg:col-start-8 lg:row-start-1",
            // `lg:sticky` makes this a stacking context, so the bag's z-index
            // is trapped inside it and the page-level scrim paints over the
            // whole column. Raising the column itself is what lets the bag sit
            // above the blur; `gb-lift` then fades everything in it except the
            // bag, so the column does not simply escape the dim as a bright
            // rectangle.
            hero && "gb-lift",
          )}
        >
          <ColumnHeading
            title={t("receipt.title")}
            hint={bagLive ? t("bag.headHintLive") : t("bag.headHintEmpty")}
          />

          <Card
            className={cn("gap-0 p-0", hero ? "gb-liftcard overflow-visible" : "overflow-hidden")}
          >
            {isConnected && (
              <div ref={heroStageAt(0)} className={cn("hidden lg:block", hero && "gb-hero")}>
                <BagStage
                  variant="desktop"
                  bag={bagDesktop}
                  action={bagMuteToggle}
                  {...bagStageProps}
                />
              </div>
            )}

            {isConnected && (
              <Receipt
                walletValue={walletContribution}
                walletOn={walletOn}
                walletPct={walletPct}
                walletLoading={demo ? false : wallet.isLoading}
                walletError={demo ? false : wallet.isError}
                gasReserve={gasReserve}
                zoraCount={selectedZora.length}
                zoraEthOut={zoraEthOut}
                oldGnarsIncluded={includeOldGnars}
                oldGnarsEthOut={oldGnarsEthOut}
                available={walletContribution + selectedEthOut}
                quotesLoading={quotesLoading}
                failedCount={failedCount}
                onRetryQuotes={refetchFailed}
              />
            )}

            {isConnected && (
              <div className="space-y-3 border-b p-5">
                {hasSelection && (
                  <div className="space-y-3">
                    {mockRun && (
                      <p className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 px-3 py-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        {t("preview.simulated")}
                      </p>
                    )}
                    {primaryCta}
                    {live && (
                      <div className="text-center">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs text-muted-foreground"
                          disabled={ctaDisabled}
                          onClick={() => void run(false)}
                        >
                          {t("preview.sellOnlyLink")}
                        </Button>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {canBatch
                        ? live
                          ? t("preview.batchNote")
                          : t("preview.batchNoteSellOnly")
                        : live
                          ? t("preview.sequentialNote", { count: signatureCount })
                          : t("preview.sequentialNoteSellOnly", { count: signatureCount })}
                    </p>
                    {kyberCount > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        {t("preview.viaKyber", { count: kyberCount })}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">{t("preview.slippageNote")}</p>
                    <div className="space-y-2">
                      <Disclosure label={t("preview.whyLabel")}>
                        <p>{t("preview.slippageDetails")}</p>
                        {live && <p className="mt-1.5">{t("preview.leftoverNote")}</p>}
                      </Disclosure>
                      <Disclosure label={t("route.detailsLabel")}>
                        <RouteMap coins={selectedCoins} />
                      </Disclosure>
                    </div>
                    {runSteps.length > 0 && <StepList steps={runSteps} />}
                    {lastResult?.depositFailed && (
                      <ErrorNote>
                        <span>
                          {t("preview.depositFailedAfterSells", {
                            amount: formatEther(lastResult.received),
                          })}
                        </span>
                      </ErrorNote>
                    )}
                  </div>
                )}

                <DepositPanel
                  position={position}
                  walletValue={walletWei}
                  walletError={demo ? false : wallet.isError}
                  refetchWallet={() => void wallet.refetch()}
                  usableWallet={usableWallet}
                  gasReserve={gasReserve}
                  separated={hasSelection}
                />
              </div>
            )}

            <PositionBlock position={position} connected={isConnected} />
          </Card>

          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>
              {t("deposit.ownerNote")}{" "}
              {UPGRADER_ADDRESS && (
                <a
                  href={`https://basescan.org/address/${UPGRADER_ADDRESS}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  {t("deposit.contractLink")} <ExternalLink className="size-3" />
                </a>
              )}
            </span>
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-4 lg:col-span-7 lg:col-start-1 lg:row-start-1">
          <ColumnHeading title={t("hold.title")} hint={t("hold.hint")} />

          {!isConnected ? (
            <Card className="flex flex-col items-center gap-4 p-10 text-center">
              <p className="text-sm text-muted-foreground">{t("connectPrompt")}</p>
              <ConnectButton />
            </Card>
          ) : (
            <>
              <EthRow
                value={walletWei}
                loading={demo ? false : wallet.isLoading}
                error={demo ? false : wallet.isError}
                on={walletOn}
                pct={walletPct}
                contribution={walletContribution}
                onToggle={() => setWalletOn((v) => !v)}
                onPct={setWalletPct}
              />

              {/* Reads a balance for an address that does not exist in demo
                  mode, so it would render only its own error card. */}
              {!demo && (
                <OldGnarsRow
                  position={oldGnars}
                  included={includeOldGnars}
                  onIncludedChange={setOldGnarsIncluded}
                  amount={oldGnarsAmount}
                  onAmountChange={setOldGnarsAmount}
                  avatarRef={bagAvatarRef}
                />
              )}

              <HoldingsList
                title={t("hold.zoraTitle")}
                coins={zoraCoins}
                isLoading={demo ? false : isLoading}
                isError={demo ? false : isError}
                errorMessage={t("holdingsError")}
                coinsElsewhereHint={coinsElsewhereHint}
                onRetry={() => void refetch()}
                selected={selected}
                quoteByAddr={quoteByAddr}
                onToggle={toggle}
                unroutableCount={unroutableSelected.length}
                onSelectAll={selectAll}
                onClearAll={clearAll}
                onDeselectUnroutable={deselectUnroutable}
                avatarRef={bagAvatarRef}
              />

              {/* Second source, and never folded into the one above: these came
                  from a scan of the wallet, not from Zora's curated indexer.
                  Own card, own heading, own per-row badge. */}
              {MIGRATE_WALLET_TOKENS_ENABLED && !demo && (
                <HoldingsList
                  title={t("hold.walletTitle")}
                  subtitle={t("hold.walletHint")}
                  badgeLabel={t("hold.walletBadge")}
                  coins={walletTokens}
                  isLoading={walletIsLoading || (walletPricing && walletTokens.length === 0)}
                  isError={walletIsError}
                  errorMessage={t("hold.walletError")}
                  onRetry={() => void walletRefetch()}
                  hideWhenEmpty
                  allowSelectAll={false}
                  footnote={
                    walletHiddenCount > 0 && !walletPricing
                      ? t("hold.walletHidden", {
                          count: walletHiddenCount,
                          min: `$${MIN_WALLET_TOKEN_USD}`,
                        })
                      : undefined
                  }
                  selected={selected}
                  quoteByAddr={quoteByAddr}
                  onToggle={toggle}
                  unroutableCount={0}
                  onSelectAll={selectAll}
                  onClearAll={clearAll}
                  onDeselectUnroutable={deselectUnroutable}
                  avatarRef={bagAvatarRef}
                />
              )}

              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-px size-3.5 shrink-0" />
                {MIGRATE_WALLET_TOKENS_ENABLED ? t("safetyHint") : t("safetyHintZoraOnly")}
              </p>
            </>
          )}
        </section>
      </div>

      {/* Mounted for the whole connected session, exactly as the prototype's
          bagbar is always present (Mobile.dc.html). Gating it on hasSelection
          unmounted the engine in the same commit the recall was scheduled:
          the coins-fly-back animation never played, and the engine kept a
          stale pile that double-counted on the next pick. */}
      {isConnected && (
        <div
          className={cn(
            "sticky bottom-0 z-30 bg-background/90 backdrop-blur lg:hidden",
            hero && "gb-lift gb-liftcard",
          )}
        >
          <div ref={heroStageAt(1)} className={cn(hero && "gb-hero")}>
            <BagStage variant="mobile" bag={bagMobile} action={bagMuteToggle} {...bagStageProps} />
          </div>
          <div className="py-3">{primaryCta}</div>
        </div>
      )}

      {hero && <div className="gb-scrim" aria-hidden="true" />}
      <canvas
        ref={attachDesktopFlight}
        className={cn("gb-flightcanvas", hero && "gb-flightcanvas--hero")}
        aria-hidden="true"
      />
      <canvas
        ref={attachMobileFlight}
        className={cn("gb-flightcanvas", hero && "gb-flightcanvas--hero")}
        aria-hidden="true"
      />
    </div>
  );
}

/** The one action that moves the money, shared by the card and the mobile bar. */
function PrimaryCta({
  label,
  disabled,
  onClick,
  progress,
  done,
  doneLabel,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** 0..1 across the run's steps, or null when nothing is running. */
  progress?: number | null;
  done?: boolean;
  doneLabel?: string;
}) {
  return (
    <Button
      className={cn("gb-cta relative w-full overflow-hidden", done && "gb-cta--done")}
      size="lg"
      disabled={disabled}
      onClick={onClick}
    >
      {/* A spinner says "something is happening"; this says how far along it is,
          which is the honest thing to show when the run is a known number of
          steps. Width, not a marquee — a fake indeterminate bar would imply
          progress we do not have. */}
      {progress != null && (
        <span
          // Positioned with utilities, NOT the hand-written stylesheet: this
          // element must be out of flow or it becomes a flex item and shoves
          // the label sideways as it grows. Layout cannot depend on a rule
          // that a stale CSS chunk can silently drop.
          className="gb-cta__fill pointer-events-none absolute inset-y-0 left-0 z-0"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }}
          aria-hidden="true"
        />
      )}
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        {done && <Check className="gb-cta__check size-4" aria-hidden="true" />}
        {done && doneLabel ? doneLabel : label}
      </span>
    </Button>
  );
}

function ColumnHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/**
 * The receipt: wallet ETH plus the selected sells equals what can be deposited.
 * A balance that has not been read is a skeleton and a failed read says so —
 * neither is ever rendered as zero.
 */
function Receipt({
  walletValue,
  walletOn,
  walletPct,
  walletLoading,
  walletError,
  gasReserve,
  zoraCount,
  zoraEthOut,
  oldGnarsIncluded,
  oldGnarsEthOut,
  available,
  quotesLoading,
  failedCount,
  onRetryQuotes,
}: {
  walletValue: bigint | undefined;
  walletOn: boolean;
  walletPct: number;
  walletLoading: boolean;
  walletError: boolean;
  gasReserve: bigint;
  zoraCount: number;
  zoraEthOut: bigint;
  oldGnarsIncluded: boolean;
  oldGnarsEthOut: bigint;
  available: bigint;
  quotesLoading: boolean;
  failedCount: number;
  onRetryQuotes: () => void;
}) {
  const t = useTranslations("migrate");
  const nothingSelected = zoraCount === 0 && !oldGnarsIncluded;

  return (
    <div className="space-y-2.5 border-b p-5">
      <ReceiptRow
        label={
          !walletOn
            ? t("receipt.walletExcluded")
            : walletPct < 100
              ? t("receipt.walletEthPortion", { pct: walletPct })
              : t("receipt.walletEth")
        }
      >
        {walletLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : walletError || walletValue === undefined ? (
          <span className="text-muted-foreground">{t("hold.unreadable")}</span>
        ) : (
          formatCoinAmount(walletValue, 18, 4)
        )}
      </ReceiptRow>

      {walletOn && gasReserve > 0n && walletValue !== undefined && walletValue > 0n && (
        <ReceiptRow label={t("receipt.gasReserve")}>
          {formatCoinAmount(gasReserve, 18, 4)}
        </ReceiptRow>
      )}

      <ReceiptRow
        label={
          zoraCount > 0 ? t("receipt.coinsSold", { count: zoraCount }) : t("receipt.coinsNone")
        }
      >
        {nothingSelected ? (
          <span className="text-muted-foreground">{t("receipt.nothingSelected")}</span>
        ) : quotesLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : (
          formatCoinAmount(zoraEthOut, 18, 4)
        )}
      </ReceiptRow>

      {oldGnarsIncluded && (
        <ReceiptRow label={t("receipt.oldGnarsSold")}>
          {quotesLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            formatCoinAmount(oldGnarsEthOut, 18, 4)
          )}
        </ReceiptRow>
      )}

      <div className="h-px bg-border" />

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{t("receipt.available")}</span>
        <span className="text-xl font-bold tabular-nums">
          {formatCoinAmount(available, 18, 4)}{" "}
          <span className="text-sm font-medium text-muted-foreground">ETH</span>
        </span>
      </div>

      {failedCount > 0 && (
        <ErrorNote>
          <span>{t("preview.quoteFailed", { count: failedCount })}</span>
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={onRetryQuotes}>
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      )}
    </div>
  );
}

function ReceiptRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Deposit ETH from the wallet, withdraw it while the window is open. Gated
 * until both the contract address and the upgrade id are configured; a
 * malformed config renders as an error rather than as "opens at launch".
 */
function DepositPanel({
  position,
  walletValue,
  walletError,
  refetchWallet,
  usableWallet,
  gasReserve,
  separated,
}: {
  position: UpgraderPosition;
  walletValue: bigint | undefined;
  walletError: boolean;
  refetchWallet: () => void;
  usableWallet: bigint;
  gasReserve: bigint;
  separated: boolean;
}) {
  const t = useTranslations("migrate");
  const { viewMode, canSwitchView, adminAddress } = useUserAddress();
  const { deposit, withdraw, running, lastTx } = useUpgradeDeposit();
  const [amount, setAmount] = React.useState("");
  const live = isMigrationDepositLive();

  const parsed = React.useMemo(() => {
    if (amount.trim() === "") return null;
    try {
      const v = parseEther(amount.trim());
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount]);

  const afterWrite = (outcome: "confirmed" | "sent" | "failed" | "cancelled" | "refused") => {
    // "sent" is a landed broadcast whose receipt we could not see: treat it as
    // done on our side (clear the input, refetch) — never as a failure.
    if (outcome === "confirmed" || outcome === "sent") {
      setAmount("");
      position.refetch();
      refetchWallet();
    }
  };

  // Deposits are over once the launch has run; the claim lives in the position
  // block below, so this sub-block simply steps aside.
  if (position.executed === true) return null;

  const wrap = (children: React.ReactNode) => (
    <div className={cn("space-y-2", separated && "border-t pt-4")}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {live ? <Wallet className="size-4" /> : <Lock className="size-4 text-muted-foreground" />}
        {t("deposit.fromWallet")}
      </div>
      {children}
    </div>
  );

  if (MIGRATION_CONFIG_ERROR) {
    return wrap(
      <ErrorNote>{t("deposit.configError", { error: MIGRATION_CONFIG_ERROR })}</ErrorNote>,
    );
  }
  if (!live) {
    return wrap(
      <>
        <p className="text-xs font-medium text-muted-foreground">{t("deposit.opensAtLaunch")}</p>
        <p className="text-[11px] text-muted-foreground">{t("deposit.gatedHint")}</p>
      </>,
    );
  }
  if (position.isError) {
    return wrap(
      <ErrorNote>
        <span>{t("deposit.readError")}</span>
        <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={position.refetch}>
          <RefreshCw className="size-3" /> {t("deposit.retry")}
        </Button>
      </ErrorNote>,
    );
  }

  const busy = running !== null;
  // Fail safe: until both flags have been READ as false, the window is not
  // known to be open and the buttons stay off.
  const closed = position.executed !== false || position.halted !== false;
  // External wallet viewing as its smart account: the ETH is almost always in
  // the admin EOA, not here. Say where it is instead of "more than you hold".
  const ethElsewhere = canSwitchView && viewMode === "sa" && walletValue === 0n;
  // Three states, on purpose: a readable balance caps the deposit; an
  // unreadable one must never block a legitimate deposit.
  const exceedsWallet = Boolean(
    walletValue !== undefined && parsed !== null && parsed > usableWallet,
  );

  return wrap(
    <>
      {ethElsewhere && adminAddress && (
        <p className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs text-muted-foreground">
          {t("deposit.ethElsewhere", {
            address: `${adminAddress.slice(0, 6)}…${adminAddress.slice(-4)}`,
            mode: t("deposit.modeEoa"),
            button: t("deposit.switchButtonEoa"),
          })}
        </p>
      )}

      <label className="block text-xs text-muted-foreground" htmlFor="migration-eth-amount">
        {t("deposit.amountLabel")}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id="migration-eth-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy || closed}
            className="pr-12"
            onChange={(e) => setAmount(normalizeDecimalInput(e.target.value))}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            ETH
          </span>
        </div>
        <Button
          variant="outline"
          disabled={busy || closed || walletValue === undefined}
          onClick={() => setAmount(formatEther(usableWallet))}
        >
          {t("deposit.max")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {walletValue !== undefined ? (
          <span>
            {t("deposit.walletBalance", { amount: formatCoinAmount(walletValue, 18, 6) })}
          </span>
        ) : walletError ? (
          <span>{t("deposit.walletBalanceUnavailable")}</span>
        ) : (
          <span />
        )}
        {position.deposited !== undefined && position.deposited > 0n && (
          <button
            type="button"
            className="cursor-pointer underline-offset-2 hover:underline"
            onClick={() => setAmount(formatEther(position.deposited!))}
          >
            {t("deposit.fillDeposited")}
          </button>
        )}
      </div>
      {gasReserve > 0n && (
        <p className="text-[11px] text-muted-foreground">
          {t("deposit.gasReserveHint", { amount: formatEther(gasReserve) })}
        </p>
      )}

      {parsed !== null && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t("deposit.amountEcho")} </span>
          <span className="font-semibold tabular-nums">{formatEther(parsed)} ETH</span>
          {exceedsWallet && (
            <span className="ml-2 text-destructive">{t("deposit.exceedsWallet")}</span>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={busy || closed || !parsed || exceedsWallet}
          onClick={() => parsed && void deposit({ amount: parsed }).then(afterWrite)}
        >
          {running === "deposit" ? <Spinner className="size-4" /> : t("deposit.depositCta")}
        </Button>
        <Button
          variant="outline"
          disabled={
            busy ||
            closed ||
            !parsed ||
            position.deposited === undefined ||
            parsed > position.deposited
          }
          onClick={() => parsed && void withdraw({ amount: parsed }).then(afterWrite)}
        >
          {running === "withdraw" ? <Spinner className="size-4" /> : t("deposit.withdrawCta")}
        </Button>
      </div>

      {lastTx && (
        <p className="text-[11px] text-muted-foreground">
          {lastTx.confirmed ? t("deposit.lastTxConfirmed") : t("deposit.lastTxPending")}{" "}
          <a
            href={`https://basescan.org/tx/${lastTx.hash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline underline-offset-2"
          >
            {lastTx.hash.slice(0, 10)}…{lastTx.hash.slice(-6)}
          </a>
        </p>
      )}
    </>,
  );
}

/**
 * What the deposit is and what it becomes. After the operator runs the launch
 * this block is the claim: the deposit is gone and the new $gnars is what is
 * left to collect.
 */
function PositionBlock({
  position,
  connected,
}: {
  position: UpgraderPosition;
  connected: boolean;
}) {
  const t = useTranslations("migrate");
  const { claim, running } = useUpgradeDeposit();
  const busy = running !== null;

  if (connected && position.executed === true) {
    return (
      <div className="space-y-3 bg-muted/40 p-5">
        <div className="text-xs text-muted-foreground">{t("deposit.claimTitle")}</div>
        <div className="text-2xl font-bold tabular-nums">
          {position.claimable === undefined ? "…" : formatCoinAmount(position.claimable, 18, 2)}{" "}
          <span className="text-base">$GNARS</span>
        </div>
        {position.claimed ? (
          <p className="text-xs text-muted-foreground">{t("deposit.claimed")}</p>
        ) : (
          <Button
            className="w-full"
            size="lg"
            disabled={busy || !position.claimable || position.claimable === 0n}
            onClick={() =>
              void claim().then((outcome) => {
                if (outcome === "confirmed" || outcome === "sent") position.refetch();
              })
            }
          >
            {running === "claim" ? <Spinner className="size-4" /> : t("deposit.claimCta")}
          </Button>
        )}
        <OtherAddressNotice position={position} />
        <p className="text-[11px] text-muted-foreground">
          {t("deposit.withdrawHint", {
            address: position.activeAddress
              ? `${position.activeAddress.slice(0, 6)}…${position.activeAddress.slice(-4)}`
              : "—",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 bg-muted/40 p-5">
      {connected && (
        <ReceiptRow label={t("deposit.depositedSoFar")}>
          {position.isLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : position.deposited === undefined ? (
            "—"
          ) : (
            `${formatCoinAmount(position.deposited, 18, 6)} ETH`
          )}
        </ReceiptRow>
      )}
      <ReceiptRow label={t("deposit.totalDeposits")}>
        {position.isLoading ? (
          <Skeleton className="h-4 w-16" />
        ) : position.totalDeposited === undefined ? (
          "—"
        ) : (
          `${formatCoinAmount(position.totalDeposited, 18, 4)} ETH`
        )}
      </ReceiptRow>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">{t("deposit.becomesLabel")}</span>
        <span className="flex items-center gap-2">
          <span className="size-3 shrink-0 rounded-full bg-yellow-400" />
          {t("deposit.becomesValue")}
        </span>
      </div>

      {connected && (
        <>
          <OtherAddressNotice position={position} />
          <p className="text-[11px] text-muted-foreground">
            {t("deposit.withdrawHint", {
              address: position.activeAddress
                ? `${position.activeAddress.slice(0, 6)}…${position.activeAddress.slice(-4)}`
                : "—",
            })}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * One person, two addresses. When the wallet's other view mode holds a deposit
 * (or a claim), say so and name the mode to switch to — withdraw and claim must
 * be signed by the address that deposited, and a silent "0 ETH" here would read
 * as a lost deposit.
 */
function OtherAddressNotice({ position }: { position: UpgraderPosition }) {
  const t = useTranslations("migrate");
  const other = position.other;
  if (!other) return null;
  const hasDeposit = other.deposited !== undefined && other.deposited > 0n;
  const hasClaim = other.claimable !== undefined && other.claimable > 0n && other.claimed === false;
  if (!hasDeposit && !hasClaim) return null;
  const short = `${other.address.slice(0, 6)}…${other.address.slice(-4)}`;
  const modeLabel = t(other.mode === "sa" ? "deposit.modeSa" : "deposit.modeEoa");
  const buttonLabel = t(other.mode === "sa" ? "deposit.switchButtonSa" : "deposit.switchButtonEoa");
  return (
    <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
      <div className="font-medium">
        {hasDeposit
          ? t("deposit.otherAddressDeposit", {
              amount: formatCoinAmount(other.deposited!, 18, 6),
              address: short,
            })
          : t("deposit.otherAddressClaim", { address: short })}
      </div>
      <p className="text-muted-foreground">
        {t("deposit.otherAddressHint", { mode: modeLabel, button: buttonLabel })}
      </p>
    </div>
  );
}

/** ETH already in the wallet. Unlike the coins it needs no trade, but the user
 *  still chooses whether it goes in and how much of it — it is their money
 *  sitting in their wallet, not something the page gets to volunteer. */
function EthRow({
  value,
  loading,
  error,
  on,
  pct,
  contribution,
  onToggle,
  onPct,
}: {
  value: bigint | undefined;
  loading: boolean;
  error: boolean;
  on: boolean;
  pct: number;
  contribution: bigint;
  onToggle: () => void;
  onPct: (pct: number) => void;
}) {
  const t = useTranslations("migrate");
  const readable = !loading && !error && value !== undefined && value > 0n;
  return (
    <Card className="gap-0 p-0">
      <div
        role="button"
        tabIndex={readable ? 0 : -1}
        aria-pressed={on}
        aria-disabled={!readable}
        onClick={readable ? onToggle : undefined}
        onKeyDown={
          readable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        className={cn(
          "flex flex-row items-center gap-3 p-4",
          readable ? "cursor-pointer transition-colors hover:bg-accent" : "cursor-default",
        )}
      >
        <Checkbox checked={on} disabled={!readable} tabIndex={-1} className="pointer-events-none" />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <Wallet className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("hold.ethTitle")}</div>
          <div className="text-xs text-muted-foreground">
            {on ? t("hold.ethReady") : t("hold.ethExcluded")}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {loading ? (
              <Skeleton className="ml-auto h-4 w-20" />
            ) : error || value === undefined ? (
              <span className="text-xs font-normal text-muted-foreground">
                {t("hold.unreadable")}
              </span>
            ) : (
              `${formatCoinAmount(on ? contribution : value, 18, 4)} ETH`
            )}
          </div>
          {on ? (
            <div className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("hold.accepted")}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">{t("hold.ethNotCounted")}</div>
          )}
        </div>
      </div>
      {on && readable && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">{t("hold.ethPortion")}</span>
          {OLD_GNARS_PORTIONS.map((p) => (
            <Button
              key={p.pct}
              variant={pct === p.pct ? "secondary" : "outline"}
              size="sm"
              onClick={() => onPct(p.pct)}
            >
              {t(p.labelKey)}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Old $gnars shaped like a Zora coin so the quote and run paths treat it uniformly. */
function oldGnarsAsCoin(balance: bigint): MigratableCoin {
  return {
    address: GNARS_CREATOR_COIN,
    source: "zora",
    symbol: "$GNARS",
    name: "Gnars (old)",
    decimals: 18,
    balance: balance.toString(),
    displayBalance: formatEther(balance),
    logoUrl: null,
    usdValue: null,
    marketCap: null,
    pairedWith: { address: "0x1111111111166b7FE7bd91427724B487980aFc69", name: "ZORA" },
  };
}

/** Quick portions for the old $gnars sell. 100% leads and is styled as the
 *  recommendation: the point of the migration is to leave the old coin behind. */
const OLD_GNARS_PORTIONS = [
  { pct: 100, labelKey: "oldGnars.portionAll" },
  { pct: 75, labelKey: "oldGnars.portion75" },
  { pct: 50, labelKey: "oldGnars.portion50" },
  { pct: 25, labelKey: "oldGnars.portion25" },
] as const;

/**
 * The sell leg for people who already hold old $gnars. ETH-only means the only
 * way in for them is selling into the thin $gnars → ZORA → WETH pool, so this
 * row quotes that sale and shows the price impact as a number. It also says, in
 * so many words, that holding and doing nothing is a legitimate choice.
 */
function OldGnarsRow({
  position,
  included,
  onIncludedChange,
  amount,
  onAmountChange,
  avatarRef,
}: {
  position: ReturnType<typeof useOldGnarsPosition>;
  included: boolean;
  onIncludedChange: (v: boolean) => void;
  amount: string;
  onAmountChange: (v: string) => void;
  /** Registers a token id's avatar element as its launch origin (same shape
   *  as HoldingsList's, called here — `ref={avatarRef(id)}` — rather than by
   *  the parent, matching the one call-expression shape the react-hooks/refs
   *  rule does not flag: see HoldingsList's own use of it below). */
  avatarRef: (tokenId: string) => (el: HTMLElement | null) => void;
}) {
  const t = useTranslations("migrate");

  if (position.isBalanceLoading) {
    return (
      <Card className="p-4">
        <Skeleton className="h-12 w-full" />
      </Card>
    );
  }
  if (position.isBalanceError) {
    return (
      <Card className="p-5">
        <ErrorNote>
          <span>{t("oldGnars.balanceError")}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1"
            onClick={() => void position.refetchBalance()}
          >
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      </Card>
    );
  }
  // Unknown is not zero: keep the skeleton until the balance has been read.
  if (position.balance === undefined) {
    return (
      <Card className="p-4">
        <Skeleton className="h-12 w-full" />
      </Card>
    );
  }
  if (position.balance === 0n) return null;

  const balance = position.balance;
  const impact = position.quote?.impactBps;
  const impactPct = impact === null || impact === undefined ? null : impact / 100;
  // Typing more than you hold is caught here rather than at signing time; the
  // hook already clamps the quote, so this only explains why the number stopped
  // following the field.
  const overBalance = (() => {
    const raw = amount.trim();
    if (!raw) return false;
    try {
      return parseEther(raw) > balance;
    } catch {
      return false;
    }
  })();
  const impactTone =
    impactPct === null
      ? "text-muted-foreground"
      : impactPct >= 10
        ? "text-destructive"
        : impactPct >= 3
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground";

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-3 p-4">
        <Checkbox
          checked={included}
          disabled={position.isQuoteError || !position.quote}
          aria-label={t("oldGnars.include")}
          onCheckedChange={(v) => onIncludedChange(v === true)}
        />
        <span
          ref={avatarRef(OLD_GNARS_KEY)}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-xs font-bold text-black"
        >
          G
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("oldGnars.title")}</div>
          <div className="text-xs text-muted-foreground">{t("oldGnars.body")}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {formatCoinAmount(balance, 18, 0)}
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {position.isQuoting ? (
              <Skeleton className="ml-auto h-3.5 w-16" />
            ) : position.isQuoteError ? (
              t("oldGnars.noRoute")
            ) : position.quote ? (
              `≈ ${formatCoinAmount(position.quote.out, 18, 6)} ETH`
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2 border-t p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {OLD_GNARS_PORTIONS.map(({ pct, labelKey }) => (
              <Button
                key={pct}
                type="button"
                variant={pct === 100 ? "secondary" : "outline"}
                size="sm"
                className="h-8 px-2.5 text-xs"
                onClick={() => onAmountChange(formatEther((balance * BigInt(pct)) / 100n))}
              >
                {t(labelKey)}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-xs">
            <span className="whitespace-nowrap text-muted-foreground">{t("oldGnars.impact")}</span>
            <span className={cn("font-semibold tabular-nums", impactTone)}>
              {position.isQuoting ? (
                <Skeleton className="h-4 w-10" />
              ) : impactPct === null ? (
                t("oldGnars.impactUnknown")
              ) : (
                `−${impactPct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
              )}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            id="old-gnars-amount"
            aria-label={t("oldGnars.amountLabel")}
            className="h-8"
            inputMode="decimal"
            placeholder={formatEther(balance)}
            value={amount}
            onChange={(e) => onAmountChange(normalizeDecimalInput(e.target.value))}
          />
          <span className="text-xs font-medium text-muted-foreground">$GNARS</span>
        </div>
      </div>

      <div className="space-y-1 border-t px-4 py-3">
        {overBalance && (
          <p className="text-[11px] text-destructive">{t("oldGnars.exceedsBalance")}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t("oldGnars.impactHint")} {t("oldGnars.holdBody")}
        </p>
      </div>
    </Card>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
      <AlertTriangle className="size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/**
 * Step-by-step route map: groups the selected coins by their first hop, then
 * shows the shared tail into ETH. Purely explanatory — each coin is one trade.
 */
function RouteMap({ coins }: { coins: MigratableCoin[] }) {
  const t = useTranslations("migrate");

  const groups = React.useMemo(() => {
    const map = new Map<string, { via: RouteHop; tail: RouteHop[]; sources: MigratableCoin[] }>();
    for (const coin of coins) {
      const { hops } = buildRoute(coin);
      const via = hops[1];
      const key = `${via.kind}:${via.label}`;
      const existing = map.get(key);
      if (existing) existing.sources.push(coin);
      else map.set(key, { via, tail: hops.slice(2), sources: [coin] });
    }
    return Array.from(map.values());
  }, [coins]);

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {groups.map((g, i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {g.sources.map((c) => (
                <span
                  key={c.address}
                  className="max-w-[9rem] truncate rounded-md border bg-background px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground"
                >
                  {c.symbol}
                </span>
              ))}
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
              <RouteChips hops={[g.via, ...g.tail]} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("route.hopHint")}</p>
    </div>
  );
}

/** A one-click disclosure for detail that would otherwise crowd the decision. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="mt-2 text-xs text-muted-foreground">{children}</div>
    </details>
  );
}

/** Renders a routing path as connected chips: coin → creator → ZORA → ETH. */
function RouteChips({ hops, className }: { hops: RouteHop[]; className?: string }) {
  const chipClass = (kind: RouteHop["kind"]) => {
    switch (kind) {
      case "eth":
        return "bg-primary/15 text-primary font-semibold";
      case "zora":
        return "bg-accent text-foreground";
      case "creator":
        return "bg-muted text-foreground";
      default:
        return "bg-background text-muted-foreground border";
    }
  };
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className ?? ""}`}>
      {hops.map((hop, i) => (
        <React.Fragment key={`${hop.label}-${i}`}>
          <span
            className={`max-w-[10rem] truncate rounded-md px-1.5 py-0.5 text-[11px] leading-tight ${chipClass(hop.kind)}`}
          >
            {hop.label}
          </span>
          {i < hops.length - 1 && (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/** Small round coin avatar: logo when available, symbol initial otherwise. */
function CoinAvatar({ src, symbol }: { src: string | null; symbol: string }) {
  const [errored, setErrored] = React.useState(false);
  if (src && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={symbol}
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-full object-cover"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold uppercase text-muted-foreground">
      {symbol.slice(0, 2)}
    </div>
  );
}

function HoldingsList({
  title,
  subtitle,
  badgeLabel,
  footnote,
  hideWhenEmpty = false,
  allowSelectAll = true,
  errorMessage,
  coins,
  isLoading,
  isError,
  onRetry,
  coinsElsewhereHint,
  selected,
  quoteByAddr,
  onToggle,
  unroutableCount,
  onSelectAll,
  onClearAll,
  onDeselectUnroutable,
  avatarRef,
}: {
  /** Heading for this source. The two sources never share a card. */
  title: string;
  /** One line saying what this source is, when it is not self-evident. */
  subtitle?: string;
  /** Per-row marker, so a row is identifiable as this source on its own. */
  badgeLabel?: string;
  /** Shown under the rows — e.g. how many were filtered out and why. */
  footnote?: string;
  /** An empty curated list is news; an empty scan is not, so it can vanish. */
  hideWhenEmpty?: boolean;
  /** Off for uncurated sources: bulk-selecting tokens nobody vetted is the
   *  exact mistake the spam filter exists to prevent. */
  allowSelectAll?: boolean;
  errorMessage: string;
  coins: MigratableCoin[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Shown with the empty state when this address's coins live at its other address. */
  coinsElsewhereHint?: string;
  selected: Set<string>;
  quoteByAddr: Map<string, CoinQuote>;
  onToggle: (addr: string) => void;
  /** Selected coins with no route or a failed quote. */
  unroutableCount: number;
  onSelectAll: () => void;
  onClearAll: () => void;
  onDeselectUnroutable: () => void;
  /** Registers a coin row's avatar element as that coin's launch origin. */
  avatarRef: (tokenId: string) => (el: HTMLElement | null) => void;
}) {
  const t = useTranslations("migrate");

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="p-5">
        <ErrorNote>
          <span>{errorMessage}</span>
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={onRetry}>
            <RefreshCw className="size-3" /> {t("deposit.retry")}
          </Button>
        </ErrorNote>
      </Card>
    );
  }

  if (coins.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <Card className="space-y-2 p-10 text-center text-sm text-muted-foreground">
        <p>{t("noCoins")}</p>
        {coinsElsewhereHint && <p className="text-xs">{coinsElsewhereHint}</p>}
      </Card>
    );
  }

  const selectedCount = coins.filter((c) => selected.has(c.address.toLowerCase())).length;
  // A coin is only pickable once its own ETH value is on screen, so "Select
  // all" — which picks every coin at once — waits for the last of them.
  const anyQuotePending = coins.some((c) => !quoteByAddr.has(c.address.toLowerCase()));

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">
              {unroutableCount > 0
                ? t("hold.selectedCountNoRoute", {
                    selected: selectedCount,
                    total: coins.length,
                    noRoute: unroutableCount,
                  })
                : t("hold.selectedCount", { selected: selectedCount, total: coins.length })}
            </span>
          </div>
          {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {allowSelectAll && (
            <Button
              variant="outline"
              size="sm"
              onClick={onSelectAll}
              disabled={anyQuotePending}
              title={anyQuotePending ? t("hold.pricingAll") : undefined}
            >
              {t("selectAll")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onDeselectUnroutable}
            disabled={unroutableCount === 0}
          >
            {unroutableCount > 0
              ? t("hold.deselectUnroutableCount", { count: unroutableCount })
              : t("hold.deselectUnroutable")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClearAll} disabled={selected.size === 0}>
            {t("clear")}
          </Button>
        </div>
      </div>
      <ul className="max-h-[420px] divide-y overflow-y-auto">
        {coins.map((coin) => {
          const key = coin.address.toLowerCase();
          const isChecked = selected.has(key);
          const quote = quoteByAddr.get(key);
          const noRoute = quote?.status === "no-route";
          const quoteFailed = quote?.status === "quote-failed";
          // Every coin is quoted up front, so the value shows whether or not the
          // coin is picked — and a coin with no value yet is still being priced:
          // a skeleton, never a blank that reads as "nothing to get".
          const quotePending = quote === undefined;
          return (
            <li key={key}>
              {/* A div, not a button: the Checkbox is itself a button and buttons
                  cannot nest. Keyboard reachable via tabIndex + Enter/Space. */}
              {/* Until this coin has a price it cannot be picked: the bag sizes
                  its flight from that value. Non-interactive for real — no
                  handlers and out of the tab order, not merely
                  `pointer-events-none`, which a keyboard would walk straight
                  past. */}
              <div
                role="button"
                tabIndex={quotePending ? -1 : 0}
                aria-pressed={isChecked}
                aria-disabled={quotePending || undefined}
                title={quotePending ? t("hold.pricing") : undefined}
                onClick={quotePending ? undefined : () => onToggle(coin.address)}
                onKeyDown={
                  quotePending
                    ? undefined
                    : (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onToggle(coin.address);
                        }
                      }
                }
                className={cn(
                  "flex w-full items-center gap-3 p-3 text-left transition-colors",
                  quotePending ? "cursor-default opacity-50" : "cursor-pointer hover:bg-accent",
                  noRoute && "opacity-60",
                )}
              >
                <Checkbox
                  checked={isChecked}
                  disabled={quotePending}
                  tabIndex={-1}
                  className="pointer-events-none"
                />
                <span ref={avatarRef(key)} className="inline-flex shrink-0">
                  <CoinAvatar src={coin.logoUrl} symbol={coin.symbol} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{coin.name}</span>
                    {badgeLabel && (
                      <span className="shrink-0 rounded border px-1 py-px text-[10px] font-medium uppercase leading-tight text-muted-foreground">
                        {badgeLabel}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs tabular-nums text-muted-foreground">
                    {formatCoinAmount(BigInt(coin.balance), coin.decimals)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {quotePending ? (
                    <Skeleton className="ml-auto h-4 w-20" />
                  ) : noRoute ? (
                    <div className="text-xs text-muted-foreground">{t("hold.noLiquidity")}</div>
                  ) : quoteFailed ? (
                    <div className="flex items-center justify-end gap-1 text-xs text-destructive">
                      <AlertTriangle className="size-3 shrink-0" />
                      {t("hold.quoteFailed")}
                    </div>
                  ) : quote?.routable ? (
                    <div className="text-sm font-medium tabular-nums">
                      ≈ {formatCoinAmount(quote.out, 18, 4)} ETH
                    </div>
                  ) : null}
                  {coin.usdValue !== null && (
                    <div className="text-xs tabular-nums text-muted-foreground">
                      ${coin.usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {footnote && <p className="border-t p-3 text-xs text-muted-foreground">{footnote}</p>}
    </Card>
  );
}

/** Per-step progress for the run (one row per swap, plus the deposit). */
function StepList({ steps }: { steps: MigrationStep[] }) {
  return (
    <ol className="space-y-1.5 rounded-lg border p-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-2 text-sm">
          {step.status === "done" ? (
            <Check className="size-4 text-primary" />
          ) : step.status === "failed" ? (
            <X className="size-4 text-destructive" />
          ) : step.status === "active" ? (
            <Spinner className="size-4" />
          ) : (
            <span className="size-4 rounded-full border" />
          )}
          <span
            className={
              step.status === "failed"
                ? "text-destructive"
                : step.status === "pending"
                  ? "text-muted-foreground"
                  : ""
            }
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
