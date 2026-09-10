import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceShareData, loadMarketplaceShareArtwork } from "@/services/marketplace-share";
import { GET } from "./route";

vi.mock("@/services/marketplace-share", () => ({
  getMarketplaceShareData: vi.fn(),
  loadMarketplaceShareArtwork: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(
    async () => (key: string) => (key === "share.openNft" ? "Ver NFT" : "Ver detalhes do NFT"),
  ),
}));
const captured = vi.hoisted(() => ({ nodes: [] as unknown[] }));
vi.mock("next/og", () => ({
  ImageResponse: class extends Response {
    constructor(node: unknown, options: unknown) {
      super(JSON.stringify(options));
      captured.nodes.push(node);
    }
  },
}));
const request = (search = "") =>
  GET(new Request(`https://gnars.com/pt-br/marketplace/miniapp-image${search}`), {
    params: Promise.resolve({ locale: "pt-br" }),
  });

describe("marketplace miniapp image", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    captured.nodes.length = 0;
  });
  it("renders generic PNG at exactly 1200x800 without provider calls", async () => {
    const response = await request();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.json()).toMatchObject({ width: 1200, height: 800 });
    expect(getMarketplaceShareData).not.toHaveBeenCalled();
  });
  it("rejects duplicate or malformed target identifiers", async () => {
    await request("?nft=1&nft=2");
    await request("?nft=1&collection=bad");
    expect(getMarketplaceShareData).not.toHaveBeenCalled();
  });
  it("uses trusted NFT image and text, ignores injected image and price", async () => {
    vi.mocked(getMarketplaceShareData).mockResolvedValue({
      name: "Edição Gnars",
      image: "https://i.seadn.io/art.png",
      price: "0.02 ETH",
      source: "gnars-contract",
    });
    vi.mocked(loadMarketplaceShareArtwork).mockResolvedValue("data:image/png;base64,c2FmZQ==");
    const response = await request("?nft=54&name=Injected&price=99&image=https://attacker.invalid");
    expect(await response.json()).toEqual({ width: 1200, height: 800 });
    expect(loadMarketplaceShareArtwork).toHaveBeenCalledWith("https://i.seadn.io/art.png");
    const rendered = JSON.stringify(captured.nodes);
    expect(rendered).toContain("Edição Gnars");
    expect(rendered).toContain("0.02 ETH");
    expect(rendered).not.toMatch(/Injected|attacker/);
  });
  it("provider failure returns a short-lived generic fallback without leaking details", async () => {
    vi.mocked(getMarketplaceShareData).mockRejectedValue(new Error("secret-key"));
    const response = await request("?nft=54");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=10");
    expect(await response.text()).not.toContain("secret-key");
  });
  it("renders the NFT composition with the actual PNG renderer", async () => {
    const { ImageResponse } = await vi.importActual<typeof import("next/og")>("next/og");
    vi.mocked(getMarketplaceShareData).mockResolvedValue({
      name: "Gnar #3656",
      image: null,
      price: "0.01 ETH",
      source: "gnars-contract",
    });
    const logo = await readFile("public/gnars-splash-200.png");
    vi.mocked(loadMarketplaceShareArtwork).mockResolvedValue(
      `data:image/png;base64,${logo.toString("base64")}`,
    );
    await request("?nft=3656");
    const result = new ImageResponse(captured.nodes[0] as React.ReactElement, {
      width: 1200,
      height: 800,
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(800);
  });
});
