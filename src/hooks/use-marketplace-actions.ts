"use client";

import { useEffect, useRef, useState } from "react";
import { sendTransaction } from "thirdweb";
import { viemAdapter } from "thirdweb/adapters/viem";
import { base } from "thirdweb/chains";
import {
  encodeFunctionData,
  erc721Abi,
  isAddressEqual,
  parseEther,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { useWriteAccount, type WriteAccount } from "@/hooks/use-write-account";
import { prepareTransaction } from "@/lib/builder-code";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  getListingApprovalOperator,
  hasConfirmedMarketplaceApproval,
} from "@/lib/marketplace/approval";
import { generateMarketplaceSalt } from "@/lib/marketplace/attribution";
import { parseMarketplaceApiError } from "@/lib/marketplace/errors";
import {
  assertMarketplaceJournalProtocol,
  assertPublishedListing,
  canCancelSavedListing,
  listingSource,
  parseOpenSeaQuote,
  sameListingQuote,
  type MarketplaceListingQuote,
} from "@/lib/marketplace/listing-intent";
import { verifyOpenSeaTransaction } from "@/lib/marketplace/opensea-fulfillment";
import {
  getOpenSeaCancellation,
  validateOpenSeaListingFees,
} from "@/lib/marketplace/opensea-listing";
import {
  canResumeMarketplacePreflight,
  canRetryMarketplacePublication,
  inspectSavedMarketplaceListing,
  marketplaceActionError,
  repairMarketplaceJournal,
} from "@/lib/marketplace/recovery";
import {
  getConduitOperator,
  getListingConduitKey,
  getMarketplaceProtocolAddress,
} from "@/lib/marketplace/routing";
import {
  canAbandonMarketplaceSignature,
  canAcceptMarketplaceSignature,
  canReplaceMarketplaceAttempt,
  getListingCancellation,
  getListingFulfillment,
  getListingOrderHash,
  getListingPriceWei,
  getListingRoyalty,
  getListingTypedData,
  SEAPORT_ADDRESS,
  seaportAbi,
  validateListingOnchain,
  validateListingStructure,
  verifyMarketplaceTransaction,
  type MarketplaceTransactionIntent,
  type OrderComponents,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, normalizeTxError, waitForSuccessfulReceipt } from "@/lib/thirdweb-tx";
import type { MarketplaceOffer, MarketplaceSource } from "@/types/marketplace";

export type MarketplacePhase =
  | "idle"
  | "approving"
  | "signing"
  | "saving"
  | "buying"
  | "cancelling"
  | "confirming"
  | "pending"
  | "unknown"
  | "complete"
  | "failed";
export type MarketplaceActionError = {
  code: string;
  message: string;
  retryable?: boolean;
  requestId?: string;
};
type ListInput = {
  tokenId: string;
  priceEth: string;
  durationDays: number;
  expectedRoyaltyWei?: string;
  source?: MarketplaceSource;
  protocolAddress?: Address;
  expectedQuote?: MarketplaceListingQuote;
};
type Journal = {
  version: 1;
  account: Address;
  id: string;
  kind: "list" | "buy" | "cancel";
  phase: MarketplacePhase;
  tokenId: string;
  input?: ListInput;
  listing?: SignedListing;
  offer?: MarketplaceOffer;
  txHash?: Hex;
  approvalTxHash?: Hex;
  txStep?: "approval" | "buy" | "cancel";
  transactionFailed?: boolean;
  transactionIntent?: MarketplaceTransactionIntent;
  signatureRequestSettled?: boolean;
  listingOutcome?: "filled" | "cancelled" | "expired";
  error?: MarketplaceActionError;
};
type Entry = {
  journal: Journal | null;
  busy: boolean;
  listeners: Set<() => void>;
  invalidRaw?: string;
};
const entries = new Map<string, Entry>();
const keyFor = (account: Address) => `gnars:marketplace:v1:8453:${account.toLowerCase()}`;
const notify = (entry: Entry) => entry.listeners.forEach((listener) => listener());
function read(account: Address): Journal | null {
  const raw = localStorage.getItem(keyFor(account));
  if (!raw) return null;
  return parseJournal(raw, account);
}
function parseJournal(raw: string, account: Address): Journal {
  const value = JSON.parse(raw) as Journal;
  if (
    value.version !== 1 ||
    !isAddressEqual(value.account, account) ||
    !value.id ||
    !["list", "buy", "cancel"].includes(value.kind)
  )
    throw new Error("Invalid saved marketplace attempt");
  if (value.kind === "list") listingSource(value.input);
  assertMarketplaceJournalProtocol(value);
  if (value.listing)
    validateListingStructure(value.listing, {
      allowExpired: true,
      source: value.kind === "list" ? listingSource(value.input) : (value.offer?.source ?? "gnars"),
    });
  if (
    ![
      "idle",
      "approving",
      "signing",
      "saving",
      "buying",
      "cancelling",
      "confirming",
      "pending",
      "unknown",
      "complete",
      "failed",
    ].includes(value.phase) ||
    !/^\d+$/.test(value.tokenId)
  )
    throw new Error("Invalid saved marketplace state");
  if (value.kind === "list" && (!value.input || value.input.tokenId !== value.tokenId))
    throw new Error("Saved listing inputs do not match the NFT");
  if (value.txHash && (!/^0x[\da-fA-F]{64}$/.test(value.txHash) || !value.transactionIntent))
    throw new Error("Saved transaction has no valid intent");
  if (
    value.transactionIntent &&
    (!isAddressEqual(value.transactionIntent.account, account) ||
      !/^\d+$/.test(value.transactionIntent.startedBlock) ||
      !/^\d+$/.test(value.transactionIntent.value) ||
      !/^0x(?:[\da-fA-F]{2})+$/.test(value.transactionIntent.data))
  )
    throw new Error("Invalid saved transaction intent");
  return value;
}
function save(entry: Entry, journal: Journal) {
  entry.journal = journal;
  localStorage.setItem(keyFor(journal.account), JSON.stringify(journal));
  notify(entry);
}
function client(): PublicClient {
  const thirdweb = getThirdwebClient();
  if (!thirdweb) throw new Error("Wallet client unavailable");
  return viemAdapter.publicClient.toViem({
    chain: base,
    client: thirdweb,
  }) as unknown as PublicClient;
}
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/marketplace${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw parseMarketplaceApiError(await response.json().catch(() => null), response.status);
  return response.json();
}
async function locked<T>(account: Address, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser cannot safely coordinate wallet requests");
  return await navigator.locks.request(keyFor(account), action);
}

export function useMarketplaceActions() {
  const writer = useWriteAccount(),
    writerRef = useRef(writer);
  writerRef.current = writer;
  const account = writer?.account.address as Address | undefined;
  const [journal, setJournal] = useState<Journal | null>(null),
    [isBusy, setBusy] = useState(false),
    [error, setError] = useState<MarketplaceActionError | null>(null);
  const [invalidJournal, setInvalidJournal] = useState<{ raw: string; storageKey: string } | null>(
    null,
  );
  const activeRef = useRef(account);
  activeRef.current = account;
  useEffect(() => {
    setJournal(null);
    setError(null);
    setBusy(false);
    setInvalidJournal(null);
    if (!account) return;
    let entry = entries.get(keyFor(account));
    try {
      if (!entry) {
        entry = { journal: read(account), busy: false, listeners: new Set() };
        entries.set(keyFor(account), entry);
      }
    } catch {
      let invalidRaw = "";
      try {
        invalidRaw = localStorage.getItem(keyFor(account)) ?? "";
      } catch {
        /* Storage itself may be blocked. */
      }
      entry = {
        journal: null,
        busy: false,
        listeners: new Set(),
        invalidRaw,
      };
      entries.set(keyFor(account), entry);
    }
    const sync = () => {
      setJournal(entry!.journal ? { ...entry!.journal } : null);
      setBusy(entry!.busy);
      setError(entry!.journal?.error ?? null);
      setInvalidJournal(
        entry!.invalidRaw !== undefined
          ? { raw: entry!.invalidRaw, storageKey: keyFor(account) }
          : null,
      );
      if (entry!.invalidRaw !== undefined)
        setError({
          code: "INVALID_JOURNAL",
          message: "The saved marketplace attempt needs recovery",
        });
    };
    entry.listeners.add(sync);
    sync();
    return () => {
      entry!.listeners.delete(sync);
    };
  }, [account]);

  function signer(owner: Address): WriteAccount {
    const current = writerRef.current;
    if (
      !current ||
      !isAddressEqual(current.account.address as Address, owner) ||
      !isAddressEqual(current.wallet.getAccount()?.address as Address, owner)
    )
      throw new Error("The connected owner changed");
    return current;
  }
  async function prepareSigner(owner: Address) {
    const current = signer(owner);
    await ensureOnChain(current.wallet, base);
    if (signer(owner).account !== current.account) throw new Error("The connected owner changed");
    if ((await client().getChainId()) !== 8453) throw new Error("Base chain required");
    return current;
  }
  async function execute(action: (entry: Entry, owner: Address) => Promise<void>) {
    if (!account) {
      setError({ code: "wallet", message: "Connect the owner wallet" });
      return;
    }
    const entry = entries.get(keyFor(account));
    if (!entry || entry.busy) return;
    entry.busy = true;
    notify(entry);
    let failure: MarketplaceActionError | null = null;
    try {
      await action(entry, account);
    } catch (reason) {
      failure = marketplaceActionError(reason);
      try {
        await locked(account, async () => {
          const latest = read(account);
          if (!latest || latest.id !== entry.journal?.id || latest.phase === "complete") return;
          // A failed status read must not make a rejected signed order retryable again.
          if (latest.kind === "list" && latest.listing && latest.error?.retryable === false)
            failure = latest.error;
          const protectedPhase = ["unknown", "pending", "confirming"].includes(latest.phase);
          save(entry, {
            ...latest,
            phase: protectedPhase
              ? latest.phase
              : latest.listing && latest.kind === "list"
                ? "saving"
                : "failed",
            error: failure!,
          });
        });
      } catch {
        notify(entry);
      }
    } finally {
      entry.busy = false;
      notify(entry);
      if (failure && activeRef.current === account) setError(failure);
    }
  }
  async function broadcast(
    entry: Entry,
    owner: Address,
    call: { to: Address; data: Hex; value: bigint },
    step: NonNullable<Journal["txStep"]>,
  ) {
    const current = await prepareSigner(owner),
      thirdweb = getThirdwebClient()!;
    const intent = entry.journal!;
    const startedBlock = (await client().getBlockNumber({ cacheTime: 0 })).toString();
    await locked(owner, async () => {
      const saved = read(owner);
      if (
        saved?.id !== intent.id ||
        saved.txHash ||
        ["unknown", "pending", "confirming"].includes(saved.phase)
      )
        throw new Error("Resolve the existing wallet request");
      save(entry, {
        ...intent,
        phase: "unknown",
        txStep: step,
        transactionIntent: { account: owner, ...call, value: call.value.toString(), startedBlock },
        error: undefined,
      });
    });
    // The durable unknown barrier precedes the wallet call and survives reloads.
    let signerUnchanged = false;
    try {
      signerUnchanged =
        signer(owner).account === current.account && current.wallet.getChain()?.id === 8453;
    } catch {}
    if (!signerUnchanged) {
      await locked(owner, async () => {
        const saved = read(owner);
        if (saved?.id === intent.id && !saved.txHash)
          save(entry, {
            ...saved,
            phase: "failed",
            transactionIntent: undefined,
            txStep: undefined,
            error: {
              code: "WALLET_CHANGED",
              message: "The signer or network changed before sending",
            },
          });
      });
      throw new Error("The signer or network changed before sending");
    }
    let lateHash: Hex | undefined;
    const pending = sendTransaction({
      account: current.account,
      transaction: prepareTransaction({
        client: thirdweb,
        chain: base,
        to: call.to,
        data: call.data,
        value: call.value,
      }),
    })
      .then(async (result) => {
        lateHash = result.transactionHash;
        await locked(owner, async () => {
          const saved = read(owner);
          if (saved?.id !== intent.id) throw new Error("Marketplace attempt changed");
          if (saved.txHash && saved.txHash.toLowerCase() !== result.transactionHash.toLowerCase())
            throw new Error("The wallet returned a different transaction from the attached hash");
          if (saved.phase === "complete" || saved.txStep !== step) return;
          save(entry, { ...saved, txHash: lateHash, phase: "confirming" });
        });
        await waitForSuccessfulReceipt({
          client: thirdweb,
          chain: base,
          transactionHash: lateHash,
        });
        await reconcile(entry, owner);
      })
      .catch(async (reason) => {
        await locked(owner, async () => {
          const saved = read(owner);
          if (saved?.id !== intent.id || saved.phase === "complete" || saved.txStep !== step)
            return;
          const rejected =
            !lateHash && !saved.txHash && normalizeTxError(reason).category === "user-rejected";
          save(entry, {
            ...saved,
            txHash: saved.txHash ?? lateHash,
            phase: rejected ? "failed" : saved.txHash || lateHash ? "pending" : "unknown",
            ...(rejected ? { transactionIntent: undefined, txStep: undefined } : {}),
            error: {
              code: rejected ? "wallet" : "unknown",
              message: reason instanceof Error ? reason.message : "Wallet result unknown",
            },
          });
        }).catch(() => {
          entry.journal = {
            ...entry.journal!,
            txHash: lateHash ?? entry.journal?.txHash,
            phase: "unknown",
          };
          notify(entry);
        });
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 45000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // No second call can pass the persisted unknown/pending barrier, even when
    // the original WalletConnect promise never settles.
  }
  async function reconcile(entry: Entry, owner: Address) {
    return locked(owner, async () => {
      let saved = read(owner);
      if (!saved) return;
      // Cancellation is terminal for this exact order, independently of receipt availability.
      if (saved.kind === "cancel") {
        const orderHash = saved.listing
          ? getListingOrderHash(saved.listing.parameters)
          : saved.offer?.orderHash;
        const seller = saved.listing?.parameters.offerer ?? saved.offer?.seller;
        if (!orderHash || !seller || !isAddressEqual(seller, owner))
          throw new Error("Saved cancellation does not match the connected owner");
        const status = await client().readContract({
          address: getMarketplaceProtocolAddress(saved.offer?.source ?? listingSource(saved.input)),
          abi: seaportAbi,
          functionName: "getOrderStatus",
          args: [orderHash],
        });
        if (status[1]) {
          save(entry, {
            ...saved,
            phase: "complete",
            listingOutcome: "cancelled",
            error: undefined,
          });
          await api(saved.offer?.source === "opensea" ? "/opensea/reconcile" : "/reconcile", {
            orderHash,
            ...(saved.offer?.source === "gnars-contract" ? { source: "gnars-contract" } : {}),
          }).catch(() => {});
          return;
        }
      }
      const approvalOperator = getListingApprovalOperator(
        saved.transactionIntent,
        owner,
        saved.tokenId,
      );
      if (
        saved.kind === "list" &&
        saved.txStep === "approval" &&
        saved.txHash &&
        !saved.listing &&
        approvalOperator &&
        (await hasConfirmedMarketplaceApproval(client(), owner, saved.tokenId, approvalOperator))
      ) {
        // Preserve the observed hash for audit; it is not proof that its receipt succeeded.
        save(entry, {
          ...saved,
          approvalTxHash: saved.txHash,
          txHash: undefined,
          txStep: undefined,
          transactionIntent: undefined,
          transactionFailed: undefined,
          phase: "signing",
          error: undefined,
        });
        return;
      }
      if (saved.txHash) {
        let receipt;
        try {
          receipt = await client().getTransactionReceipt({ hash: saved.txHash });
        } catch (error) {
          if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") {
            save(entry, { ...saved, phase: "pending" });
            return;
          }
          throw error;
        }
        if (!saved.transactionIntent) throw new Error("Saved transaction intent is unavailable");
        const tx = await client().getTransaction({ hash: saved.txHash });
        if (!verifyMarketplaceTransaction(saved.transactionIntent, tx, receipt)) {
          save(entry, {
            ...saved,
            phase: "failed",
            transactionFailed: true,
            error: { code: "TRANSACTION_REVERTED", message: "Transaction reverted" },
          });
          return;
        }
        if (saved.txStep === "approval") {
          if (
            !approvalOperator ||
            !(await hasConfirmedMarketplaceApproval(
              client(),
              owner,
              saved.tokenId,
              approvalOperator,
            ))
          )
            throw new Error("NFT approval is not confirmed");
          saved = {
            ...saved,
            txHash: undefined,
            txStep: undefined,
            transactionIntent: undefined,
            phase: "signing",
          };
          save(entry, saved);
        } else {
          const orderHash = saved.listing
            ? getListingOrderHash(saved.listing.parameters)
            : saved.offer?.orderHash;
          if (!orderHash) throw new Error("Missing saved order");
          const chainStatus = await client().readContract({
            address: getMarketplaceProtocolAddress(
              saved.offer?.source ?? listingSource(saved.input),
            ),
            abi: seaportAbi,
            functionName: "getOrderStatus",
            args: [orderHash],
          });
          const status = chainStatus[1] ? "cancelled" : chainStatus[2] > 0n ? "filled" : "active";
          if (saved.kind === "cancel" ? status !== "cancelled" : status !== "filled")
            throw new Error("Marketplace execution is not confirmed");
          if (saved.kind === "buy") {
            const nftOwner = await client().readContract({
              address: DAO_ADDRESSES.token,
              abi: erc721Abi,
              functionName: "ownerOf",
              args: [BigInt(saved.tokenId)],
            });
            if (!isAddressEqual(nftOwner, owner))
              throw new Error("The purchased NFT is not owned by this buyer");
          }
          save(entry, { ...saved, phase: "complete", error: undefined });
          await api(saved.offer?.source === "opensea" ? "/opensea/reconcile" : "/reconcile", {
            orderHash,
            ...(saved.offer?.source === "gnars-contract" ? { source: "gnars-contract" } : {}),
          }).catch(() => {});
          return;
        }
      }
      if (saved.kind === "list" && saved.listing) {
        const outcome = await inspectSavedMarketplaceListing(client(), saved.listing, {
          source: listingSource(saved.input),
        });
        if (outcome)
          save(entry, { ...saved, phase: "complete", listingOutcome: outcome, error: undefined });
        else {
          entry.journal = saved;
          notify(entry);
        }
        return;
      }
      // Checking status never opens another wallet prompt.
      entry.journal = saved;
      notify(entry);
    });
  }
  async function publish(entry: Entry, saved: Journal) {
    const action = async () => {
      const current = read(saved.account);
      if (current?.id !== saved.id) return;
      if (!current.listing) throw new Error("Missing signed marketplace order");
      const outcome = await inspectSavedMarketplaceListing(client(), current.listing, {
        source: listingSource(current.input),
      });
      if (outcome) {
        save(entry, { ...current, phase: "complete", listingOutcome: outcome, error: undefined });
        return;
      }
      if (!canRetryMarketplacePublication(current)) return;
      save(entry, { ...current, phase: "saving" });
      const source = listingSource(current.input);
      const response = await api(source === "opensea" ? "/opensea/orders" : "/orders", {
        listing: current.listing,
        ...(source === "gnars-contract" ? { source } : {}),
      });
      assertPublishedListing(response.offer, current.listing, source);
      const latest = read(saved.account);
      if (latest?.id === saved.id) save(entry, { ...latest, phase: "complete", error: undefined });
    };
    return locked(saved.account, action);
  }
  async function quote({
    tokenId,
    priceEth,
    source = "gnars",
  }: {
    tokenId: string;
    priceEth: string;
    source?: MarketplaceSource;
  }): Promise<MarketplaceListingQuote> {
    if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(priceEth)) throw new Error("Invalid ETH precision");
    const price = parseEther(priceEth);
    if (price <= 0n) throw new Error("Invalid listing price");
    if (source === "opensea") {
      const response = await api("/opensea/quote", { tokenId, priceWei: price.toString() });
      return parseOpenSeaQuote(response.quote, price.toString());
    }
    const royalty = await getListingRoyalty(client(), BigInt(tokenId), price);
    return {
      priceWei: price.toString(),
      royaltyWei: royalty.amount.toString(),
      royaltyRecipient: royalty.amount ? royalty.recipient : null,
      sellerWei: (price - royalty.amount).toString(),
      fees: [],
      source,
    };
  }
  async function list(input: ListInput) {
    return execute(async (entry, owner) => {
      let saved = read(owner);
      const source = listingSource(
        saved && !canReplaceMarketplaceAttempt(saved) && saved.kind === "list"
          ? saved.input
          : input,
      );
      const ready = await api("/readiness");
      if (
        !(source === "opensea"
          ? ready.capabilities?.openseaSell
          : source === "gnars-contract"
            ? ready.capabilities?.customTrading
            : ready.capabilities?.localTrading)
      )
        throw new Error("Marketplace listing service is unavailable");
      if (saved && !canReplaceMarketplaceAttempt(saved)) {
        if (
          saved.kind !== "list" ||
          saved.tokenId !== input.tokenId ||
          !["signing", "saving", "approving"].includes(saved.phase)
        )
          throw new Error("Resolve the existing marketplace attempt");
        entry.journal = saved;
        if (saved.listing) {
          await publish(entry, saved);
          return;
        }
      } else {
        if (
          !Number.isInteger(input.durationDays) ||
          input.durationDays < 1 ||
          input.durationDays > 30
        )
          throw new Error("Invalid listing duration");
        await locked(owner, async () => {
          const latest = read(owner);
          if (latest && !canReplaceMarketplaceAttempt(latest))
            throw new Error("Resolve the existing marketplace attempt");
          save(entry, {
            version: 1,
            account: owner,
            id: crypto.randomUUID(),
            kind: "list",
            phase: "approving",
            tokenId: input.tokenId,
            input: {
              ...input,
              ...(source === "gnars-contract"
                ? { protocolAddress: getMarketplaceProtocolAddress(source) }
                : {}),
            },
          });
        });
        saved = entry.journal!;
      }
      const current = await prepareSigner(owner);
      const code = await client().getCode({ address: owner });
      if (current.wallet.id === "smart" && (!code || code === "0x"))
        throw new Error("Deploy this smart account before listing, or select the NFT-owning EOA");
      const actualOwner = await client().readContract({
        address: DAO_ADDRESSES.token,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(saved.tokenId)],
      });
      if (!isAddressEqual(actualOwner, owner))
        throw new Error("The connected account does not own this NFT");
      const fixed = saved.input!;
      const amounts = await quote(fixed);
      if (fixed.expectedQuote && !sameListingQuote(fixed.expectedQuote, amounts))
        throw new Error("Listing fees changed; review the price again");
      if (source === "opensea" && !fixed.expectedQuote)
        throw new Error("Review OpenSea fees before listing");
      if (fixed.expectedRoyaltyWei !== undefined && fixed.expectedRoyaltyWei !== amounts.royaltyWei)
        throw new Error("The collection royalty changed; review the price again");
      const conduitKey = getListingConduitKey(source);
      const approvalOperator = getConduitOperator(conduitKey, source);
      if (
        !(await hasConfirmedMarketplaceApproval(client(), owner, saved.tokenId, approvalOperator))
      ) {
        await broadcast(
          entry,
          owner,
          {
            to: DAO_ADDRESSES.token,
            data: encodeFunctionData({
              abi: erc721Abi,
              functionName: "approve",
              args: [approvalOperator, BigInt(saved.tokenId)],
            }),
            value: 0n,
          },
          "approval",
        );
        if (entry.journal?.phase !== "signing") return;
      }
      const now = Number((await client().getBlock()).timestamp);
      const counter = await client().readContract({
        address: getMarketplaceProtocolAddress(source),
        abi: seaportAbi,
        functionName: "getCounter",
        args: [owner],
      });
      const payment = (amount: string, recipient: Address) => ({
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: amount,
        endAmount: amount,
        recipient,
      });
      const parameters: OrderComponents = {
        offerer: owner,
        zone: zeroAddress,
        offer: [
          {
            itemType: 2,
            token: DAO_ADDRESSES.token,
            identifierOrCriteria: saved.tokenId,
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          payment(amounts.sellerWei, owner),
          ...amounts.fees.map((fee) => payment(fee.amountWei, fee.recipient)),
          ...(amounts.royaltyRecipient
            ? [payment(amounts.royaltyWei, amounts.royaltyRecipient)]
            : []),
        ],
        orderType: 0,
        startTime: String(now - 30),
        endTime: String(now + fixed.durationDays * 86400),
        zoneHash: zeroHash,
        salt: generateMarketplaceSalt(),
        conduitKey,
        counter: counter.toString(),
      };
      validateListingStructure({ parameters, signature: "0x00" }, { source });
      const currentQuote = await quote(fixed);
      if (!sameListingQuote(currentQuote, amounts))
        throw new Error("Listing fees changed; review the price again");
      await locked(owner, async () => {
        const latest = read(owner);
        if (latest?.id !== saved!.id || latest.phase === "unknown")
          throw new Error("Resolve the existing signature request");
        save(entry, { ...entry.journal!, phase: "unknown", signatureRequestSettled: false });
      });
      const pending = signer(owner)
        .account.signTypedData(getListingTypedData(parameters, { source }))
        .then(async (signature) => {
          const listing = validateListingStructure({ parameters, signature }, { source });
          if (source === "opensea") validateOpenSeaListingFees(listing, amounts);
          const accepted = await locked(owner, async () => {
            const latest = read(owner);
            if (!canAcceptMarketplaceSignature(latest, saved!.id)) return false;
            save(entry, { ...latest!, listing, phase: "saving", signatureRequestSettled: true });
            return true;
          });
          if (!accepted) return;
          await validateListingOnchain(client(), listing, { requireApproval: true, source });
          await publish(entry, { ...saved!, listing, phase: "saving" });
        })
        .catch(async (reason) => {
          await locked(owner, async () => {
            const latest = read(owner);
            if (latest?.id !== saved!.id) return;
            const rejected = normalizeTxError(reason).category === "user-rejected";
            save(entry, {
              ...latest,
              signatureRequestSettled: true,
              phase: latest.listing ? "saving" : rejected ? "failed" : "unknown",
              error: marketplaceActionError(reason, rejected ? "wallet" : "unknown"),
            });
          });
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 45000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    });
  }
  async function trade(kind: "buy" | "cancel", tokenId: string, offer: MarketplaceOffer) {
    return execute((entry, owner) => tradeAction(entry, owner, kind, tokenId, offer));
  }
  async function tradeAction(
    entry: Entry,
    owner: Address,
    kind: "buy" | "cancel",
    tokenId: string,
    offer: MarketplaceOffer,
  ) {
    const ready = await api("/readiness");
    if (
      offer.source !== "opensea" &&
      !(offer.source === "gnars-contract"
        ? ready.capabilities?.customTrading
        : ready.capabilities?.localTrading)
    )
      throw new Error("Marketplace trading is unavailable");
    if (offer.source === "opensea") {
      if (kind === "cancel") {
        if (!ready.capabilities?.openseaCancel || !isAddressEqual(owner, offer.seller))
          throw new Error("Only the listing owner can cancel");
        const raw = await api(`/opensea/orders/${offer.orderHash}`);
        const call = getOpenSeaCancellation(raw, {
          orderHash: offer.orderHash,
          seller: owner,
          tokenId,
        });
        await client().call({ account: owner, ...call });
        await locked(owner, async () => {
          const saved = read(owner);
          if (saved && !canReplaceMarketplaceAttempt(saved))
            throw new Error("Resolve the existing marketplace attempt");
          save(entry, {
            version: 1,
            account: owner,
            id: crypto.randomUUID(),
            kind,
            phase: "cancelling",
            tokenId,
            offer,
          });
        });
        await broadcast(entry, owner, call, "cancel");
        return;
      }
      if (!ready.capabilities?.openseaBuy) throw new Error("OpenSea execution is unavailable");
      const response = await api("/fulfillment", {
        source: offer.source,
        orderHash: offer.orderHash,
        tokenId,
        buyer: owner,
        expectedPriceWei: offer.priceWei,
      });
      const counter = await client().readContract({
        address: SEAPORT_ADDRESS,
        abi: seaportAbi,
        functionName: "getCounter",
        args: [offer.seller],
      });
      const tx = { ...response.transaction, value: BigInt(response.transaction.value) };
      if (response.transaction.chainId !== 8453) throw new Error("Base chain required");
      verifyOpenSeaTransaction(tx, { offer, tokenId, buyer: owner, counter });
      await client().call({ account: owner, to: tx.to, data: tx.data, value: tx.value });
      await locked(owner, async () => {
        const saved = read(owner);
        if (saved && !canReplaceMarketplaceAttempt(saved))
          throw new Error("Resolve the existing marketplace attempt");
        save(entry, {
          version: 1,
          account: owner,
          id: crypto.randomUUID(),
          kind: "buy",
          phase: "buying",
          tokenId,
          offer,
        });
      });
      await broadcast(entry, owner, tx, "buy");
      return;
    }
    const { listing: raw } = await api(
      `/orders/${offer.orderHash}${offer.source === "gnars-contract" ? "?source=gnars-contract" : ""}`,
    );
    const listing = validateListingStructure(raw, {
      allowExpired: kind === "cancel",
      source: offer.source,
    });
    if (!isAddressEqual(offer.protocolAddress, getMarketplaceProtocolAddress(offer.source)))
      throw new Error("Marketplace protocol changed");
    if (!tokenId) tokenId = listing.parameters.offer[0].identifierOrCriteria;
    if (
      getListingOrderHash(listing.parameters).toLowerCase() !== offer.orderHash.toLowerCase() ||
      listing.parameters.offer[0].identifierOrCriteria !== tokenId
    )
      throw new Error("Marketplace order changed");
    if (kind === "cancel" && !isAddressEqual(owner, listing.parameters.offerer))
      throw new Error("Only the listing owner can cancel");
    if (kind === "buy") {
      await validateListingOnchain(client(), listing, { source: offer.source });
      if (isAddressEqual(owner, listing.parameters.offerer))
        throw new Error("The seller cannot buy their own listing");
    }
    const call =
      kind === "buy"
        ? getListingFulfillment(listing, { source: offer.source })
        : getListingCancellation(listing, { source: offer.source });
    if (kind === "buy" && call.value.toString() !== offer.priceWei)
      throw new Error("Marketplace price changed");
    if (kind === "buy") {
      const response = await api("/fulfillment", {
        source: offer.source,
        orderHash: offer.orderHash,
        tokenId,
        buyer: owner,
        expectedPriceWei: offer.priceWei,
      });
      if (
        response.transaction.chainId !== 8453 ||
        !isAddressEqual(response.transaction.to, call.to) ||
        response.transaction.data.toLowerCase() !== call.data.toLowerCase() ||
        response.transaction.value !== call.value.toString()
      )
        throw new Error("Marketplace transaction changed");
    }
    await client().call({ account: owner, ...call });
    await locked(owner, async () => {
      const saved = read(owner);
      if (saved && !canReplaceMarketplaceAttempt(saved))
        throw new Error("Resolve the existing marketplace attempt");
      save(entry, {
        version: 1,
        account: owner,
        id: crypto.randomUUID(),
        kind,
        phase: kind === "buy" ? "buying" : "cancelling",
        tokenId,
        offer,
        listing,
      });
    });
    await broadcast(entry, owner, call, kind);
  }
  const visible = journal && account && isAddressEqual(journal.account, account) ? journal : null;
  return {
    phase: visible?.phase ?? "idle",
    error,
    txHash: visible?.txHash ?? null,
    listingOutcome: visible?.listingOutcome ?? null,
    isBusy,
    invalidJournal,
    txStep: visible?.txStep,
    list,
    quote,
    canAbandonSignature: canAbandonMarketplaceSignature(visible),
    canCancelSavedListing: canCancelSavedListing(visible),
    recovery: visible
      ? { tokenId: visible.tokenId, kind: visible.kind, input: visible.input, phase: visible.phase }
      : null,
    canResume: Boolean(
      visible &&
        canRetryMarketplacePublication(visible) &&
        (["signing", "saving"].includes(visible.phase) || canResumeMarketplacePreflight(visible)),
    ),
    recoverInvalidJournal: () =>
      execute(async (entry, owner) => {
        await locked(owner, async () => {
          const raw = localStorage.getItem(keyFor(owner));
          if (raw === null || entry.invalidRaw === undefined)
            throw new Error("No saved attempt needs repair");
          const repaired = parseJournal(repairMarketplaceJournal(raw, owner), owner);
          localStorage.setItem(`${keyFor(owner)}:backup:${Date.now()}`, raw);
          save(entry, repaired);
          entry.invalidRaw = undefined;
          notify(entry);
        });
      }),
    resume: () =>
      visible?.kind === "list" && visible.input && !visible.listing
        ? list(visible.input)
        : visible?.kind === "list" && visible.listing
          ? execute((entry) => publish(entry, visible))
          : visible?.kind === "buy" && visible.offer && canResumeMarketplacePreflight(visible)
            ? execute(async (entry, owner) => {
                await locked(owner, async () => {
                  const saved = read(owner);
                  if (saved?.id !== visible.id || !canResumeMarketplacePreflight(saved))
                    throw new Error("Marketplace attempt changed");
                  save(entry, { ...saved, phase: "failed" });
                });
                await tradeAction(entry, owner, "buy", visible.tokenId, visible.offer!);
              })
            : visible &&
                canResumeMarketplacePreflight(visible) &&
                visible.kind !== "list" &&
                visible.offer
              ? execute(async (entry, owner) => {
                  await locked(owner, async () => {
                    const saved = read(owner);
                    if (saved?.id !== visible.id || !canResumeMarketplacePreflight(saved))
                      throw new Error("Marketplace attempt changed");
                    // Nothing has been sent: preserve the original order and retry only this call.
                    save(entry, { ...saved, phase: "failed" });
                  });
                  const call =
                    visible.kind === "cancel"
                      ? visible.listing
                        ? getListingCancellation(visible.listing, { source: visible.offer!.source })
                        : getOpenSeaCancellation(
                            await api(`/opensea/orders/${visible.offer!.orderHash}`),
                            {
                              orderHash: visible.offer!.orderHash,
                              seller: owner,
                              tokenId: visible.tokenId,
                            },
                          )
                      : null;
                  if (!call) throw new Error("Review the purchase again before sending");
                  await client().call({ account: owner, ...call });
                  await broadcast(entry, owner, call, "cancel");
                })
              : execute((entry, owner) => reconcile(entry, owner)),
    attachTransactionHash: (hash: Hex) =>
      execute(async (entry, owner) => {
        if (!/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash");
        await locked(owner, async () => {
          const saved = read(owner);
          if (!saved?.transactionIntent || saved.phase === "complete")
            throw new Error("No unresolved transaction attempt");
          if (saved.txHash && saved.txHash.toLowerCase() !== hash.toLowerCase())
            throw new Error("This attempt already has a transaction hash");
          const tx = await client().getTransaction({ hash });
          verifyMarketplaceTransaction(saved.transactionIntent, tx);
          save(entry, { ...saved, txHash: hash, phase: "pending", error: undefined });
        });
        await reconcile(entry, owner);
      }),
    abandonSignature: () =>
      execute(async (entry, owner) => {
        await locked(owner, async () => {
          const saved = read(owner);
          if (!canAbandonMarketplaceSignature(saved))
            throw new Error("The wallet signature request is still unresolved");
          localStorage.removeItem(keyFor(owner));
          entry.journal = null;
          notify(entry);
        });
      }),
    cancelSavedListing: () =>
      execute(async (entry, owner) => {
        const saved = read(owner);
        if (!saved?.listing || !canCancelSavedListing(saved))
          throw new Error("No saved signed listing to cancel");
        const source =
          saved.kind === "cancel"
            ? (saved.offer?.source ?? listingSource(saved.input))
            : listingSource(saved.input);
        const listing = validateListingStructure(saved.listing, { source, allowExpired: true });
        if (!isAddressEqual(listing.parameters.offerer, owner))
          throw new Error("Only the listing owner can cancel");
        const call = getListingCancellation(listing, { source });
        await client().call({ account: owner, ...call });
        await locked(owner, async () => {
          const latest = read(owner);
          if (latest?.id !== saved.id || !canCancelSavedListing(latest))
            throw new Error("Saved listing changed; check its current status");
          const orderHash = getListingOrderHash(listing.parameters);
          save(entry, {
            version: 1,
            account: owner,
            id: crypto.randomUUID(),
            kind: "cancel",
            phase: "cancelling",
            tokenId: saved.tokenId,
            listing,
            input: saved.input,
            offer: {
              id: `${source}:${orderHash}`,
              source,
              orderHash,
              protocolAddress: getMarketplaceProtocolAddress(source),
              seller: owner,
              priceWei: getListingPriceWei(listing).toString(),
              currency: "ETH",
              expiresAt: Number(listing.parameters.endTime),
            },
          });
        });
        await broadcast(entry, owner, call, "cancel");
      }),
    buy: ({ tokenId, offer }: { tokenId: string; offer: MarketplaceOffer }) =>
      trade("buy", tokenId, offer),
    cancel: (offer: MarketplaceOffer, tokenId: string) => trade("cancel", tokenId, offer),
    checkStatus: () => execute((entry, owner) => reconcile(entry, owner)),
    reset: () =>
      execute(async (entry, owner) => {
        await locked(owner, async () => {
          const saved = read(owner);
          if (saved && !canReplaceMarketplaceAttempt(saved))
            throw new Error("An unresolved attempt cannot be cleared");
          localStorage.removeItem(keyFor(owner));
          entry.journal = null;
          notify(entry);
        });
      }),
  };
}
