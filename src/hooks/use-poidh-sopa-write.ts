"use client";

import { useCallback, useState } from "react";
import {
  getContract,
  sendBatchTransaction,
  sendTransaction,
  type PreparedTransaction,
  type ThirdwebContract,
} from "thirdweb";
import { base } from "thirdweb/chains";
import { erc20Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareContractCall } from "@/lib/builder-code";
import { POIDH_SOPA } from "@/lib/config";
import { POIDH_SOPA_ABI } from "@/lib/poidh-sopa/abi";
import { decodeSopaError, type DecodedSopaError } from "@/lib/poidh-sopa/errors";
import { isEthToken } from "@/lib/poidh-sopa/tokens";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, waitForSuccessfulReceipt } from "@/lib/thirdweb-tx";

/**
 * One write runner for every PoidhSopa action. Handles the ERC-20 approve leg:
 * smart accounts bundle `approve + call` into one userop (`sendBatchTransaction`);
 * EOAs send approve, wait for it, then the call (two prompts). Sopa has no tx.origin
 * check, so smart accounts can create bounties (unlike POIDH V3).
 */

export type SopaContract = ThirdwebContract<typeof POIDH_SOPA_ABI>;

export type SopaWritePhase = "idle" | "approving" | "wallet" | "confirming" | "success" | "error";

export interface SopaTxPlan {
  /** ERC-20 the call will pull via transferFrom (skipped for ETH). */
  approve?: { token: `0x${string}`; amount: bigint };
  build: (contract: SopaContract) => SopaPreparedTx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- thirdweb's tx generic is ABI-specific
type SopaPreparedTx = PreparedTransaction<any>;

type Receipt = Awaited<ReturnType<typeof waitForSuccessfulReceipt>>;

const ALLOWANCE_POLL_MS = 1_500;
const ALLOWANCE_POLL_TRIES = 8;

export function usePoidhSopaWrite() {
  const writer = useWriteAccount();
  const publicClient = usePublicClient({ chainId: POIDH_SOPA.chainId });
  const [phase, setPhase] = useState<SopaWritePhase>("idle");
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  const [error, setError] = useState<DecodedSopaError | null>(null);
  /** 1-based step for the two-transaction EOA approve flow; null for single sends. */
  const [step, setStep] = useState<{ current: number; total: number } | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setHash(undefined);
    setError(null);
    setStep(null);
  }, []);

  const run = useCallback(
    async (plan: SopaTxPlan): Promise<Receipt> => {
      setError(null);
      setHash(undefined);
      setStep(null);
      try {
        const sopa = POIDH_SOPA.address;
        if (!sopa) throw new Error("PoidhSopa is not configured");
        if (!writer) throw new Error("Connect your wallet first");
        const client = getThirdwebClient();
        if (!client) throw new Error("Thirdweb client not configured");
        await ensureOnChain(writer.wallet, base);

        const contract = getContract({ client, chain: base, address: sopa, abi: POIDH_SOPA_ABI });
        const main = plan.build(contract);
        const owner = writer.account.address as Address;

        let approveTx: PreparedTransaction | null = null;
        const approve = plan.approve && !isEthToken(plan.approve.token) ? plan.approve : null;
        if (approve) {
          if (!publicClient) throw new Error("Base RPC unavailable");
          const allowance = await publicClient.readContract({
            address: approve.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, sopa],
          });
          if (allowance < approve.amount) {
            approveTx = prepareContractCall({
              contract: getContract({ client, chain: base, address: approve.token, abi: erc20Abi }),
              method: "approve",
              params: [sopa, approve.amount],
            }) as unknown as PreparedTransaction;
          }
        }

        const confirm = async (txHash: `0x${string}`) => {
          setHash(txHash);
          setPhase("confirming");
          return waitForSuccessfulReceipt({ client, chain: base, transactionHash: txHash });
        };

        let receipt: Receipt;
        if (approveTx && writer.account.sendBatchTransaction) {
          setPhase("wallet");
          const res = await sendBatchTransaction({
            account: writer.account,
            transactions: [approveTx, main],
          });
          receipt = await confirm(res.transactionHash);
        } else if (approveTx && approve) {
          setStep({ current: 1, total: 2 });
          setPhase("approving");
          const res = await sendTransaction({ account: writer.account, transaction: approveTx });
          await confirm(res.transactionHash);
          // The wallet's RPC can lag the one we read from: wait until the allowance shows.
          for (let i = 0; i < ALLOWANCE_POLL_TRIES && publicClient; i++) {
            const now = await publicClient.readContract({
              address: approve.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [owner, sopa],
            });
            if (now >= approve.amount) break;
            await new Promise((r) => setTimeout(r, ALLOWANCE_POLL_MS));
          }
          setStep({ current: 2, total: 2 });
          setPhase("wallet");
          const res2 = await sendTransaction({ account: writer.account, transaction: main });
          receipt = await confirm(res2.transactionHash);
        } else {
          setPhase("wallet");
          const res = await sendTransaction({ account: writer.account, transaction: main });
          receipt = await confirm(res.transactionHash);
        }

        setPhase("success");
        return receipt;
      } catch (err) {
        setError(decodeSopaError(err));
        setPhase("error");
        throw err;
      }
    },
    [writer, publicClient],
  );

  return {
    run,
    reset,
    phase,
    hash,
    error,
    step,
    isPending: phase === "approving" || phase === "wallet" || phase === "confirming",
    isSuccess: phase === "success",
    /** The signer can bundle approve + call into one userop. */
    canBatch: Boolean(writer?.account.sendBatchTransaction),
    signer: writer?.account.address as Address | undefined,
  };
}

// ─── Call builders ───────────────────────────────────────────────────────────

const ids = (xs: number[]) => xs.map((x) => BigInt(x));

export const sopaCalls = {
  createBounty:
    (args: {
      kind: "open" | "solo";
      token: `0x${string}`;
      amount: bigint;
      title: string;
      description: string;
      category: string;
    }) =>
    (contract: SopaContract) =>
      prepareContractCall({
        contract,
        method: args.kind === "open" ? "createOpenBounty" : "createSoloBounty",
        params: [args.token, args.amount, args.title, args.description, args.category],
        value: isEthToken(args.token) ? args.amount : 0n,
      }),
  join: (bountyId: number, token: `0x${string}`, amount: bigint) => (contract: SopaContract) =>
    prepareContractCall({
      contract,
      method: "joinOpenBounty",
      params: [BigInt(bountyId), amount],
      value: isEthToken(token) ? amount : 0n,
    }),
  createClaim:
    (bountyId: number, name: string, description: string, uri: string) =>
    (contract: SopaContract) =>
      prepareContractCall({
        contract,
        method: "createClaim",
        params: [BigInt(bountyId), name, description, uri],
      }),
  cancel: (bountyId: number, isOpen: boolean) => (contract: SopaContract) =>
    prepareContractCall({
      contract,
      method: isOpen ? "cancelOpenBounty" : "cancelSoloBounty",
      params: [BigInt(bountyId)],
    }),
  withdrawFromOpen: (bountyId: number) => (contract: SopaContract) =>
    prepareContractCall({ contract, method: "withdrawFromOpenBounty", params: [BigInt(bountyId)] }),
  claimRefund: (bountyId: number) => (contract: SopaContract) =>
    prepareContractCall({
      contract,
      method: "claimRefundFromCancelledOpenBounty",
      params: [BigInt(bountyId)],
    }),
  acceptClaims:
    (bountyId: number, claimIds: number[], sharesBps: number[]) => (contract: SopaContract) =>
      prepareContractCall({
        contract,
        method: "acceptClaims",
        params: [BigInt(bountyId), ids(claimIds), ids(sharesBps)],
      }),
  submitWinnersForVote:
    (bountyId: number, claimIds: number[], sharesBps: number[]) => (contract: SopaContract) =>
      prepareContractCall({
        contract,
        method: "submitWinnersForVote",
        params: [BigInt(bountyId), ids(claimIds), ids(sharesBps)],
      }),
  vote: (bountyId: number, support: boolean) => (contract: SopaContract) =>
    prepareContractCall({ contract, method: "voteClaim", params: [BigInt(bountyId), support] }),
  resolveVote: (bountyId: number) => (contract: SopaContract) =>
    prepareContractCall({ contract, method: "resolveVote", params: [BigInt(bountyId)] }),
  resetVotingPeriod: (bountyId: number) => (contract: SopaContract) =>
    prepareContractCall({ contract, method: "resetVotingPeriod", params: [BigInt(bountyId)] }),
  withdraw: (token: `0x${string}`) => (contract: SopaContract) =>
    prepareContractCall({ contract, method: "withdraw", params: [token] }),
};
