import type { Account } from "thirdweb/wallets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadToPinata } from "./pinata";

vi.mock("@/lib/wallet-authorization", () => ({
  signWalletRequest: vi.fn(async () => ({ signature: "0x1234" })),
}));

const account = { address: "0x1111111111111111111111111111111111111111" } as Account;
const video = () => new File([new Uint8Array(16)], "clip.mov", { type: "video/quicktime" });
const signed = () => Response.json({ success: true, data: "https://uploads.pinata.cloud/signed" });

describe("uploadToPinata failure stages", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a missing wallet as the connect stage", async () => {
    expect(await uploadToPinata(undefined, video())).toMatchObject({
      success: false,
      stage: "connect",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a file without a known media type as the file stage", async () => {
    const untyped = new File([new Uint8Array(16)], "clip.xyz");
    expect(await uploadToPinata(account, untyped)).toMatchObject({ stage: "file" });
  });

  it("uploads an untyped .MOV as video/quicktime", async () => {
    fetchMock
      .mockResolvedValueOnce(signed())
      .mockResolvedValueOnce(Response.json({ data: { cid: "bafytest", size: 16 } }));
    const untyped = new File([new Uint8Array(16)], "IMG_7910.MOV");
    expect(await uploadToPinata(account, untyped)).toMatchObject({ success: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).upload.mimeType).toBe("video/quicktime");
    const part = (fetchMock.mock.calls[1][1].body as FormData).get("file") as File;
    expect(part.type).toBe("video/quicktime");
  });

  it("reports server refusals with their HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Too many" }, { status: 429 }));
    expect(await uploadToPinata(account, video())).toMatchObject({
      stage: "authorize",
      status: 429,
      error: "Too many",
    });
  });

  it("reports Pinata transfer failures with their HTTP status", async () => {
    fetchMock
      .mockResolvedValueOnce(signed())
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    expect(await uploadToPinata(account, video())).toMatchObject({ stage: "upload", status: 403 });
  });

  it("returns cancelled, not an error, when the caller aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(signed()).mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    expect(
      await uploadToPinata(account, video(), undefined, undefined, controller.signal),
    ).toMatchObject({ success: false, cancelled: true });
  });

  it("returns gateway URLs on success", async () => {
    fetchMock
      .mockResolvedValueOnce(signed())
      .mockResolvedValueOnce(Response.json({ data: { cid: "bafytest", size: 16 } }));
    expect(await uploadToPinata(account, video())).toMatchObject({
      success: true,
      data: { cid: "bafytest", gatewayUrl: "https://ipfs.skatehive.app/ipfs/bafytest" },
    });
  });
});
