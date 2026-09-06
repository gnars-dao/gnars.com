import { viemAdapter as thirdwebViemAdapter } from "thirdweb/adapters/viem";
import { EIP1193 } from "thirdweb/wallets";
import { createWalletClient, custom, toHex, type Chain, type Hex } from "viem";
import { BUILDER_CODE_SUFFIX } from "@/lib/config";

function appendBuilderCode(data: Hex = "0x"): Hex {
  return data.toLowerCase().endsWith(BUILDER_CODE_SUFFIX.slice(2).toLowerCase())
    ? data
    : `${data}${BUILDER_CODE_SUFFIX.slice(2)}`;
}

/** SDK writes bypass prepareTransaction; tag the provider boundary before estimating or sending. */
const toViem: typeof thirdwebViemAdapter.wallet.toViem = (options) => {
  const original = thirdwebViemAdapter.wallet.toViem(options);
  const provider = EIP1193.toProvider(options);
  return createWalletClient({
    account: original.account?.address,
    chain: original.chain as Chain,
    transport: custom({
      request: async (request) => {
        if (request.method === "eth_sendTransaction" || request.method === "eth_estimateGas") {
          const [transaction, ...rest] = request.params;
          const tagged = { ...transaction, data: appendBuilderCode(transaction.data) };
          // Zora estimates through a separate public client, then supplies that
          // gas limit. Re-estimate the final payload before requesting a signature.
          if (
            request.method === "eth_sendTransaction" &&
            transaction.gas &&
            tagged.data !== transaction.data
          ) {
            const estimation = { ...tagged };
            delete estimation.gas;
            const estimated = BigInt(
              await provider.request({
                method: "eth_estimateGas",
                params: [estimation],
              }),
            );
            tagged.gas = toHex(
              estimated > BigInt(transaction.gas) ? estimated : BigInt(transaction.gas),
            );
          }
          return provider.request({
            ...request,
            params: [tagged, ...rest],
          });
        }
        return provider.request(request);
      },
    }),
  }) as unknown as ReturnType<typeof thirdwebViemAdapter.wallet.toViem>;
};

export const viemAdapter = {
  ...thirdwebViemAdapter,
  wallet: { ...thirdwebViemAdapter.wallet, toViem },
};
