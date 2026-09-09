import { readFileSync, writeFileSync } from "node:fs";

// name -> repo-relative src path. Primary components only: the bundle exports
// all 216 PascalCase names, these 59 are the ones that get a preview card.
const UI = {
  Accordion: "accordion",
  AddressDisplay: "address-display",
  AlertDialog: "alert-dialog",
  Alert: "alert",
  AspectRatio: "aspect-ratio",
  Avatar: "avatar",
  Badge: "badge",
  ButtonGroup: "button-group",
  Button: "button",
  Card: "card",
  ChartContainer: "chart",
  Checkbox: "checkbox",
  Collapsible: "collapsible",
  Command: "command",
  ConnectButton: "ConnectButton",
  CountUp: "count-up",
  Dialog: "dialog",
  Drawer: "drawer",
  DropdownMenu: "dropdown-menu",
  Field: "field",
  InputGroup: "input-group",
  Input: "input",
  Label: "label",
  NavigationMenu: "navigation-menu",
  Popover: "popover",
  Progress: "progress",
  RadioGroup: "radio-group",
  ScrollArea: "scroll-area",
  Select: "select",
  Separator: "separator",
  Sheet: "sheet",
  Skeleton: "skeleton",
  Slider: "slider",
  Spinner: "spinner",
  Switch: "switch",
  Table: "table",
  Tabs: "tabs",
  Textarea: "textarea",
  Toaster: "sonner",
  TokenImage: "token-image",
  Tooltip: "tooltip",
  VideoPlayer: "video-player",
  VideoThumbnailSelector: "video-thumbnail-selector",
};
const FEAT = {
  RailCard: "nogglesrails/RailCard",
  NounstacleDefinition: "nogglesrails/NounstacleDefinition",
  NogglesRailsManifesto: "nogglesrails/NogglesRailsManifesto",
  NogglesRailsClosingBox: "nogglesrails/NogglesRailsClosingBox",
  ProductCard: "store/ProductCard",
  StoreHero: "store/StoreHero",
  ProductVisual: "store/ProductVisual",
  SnapshotProposalCard: "snapshot/SnapshotProposalCard",
  BidItem: "auction/BidItem",
  TokenMark: "stake/TokenMark",
  SectionHeader: "stake/SectionHeader",
  StakeFlowChart: "stake/StakeFlowChart",
  RoadmapSection: "stake/RoadmapSection",
  CoinPurchasePreview: "coin-proposal/CoinPurchasePreview",
  AnimatedDescription: "home/AnimatedDescription",
  PropdateDetail: "propdates/PropdateDetail",
};

const componentSrcMap = {};
for (const [n, f] of Object.entries(UI).sort(([a], [b]) => a.localeCompare(b)))
  componentSrcMap[n] = `src/components/ui/${f}.tsx`;
for (const [n, p] of Object.entries(FEAT).sort(([a], [b]) => a.localeCompare(b)))
  componentSrcMap[n] = `src/components/${p}.tsx`;

const prev = JSON.parse(readFileSync(".design-sync/config.json", "utf8"));
const cfg = {
  ...prev, // never drop projectId
  pkg: "gnars-website",
  globalName: "Gnars",
  shape: "package",
  srcDir: "src/components",
  tsconfig: ".design-sync/tsconfig.ds.json",
  cssEntry: ".design-sync/.cache/ds-tailwind.css",
  buildCmd:
    "node .design-sync/gen-entry.mjs && node .ds-sync/node_modules/@tailwindcss/cli/dist/index.mjs -i .design-sync/ds-styles.src.css -o .design-sync/.cache/ds-tailwind.css --minify",
  provider: { component: "GnarsProvider" },
  componentSrcMap,
};
writeFileSync(".design-sync/config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log("componentes com card:", Object.keys(componentSrcMap).length);
