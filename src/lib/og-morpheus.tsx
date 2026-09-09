import { BASE_URL } from "@/lib/config";
import { getGnarsSubnetTotalStaked } from "@/lib/morpheus-builder";
import { OG_COLORS, OG_FONTS } from "@/lib/og-utils";

/**
 * The shared composition behind /morpheus's two share cards: the 1200x630 OG
 * image and the 1200x800 Farcaster embed. They differ only in canvas and in how
 * much room the figure gets, so the layout lives here once — a copy-paste pair
 * drifts the moment one of them is tweaked.
 */

export const MOR_GREEN = "#2be58b";

/**
 * The cut-out that narrates the page itself, reused so the share card and the
 * page are recognizably the same piece. Absolute because Satori has no access
 * to the filesystem — it fetches this URL at render time. `BASE_URL` is the
 * canonical www host, which serves the asset with no redirect in between.
 */
const FIGURE_URL = `${BASE_URL}/morpheus/poses/board.png`;
/** The real pixel size of that file, used to hold its ratio without guessing. */
const FIGURE_RATIO = 941 / 1000;

export type MorpheusCardData = {
  stakedLabel: string;
};

/**
 * Read the subnet for the card.
 *
 * A failed read renders as a dash, never as "0 MOR" — an empty subnet is a very
 * different claim from an unreadable one, and a share card is exactly where
 * that lie would travel furthest.
 */
export async function readMorpheusCardData(isPt: boolean): Promise<MorpheusCardData> {
  let staked: number | null = null;
  try {
    staked = await getGnarsSubnetTotalStaked();
  } catch (error) {
    console.error("[morpheus OG] subnet read failed:", error);
  }

  const locale = isPt ? "pt-BR" : "en-US";
  return {
    stakedLabel: staked == null ? "—" : Math.floor(staked).toLocaleString(locale),
  };
}

export function morpheusCardLabels(isPt: boolean) {
  return {
    eyebrow: "GNARS × MORPHEUS",
    title: isPt ? "A Gnars constrói na Morpheus" : "Gnars builds on Morpheus",
    sub: isPt
      ? "Faça stake de MOR na subnet Gnars Builder"
      : "Stake MOR into the Gnars Builder subnet",
    staked: isPt ? "MOR em stake" : "MOR staked",
    footer: isPt ? "gnars.com/pt-br/morpheus" : "gnars.com/morpheus",
  };
}

export function MorpheusCard({
  isPt,
  stakedLabel,
  /** Height of the cut-out in px. The text column is sized around what's left. */
  figureHeight,
  padding,
  /** Type size for the staked figure — the largest thing on the card. */
  numberSize,
  titleSize,
}: MorpheusCardData & {
  isPt: boolean;
  figureHeight: number;
  padding: number;
  numberSize: number;
  titleSize: number;
}) {
  const labels = morpheusCardLabels(isPt);
  const figureWidth = Math.round(figureHeight * FIGURE_RATIO);
  // Flush to the right edge, no overhang: any bleed here crops the board, and
  // the wordmark on it is half the reason to use this cut-out at all.
  const columnWidth = 1200 - padding - figureWidth - 32;
  // The staked total is the one thing that survives thumbnail size, so it is
  // set as display type — and shrunk as it gains digits so a five-figure subnet
  // can never push it into the figure.
  const digits = stakedLabel.length;
  const scaledNumber = Math.round(numberSize * (digits <= 5 ? 1 : digits <= 7 ? 0.86 : 0.72));

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: OG_COLORS.background,
        fontFamily: OG_FONTS.family,
        padding: `${padding}px`,
      }}
    >
      {/* No glow behind the figure: Satori renders `radial-gradient` as a flat
          fill clipped to its box, so a wash meant to fade out arrives as a green
          panel with hard seams. Plain black also matches every other card. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={FIGURE_URL}
        alt=""
        width={figureWidth}
        height={figureHeight}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: figureWidth,
          height: figureHeight,
          objectFit: "contain",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: columnWidth,
          height: "100%",
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: MOR_GREEN,
            letterSpacing: "0.12em",
          }}
        >
          {labels.eyebrow}
        </div>

        {/* The number leads and the title reads as its caption — inverted from a
            normal card on purpose, because at preview size the headline is
            already unreadable and the total is not. */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ fontSize: 26, color: OG_COLORS.muted }}>{labels.staked}</div>
          <div
            style={{
              fontSize: scaledNumber,
              fontWeight: 800,
              color: MOR_GREEN,
              lineHeight: 1,
            }}
          >
            {stakedLabel}
          </div>
          <div
            style={{
              fontSize: titleSize,
              fontWeight: 700,
              color: OG_COLORS.foreground,
              marginTop: "18px",
              lineHeight: 1.1,
            }}
          >
            {labels.title}
          </div>
        </div>

        {/* Just the URL: "Gnars DAO · Base" repeated what the eyebrow, the
            wordmark on the board, and the domain itself already say. */}
        <div style={{ display: "flex", fontSize: 20, color: OG_COLORS.muted, marginTop: "26px" }}>
          {labels.footer}
        </div>
      </div>
    </div>
  );
}
