import { createThirdwebClient } from "thirdweb";
import { base } from "thirdweb/chains";
import { EIP1193, type Wallet } from "thirdweb/wallets";
import { encodeFunctionData, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viemAdapter } from "@/lib/builder-code-viem";
import { BUILDER_CODE_SUFFIX } from "@/lib/config";

vi.mock("thirdweb/wallets", () => ({ EIP1193: { toProvider: vi.fn() } }));

const address = "0x1234567890123456789012345678901234567890" as const;
const hash = `0x${"ab".repeat(32)}`;
const client = createThirdwebClient({ clientId: "test-only" });
const wallet = { getAccount: () => ({ address }) } as Wallet;

function setup() {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_estimateGas") return "0x10000";
    return hash;
  });
  vi.mocked(EIP1193.toProvider).mockReturnValue({
    request,
    on: vi.fn(),
    removeListener: vi.fn(),
  });
  return { request, walletClient: viemAdapter.wallet.toViem({ wallet, client, chain: base }) };
}

afterEach(() => vi.restoreAllMocks());

describe("SDK wallet attribution", () => {
  it("tags Zora SDK swap broadcasts, preserving destination and value", async () => {
    const { request, walletClient } = setup();
    await walletClient.sendTransaction({
      account: address,
      chain: walletClient.chain,
      to: address,
      data: "0xdeadbeef",
      value: 17n,
    });
    expect(request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [
        expect.objectContaining({
          to: address,
          value: "0x11",
          data: `0xdeadbeef${BUILDER_CODE_SUFFIX.slice(2)}`,
        }),
      ],
    });
  });

  it("tags approvals generated inside SDK writeContract calls", async () => {
    const { request, walletClient } = setup();
    const abi = parseAbi(["function approve(address spender, uint256 amount)"]);
    const args = [address, 123n] as const;
    await walletClient.writeContract({
      account: address,
      chain: walletClient.chain,
      address,
      abi,
      functionName: "approve",
      args,
    });
    expect(request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [
        expect.objectContaining({
          data: `${encodeFunctionData({ abi, functionName: "approve", args })}${BUILDER_CODE_SUFFIX.slice(2)}`,
        }),
      ],
    });
  });

  it.each([21_000n, 90_000n])(
    "re-estimates SDK gas limits against final tagged calldata (%s)",
    async (gas) => {
      const { request, walletClient } = setup();
      await walletClient.sendTransaction({
        account: address,
        chain: walletClient.chain,
        to: address,
        data: "0xdeadbeef",
        gas,
      });
      const estimation = request.mock.calls.find(([call]) => call.method === "eth_estimateGas");
      expect(estimation).toEqual([
        {
          method: "eth_estimateGas",
          params: [
            expect.objectContaining({
              data: `0xdeadbeef${BUILDER_CODE_SUFFIX.slice(2)}`,
            }),
          ],
        },
      ]);
      const estimateParams = estimation![0] as unknown as { params: [{ gas?: string }] };
      expect(estimateParams.params[0].gas).toBeUndefined();
      expect(request).toHaveBeenCalledWith({
        method: "eth_sendTransaction",
        params: [
          expect.objectContaining({
            gas: `0x${(gas > 65_536n ? gas : 65_536n).toString(16)}`,
          }),
        ],
      });
    },
  );

  it("includes attribution during gas estimation and does not double-tag data", async () => {
    const { request, walletClient } = setup();
    await walletClient.request({
      method: "eth_estimateGas",
      params: [{ from: address, to: address, data: BUILDER_CODE_SUFFIX }, "latest"],
    });
    expect(request).toHaveBeenCalledWith({
      method: "eth_estimateGas",
      params: [{ from: address, to: address, data: BUILDER_CODE_SUFFIX }, "latest"],
    });
  });

  it("attributes native transfers without modifying message signatures or reads", async () => {
    const { request, walletClient } = setup();
    await walletClient.request({ method: "eth_sendTransaction", params: [{ to: address }] });
    expect(request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [{ to: address, data: BUILDER_CODE_SUFFIX }],
    });
    await walletClient.request({ method: "personal_sign", params: ["0x1234", address] });
    expect(request).toHaveBeenCalledWith({ method: "personal_sign", params: ["0x1234", address] });
    await walletClient.request({ method: "eth_accounts" });
    expect(request).toHaveBeenCalledWith({ method: "eth_accounts" });
  });
});
