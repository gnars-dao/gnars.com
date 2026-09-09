import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const { verifyMessage, upstream } = vi.hoisted(() => ({
  verifyMessage: vi.fn(),
  upstream: vi.fn(),
}));
vi.mock("viem/actions", () => ({ verifyMessage }));
vi.mock("@/lib/rpc", () => ({ serverPublicClient: {} }));
const upload = { filename: "clip.mp4", mimeType: "video/mp4", size: 12_000_000 };
const authorization = {
  walletAddress: "0x1111111111111111111111111111111111111111",
  issuedAt: Date.now(),
  nonce: "81e4edb3-8853-4f68-945b-e5cb8603b572",
  signature: "0x1234",
};
const request = (body: unknown) =>
  new Request("https://gnars.com/api/pinata/signed-url", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("signed upload route", () => {
  beforeEach(() => {
    vi.stubEnv("PINATA_JWT", "test-only-token");
    vi.stubGlobal("fetch", upstream);
    upstream.mockReset();
    verifyMessage.mockReset();
    verifyMessage.mockResolvedValue(true);
    upstream.mockResolvedValue(Response.json({ data: "https://uploads.pinata.cloud/signed" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects anonymous upload authorization without contacting Pinata", async () => {
    expect((await POST(request({ upload }))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("enforces a signed exact file-size and MIME limit at the upload provider", async () => {
    const response = await POST(request({ upload, authorization }));
    expect(response.status).toBe(200);
    const options = upstream.mock.calls[0][1];
    expect(JSON.parse(options.body)).toMatchObject({
      max_file_size: upload.size,
      allow_mime_types: [upload.mimeType],
      expires: 60,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects oversized files before signature verification and upstream calls", async () => {
    expect(
      (await POST(request({ upload: { ...upload, size: 501 * 1024 * 1024 }, authorization })))
        .status,
    ).toBe(400);
    expect(verifyMessage).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});
