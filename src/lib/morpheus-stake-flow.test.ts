import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { entryPoint06Abi } from "viem/account-abstraction";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MORPHEUS_POOLS } from "./morpheus";
import {
  MorpheusStakeController,
  stakeCall,
  stakeJournalKey,
  StakeNotSentError,
  verifyStakeTransaction,
  type StakeFlowDependencies,
  type StakeIntent,
  type StakePosition,
  type StakeReceipt,
  type StakeStep,
  type StakeTransaction,
} from "./morpheus-stake-flow";

const account = "0x1111111111111111111111111111111111111111" as Address;
const athlete = "0x2222222222222222222222222222222222222222" as Address;
const receiver = "0x3333333333333333333333333333333333333333" as Address;
const intent: StakeIntent = {
  account,
  athlete,
  asset: "usdc",
  pool: MORPHEUS_POOLS.usdc.pool,
  amount: "1",
  amountRaw: "1000000",
  claimLockEnd: 0,
  expectedReceiver: receiver,
};
const hashFor = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function fixture() {
  const saved = new Map<string, string>();
  const transactions = new Map<Hex, StakeTransaction>();
  const receipts = new Map<Hex, StakeReceipt>();
  let allowance = 0n;
  let position: StakePosition = { deposited: 0n, referrer: athlete, receiver: zeroAddress };
  let sequence = 0;
  const register = (step: StakeStep, flow = intent) => {
    const hash = hashFor(++sequence);
    const call = stakeCall(flow, step);
    transactions.set(hash, {
      chainId: 1,
      from: account,
      to: call.to,
      input: call.data,
      value: 0n,
      blockNumber: 101n,
    });
    return hash;
  };
  const deps: StakeFlowDependencies = {
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: vi.fn((key, value) => {
        saved.set(key, value);
      }),
      removeItem: (key) => {
        saved.delete(key);
      },
    },
    allowance: vi.fn(async () => allowance),
    position: vi.fn(async () => position),
    transaction: vi.fn(async (hash) => transactions.get(hash) ?? null),
    receipt: vi.fn(async (hash) => receipts.get(hash) ?? null),
    validateIntent: vi.fn(async () => {}),
    snapshotBlock: async () => 100n,
    send: vi.fn(async (step, flow) => register(step, flow)),
    walletTimeoutMs: 10,
  };
  const controller = new MorpheusStakeController(account, "usdc", deps);
  const mine = (step: StakeStep, status: "success" | "reverted" = "success") => {
    const hash = controller.flow!.hashes[step]!;
    receipts.set(hash, { status, logs: [] });
    if (status === "success") {
      if (step === "approval") allowance = 1000000n;
      if (step === "deposit") position = { ...position, deposited: 1000000n };
      if (step === "receiver") position = { ...position, receiver };
    }
  };
  return {
    deps,
    controller,
    saved,
    transactions,
    receipts,
    register,
    mine,
    setAllowance: (value: bigint) => {
      allowance = value;
    },
    setPosition: (value: StakePosition) => {
      position = value;
    },
    reload: () => new MorpheusStakeController(account, "usdc", deps),
  };
}

afterEach(() => vi.useRealTimers());

describe("Morpheus stake journal", () => {
  it("recognizes a reverted AA bundle without requiring a missing operation event", () => {
    const call = stakeCall(intent, "deposit");
    const callData = encodeFunctionData({
      abi: parseAbi(["function execute(address target,uint256 value,bytes data)"]),
      functionName: "execute",
      args: [call.to, 0n, call.data],
    });
    const input = encodeFunctionData({
      abi: entryPoint06Abi,
      functionName: "handleOps",
      args: [
        [
          {
            sender: account,
            nonce: 0n,
            initCode: "0x",
            callData,
            callGasLimit: 100000n,
            verificationGasLimit: 100000n,
            preVerificationGas: 10000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            paymasterAndData: "0x",
            signature: "0x",
          },
        ],
        receiver,
      ],
    });
    expect(
      verifyStakeTransaction(
        intent,
        "deposit",
        {
          chainId: 1,
          from: athlete,
          to: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
          input,
          value: 0n,
        },
        { status: "reverted", logs: [] },
      ),
    ).toBe(false);
  });
  it("advances three explicit steps and only completes after checking the receiver", async () => {
    const f = fixture();
    await f.controller.start(intent);
    expect(f.controller.flow).toMatchObject({ step: "approval", status: "pending" });
    f.mine("approval");
    await f.controller.checkStatus();
    expect(f.controller.flow?.step).toBe("deposit");
    await f.controller.continueFlow();
    f.mine("deposit");
    await f.controller.checkStatus();
    expect(f.controller.flow).toMatchObject({
      step: "receiver",
      depositConfirmed: true,
      status: "ready",
    });
    await f.controller.continueFlow();
    expect(f.controller.flow?.status).toBe("pending");
    f.mine("receiver");
    await f.controller.checkStatus();
    expect(f.controller.flow?.status).toBe("complete");
    expect(vi.mocked(f.deps.send).mock.calls.map(([step]) => step)).toEqual([
      "approval",
      "deposit",
      "receiver",
    ]);
    await f.controller.clearCompleted();
    expect(f.saved.size).toBe(0);
  });

  it("never repeats a pending deposit after reload or extra status checks", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    await f.controller.start(intent);
    const reloaded = f.reload();
    await reloaded.continueFlow();
    await reloaded.checkStatus();
    await expect(reloaded.clearCompleted()).rejects.toThrow("unresolved");
    expect(f.deps.send).toHaveBeenCalledTimes(1);
    expect(reloaded.flow).toMatchObject({ status: "pending", depositConfirmed: false });
  });

  it("recovers a funded legacy position without approving or depositing again", async () => {
    const f = fixture();
    f.setPosition({ deposited: 700000n, referrer: athlete, receiver: zeroAddress });
    await f.controller.start(intent);
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(f.controller.flow).toMatchObject({
      amount: "0.7",
      step: "receiver",
      recoveryAvailable: true,
      depositConfirmed: true,
    });
    await f.controller.continueFlow();
    expect(f.deps.send).toHaveBeenCalledWith("receiver", expect.anything());
    expect(f.controller.flow?.recoveryAvailable).toBe(false);
    expect(f.reload().flow?.depositConfirmed).toBe(true);
  });

  it("blocks a funded position belonging to a different rider before any wallet request", async () => {
    const f = fixture();
    f.setPosition({ deposited: 1n, referrer: receiver, receiver });
    await expect(f.controller.start(intent)).rejects.toThrow("another rider");
    expect(f.deps.send).not.toHaveBeenCalled();
  });

  it("does not use an existing balance as proof that a new top-up succeeded", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    f.setPosition({ deposited: 1000000n, referrer: athlete, receiver });
    await f.controller.start(intent);
    await f.controller.checkStatus();
    expect(f.controller.flow).toMatchObject({ step: "deposit", depositConfirmed: false });
  });

  it("preserves confirmed deposits after receiver reverts and only retries the receiver", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    await f.controller.start(intent);
    f.mine("deposit");
    await f.controller.checkStatus();
    await f.controller.continueFlow();
    f.mine("receiver", "reverted");
    await f.controller.checkStatus();
    expect(f.controller.flow).toMatchObject({
      status: "failed",
      retryable: true,
      depositConfirmed: true,
    });
    await f.controller.continueFlow();
    expect(vi.mocked(f.deps.send).mock.calls.map(([step]) => step)).toEqual([
      "deposit",
      "receiver",
      "receiver",
    ]);
  });

  it("keeps receiver continuation available if the post-deposit position read fails", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    await f.controller.start(intent);
    f.mine("deposit");
    vi.mocked(f.deps.position).mockRejectedValueOnce(new Error("RPC unavailable"));
    await f.controller.checkStatus();
    expect(f.controller.flow).toMatchObject({
      step: "receiver",
      status: "ready",
      depositConfirmed: true,
    });
    await f.controller.continueFlow();
    expect(f.deps.send).toHaveBeenLastCalledWith("receiver", expect.anything());
  });

  it("serializes two hydrated controllers attempting the same ready deposit", async () => {
    const f = fixture();
    await f.controller.start(intent);
    f.mine("approval");
    await f.controller.checkStatus();
    const other = f.reload();
    await Promise.all([f.controller.continueFlow(), other.continueFlow()]);
    expect(vi.mocked(f.deps.send).mock.calls.filter(([step]) => step === "deposit")).toHaveLength(
      1,
    );
  });

  it("keeps a timed-out wallet request locked and captures its late hash", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAllowance(1000000n);
    let resolve!: (hash: Hex) => void;
    vi.mocked(f.deps.send).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = f.controller.start(intent);
    await vi.advanceTimersByTimeAsync(20);
    await start;
    expect(f.controller.flow?.status).toBe("unknown");
    expect(f.controller.isBusy).toBe(true);
    await f.controller.continueFlow();
    expect(f.deps.send).toHaveBeenCalledTimes(1);
    const hash = f.register("deposit");
    resolve(hash);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reload().flow?.hashes.deposit).toBe(hash);
    expect(f.controller.isBusy).toBe(false);
  });

  it("preserves a cross-controller attached pending hash when the old wallet later rejects", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAllowance(1000000n);
    let reject!: (error: Error) => void;
    vi.mocked(f.deps.send).mockImplementation(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const start = f.controller.start(intent);
    await vi.advanceTimersByTimeAsync(20);
    await start;
    const other = f.reload();
    const hash = f.register("deposit");
    await other.attachHash(hash);
    reject(new StakeNotSentError("cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.continueFlow();
    expect(f.controller.flow).toMatchObject({
      status: "pending",
      retryable: false,
      hashes: { deposit: hash },
    });
    expect(f.deps.send).toHaveBeenCalledTimes(1);
  });

  it("does not demote a confirmed attached deposit when the old wallet rejects", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAllowance(1000000n);
    let reject!: (error: Error) => void;
    vi.mocked(f.deps.send).mockImplementation(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    const start = f.controller.start(intent);
    await vi.advanceTimersByTimeAsync(20);
    await start;
    const hash = f.register("deposit");
    f.receipts.set(hash, { status: "success", logs: [] });
    await f.controller.attachHash(hash);
    reject(new StakeNotSentError("cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.flow).toMatchObject({
      step: "receiver",
      status: "ready",
      depositConfirmed: true,
    });
  });

  it("rejects an old identical transaction as evidence for a new attempt", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    vi.mocked(f.deps.send).mockRejectedValueOnce(new Error("response lost"));
    await f.controller.start(intent);
    const hash = f.register("deposit");
    f.transactions.get(hash)!.blockNumber = 100n;
    await expect(f.controller.attachHash(hash)).rejects.toThrow("predates");
    expect(f.controller.flow?.depositConfirmed).toBe(false);
  });

  it("fails closed on preflight read errors", async () => {
    const f = fixture();
    vi.mocked(f.deps.position).mockRejectedValue(new Error("RPC down"));
    await expect(f.controller.start(intent)).rejects.toThrow("RPC down");
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(f.saved.size).toBe(0);
  });

  it("does not request a wallet signature if the journal cannot be saved", async () => {
    const f = fixture();
    vi.mocked(f.deps.storage.setItem).mockImplementation(() => {
      throw new Error("quota");
    });
    await expect(f.controller.start(intent)).rejects.toThrow("persist");
    expect(f.deps.send).not.toHaveBeenCalled();
  });

  it("retains the returned hash in memory if storage fails after broadcast", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    const hash = f.register("deposit");
    vi.mocked(f.deps.send).mockImplementation(async () => {
      vi.mocked(f.deps.storage.setItem).mockImplementation(() => {
        throw new Error("quota");
      });
      return hash;
    });
    await f.controller.start(intent);
    expect(f.controller.flow).toMatchObject({
      status: "unknown",
      retryable: false,
      hashes: { deposit: hash },
    });
    await f.controller.continueFlow();
    expect(f.deps.send).toHaveBeenCalledTimes(1);
  });

  it("rejects impossible saved confirmation states", async () => {
    const f = fixture();
    f.setAllowance(1000000n);
    await f.controller.start(intent);
    const key = stakeJournalKey(account, intent.pool);
    f.saved.set(key, JSON.stringify({ ...f.controller.flow, depositConfirmed: true }));
    expect(() => f.reload()).toThrow("inconsistent");
  });

  it.each(["account", "chain", "amount", "receiver"])(
    "binds transaction identity to the intended %s",
    (field) => {
      const f = fixture();
      const step = field === "receiver" ? "receiver" : "deposit";
      const hash = f.register(step);
      const tx = f.transactions.get(hash)!;
      if (field === "account") tx.from = receiver;
      if (field === "chain") tx.chainId = 8453;
      if (field === "amount") tx.input = stakeCall({ ...intent, amountRaw: "2" }, step).data;
      if (field === "receiver")
        tx.input = stakeCall({ ...intent, expectedReceiver: athlete }, step).data;
      expect(() => verifyStakeTransaction(intent, step, tx)).toThrow();
    },
  );
});
