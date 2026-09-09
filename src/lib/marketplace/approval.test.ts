import { encodeFunctionData, erc721Abi, zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getListingApprovalOperator,
  hasConfirmedMarketplaceApproval,
  isListingApprovalIntent,
} from "./approval";
import { OPENSEA_CONDUIT_ADDRESS } from "./routing";
import { SEAPORT_ADDRESS } from "./seaport";

const account = "0x1111111111111111111111111111111111111111" as Address;
afterEach(() => vi.unstubAllEnvs());
function fixture(owner: Address = account, approved: Address = SEAPORT_ADDRESS) {
  return {
    getChainId: vi.fn().mockResolvedValue(8453),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    readContract: vi.fn().mockResolvedValueOnce(owner).mockResolvedValueOnce(approved),
  };
}
describe("confirmed listing approval recovery", () => {
  it("does not confuse identical token IDs from different collections during recovery", async () => {
    const collection = "0x4444444444444444444444444444444444444444";
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const intent = {
      account,
      to: collection,
      value: "0",
      startedBlock: "100",
      data: encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [custom, 42n] }),
    } as const;
    expect(getListingApprovalOperator(intent, account, "42", collection)).toBe(custom);
    expect(getListingApprovalOperator(intent, account, "42")).toBeUndefined();
    const reader = fixture(account, custom);
    expect(await hasConfirmedMarketplaceApproval(reader, account, "42", custom, collection)).toBe(
      true,
    );
    for (const [call] of reader.readContract.mock.calls) expect(call.address).toBe(collection);
  });
  it("recovers only the configured custom contract and does not mistake canonical approval for it", async () => {
    const custom = "0x3333333333333333333333333333333333333333";
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", custom);
    const intent = {
      account,
      to: DAO_ADDRESSES.token,
      value: "0",
      startedBlock: "100",
      data: encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [custom, 5423n] }),
    };
    expect(getListingApprovalOperator(intent, account, "5423")).toBe(custom);
    expect(await hasConfirmedMarketplaceApproval(fixture(), account, "5423", custom)).toBe(false);
    expect(
      await hasConfirmedMarketplaceApproval(fixture(account, custom), account, "5423", custom),
    ).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", "");
    expect(getListingApprovalOperator(intent, account, "5423")).toBeUndefined();
    await expect(
      hasConfirmedMarketplaceApproval(fixture(account, custom), account, "5423", custom),
    ).rejects.toThrow("Unsupported NFT approval operator");
  });
  it("recovers the exact allowlisted operator from saved approval calldata", () => {
    const intent = {
      account,
      to: DAO_ADDRESSES.token,
      value: "0",
      startedBlock: "100",
      data: encodeFunctionData({
        abi: erc721Abi,
        functionName: "approve",
        args: [OPENSEA_CONDUIT_ADDRESS, 5423n],
      }),
    };
    expect(getListingApprovalOperator(intent, account, "5423")).toBe(OPENSEA_CONDUIT_ADDRESS);
    expect(isListingApprovalIntent(intent, account, "5423")).toBe(false);
    expect(isListingApprovalIntent(intent, account, "5423", OPENSEA_CONDUIT_ADDRESS)).toBe(true);
    expect(getListingApprovalOperator(intent, account, "1")).toBeUndefined();
    expect(
      getListingApprovalOperator(
        {
          ...intent,
          data: encodeFunctionData({
            abi: erc721Abi,
            functionName: "approve",
            args: [account, 5423n],
          }),
        },
        account,
        "5423",
      ),
    ).toBeUndefined();
  });
  it("does not confuse direct Seaport approval with the OpenSea conduit", async () => {
    expect(
      await hasConfirmedMarketplaceApproval(fixture(), account, "5423", OPENSEA_CONDUIT_ADDRESS),
    ).toBe(false);
    expect(
      await hasConfirmedMarketplaceApproval(
        fixture(account, OPENSEA_CONDUIT_ADDRESS),
        account,
        "5423",
        OPENSEA_CONDUIT_ADDRESS,
      ),
    ).toBe(true);
    const reader = fixture(account, zeroAddress);
    reader.readContract.mockResolvedValueOnce(true);
    expect(
      await hasConfirmedMarketplaceApproval(reader, account, "5423", OPENSEA_CONDUIT_ADDRESS),
    ).toBe(true);
    expect(reader.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "isApprovedForAll",
        args: [account, OPENSEA_CONDUIT_ADDRESS],
        blockNumber: 100n,
      }),
    );
    await expect(
      hasConfirmedMarketplaceApproval(fixture(), account, "5423", account),
    ).rejects.toThrow("Unsupported NFT approval operator");
  });
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
  it("accepts an existing global Seaport approval without requiring another token approval", async () => {
    const reader = fixture(account, zeroAddress);
    reader.readContract.mockResolvedValueOnce(true);
    expect(await hasConfirmedMarketplaceApproval(reader, account, "5423")).toBe(true);
    expect(reader.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "isApprovedForAll",
        args: [account, SEAPORT_ADDRESS],
        blockNumber: 100n,
      }),
    );
  });
});
