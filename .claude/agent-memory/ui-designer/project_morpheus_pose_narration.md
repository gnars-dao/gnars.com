---
name: morpheus-pose-narration
description: /morpheus is narrated by Morpheus PNG cut-outs — one pose per section at editorial scale; the recipe for adding/moving a figure, and why miniatures failed
metadata:
  type: project
---

`/morpheus` (`src/components/stake/MorpheusPageContent.tsx`) uses full-body
PS1-style Morpheus cut-outs in `public/morpheus/poses/` as section decoration:
`arms-wide` = hero pitch, `point-far` = presents the three flywheel steps,
`calm-down` = the fine print, `offer` = beside the roadmap. Two sections carry
no figure on purpose — the milestone grid (three data columns already fill it)
and the crew (four rider portraits already fill it).

**Why:** the brief was "Morpheus narrates the page" — the poses are the page's
differentiation, not chrome. They must never become content: `aria-hidden` +
empty alt, so the redesign added ZERO new i18n strings.

**The lesson that cost five rejected mockups:** a photographic cut-out rendered
small inside a white utility card ALWAYS reads as clip-art, no matter how the
card is arranged — the user's words were "os componentes mais feios que já vi".
Rearranging a miniature never fixes it. What works:

- **Editorial scale.** Render the figure big enough that the visible part is
  waist-up or chest-up, then let the CARD'S OWN EDGE crop the legs
  (`overflow-hidden` on the section + a negative margin or `translate-y`).
  A frame crop reads as layout; a shrunken whole body reads as a sticker.
- **No gradient dissolve on bodies.** A half-transparent torso reads as a
  rendering bug. Hard crop only. (The crew heads keep a bottom fade — they have
  no frame at all, so a straight cut there would guillotine the chest.)
- **Near-invisible contact shadow**, `drop-shadow(0 1px 2px rgba(0,0,0,.14))`.
  A big blurred drop-shadow smudges the card background.
- **One figure per section, not one per card.** Three cards each with their own
  small Morpheus was the worst version; one large narrator presenting a
  numbered list was the accepted one.

**How to apply** when adding or moving a figure:

- Source poses live outside the repo in
  `/Users/r4to/Script/imagen-lab/explorations/ps1-filme/morpheus-27poses/`
  (see its `POSES.md` for the semantic catalog of all 27). Export with PIL: trim
  to the alpha bbox at threshold `a>8`, 6px pad, no resize, `optimize=True`.
  Add the exact trimmed dimensions to the `POSES` map — `<Image>` needs them.
- Check which way the arm points before choosing a side. `point-far` points to
  the viewer's RIGHT (so it belongs on the LEFT of what it indicates);
  `offer`'s palm faces LEFT (so it belongs on the RIGHT). Flip with
  `scaleX(-1)` only if a side is forced.
- Height is pinned via `h-[...]`; the `Pose` helper bakes in `w-auto max-w-none`
  because Tailwind preflight's `max-width:100%` otherwise squashes a figure
  placed in a narrow band.
- Centre a figure in the gutter its text leaves free — give the clipping window
  an explicit width and `left-1/2 -translate-x-1/2` the pose inside it. Pinning
  it to `right-*` clips the extended arm.
- `RoadmapSection` / `SubnetSection` are shared with `/stake`. Never add a
  figure inside them; wrap the call site in `relative` and place the figure as
  an absolutely-positioned sibling with its own clipping window.
- Big side figures are `hidden` below `lg`/`md`. On mobile the page is text
  plus the hero bust only.

**Crew portraits** (same file) are framed as 3x4 ID photos with NO frame drawn:
`aspectRatio: "3 / 4"`, `PHOTO_ZOOM = "350%"`, `PHOTO_POS = "50% 3.2%"`, bottom
fade. The cut-outs are 3:4 and the box is 3:4, so `background-size` (a % of the
box WIDTH) scales uniformly and the visible slice is exactly `1/zoom` — 350%
shows the top 28.6%: headroom, head, shoulders. These are a LOCAL override, not
`c.face` — those values are the `/stake` roster's tight head crop and are
shared production data.

Related: [[stake-dark-surface]], [[visual-differentiation-over-reordering]],
[[design_system_overview]]
