import { encodeFunctionData, erc721Abi, zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { hasConfirmedMarketplaceApproval, isListingApprovalIntent } from "./approval";
import { SEAPORT_ADDRESS } from "./seaport";

const account = "0x1111111111111111111111111111111111111111" as Address;
function fixture(owner: Address = account, approved: Address = SEAPORT_ADDRESS) {
  return {
    getChainId: vi.fn().mockResolvedValue(8453),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    readContract: vi.fn().mockResolvedValueOnce(owner).mockResolvedValueOnce(approved),
  };
}
describe("confirmed listing approval recovery", () => {
  it("does not recover other calls that were mislabeled as an approval", () => {
    const intent = {
      account,
      to: DAO_ADDRESSES.token,
      value: "0",
      startedBlock: "100",
      data: encodeFunctionData({
        abi: erc721Abi,
        functionName: "approve",
        args: [SEAPORT_ADDRESS, 5423n],
      }),
    };
    expect(isListingApprovalIntent(intent, account, "5423")).toBe(true);
    expect(isListingApprovalIntent(undefined, account, "5423")).toBe(false);
    expect(isListingApprovalIntent(intent, account, "1")).toBe(false);
    expect(isListingApprovalIntent({ ...intent, value: "1" }, account, "5423")).toBe(false);
    expect(isListingApprovalIntent({ ...intent, to: SEAPORT_ADDRESS }, account, "5423")).toBe(
      false,
    );
    expect(isListingApprovalIntent({ ...intent, account: zeroAddress }, account, "5423")).toBe(
      false,
    );
  });
  it("requires exact owner and spender at the same Base block", async () => {
    const client = fixture();
    expect(await hasConfirmedMarketplaceApproval(client, account, "5423")).toBe(true);
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    for (const [call] of client.readContract.mock.calls) {
      expect(call.blockNumber).toBe(100n);
      expect(call.args).toEqual([5423n]);
    }
    expect(await hasConfirmedMarketplaceApproval(fixture(zeroAddress), account, "5423")).toBe(
      false,
    );
    expect(
      await hasConfirmedMarketplaceApproval(fixture(account, zeroAddress), account, "5423"),
    ).toBe(false);
  });
  it("never treats a read failure or wrong chain as confirmation", async () => {
    const wrongChain = fixture();
    wrongChain.getChainId.mockResolvedValue(1);
    await expect(hasConfirmedMarketplaceApproval(wrongChain, account, "5423")).rejects.toThrow(
      "Base",
    );
    expect(wrongChain.readContract).not.toHaveBeenCalled();
    const failed = fixture();
    failed.readContract.mockReset().mockRejectedValue(new Error("RPC unavailable"));
    await expect(hasConfirmedMarketplaceApproval(failed, account, "5423")).rejects.toThrow(
      "RPC unavailable",
    );
  });
});
