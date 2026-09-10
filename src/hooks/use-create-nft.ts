"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getContract, sendTransaction } from "thirdweb";
import { base } from "thirdweb/chains";
import { bytesToHex, erc721Abi, isAddressEqual, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareContractCall } from "@/lib/builder-code";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  communityNftAbi,
  nftCreationJournalSchema,
  nftCreationStorageKey,
  type NftCreationJournal,
} from "@/lib/create-nft";
import { isNftWalletRejection } from "@/lib/create-nft-deployment";
import { uploadToPinata } from "@/lib/pinata";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain } from "@/lib/thirdweb-tx";
import { signWalletRequest } from "@/lib/wallet-authorization";

export function useCreateNft(contractAddress: Address | undefined) {
  const writer = useWriteAccount();
  const writerRef = useRef(writer);
  useLayoutEffect(() => {
    writerRef.current = writer;
  }, [writer]);
  const client = usePublicClient({ chainId: 8453 });
  const account = writer?.account.address;
  const key =
    account && contractAddress ? nftCreationStorageKey(account, contractAddress) : undefined;
  const [journal, setJournal] = useState<NftCreationJournal | null>(null);
  const [step, setStep] = useState<"idle" | "upload" | "metadata" | "wallet" | "confirm">("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [confirmedMint, setConfirmedMint] = useState<NftCreationJournal | null>(null);
  const sessionRef = useRef({ key });

  useLayoutEffect(() => {
    sessionRef.current = { key };
    setConfirmedMint(null);
  }, [key]);

  useEffect(() => {
    const restore = () => {
      setJournal(null);
      setError("");
      setStorageReady(false);
      if (!key) return;
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const restored = nftCreationJournalSchema.parse(JSON.parse(raw));
          if (nftCreationStorageKey(restored.account, restored.contract) !== key)
            throw new Error("Journal identity mismatch");
          setJournal(restored);
        }
        setStorageReady(Boolean(navigator.locks));
      } catch {
        setError("storageError");
      }
    };
    restore();
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [key]);

  const save = useCallback((value: NftCreationJournal) => {
    const storageKey = nftCreationStorageKey(value.account, value.contract);
    localStorage.setItem(storageKey, JSON.stringify(value));
    if (
      sessionRef.current.key === storageKey &&
      writerRef.current?.account.address.toLowerCase() === value.account.toLowerCase()
    )
      setJournal(value);
  }, []);

  const verify = useCallback(
    async (saved: NftCreationJournal) => {
      if (!client) throw new Error("failed");
      const verificationSession = sessionRef.current;
      const address = saved.contract as Address;
      const update = (values: Partial<NftCreationJournal>) => {
        const raw = localStorage.getItem(nftCreationStorageKey(saved.account, saved.contract));
        if (!raw) return;
        const latest = nftCreationJournalSchema.parse(JSON.parse(raw));
        if (latest.requestId !== saved.requestId) return;
        const updated = { ...latest, ...values };
        save(updated);
        if (
          values.tokenId &&
          !latest.tokenId &&
          sessionRef.current === verificationSession &&
          verificationSession.key === nftCreationStorageKey(saved.account, saved.contract) &&
          writerRef.current?.account.address.toLowerCase() === saved.account.toLowerCase()
        )
          setConfirmedMint(updated);
      };
      const tokenId = await client.readContract({
        address,
        abi: communityNftAbi,
        functionName: "mintedRequests",
        args: [saved.account as Address, saved.requestId as Hex],
      });
      if (tokenId > 0n) {
        const [creator, uri] = await Promise.all([
          client.readContract({
            address,
            abi: communityNftAbi,
            functionName: "creators",
            args: [tokenId],
          }),
          client.readContract({
            address,
            abi: communityNftAbi,
            functionName: "tokenURI",
            args: [tokenId],
          }),
        ]);
        if (!isAddressEqual(creator, saved.account as Address) || uri !== saved.uri)
          throw new Error("mismatch");
        update({ tokenId: tokenId.toString(), failed: false });
        return true;
      }
      if (saved.hash) {
        const receipt = await client.getTransactionReceipt({ hash: saved.hash as Hex });
        if (receipt.status === "reverted") {
          update({ failed: true });
          setError("reverted");
          return true;
        }
      }
      return false;
    },
    [client, save],
  );

  useEffect(() => {
    if (!journal || journal.tokenId || journal.failed) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let count = 0;
    const deadline = Date.now() + 120000;
    const check = async () => {
      if (stopped || Date.now() > deadline) return;
      try {
        if (document.visibilityState !== "hidden" && (await verify(journal))) return;
      } catch {
        /* A read failure never authorizes a second mint. */
      }
      if (!stopped) timer = setTimeout(check, Math.min(2000 * 2 ** count++, 15000));
    };
    timer = setTimeout(check, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [journal, verify]);

  async function create(file: File, name: string, description: string) {
    if (!key || !contractAddress || !writer || !client || busy || !storageReady) return;
    const signer = writer;
    const address = signer.account.address as Address;
    setBusy(true);
    setError("");
    try {
      await navigator.locks.request(key, async () => {
        if (localStorage.getItem(key)) throw new Error("pending");
        const checkAccount = () => {
          if (writerRef.current?.account.address.toLowerCase() !== address.toLowerCase())
            throw new Error("accountChanged");
        };
        if (
          (await client.readContract({
            address: DAO_ADDRESSES.token,
            abi: erc721Abi,
            functionName: "balanceOf",
            args: [address],
          })) < 6n
        )
          throw new Error("membership");
        setStep("upload");
        const media = await uploadToPinata(signer.account, file, file.name);
        if (!media.success || !media.data) throw new Error("uploadError");
        checkAccount();
        setStep("metadata");
        const metadata = {
          name: name.trim(),
          description: description.trim(),
          image: media.data.ipfsUrl,
        };
        const authorization = await signWalletRequest(signer.account, {
          method: "POST",
          path: "/api/create-nft/metadata",
          payload: metadata,
        });
        const response = await fetch("/api/create-nft/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata, authorization }),
        });
        if (!response.ok) throw new Error("uploadError");
        const result = (await response.json()) as { uri: string };
        const saved = nftCreationJournalSchema.parse({
          account: address,
          contract: contractAddress,
          requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
          uri: result.uri,
          name: metadata.name,
        });
        checkAccount();
        await ensureOnChain(signer.wallet, base);
        checkAccount();
        await client.simulateContract({
          account: address,
          address: contractAddress,
          abi: communityNftAbi,
          functionName: "mint",
          args: [saved.requestId as Hex, saved.uri],
        });
        const thirdweb = getThirdwebClient();
        if (!thirdweb) throw new Error("failed");
        checkAccount();
        save(saved);
        setStep("wallet");
        try {
          const result = await sendTransaction({
            account: signer.account,
            transaction: prepareContractCall({
              contract: getContract({ client: thirdweb, chain: base, address: contractAddress }),
              method: "function mint(bytes32 requestId,string uri) returns(uint256)",
              params: [saved.requestId as Hex, saved.uri],
            }),
          });
          save({ ...saved, hash: result.transactionHash });
          setStep("confirm");
        } catch (cause) {
          if (isNftWalletRejection(cause)) {
            save({ ...saved, failed: true });
            throw new Error("rejected");
          }
          throw new Error("pending");
        }
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "failed";
      setError(
        ["membership", "accountChanged", "uploadError", "pending", "rejected"].includes(message)
          ? message
          : "failed",
      );
    } finally {
      setBusy(false);
      setStep("idle");
    }
  }

  async function check() {
    if (!journal || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!(await verify(journal))) setError("pending");
    } catch {
      setError("pending");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!key || !journal || (!journal.tokenId && !journal.failed) || busy) return;
    await navigator.locks.request(key, () => {
      localStorage.removeItem(key);
      setJournal(null);
      setConfirmedMint(null);
      setError("");
    });
  }

  return { writer, journal, confirmedMint, step, error, busy, storageReady, create, check, reset };
}
