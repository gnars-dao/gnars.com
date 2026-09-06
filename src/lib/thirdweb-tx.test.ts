import { waitForReceipt } from "thirdweb";
import { base } from "thirdweb/chains";
import type { Wallet } from "thirdweb/wallets";
import { describe, expect, it, vi } from "vitest";
import { ensureOnChain, TransactionRevertedError, waitForSuccessfulReceipt } from "./thirdweb-tx";

vi.mock("thirdweb", () => ({ waitForReceipt: vi.fn() }));

describe("transaction confirmation", () => {
  const options = { chain: base, transactionHash: "0x123", client: {} } as unknown as Parameters<
    typeof waitForReceipt
  >[0];

  it("returns the mined successful receipt", async () => {
    const receipt = { status: "success", transactionHash: "0x456" };
    vi.mocked(waitForReceipt).mockResolvedValueOnce(receipt as never);
    expect(await waitForSuccessfulReceipt(options)).toBe(receipt);
  });

  it("rejects a mined revert and preserves its transaction hash", async () => {
    vi.mocked(waitForReceipt).mockResolvedValueOnce({
      status: "reverted",
      transactionHash: "0x456",
    } as never);
    await expect(waitForSuccessfulReceipt(options)).rejects.toEqual(
      new TransactionRevertedError("0x456"),
    );
  });

  it("preserves receipt timeout errors instead of treating them as mined failures", async () => {
    const timeout = new Error("RPC timeout");
    vi.mocked(waitForReceipt).mockRejectedValueOnce(timeout);
    await expect(waitForSuccessfulReceipt(options)).rejects.toBe(timeout);
  });
});

describe("wallet network checks", () => {
  it("switches a wrong-chain wallet and verifies the result", async () => {
    let id = 1;
    const switchChain = vi.fn(async () => {
      id = base.id;
    });
    await ensureOnChain({ getChain: () => ({ id }), switchChain } as unknown as Wallet, base);
    expect(switchChain).toHaveBeenCalledWith(base);
  });

  it("refuses a wallet that resolves switchChain without changing networks", async () => {
    const wallet = {
      getChain: () => ({ id: 1 }),
      switchChain: vi.fn().mockResolvedValue(undefined),
    } as unknown as Wallet;
    await expect(ensureOnChain(wallet, base)).rejects.toThrow("did not switch");
  });
});
