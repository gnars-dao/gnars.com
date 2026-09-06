import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { entryPoint06Abi } from "viem/account-abstraction";
import { z } from "zod";
import {
  depositPoolAbi,
  MORPHEUS_DISTRIBUTOR,
  MORPHEUS_POOLS,
  type MorpheusAsset,
} from "./morpheus";

export type StakeStep = "approval" | "deposit" | "receiver";
export type StakeFlowStatus =
  | "ready"
  | "wallet"
  | "confirming"
  | "pending"
  | "unknown"
  | "failed"
  | "complete";
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as Address);
const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  chainId: z.literal(1),
  account: addressSchema,
  asset: z.enum(["stEth", "usdc"]),
  pool: addressSchema,
  athlete: addressSchema,
  amount: z.string().min(1),
  amountRaw: z.string().regex(/^[1-9]\d*$/),
  claimLockEnd: z.number().int().nonnegative().safe(),
  expectedReceiver: addressSchema,
  step: z.enum(["approval", "deposit", "receiver"]),
  status: z.enum(["ready", "wallet", "confirming", "pending", "unknown", "failed", "complete"]),
  hashes: z.object({
    approval: hashSchema.optional(),
    deposit: hashSchema.optional(),
    receiver: hashSchema.optional(),
  }),
  previousHashes: z.array(hashSchema).default([]),
  depositConfirmed: z.boolean(),
  recoveryAvailable: z.boolean(),
  retryable: z.boolean(),
  recoveryOnly: z.boolean().optional(),
  startedBlock: z.string().regex(/^\d+$/).optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type MorpheusStakeFlow = z.infer<typeof journalSchema>;
export type StakeIntent = Pick<
  MorpheusStakeFlow,
  | "account"
  | "asset"
  | "pool"
  | "athlete"
  | "amount"
  | "amountRaw"
  | "claimLockEnd"
  | "expectedReceiver"
>;
export interface StakePosition {
  deposited: bigint;
  referrer: Address;
  receiver: Address;
  claimLockEnd?: number;
}
export interface StakeTransaction {
  chainId: number;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  blockNumber?: bigint | null;
}
export interface StakeReceipt {
  status: "success" | "reverted";
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}
export interface StakeFlowDependencies {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  allowance(flow: StakeIntent): Promise<bigint>;
  position(flow: StakeIntent): Promise<StakePosition>;
  transaction(hash: Hex): Promise<StakeTransaction | null>;
  receipt(hash: Hex): Promise<StakeReceipt | null>;
  send(step: StakeStep, flow: StakeIntent): Promise<Hex>;
  validateIntent(flow: StakeIntent): Promise<void>;
  snapshotBlock(): Promise<bigint>;
  lock?<T>(key: string, action: () => Promise<T>): Promise<T>;
  now?: () => number;
  walletTimeoutMs?: number;
}

/** Only use when a wallet request definitely did not broadcast. Other errors are ambiguous. */
export class StakeNotSentError extends Error {}

export function stakeJournalKey(account: Address, pool: Address): string {
  return `gnars:morpheus-stake:v1:1:${account.toLowerCase()}:${pool.toLowerCase()}`;
}

export function stakeCall(flow: StakeIntent, step: StakeStep): { to: Address; data: Hex } {
  if (step === "approval")
    return {
      to: MORPHEUS_POOLS[flow.asset].token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [MORPHEUS_DISTRIBUTOR, BigInt(flow.amountRaw)],
      }),
    };
  return {
    to: flow.pool,
    data:
      step === "deposit"
        ? encodeFunctionData({
            abi: depositPoolAbi,
            functionName: "stake",
            args: [0n, BigInt(flow.amountRaw), BigInt(flow.claimLockEnd), flow.athlete],
          })
        : encodeFunctionData({
            abi: depositPoolAbi,
            functionName: "setClaimReceiver",
            args: [0n, flow.expectedReceiver],
          }),
  };
}

const ENTRYPOINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const accountAbi = parseAbi(["function execute(address target,uint256 value,bytes data)"]);

/** Match the intended call, including the account-specific result inside an AA bundle. */
export function verifyStakeTransaction(
  flow: StakeIntent,
  step: StakeStep,
  tx: StakeTransaction,
  receipt?: StakeReceipt,
): boolean {
  if (tx.chainId !== 1) throw new Error("Transaction belongs to another chain");
  let target = tx.to;
  let input = tx.input;
  let value = tx.value;
  let operationSucceeded = true;
  if (!isAddressEqual(tx.from, flow.account)) {
    if (!tx.to || !isAddressEqual(tx.to, ENTRYPOINT))
      throw new Error("Transaction belongs to another account");
    const bundle = decodeFunctionData({ abi: entryPoint06Abi, data: tx.input });
    if (bundle.functionName !== "handleOps")
      throw new Error("Unsupported smart-account transaction");
    const operations = bundle.args[0].filter((op) => isAddressEqual(op.sender, flow.account));
    if (operations.length !== 1) throw new Error("Ambiguous smart-account transaction");
    const op = operations[0];
    const call = decodeFunctionData({ abi: accountAbi, data: op.callData });
    [target, value, input] = call.args;
    if (receipt && receipt.status !== "reverted") {
      const outcomes = receipt.logs.flatMap((log) => {
        if (!isAddressEqual(log.address, ENTRYPOINT)) return [];
        try {
          const event = decodeEventLog({
            abi: entryPoint06Abi,
            eventName: "UserOperationEvent",
            data: log.data,
            topics: [...log.topics] as [Hex, ...Hex[]],
          });
          return isAddressEqual(event.args.sender, flow.account) && event.args.nonce === op.nonce
            ? [event.args.success]
            : [];
        } catch {
          return [];
        }
      });
      if (outcomes.length !== 1) throw new Error("Smart-account execution result unavailable");
      operationSucceeded = outcomes[0];
    }
  }
  const expected = stakeCall(flow, step);
  // Builder attribution is appended to ABI calldata; the complete expected call
  // must still be the prefix, so token, amount, rider, lock and receiver all match.
  if (
    !target ||
    !isAddressEqual(target, expected.to) ||
    value !== 0n ||
    !input.toLowerCase().startsWith(expected.data.toLowerCase())
  ) {
    throw new Error("Transaction does not match this stake attempt");
  }
  return operationSucceeded && receipt?.status !== "reverted";
}

const journalLocks = new Map<string, Promise<unknown>>();

export class MorpheusStakeController {
  flow: MorpheusStakeFlow | null = null;
  private listeners = new Set<() => void>();
  private working = false;
  private walletPromise: Promise<void> | null = null;
  private readonly key: string;

  constructor(
    readonly account: Address,
    readonly asset: MorpheusAsset,
    private readonly deps: StakeFlowDependencies,
  ) {
    this.key = stakeJournalKey(account, MORPHEUS_POOLS[asset].pool);
    this.reload();
  }

  get isBusy(): boolean {
    return this.working || this.walletPromise !== null;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.listeners.forEach((listener) => listener());
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private reload() {
    const saved = this.deps.storage.getItem(this.key);
    if (!saved) {
      if (this.flow && this.flow.status !== "complete")
        throw new Error("The unresolved stake journal was removed");
      this.flow = null;
      return;
    }
    const flow = journalSchema.parse(JSON.parse(saved));
    if (
      !isAddressEqual(flow.account, this.account) ||
      flow.asset !== this.asset ||
      !isAddressEqual(flow.pool, MORPHEUS_POOLS[this.asset].pool)
    )
      throw new Error("Saved stake attempt does not match this account and pool");
    if (
      (flow.depositConfirmed && flow.step !== "receiver") ||
      (!flow.depositConfirmed && flow.step === "receiver") ||
      (flow.status === "complete" && !flow.depositConfirmed) ||
      (flow.depositConfirmed && !flow.hashes.deposit && !flow.recoveryOnly)
    )
      throw new Error("Saved stake attempt has inconsistent confirmation state");
    this.flow = flow;
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = journalLocks.get(this.key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => {
        const run = async () => {
          this.reload();
          return action();
        };
        return this.deps.lock ? this.deps.lock(this.key, run) : run();
      });
    journalLocks.set(this.key, task);
    try {
      return await task;
    } finally {
      if (journalLocks.get(this.key) === task) journalLocks.delete(this.key);
    }
  }

  private save(flow: MorpheusStakeFlow) {
    this.flow = { ...flow, updatedAt: this.now() };
    try {
      this.deps.storage.setItem(this.key, JSON.stringify(this.flow));
    } catch {
      this.notify();
      throw new Error(
        "Unable to persist this stake attempt. No new transaction can be started safely.",
      );
    }
    this.notify();
  }
  private update(patch: Partial<MorpheusStakeFlow>) {
    if (this.flow) this.save({ ...this.flow, ...patch });
  }
  private async run(action: () => Promise<void>) {
    if (this.working) return;
    this.working = true;
    this.notify();
    try {
      await action();
    } finally {
      this.working = false;
      this.notify();
    }
  }

  private newFlow(intent: StakeIntent, patch: Partial<MorpheusStakeFlow> = {}) {
    return journalSchema.parse({
      ...intent,
      version: 1,
      chainId: 1,
      id: `${this.now()}:${crypto.randomUUID()}`,
      step: "approval",
      status: "ready",
      hashes: {},
      previousHashes: [],
      depositConfirmed: false,
      recoveryAvailable: false,
      retryable: false,
      createdAt: this.now(),
      updatedAt: this.now(),
      ...patch,
    });
  }
  private saveRecovery(intent: StakeIntent, position: StakePosition) {
    this.save(
      this.newFlow(
        {
          ...intent,
          amount: formatUnits(position.deposited, MORPHEUS_POOLS[intent.asset].decimals),
          amountRaw: position.deposited.toString(),
          claimLockEnd: position.claimLockEnd ?? 0,
        },
        { step: "receiver", depositConfirmed: true, recoveryAvailable: true, recoveryOnly: true },
      ),
    );
  }

  async start(intent: StakeIntent): Promise<void> {
    if (this.isBusy) return;
    await this.run(() =>
      this.locked(async () => {
        if (this.flow) throw new Error("Resolve the saved attempt before starting another deposit");
        if (
          !isAddressEqual(intent.account, this.account) ||
          intent.asset !== this.asset ||
          !isAddressEqual(intent.pool, MORPHEUS_POOLS[this.asset].pool)
        )
          throw new Error("Stake intent does not match the signer");
        await this.deps.validateIntent(intent);
        const position = await this.deps.position(intent);
        if (position.deposited > 0n) {
          if (!isAddressEqual(position.referrer, intent.athlete))
            throw new Error("This pool position belongs to another rider");
          if (!isAddressEqual(position.receiver, intent.expectedReceiver)) {
            this.saveRecovery(intent, position);
            return;
          }
        }
        const startedBlock = (await this.deps.snapshotBlock()).toString();
        this.save(this.newFlow(intent, { startedBlock }));
      }),
    );
    if (!this.flow?.recoveryAvailable) await this.continueFlow();
  }

  async discoverRecovery(intent: StakeIntent): Promise<void> {
    if (this.isBusy) return;
    await this.run(() =>
      this.locked(async () => {
        if (this.flow) return;
        await this.deps.validateIntent(intent);
        const position = await this.deps.position(intent);
        if (
          position.deposited > 0n &&
          isAddressEqual(position.referrer, intent.athlete) &&
          !isAddressEqual(position.receiver, intent.expectedReceiver)
        )
          this.saveRecovery(intent, position);
      }),
    );
  }

  async clearCompleted(): Promise<void> {
    if (this.isBusy) throw new Error("An unresolved stake attempt cannot be cleared");
    await this.locked(async () => {
      if (this.flow?.status !== "complete")
        throw new Error("An unresolved stake attempt cannot be cleared");
      this.deps.storage.removeItem(this.key);
      this.flow = null;
      this.notify();
    });
  }

  async continueFlow(): Promise<void> {
    if (this.isBusy) return;
    await this.run(async () => {
      let pending: Promise<void> | null = null;
      let submitted: MorpheusStakeFlow | null = null;
      await this.locked(async () => {
        const flow = this.flow;
        if (!flow || flow.status === "complete") return;
        if (flow.hashes[flow.step] && !(flow.status === "failed" && flow.retryable)) {
          await this.reconcile();
          return;
        }
        if (flow.status !== "ready" && !(flow.status === "failed" && flow.retryable)) return;
        if (flow.status === "failed") {
          const hash = flow.hashes[flow.step];
          this.update({
            hashes: { ...flow.hashes, [flow.step]: undefined },
            previousHashes: hash ? [...flow.previousHashes, hash] : flow.previousHashes,
            status: "ready",
            error: undefined,
            retryable: false,
          });
        }
        try {
          await this.deps.validateIntent(this.flow!);
          if (
            this.flow!.step === "approval" &&
            (await this.deps.allowance(this.flow!)) >= BigInt(this.flow!.amountRaw)
          )
            this.update({ step: "deposit" });
          if (
            this.flow!.step === "deposit" &&
            (await this.deps.allowance(this.flow!)) < BigInt(this.flow!.amountRaw)
          ) {
            this.update({
              step: "approval",
              hashes: { ...this.flow!.hashes, approval: undefined },
            });
            return;
          }
          if (this.flow!.step === "receiver") {
            const position = await this.deps.position(this.flow!);
            if (position.deposited <= 0n || !isAddressEqual(position.referrer, this.flow!.athlete))
              throw new Error("The existing position does not match this rider");
            if (isAddressEqual(position.receiver, this.flow!.expectedReceiver)) {
              this.update({ status: "complete", error: undefined });
              return;
            }
          }
        } catch (error) {
          this.update({
            status: "failed",
            retryable: true,
            error: error instanceof Error ? error.message : "Position read failed",
          });
          return;
        }
        submitted = this.flow!;
        // Persist the barrier while holding the cross-tab lock, before invoking
        // the wallet. Never hold that lock while waiting for the wallet response.
        pending = this.beginSignature();
      });
      if (pending && submitted) await this.waitForWallet(pending, submitted);
    });
  }

  private beginSignature(): Promise<void> {
    const intent = this.flow!;
    const step = intent.step;
    let returnedHash: Hex | undefined;
    this.update({ status: "wallet", error: undefined, retryable: false, recoveryAvailable: false });
    const pending = Promise.resolve()
      .then(() => this.deps.send(step, intent))
      .then((hash) => {
        returnedHash = hashSchema.parse(hash) as Hex;
        return this.locked(async () => {
          hashSchema.parse(hash);
          if (this.flow?.id !== intent.id) return;
          const attached = this.flow.hashes[step];
          if (attached && attached.toLowerCase() !== hash.toLowerCase()) {
            this.update({
              previousHashes: [...this.flow.previousHashes, hash],
              status: "unknown",
              retryable: false,
              error:
                "The wallet returned a different transaction from the attached hash. Check both transactions before continuing.",
            });
            return;
          }
          this.update({
            hashes: { ...this.flow.hashes, [step]: hash },
            ...(this.flow.step === step ? { status: "confirming" as const, error: undefined } : {}),
          });
          await this.reconcile();
        });
      })
      .catch((error) =>
        this.locked(async () => {
          if (
            this.flow?.id !== intent.id ||
            this.flow.step !== step ||
            this.flow.status === "complete"
          )
            return;
          if (returnedHash && !this.flow.hashes[step]) {
            this.update({ hashes: { ...this.flow.hashes, [step]: returnedHash } });
          }
          if (this.flow.hashes[step]) {
            await this.reconcile();
            return;
          }
          const notSent = error instanceof StakeNotSentError;
          this.update({
            status: notSent ? "failed" : "unknown",
            retryable: notSent,
            error: error instanceof Error ? error.message : "Wallet response unknown",
          });
        }),
      )
      .catch((error) => {
        // A storage failure still leaves the broadcast barrier in the last saved
        // journal. Keep any late hash visible in memory and refuse new sends.
        if (this.flow)
          this.flow = {
            ...this.flow,
            hashes: returnedHash ? { ...this.flow.hashes, [step]: returnedHash } : this.flow.hashes,
            status: "unknown",
            retryable: false,
            error: error instanceof Error ? error.message : "Unable to save wallet result",
          };
        this.notify();
      })
      .finally(() => {
        this.walletPromise = null;
        this.notify();
      });
    this.walletPromise = pending;
    return pending;
  }

  private async waitForWallet(pending: Promise<void>, intent: MorpheusStakeFlow) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          void this.locked(async () => {
            if (
              this.flow?.id !== intent.id ||
              this.flow.step !== intent.step ||
              this.flow.status === "complete"
            )
              return;
            this.update(
              this.flow.hashes[intent.step]
                ? {
                    status: "pending",
                    retryable: false,
                    error: "Transaction confirmation is still pending",
                  }
                : {
                    status: "unknown",
                    retryable: false,
                    error:
                      "The wallet has not returned a transaction hash. Check the existing request; do not submit another deposit.",
                  },
            );
          })
            .catch(() => {})
            .finally(resolve);
        }, this.deps.walletTimeoutMs ?? 45_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private verify(
    flow: MorpheusStakeFlow,
    step: StakeStep,
    tx: StakeTransaction,
    receipt?: StakeReceipt,
  ) {
    if (flow.startedBlock && tx.blockNumber != null && tx.blockNumber <= BigInt(flow.startedBlock))
      throw new Error("Transaction predates this stake attempt");
    return verifyStakeTransaction(flow, step, tx, receipt);
  }

  /** Called only while the journal lock is held. */
  private async reconcile(): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.status === "complete") return;
    const step = flow.step;
    const hash = flow.hashes[step];
    try {
      await this.deps.validateIntent(flow);
      if (!hash) {
        if (flow.status === "wallet" && !this.walletPromise)
          this.update({
            status: "unknown",
            retryable: false,
            error: "The previous wallet response was interrupted. Check the existing transaction.",
          });
        if (
          step === "approval" &&
          flow.status !== "wallet" &&
          (await this.deps.allowance(flow)) >= BigInt(flow.amountRaw)
        )
          this.update({ step: "deposit", status: "ready", error: undefined });
        if (
          step === "receiver" &&
          isAddressEqual((await this.deps.position(flow)).receiver, flow.expectedReceiver)
        )
          this.update({ status: "complete", error: undefined });
        return;
      }
      const [tx, receipt] = await Promise.all([
        this.deps.transaction(hash),
        this.deps.receipt(hash),
      ]);
      if (!tx) {
        this.update({ status: "pending", retryable: false });
        return;
      }
      this.verify(flow, step, tx);
      if (!receipt) {
        this.update({ status: "pending", retryable: false });
        return;
      }
      if (!this.verify(flow, step, tx, receipt)) {
        this.update({
          status: "failed",
          retryable: true,
          error: "The transaction reverted. Previous confirmed steps are preserved.",
        });
        return;
      }
      if (step === "approval") {
        if ((await this.deps.allowance(flow)) < BigInt(flow.amountRaw)) {
          this.update({ status: "pending", error: "Waiting for the confirmed allowance" });
          return;
        }
        this.update({ step: "deposit", status: "ready", retryable: false, error: undefined });
      } else if (step === "deposit") {
        this.update({
          step: "receiver",
          status: "ready",
          depositConfirmed: true,
          retryable: false,
          error: undefined,
        });
        if (isAddressEqual((await this.deps.position(flow)).receiver, flow.expectedReceiver))
          this.update({ status: "complete" });
      } else if (isAddressEqual((await this.deps.position(flow)).receiver, flow.expectedReceiver))
        this.update({ status: "complete", retryable: false, error: undefined });
      else this.update({ status: "pending", error: "Waiting for the confirmed claim receiver" });
    } catch (error) {
      this.update({
        status: this.flow?.step !== step ? "ready" : hash ? "pending" : this.flow!.status,
        retryable: false,
        error: error instanceof Error ? error.message : "Transaction status unavailable",
      });
    }
  }

  async checkStatus(): Promise<void> {
    await this.run(() => this.locked(() => this.reconcile()));
  }

  async attachHash(hash: Hex): Promise<void> {
    if (this.working) throw new Error("Wait for the current status check to finish");
    hashSchema.parse(hash);
    await this.run(() =>
      this.locked(async () => {
        const flow = this.flow;
        if (!flow || flow.status === "complete") throw new Error("No unresolved stake attempt");
        await this.deps.validateIntent(flow);
        const tx = await this.deps.transaction(hash);
        if (!tx) throw new Error("Transaction not found on Ethereum");
        if (!flow.startedBlock && !flow.recoveryOnly)
          throw new Error("This journal has no transaction time boundary");
        this.verify(flow, flow.step, tx);
        const existing = flow.hashes[flow.step];
        if (existing && existing.toLowerCase() !== hash.toLowerCase() && !flow.retryable)
          throw new Error("This step already has an unresolved transaction");
        this.update({
          hashes: { ...flow.hashes, [flow.step]: hash },
          status: "confirming",
          error: undefined,
          retryable: false,
        });
        await this.reconcile();
      }),
    );
  }
}
