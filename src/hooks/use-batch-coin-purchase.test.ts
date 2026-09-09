import { createTradeCall } from "@zoralabs/coins-sdk";
import { sendTransaction, waitForReceipt } from "thirdweb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBatchCoinPurchase } from "./use-batch-coin-purchase";

const mocks = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111",
  chainId: 1,
  switchChain: vi.fn(),
}));
vi.mock("react", () => ({ useState: (value: unknown) => [value, vi.fn()] }));
vi.mock("@zoralabs/coins-sdk", () => ({ createTradeCall: vi.fn() }));
vi.mock("thirdweb", () => ({ sendTransaction: vi.fn(), waitForReceipt: vi.fn() }));
vi.mock("thirdweb/adapters/viem", () => ({
  viemAdapter: { publicClient: { toViem: () => ({ call: vi.fn().mockResolvedValue({}) }) } },
}));
vi.mock("@/hooks/use-user-address", () => ({ useUserAddress: () => ({ address: mocks.address }) }));
vi.mock("@/hooks/use-write-account", () => ({
  useWriteAccount: () => ({
    account: { address: mocks.address },
    wallet: { getChain: () => ({ id: mocks.chainId }), switchChain: mocks.switchChain },
  }),
}));
vi.mock("@/lib/thirdweb", () => ({ getThirdwebClient: () => ({}) }));
vi.mock("@/lib/builder-code", () => ({ prepareTransaction: (params: unknown) => params }));

const coin = "0x2222222222222222222222222222222222222222" as const;
const quote = { success: true, call: { target: coin, data: "0x", value: "100" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chainId = 1;
  mocks.switchChain.mockImplementation(async () => {
    mocks.chainId = 8453;
  });
  vi.mocked(createTradeCall).mockResolvedValue(quote as never);
  vi.mocked(sendTransaction).mockResolvedValue({ transactionHash: "0x123" } as never);
  vi.mocked(waitForReceipt).mockResolvedValue({
    status: "success",
    transactionHash: "0x123",
  } as never);
});

describe("basket purchase safeguards", () => {
  it("aborts the whole basket when one selected coin has no quote", async () => {
    vi.mocked(createTradeCall)
      .mockResolvedValueOnce(quote as never)
      .mockResolvedValueOnce({ success: false } as never);
    const purchase = useBatchCoinPurchase({
      coins: [
        { address: coin, ethAmount: 100n },
        { address: coin, ethAmount: 100n },
      ],
    });
    await expect(purchase.executeBatchPurchase()).rejects.toThrow("No purchases were submitted");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("switches the EOA to Base before sending a funded basket", async () => {
    const purchase = useBatchCoinPurchase({ coins: [{ address: coin, ethAmount: 100n }] });
    await purchase.executeBatchPurchase();
    expect(mocks.switchChain).toHaveBeenCalled();
    expect(mocks.switchChain.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendTransaction).mock.invocationCallOrder[0],
    );
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account: { address: mocks.address } }),
    );
  });

  it("never sends when the wallet remains on the wrong network", async () => {
    mocks.switchChain.mockResolvedValue(undefined);
    const purchase = useBatchCoinPurchase({ coins: [{ address: coin, ethAmount: 100n }] });
    await expect(purchase.executeBatchPurchase()).rejects.toThrow("did not switch");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("does not fire purchase success for a mined revert", async () => {
    vi.mocked(waitForReceipt).mockResolvedValueOnce({
      status: "reverted",
      transactionHash: "0x123",
    } as never);
    const onSuccess = vi.fn();
    const purchase = useBatchCoinPurchase({
      coins: [{ address: coin, ethAmount: 100n }],
      onSuccess,
    });
    await expect(purchase.executeBatchPurchase()).rejects.toThrow("reverted");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
