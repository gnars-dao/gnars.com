"use client";

// The /morpheus landing — the page the Gnars subnet bio on the Morpheus site
// links to. A cold visitor arrives knowing Morpheus but not Gnars, so the hero
// explains the whole build before asking for anything. Below it the page reuses
// the production subnet components rather than restating them: SubnetSection
// carries the live ladder + stake CTA, RoadmapSection the four phases. /stake
// stays the multi-purpose page; this one is single-purpose.
//
// ART DIRECTION — Morpheus narrates the page.
//
//   A section is flanked by one PS1-style cut-out of the character whose
//   gesture matches what the section says: arms wide for the opening pitch, an
//   arm thrown out presenting the flywheel steps, hands pressing down over the
//   fine print, an offered palm at the closing CTA. Two sections carry no
//   figure: the milestone grid (three data columns already fill it) and the
//   crew (four rider portraits already fill it).
//
//   Rules the figures follow, so they stay decoration and never content:
//   - `aria-hidden` with an empty alt — zero new i18n strings, nothing for a
//     screen reader to read out.
//   - Sides alternate down the page (right, alternating, left, right, left,
//     right) so the eye zig-zags instead of tracking one column.
//   - Editorial crop, never a miniature: every figure renders big enough that
//     the visible part is waist-up, with the legs cropped HARD by the card's
//     own edge (overflow-hidden + bleed). No gradient dissolve on bodies — a
//     half-transparent torso reads as a rendering bug, a frame crop reads as
//     layout. The only soft mask left on this page is the crew heads' neck
//     fade, which predates this pass.
//   - Shadows are near-invisible contact shadows. A big blurred drop-shadow
//     under a cut-out reads as a smudge on the card background.
//   - Explicit width/height from the trimmed PNG (no `fill`) so nothing shifts
//     while the bitmap loads, and `max-w-none` because the height is what is
//     pinned, not the width.
//   - Big side figures are `hidden` until the breakpoint where there is real
//     slack for them. On mobile the page is text plus the small in-card busts,
//     so nothing covers a paragraph and the hero CTA stays above the fold.
//
// Custody copy rule (same as everywhere else): every claim in `facts` was read
// from the verified BuildersV4 source — permissionless withdraw to the staker's
// wallet, 7-day lock counted from the LAST deposit, rewards accrue to the
// subnet. Don't add a claim here without reading the contract first.
import { useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import { Clapperboard, Flag, MapPin, Rocket, Shirt, Tv } from "lucide-react";
import { CHARACTERS } from "@/components/stake/CharacterSelector";
import { GnarsStakeDialog } from "@/components/stake/GnarsStakeDialog";
import { RoadmapSection } from "@/components/stake/RoadmapSection";
import { CARD, CARD_PAD, GOLD, GOLD_CTA, GOLD_INK, MUTED } from "@/components/stake/stake-ui";
import { SubnetSection } from "@/components/stake/SubnetSection";
import { Button } from "@/components/ui/button";
import { useGnarsSubnet } from "@/hooks/use-gnars-subnet";
import { Link } from "@/i18n/navigation";
import { EASE_OUT_ARRAY } from "@/lib/motion";
import { isMilestoneDone, nextMilestone, SUBNET_MILESTONES } from "@/lib/stake-milestones";
import { cn } from "@/lib/utils";

// The four riders who narrate the page, one Morpheus topic each. Heads are
// cropped from the /stake cut-outs with the roster's own face zoom data, so a
// new cut-out automatically works here too.
const CREW = ["vlad", "r4to", "yan", "pamtech"] as const;

// One icon per milestone rung. Data-keyed (not positional) so a ladder edit in
// stake-milestones.ts can't silently shift every icon.
const RUNG_ICONS: Record<string, typeof Tv> = {
  "10k": Tv,
  "15k": Flag,
  "25k": Clapperboard,
  "30k": Shirt,
  "50k": MapPin,
  "100k": Rocket,
};

// Trimmed cut-outs in /public/morpheus/poses. Dimensions are the real pixel size
// of each file (alpha bbox + 6px), kept here so every <Image> can declare its
// intrinsic ratio without a layout shift. Re-export a pose and these change.
const POSES = {
  "arms-wide": { w: 794, h: 890 },
  "point-far": { w: 653, h: 898 },
  "calm-down": { w: 514, h: 890 },
  offer: { w: 377, h: 888 },
  board: { w: 941, h: 1000 },
} as const;

type PoseId = keyof typeof POSES;

/** Crew heads, framed at 3x4 ID-photo proportions but with no frame drawn: the
 *  cut-outs are 3:4 and the box is 3:4, so `background-size` (a % of the box
 *  WIDTH) scales uniformly and the visible slice of the art is exactly 1/zoom.
 *  350% shows the top 28.6%: headroom, head, shoulders. With no box to justify
 *  a hard edge, the bottom fade dissolves the chest instead of guillotining it. */
const PHOTO_ZOOM = "350%";
const PHOTO_POS = "50% 3.2%";
const PHOTO_FADE = "linear-gradient(to bottom, #000 76%, transparent 99%)";

/**
 * A decorative Morpheus figure. Height comes from `className` (`h-[...]`) and
 * the width follows the intrinsic ratio, which is why `w-auto max-w-none` is
 * baked in — Tailwind's preflight would otherwise cap it at the parent width and
 * silently squash the pose. The shadow is a barely-there contact shadow that
 * follows the alpha silhouette; anything blurrier smudges the card background.
 */
function Pose({
  id,
  className,
  sizes = "(max-width: 640px) 40vw, 320px",
}: {
  id: PoseId;
  className?: string;
  sizes?: string;
}) {
  return (
    <Image
      src={`/morpheus/poses/${id}.png`}
      alt=""
      aria-hidden
      width={POSES[id].w}
      height={POSES[id].h}
      sizes={sizes}
      className={cn(
        "pointer-events-none w-auto max-w-none select-none",
        "[filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.14))]",
        "dark:[filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.45))]",
        className,
      )}
    />
  );
}

/** Fade + 12px rise the first time a block scrolls in. Motion-off users get the
 *  same markup with no animation at all, not a slower one. */
function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.5, ease: EASE_OUT_ARRAY, delay }}
    >
      {children}
    </motion.div>
  );
}

export function MorpheusPageContent() {
  const t = useTranslations("stake.morpheusPage");
  const tSub = useTranslations("stake.page.subnet");
  const tChar = useTranslations("stake.characters");
  const locale = useLocale();
  const [stakeOpen, setStakeOpen] = useState(false);
  const { totalStaked } = useGnarsSubnet();
  const next = nextMilestone(totalStaked);

  const steps = ["step1", "step2", "step3"] as const;
  const facts = ["f1", "f2", "f3"] as const;

  const stakeButton = (
    <Button
      onClick={() => setStakeOpen(true)}
      className={GOLD_CTA}
      style={{ backgroundImage: GOLD, color: GOLD_INK }}
    >
      {t("ctaStake")}
    </Button>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 sm:px-6">
      {/* Hero — text left, arms-wide right. The figure sits in the grid (not
          absolutely) so it can never overlap the copy at any width, bottom
          aligned and bled into the card's bottom padding. */}
      <section className={`${CARD} ${CARD_PAD} relative overflow-hidden sm:p-8`}>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <div className="flex items-center gap-2.5">
              <Image
                src="/logos/morpheus.webp"
                alt="Morpheus"
                width={28}
                height={28}
                className="rounded-md"
              />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {t("eyebrow")}
              </span>
            </div>
            <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">{t("title")}</h1>
            <p className={`mt-3 max-w-2xl text-sm sm:text-base ${MUTED}`}>{t("lede")}</p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {stakeButton}
              <Button asChild variant="outline">
                <Link href="/stake">{t("ctaFull")}</Link>
              </Button>
            </div>
          </div>
          {/* Waist-up, cropped by the card's own bottom edge: the figure is
              rendered taller than the visible window and bled past the padding,
              overflow-hidden on the section does the cut. */}
          <Reveal className="hidden justify-self-end md:-mr-2 md:-mb-[160px] md:block lg:-mb-[200px]">
            <Pose id="arms-wide" className="h-[430px] lg:h-[560px]" sizes="500px" />
          </Reveal>
        </div>
        {/* Mobile: the same waist-up crop, centered under the CTAs and bled to
            the card's bottom edge, so the buttons keep their place above the
            fold and the crop line coincides with the frame. */}
        <Reveal className="relative mt-5 -mb-4 h-[168px] overflow-hidden sm:-mb-6 md:hidden">
          <Pose
            id="arms-wide"
            className="absolute top-0 left-1/2 h-[300px] -translate-x-1/2"
            sizes="70vw"
          />
        </Reveal>
      </section>

      {/* The flywheel, narrated. One Morpheus — hand on the conspiracy board —
          presents the three steps as a numbered list: the figure appears once,
          big, instead of three miniatures, and the arm reads into the rows it
          introduces. The cropped feet run past the card's bottom edge. The
          `board` cut-out is far wider than a plain pose, so its column is
          capped and it only appears from `lg` up, where the list still has
          room. */}
      <section className={`${CARD} ${CARD_PAD} overflow-hidden sm:p-8`}>
        <h2 className="text-lg font-bold tracking-tight">{t("how.title")}</h2>
        <div className="flex items-end gap-6 lg:gap-10">
          <Reveal className="hidden shrink-0 lg:-mb-[90px] lg:block">
            <Pose id="board" className="h-[400px]" sizes="380px" />
          </Reveal>
          <ol className="min-w-0 flex-1">
            {steps.map((s, i) => (
              <Reveal key={s} delay={i * 0.08}>
                <li
                  className={cn(
                    "flex gap-4 border-b border-border/40 py-4",
                    i === 0 && "md:pt-6",
                    i === steps.length - 1 && "border-b-0 pb-0",
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-extrabold text-background">
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-sm font-semibold">{t(`how.${s}t`)}</div>
                    <p className={`mt-1 text-xs leading-relaxed ${MUTED}`}>{t(`how.${s}d`)}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* The amplification ladder, illustrated — the marketing Gnars ships for
          Morpheus at each rung, with live unlock state. Morpheus green is the
          accent on purpose: this page is the Morpheus page. No figure here —
          the `board` cut-out narrates the flywheel above, and the grid keeps
          its three columns. */}
      <section className={`${CARD} ${CARD_PAD} sm:p-8`}>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold tracking-tight">{t("amp.title")}</h2>
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-300">
              {t("amp.liveChip", { n: Math.floor(totalStaked) })}
            </span>
          </div>
          <p className={`mt-1.5 max-w-2xl text-sm ${MUTED}`}>{t("amp.desc")}</p>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SUBNET_MILESTONES.map((m) => {
              const done = isMilestoneDone(m, totalStaked);
              const isNext = next?.id === m.id;
              const Icon = RUNG_ICONS[m.id] ?? Rocket;
              return (
                <li
                  key={m.id}
                  className={cn(
                    "rounded-2xl border p-4 transition-colors",
                    done &&
                      "border-emerald-500/40 bg-gradient-to-br from-emerald-500/[0.12] to-transparent",
                    isNext &&
                      "border-amber-500/50 bg-gradient-to-br from-amber-500/[0.08] to-transparent",
                    !done && !isNext && "border-border/60 bg-background/40",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl",
                        done
                          ? "bg-emerald-500 text-white"
                          : isNext
                            ? "bg-amber-500/90 text-white"
                            : "border border-border text-muted-foreground",
                      )}
                    >
                      <Icon className="h-5 w-5" aria-hidden />
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        done
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                          : isNext
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
                            : "text-muted-foreground",
                      )}
                    >
                      {done ? t("amp.unlocked") : isNext ? t("amp.next") : t("amp.upcoming")}
                    </span>
                  </div>
                  <div className="mt-3 text-xl font-black tabular-nums">
                    {m.amountMor.toLocaleString(locale)}{" "}
                    <span className="text-xs font-medium text-muted-foreground">MOR</span>
                  </div>
                  <div className="mt-1 text-sm font-medium leading-snug">
                    {tSub(`milestones.${m.id}`)}
                  </div>
                  <div
                    className={`mt-1.5 text-[10px] font-semibold uppercase tracking-wider ${MUTED}`}
                  >
                    {tSub(`firmness.${m.firmness}`)}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* The crew explains it, fighting-game style: rider heads from the /stake
          cut-outs + speech balloons. This is also where the Morpheus-powered
          SPONSORSHIP VAULTS get their mention — the subnet sections above are
          about MOR, this bubble routes people to the rider side. No Morpheus
          figure here: four faces already carry the section, and a fifth body
          just crowded them.

          The heads sit at 3x4 ID-photo proportions with no frame around them —
          bare cut-outs on the card, chest dissolved by a bottom fade. Local
          override, not `c.face` — those values are the /stake roster's tight
          head crop and are shared production data. */}
      <section className={`${CARD} ${CARD_PAD} sm:p-8`}>
        <h2 className="text-lg font-bold tracking-tight">{t("crew.title")}</h2>
        <div className="mt-5 flex flex-col gap-5">
          {CREW.map((id, i) => {
            const c = CHARACTERS.find((x) => x.id === id);
            if (!c) return null;
            const flipped = i % 2 === 1;
            return (
              <div
                key={id}
                className={cn("flex items-center gap-3 sm:gap-5", flipped && "flex-row-reverse")}
              >
                <div className="flex w-24 shrink-0 flex-col items-center gap-1.5 sm:w-32">
                  <div
                    aria-hidden
                    className="w-full"
                    style={{
                      aspectRatio: "3 / 4",
                      backgroundImage: `url("${c.image}")`,
                      backgroundSize: PHOTO_ZOOM,
                      backgroundPosition: PHOTO_POS,
                      backgroundRepeat: "no-repeat",
                      maskImage: PHOTO_FADE,
                      WebkitMaskImage: PHOTO_FADE,
                      filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.18))",
                    }}
                  />
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    {tChar(`${id}.name`)}
                  </span>
                </div>
                <div
                  className={cn(
                    "relative max-w-xl rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm leading-relaxed shadow-sm",
                    flipped ? "mr-1.5" : "ml-1.5",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-border/60 bg-card",
                      flipped ? "-right-1.5 border-t border-r" : "-left-1.5 border-b border-l",
                    )}
                  />
                  {t(`crew.${id}`)}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Custody facts AND the page's closing ask, merged into one card. They
          used to be two stacked blocks and the second was a near-empty amber
          band holding nothing but the hero's own buttons — the fine print is
          exactly the reassurance that earns the ask, so the ask belongs under
          it. Morpheus stands in the row with both hands pressing down: calm,
          here are the terms. */}
      <section className={`${CARD} ${CARD_PAD} overflow-hidden`}>
        <div className="flex items-end gap-6">
          {/* Chest-up, hands pressing down at the crop line — bled past the
              padding so the card edge cuts him at the wrists. */}
          <Reveal className="hidden shrink-0 md:-mb-[122px] md:block">
            <Pose id="calm-down" className="h-[300px]" sizes="180px" />
          </Reveal>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold tracking-tight">{t("facts.title")}</h2>
            <ul className="mt-3 grid gap-2.5 sm:grid-cols-3">
              {facts.map((f) => (
                <li key={f} className={`text-xs leading-relaxed ${MUTED}`}>
                  {t(`facts.${f}`)}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {stakeButton}
              <Button asChild variant="outline">
                <Link href="/stake">{t("ctaFull")}</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Live ladder + stake CTA, and the four phases — the production sections.
          RoadmapSection is shared with /stake, so it stays untouched: the
          offered palm is a sibling parked in its right gutter on this page
          only, absolutely placed and cropped by its own window so the shared
          card keeps its own box. */}
      <SubnetSection showChecklist={false} />
      <div className="relative">
        <RoadmapSection />
        {/* The gutter the roadmap copy leaves free is roughly the card's right
            300px; the window claims exactly that and the figure is centred in
            it, rather than shoved against the edge where his arm clipped. Top
            aligned so the crop lands on the shins, never the head. */}
        <Reveal className="pointer-events-none absolute right-6 bottom-0 hidden h-[290px] w-[300px] overflow-hidden lg:block">
          <Pose
            id="offer"
            className="absolute top-0 left-1/2 h-[400px] -translate-x-1/2"
            sizes="180px"
          />
        </Reveal>
      </div>

      <GnarsStakeDialog open={stakeOpen} onOpenChange={setStakeOpen} />
    </div>
  );
}
