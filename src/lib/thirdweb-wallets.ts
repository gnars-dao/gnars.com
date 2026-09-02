import { base } from "thirdweb/chains";
import { createWallet } from "thirdweb/wallets";
import { inAppWallet } from "thirdweb/wallets/in-app";
import type { SmartWalletOptions } from "thirdweb/wallets/smart";

/**
 * Singleton wallet list used by every thirdweb hook entry point in the app.
 *
 * The inAppWallet factory intentionally does NOT set `executionMode` — the
 * `accountAbstraction` config passed at the `useConnectModal` / `useAutoConnect`
 * call level handles smart-account wrapping uniformly for every wallet in
 * this list (including inAppWallet and external wallets like MetaMask). One
 * code path, one SA derivation, no double-wrap.
 */
export const THIRDWEB_WALLETS = [
  inAppWallet({
    auth: {
      options: ["google", "apple", "x", "discord", "farcaster", "email"],
      mode: "popup",
    },
    metadata: { name: "Gnars DAO" },
  }),
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
  createWallet("me.rainbow"),
  createWallet("walletConnect"),
];

/**
 * Account-abstraction config passed to every thirdweb hook that accepts one.
 * `sponsorGas: true` routes transactions through thirdweb's paymaster so
 * users never pay gas on Base. The same `chain` is used for SA derivation
 * regardless of which personal wallet signs the user op.
 */
/**
 * PINNED, deliberately. The smart-account address is a counterfactual of
 * (factory, entrypoint, admin EOA). thirdweb's defaults are a caret-range
 * dependency away from changing, and a changed default would move every
 * user's SA address — with their UpgraderEth deposit left under the old one,
 * unreachable for withdraw. These two values are thirdweb's current v0.6
 * defaults (wallets/smart/lib/constants.js), so pinning them changes nothing
 * for existing users; it only stops the ground from moving. Verified after
 * pinning: an impersonated MetaMask EOA still resolves to the same SA.
 */
export const THIRDWEB_ENTRYPOINT_V0_6 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as const;
export const THIRDWEB_ACCOUNT_FACTORY_V0_6 = "0x85e23b94e7F5E9cC1fF78BCe78cfb15B81f0DF00" as const;

export const THIRDWEB_AA_CONFIG: SmartWalletOptions = {
  chain: base,
  sponsorGas: true,
  factoryAddress: THIRDWEB_ACCOUNT_FACTORY_V0_6,
  overrides: { entrypointAddress: THIRDWEB_ENTRYPOINT_V0_6 },
};
