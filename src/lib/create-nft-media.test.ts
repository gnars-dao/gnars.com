import type { Account } from "thirdweb/wallets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadNftMedia } from "./create-nft-media";
import { uploadToPinata } from "./pinata";

vi.mock("./pinata", () => ({ uploadToPinata: vi.fn() }));
const account = { address: `0x${"11".repeat(20)}` } as Account;
const mediaUri = `ipfs://${"a".repeat(46)}`;
const coverUri = `ipfs://${"b".repeat(46)}`;
const video = new File(["video"], "clip.mp4", { type: "video/mp4" });
const cover = new File(["image"], "cover.png", { type: "image/png" });
const uploaded = (uri: string) => ({
  success: true,
  data: {
    ipfsUrl: uri,
    cid: uri.slice(7),
    id: "id",
    name: "file",
    size: 5,
    gatewayUrl: "https://example.com",
  },
});
function options(file = video) {
  return {
    account,
    file,
    cover,
    name: " Clip ",
    description: " Test ",
    checkAccount: vi.fn(),
    onProgress: vi.fn(),
  };
}
beforeEach(() => vi.resetAllMocks());

describe("NFT media preparation before mint", () => {
  it("uploads MP4 then cover and binds both immutable URIs", async () => {
    vi.mocked(uploadToPinata).mockImplementation(async (_account, file, _name, progress) => {
      progress?.(100);
      return uploaded(file === video ? mediaUri : coverUri);
    });
    const input = options();
    expect(await uploadNftMedia(input)).toEqual({
      name: "Clip",
      description: "Test",
      image: coverUri,
      animation_url: mediaUri,
      animation_details: { type: "video/mp4" },
    });
    expect(vi.mocked(uploadToPinata).mock.calls.map((call) => call[1])).toEqual([video, cover]);
    expect(input.checkAccount).toHaveBeenCalledTimes(3);
    expect(input.onProgress.mock.calls.flat()).toEqual([0, 50, 100]);
  });
  it("keeps ordinary image NFTs as one upload, without animation fields", async () => {
    vi.mocked(uploadToPinata).mockResolvedValue(uploaded(coverUri));
    expect(await uploadNftMedia(options(cover))).toEqual({
      name: "Clip",
      description: "Test",
      image: coverUri,
    });
    expect(uploadToPinata).toHaveBeenCalledTimes(1);
  });
  it("rejects missing or invalid covers before uploading", async () => {
    for (const invalidCover of [undefined, video]) {
      await expect(uploadNftMedia({ ...options(), cover: invalidCover })).rejects.toThrow(
        "invalidMedia",
      );
    }
    expect(uploadToPinata).not.toHaveBeenCalled();
  });
  it("never prepares metadata after a failed video upload", async () => {
    vi.mocked(uploadToPinata).mockResolvedValue({ success: false });
    await expect(uploadNftMedia(options())).rejects.toThrow("uploadError");
    expect(uploadToPinata).toHaveBeenCalledTimes(1);
  });
  it("never prepares metadata after a failed cover upload", async () => {
    vi.mocked(uploadToPinata)
      .mockResolvedValueOnce(uploaded(mediaUri))
      .mockResolvedValueOnce({ success: false });
    await expect(uploadNftMedia(options())).rejects.toThrow("uploadError");
  });
  it("does not prompt the old account for a cover upload after switching wallets", async () => {
    vi.mocked(uploadToPinata).mockResolvedValue(uploaded(mediaUri));
    const input = options();
    input.checkAccount
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("accountChanged");
      });
    await expect(uploadNftMedia(input)).rejects.toThrow("accountChanged");
    expect(uploadToPinata).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed provider CIDs before metadata signing", async () => {
    vi.mocked(uploadToPinata).mockResolvedValue(uploaded("https://example.com/video.mp4"));
    await expect(uploadNftMedia(options())).rejects.toThrow();
  });
});
