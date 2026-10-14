"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { base } from "thirdweb/chains";
import { useActiveWalletChain, useConnectModal } from "thirdweb/react";
import { useUserAddress } from "@/hooks/use-user-address";
import { useWriteAccount } from "@/hooks/use-write-account";
import { POIDH_SOPA } from "@/lib/config";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain } from "@/lib/thirdweb-tx";
import { THIRDWEB_AA_CONFIG, THIRDWEB_WALLETS } from "@/lib/thirdweb-wallets";

/**
 * Connect / network state for Sopa actions. The chain check reads the SIGNING wallet
 * (`useWriteAccount().wallet`): in EOA view that is the admin wallet, whose chain can
 * differ from the SA wrapper's pinned Base.
 */
export function useSopaWallet() {
  const t = useTranslations("bounties");
  const { address, isConnected } = useUserAddress();
  const writer = useWriteAccount();
  // Subscribing re-renders on chain changes; the signer's chain is read below.
  const activeChain = useActiveWalletChain();
  const { connect: openConnectModal } = useConnectModal();
  const [isSwitching, setIsSwitching] = useState(false);
  const [, bump] = useState(0);

  const signerChainId = writer?.wallet.getChain()?.id ?? activeChain?.id;
  const wrongNetwork = isConnected && !!signerChainId && signerChainId !== POIDH_SOPA.chainId;

  const connect = useCallback(async () => {
    const client = getThirdwebClient();
    if (!client) return;
    try {
      await openConnectModal({
        client,
        wallets: THIRDWEB_WALLETS,
        accountAbstraction: THIRDWEB_AA_CONFIG,
        size: "compact",
        title: t("detail.connectWallet"),
      });
    } catch {
      // user closed the modal
    }
  }, [openConnectModal, t]);

  const switchToBase = useCallback(async () => {
    if (!writer || isSwitching) return;
    setIsSwitching(true);
    try {
      await ensureOnChain(writer.wallet, base);
    } catch {
      // user cancelled; the button stays
    } finally {
      setIsSwitching(false);
      bump((n) => n + 1);
    }
  }, [writer, isSwitching]);

  return { address, isConnected, wrongNetwork, isSwitching, connect, switchToBase };
}
