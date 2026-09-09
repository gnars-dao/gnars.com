"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Fuel, Loader2, Rocket, ShieldAlert } from "lucide-react";
import { sendTransaction } from "thirdweb";
import { base } from "thirdweb/chains";
import { concatHex, formatEther, isAddress, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/ui/ConnectButton";
import { Input } from "@/components/ui/input";
import { useWriteAccount } from "@/hooks/use-write-account";
import { prepareTransaction } from "@/lib/builder-code";
import { BUILDER_CODE, BUILDER_CODE_SUFFIX } from "@/lib/config";
import { canOriginateNftDeployment, isNftWalletRejection } from "@/lib/create-nft-deployment";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain } from "@/lib/thirdweb-tx";

const KEY = "gnars:community-nft-deployment:8453:v1";
type Attempt = { account: Address; royaltyBps: number; hash?: Hex; address?: Address };
type Prepared = {
  data: Hex;
  checksum: string;
  recipient: Address;
  royaltyBps: number;
  gas: bigint;
  cost: bigint;
  account: Address;
  preparedAt: number;
};

export function LocalNftDeploy() {
  const t = useTranslations("createNft");
  const writer = useWriteAccount();
  const writerRef = useRef(writer);
  useLayoutEffect(() => {
    writerRef.current = writer;
  }, [writer]);
  const client = usePublicClient({ chainId: 8453 });
  const [bps, setBps] = useState("");
  const [prepared, setPrepared] = useState<Prepared>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [hash, setHash] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    const restore = () => {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const value = JSON.parse(raw) as Attempt;
          if (
            !isAddress(value.account) ||
            !Number.isInteger(value.royaltyBps) ||
            value.royaltyBps < 1 ||
            value.royaltyBps > 10000 ||
            (value.hash && !/^0x[0-9a-f]{64}$/i.test(value.hash)) ||
            (value.address && !isAddress(value.address))
          )
            throw new Error();
          setAttempt(value);
          setBps(String(value.royaltyBps));
          setHash(value.hash ?? "");
        }
        setStorageReady(Boolean(navigator.locks));
      } catch {
        setError("storageError");
      }
    };
    restore();
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, []);
  function save(value: Attempt) {
    localStorage.setItem(KEY, JSON.stringify(value));
    setAttempt(value);
  }
  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(
        cause instanceof Error &&
          ["deployEoa", "deployUnknown", "accountChanged", "deployPending"].includes(cause.message)
          ? cause.message
          : "failed",
      );
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  function signer() {
    const current = writerRef.current;
    if (
      !current ||
      current.wallet.id === "smart" ||
      current.wallet.id === "inApp" ||
      current.wallet.getAccount()?.address.toLowerCase() !== current.account.address.toLowerCase()
    )
      throw new Error("deployEoa");
    return current;
  }
  async function prepare() {
    setPrepared(undefined);
    setAck(false);
    const current = signer();
    if (!client || localStorage.getItem(KEY)) throw new Error("deployPending");
    if (
      !canOriginateNftDeployment(
        await client.getCode({ address: current.account.address as Address }),
      )
    )
      throw new Error("deployEoa");
    const response = await fetch(`/api/local-nft-deploy?royaltyBps=${encodeURIComponent(bps)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const artifact = (await response.json()) as Omit<
      Prepared,
      "gas" | "cost" | "account" | "preparedAt"
    >;
    const data = concatHex([artifact.data, BUILDER_CODE_SUFFIX]);
    const gas =
      ((await client.estimateGas({
        account: current.account.address as Address,
        data,
        value: 0n,
      })) *
        120n) /
      100n;
    const price = await client.getGasPrice();
    if (signer().account.address !== current.account.address) throw new Error("accountChanged");
    setPrepared({
      ...artifact,
      gas,
      cost: gas * price,
      account: current.account.address as Address,
      preparedAt: Date.now(),
    });
  }
  async function deploy() {
    if (!prepared || !ack || !client || !storageReady) return;
    await navigator.locks.request(KEY, async () => {
      if (localStorage.getItem(KEY)) throw new Error("deployPending");
      const current = signer();
      if (
        current.account.address.toLowerCase() !== prepared.account.toLowerCase() ||
        Date.now() - prepared.preparedAt > 120000 ||
        Number(bps) !== prepared.royaltyBps
      )
        throw new Error("accountChanged");
      if (!canOriginateNftDeployment(await client.getCode({ address: prepared.account })))
        throw new Error("deployEoa");
      await ensureOnChain(current.wallet, base);
      if (signer().account.address !== current.account.address) throw new Error("accountChanged");
      const thirdweb = getThirdwebClient();
      if (!thirdweb) throw new Error();
      const saved: Attempt = { account: prepared.account, royaltyBps: prepared.royaltyBps };
      save(saved);
      try {
        const result = await sendTransaction({
          account: current.account,
          transaction: prepareTransaction({
            client: thirdweb,
            chain: base,
            data: prepared.data,
            value: 0n,
            gas: prepared.gas,
          }),
        });
        save({ ...saved, hash: result.transactionHash });
        setHash(result.transactionHash);
      } catch (cause) {
        if (isNftWalletRejection(cause)) {
          localStorage.removeItem(KEY);
          setAttempt(undefined);
          throw cause;
        }
        throw new Error("deployUnknown");
      }
    });
  }
  async function verify() {
    const account = attempt?.account ?? signer().account.address;
    const response = await fetch("/api/local-nft-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash, account, royaltyBps: attempt?.royaltyBps ?? Number(bps) }),
    });
    if (!response.ok) throw new Error();
    const result = (await response.json()) as { address: Address; hash: Hex; royaltyBps: number };
    if (!isAddress(result.address) || result.hash.toLowerCase() !== hash.toLowerCase())
      throw new Error();
    save({ account: account as Address, ...result });
  }
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{t("localOnly")}</p>
          <h1 className="mt-2 text-3xl font-semibold">{t("deployTitle")}</h1>
        </div>
        <ConnectButton />
      </div>
      <p className="flex gap-3 border-y py-5 text-sm text-amber-500">
        <ShieldAlert className="size-5 shrink-0" />
        {t("deployWarning")}
      </p>
      <div className="space-y-2">
        <label htmlFor="royalty-bps">{t("royaltyBps")}</label>
        <Input
          id="royalty-bps"
          type="number"
          min={1}
          max={10000}
          step={1}
          value={bps}
          disabled={busy || !!attempt}
          onChange={(e) => {
            setBps(e.target.value);
            setPrepared(undefined);
            setAck(false);
          }}
        />
        <p className="text-sm text-muted-foreground">{t("royaltyHelp")}</p>
      </div>
      {!attempt && (
        <Button
          variant="outline"
          onClick={() => void run(prepare)}
          disabled={!writer || busy || !bps || !storageReady}
        >
          <Fuel className="size-4" />
          {t("prepare")}
        </Button>
      )}
      {prepared && !attempt && (
        <section className="space-y-4 border-y py-5 text-sm">
          <p>
            {t("royalty")}: <strong>{prepared.royaltyBps / 100}%</strong>
          </p>
          <p className="break-all">
            {t("recipient")}: {prepared.recipient}
          </p>
          <p>
            {t("estimate")}: {formatEther(prepared.cost)} ETH
          </p>
          <p className="break-all">SHA-256: {prepared.checksum}</p>
          <p>Builder code: {BUILDER_CODE}</p>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              disabled={busy}
              className="mt-1"
            />
            {t("deployAck")}
          </label>
          <Button onClick={() => void run(deploy)} disabled={!ack || busy}>
            <Rocket className="size-4" />
            {t("deploy")}
          </Button>
        </section>
      )}
      {attempt && !attempt.address && (
        <p role="status">{t(attempt.hash ? "deployPending" : "deployUnknown")}</p>
      )}
      <div className="space-y-3 border-t pt-5">
        <label htmlFor="deploy-hash">{t("deployHash")}</label>
        <Input id="deploy-hash" value={hash} onChange={(e) => setHash(e.target.value)} />
        <Button
          onClick={() => void run(verify)}
          disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hash) || !bps}
        >
          {t("verify")}
        </Button>
      </div>
      {attempt?.address && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2">
            <Check className="size-5 text-emerald-500" />
            {t("deployVerified")}
          </h2>
          <p>{t("deployEnv")}</p>
          <code className="block break-all rounded border p-3">
            NEXT_PUBLIC_GNARS_COMMUNITY_NFT_ADDRESS={attempt.address}
          </code>
        </section>
      )}
      {busy && <Loader2 aria-label={t("loading")} className="size-5 animate-spin" />}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
    </main>
  );
}
