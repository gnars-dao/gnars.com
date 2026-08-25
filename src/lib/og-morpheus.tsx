import { BASE_URL } from "@/lib/config";
import { getGnarsSubnetTotalStaked } from "@/lib/morpheus-builder";
import { OG_COLORS, OG_FONTS } from "@/lib/og-utils";
import { nextMilestone } from "@/lib/stake-milestones";

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
  nextLabel: string;
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

  const next = staked == null ? null : nextMilestone(staked);
  const locale = isPt ? "pt-BR" : "en-US";
  return {
    stakedLabel: staked == null ? "—" : Math.floor(staked).toLocaleString(locale),
    nextLabel: next == null ? "—" : next.amountMor.toLocaleString(locale),
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
    next: isPt ? "Próximo marco" : "Next milestone",
    footer: isPt ? "gnars.com/pt-br/morpheus" : "gnars.com/morpheus",
  };
}

export function MorpheusCard({
  isPt,
  stakedLabel,
  nextLabel,
  height,
  /** Height of the cut-out in px. The column is sized around what's left. */
  figureHeight,
  padding,
  titleSize,
}: MorpheusCardData & {
  isPt: boolean;
  height: number;
  figureHeight: number;
  padding: number;
  titleSize: number;
}) {
  const labels = morpheusCardLabels(isPt);
  const figureWidth = Math.round(figureHeight * FIGURE_RATIO);
  // Flush to the left edge, no overhang: on the right the bleed cropped the
  // board (harmless), but on the left it cuts into the man's arm and torso.
  // The text column takes the rest minus a gutter, so the thrown-out arm never
  // lands on a word.
  const columnWidth = 1200 - padding - figureWidth - 32;

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
          left: 0,
          bottom: 0,
          width: figureWidth,
          height: figureHeight,
          objectFit: "contain",
        }}
      />

      {/* `marginLeft: auto` parks the column against the right edge, clear of
          the figure, without a second absolutely-positioned box to keep in sync. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: columnWidth,
          height: "100%",
          marginLeft: "auto",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
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
          <div
            style={{
              fontSize: titleSize,
              fontWeight: 800,
              color: OG_COLORS.foreground,
              marginTop: "14px",
              lineHeight: 1.05,
            }}
          >
            {labels.title}
          </div>
          <div style={{ fontSize: 26, color: OG_COLORS.mutedLight, marginTop: "14px" }}>
            {labels.sub}
          </div>
        </div>

        <div style={{ display: "flex", gap: "20px", marginTop: "auto" }}>
          <Stat label={labels.staked} value={stakedLabel} color={MOR_GREEN} />
          <Stat label={labels.next} value={nextLabel} color={OG_COLORS.accentYellow} />
        </div>

        {/* Just the URL: "Gnars DAO · Base" repeated what the eyebrow, the
            wordmark on the board, and the domain itself already say. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: height >= 700 ? "32px" : "24px",
            fontSize: 20,
            color: OG_COLORS.muted,
          }}
        >
          {labels.footer}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        flex: 1,
        backgroundColor: OG_COLORS.card,
        borderRadius: "16px",
        border: `2px solid ${OG_COLORS.cardBorder}`,
        padding: "24px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ fontSize: 20, color: OG_COLORS.muted }}>{label}</div>
      <div style={{ fontSize: 56, fontWeight: 800, color, marginTop: "4px" }}>{value}</div>
    </div>
  );
}
