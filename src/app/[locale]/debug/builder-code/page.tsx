"use client";

import { useCallback, useEffect, useState } from "react";
import {
  encode,
  getContract,
  prepareContractCall,
  prepareTransaction,
  sendTransaction,
  waitForReceipt,
  type PreparedTransaction,
} from "thirdweb";
import { base } from "thirdweb/chains";
import { isAddress, type Address, type Hex } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUserAddress } from "@/hooks/use-user-address";
import { useWriteAccount } from "@/hooks/use-write-account";
import { withBuilderCode } from "@/lib/builder-code";
import {
  BUILDER_CODE,
  BUILDER_CODE_SUFFIX,
  DAO_ADDRESSES,
  TREASURY_TOKEN_ALLOWLIST,
} from "@/lib/config";
import { getThirdwebClient } from "@/lib/thirdweb";
import { ensureOnChain, normalizeTxError } from "@/lib/thirdweb-tx";

const CHECKER_URL = "https://builder-code-checker.vercel.app/";
const SUFFIX_BYTES = (BUILDER_CODE_SUFFIX.length - 2) / 2;

type TxBuilder = (ctx: {
  client: NonNullable<ReturnType<typeof getThirdwebClient>>;
  address: Address;
  input: string;
}) => PreparedTransaction;

interface TestDef {
  id: string;
  title: string;
  /** Why this shape is worth testing, not what the call does. */
  rationale: string;
  /** What it costs you beyond gas. */
  effect: string;
  input?: { label: string; placeholder: string; defaultToSelf?: boolean };
  build: TxBuilder;
}

const TESTS: TestDef[] = [
  {
    id: "raw-eth",
    title: "ETH cru — 0 wei para você mesmo",
    rationale:
      "prepareTransaction sem ABI. O caso mais simples que existe: se o sufixo quebrar aqui, quebra em tudo.",
    effect: "Nada. Você manda 0 wei para o seu próprio endereço.",
    build: ({ client, address }) =>
      prepareTransaction({ chain: base, client, to: address, value: 0n }),
  },
  {
    id: "erc20-approve",
    title: "USDC — approve(você, 0)",
    rationale:
      "Contract call com argumentos ABI-encodados. É a forma da grande maioria das escritas do app.",
    effect: "Zera uma allowance que já é zero. Nenhum gasto além do gas.",
    build: ({ client, address }) =>
      prepareContractCall({
        contract: getContract({ client, chain: base, address: TREASURY_TOKEN_ALLOWLIST.USDC }),
        method: "function approve(address spender, uint256 amount)",
        params: [address, 0n],
      }),
  },
  {
    id: "no-arg",
    title: "WETH — deposit() com 0 wei",
    rationale:
      "Função SEM argumentos: o calldata é só o selector de 4 bytes. É onde bytes extras têm mais chance de confundir o decode do contrato.",
    effect: "Deposita 0 ETH, recebe 0 WETH. Inócuo.",
    build: ({ client }) =>
      prepareContractCall({
        contract: getContract({ client, chain: base, address: TREASURY_TOKEN_ALLOWLIST.WETH }),
        method: "function deposit()",
        params: [],
        value: 0n,
      }),
  },
  {
    id: "delegate",
    title: "Gnars token — delegate(endereço)",
    rationale:
      "Escrita real de governança no contrato do DAO. É a que importa para saber se atribuição funciona onde tem valor de verdade.",
    effect:
      "MUDA ESTADO: reaponta seu poder de voto. Preencha com o seu delegate atual (ou o seu próprio endereço) para que não mude nada de fato.",
    input: { label: "Delegatee", placeholder: "0x…", defaultToSelf: true },
    build: ({ client, input }) =>
      prepareContractCall({
        contract: getContract({ client, chain: base, address: DAO_ADDRESSES.token }),
        method: "function delegate(address delegatee)",
        params: [input as Address],
      }),
  },
];

export default function BuilderCodeDebugPage() {
  const [withCode, setWithCode] = useState(true);
  const { address, saAddress, adminAddress, viewMode, isConnected } = useUserAddress();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">Builder Code — banco de testes</h1>
        <p className="text-sm text-muted-foreground">
          Manda transações reais na Base com o sufixo ERC-8021 anexado ao calldata, para conferir
          quais formas de chamada aceitam os bytes extras e se a Base credita a atribuição.
        </p>
        <div className="rounded-md border p-3 text-xs font-mono space-y-1 break-all">
          <div>
            code <span className="text-muted-foreground">{BUILDER_CODE}</span>
          </div>
          <div>
            suffix <span className="text-muted-foreground">{BUILDER_CODE_SUFFIX}</span>{" "}
            <span className="text-muted-foreground">({SUFFIX_BYTES} bytes)</span>
          </div>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Modo de assinatura</CardTitle>
          <CardDescription>
            Rode cada teste nos dois modos. Em <strong>SA</strong> a chamada vai embrulhada num
            userop, então o sufixo cai no calldata interno do <code>execute()</code> — se a Base não
            creditar nesse modo, é o achado mais importante desta página.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={viewMode === "eoa" ? "default" : "secondary"}>
              view atual: {viewMode.toUpperCase()}
            </Badge>
            {!isConnected && <span className="text-destructive">carteira desconectada</span>}
          </div>
          <div className="font-mono text-xs text-muted-foreground break-all">
            <div>assinando como: {address ?? "—"}</div>
            <div>SA: {saAddress ?? "—"}</div>
            <div>EOA admin: {adminAddress ?? "—"}</div>
          </div>
          <p className="text-xs text-muted-foreground">
            Troque de modo no WalletDrawer (não dá para trocar daqui).
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 rounded-md border p-3">
        <Switch id="with-code" checked={withCode} onCheckedChange={setWithCode} />
        <Label htmlFor="with-code" className="text-sm">
          Anexar o sufixo do builder code
        </Label>
        <span className="ml-auto text-xs text-muted-foreground">
          desligue para mandar a mesma tx sem atribuição e comparar
        </span>
      </div>

      <div className="space-y-4">
        {TESTS.map((test) => (
          <TestCard key={test.id} test={test} withCode={withCode} />
        ))}
      </div>

      <footer className="text-xs text-muted-foreground">
        Depois de mandar, confira em{" "}
        <a className="underline" href={CHECKER_URL} target="_blank" rel="noreferrer">
          builder-code-checker
        </a>{" "}
        e no dashboard da Base.
      </footer>
    </div>
  );
}

function TestCard({ test, withCode }: { test: TestDef; withCode: boolean }) {
  const writer = useWriteAccount();
  const { address } = useUserAddress();
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [previewError, setPreviewError] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const [hash, setHash] = useState<Hex | undefined>();
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    if (test.input?.defaultToSelf && address && !input) setInput(address);
  }, [address, input, test.input?.defaultToSelf]);

  const build = useCallback((): PreparedTransaction | undefined => {
    const client = getThirdwebClient();
    if (!client || !address) return undefined;
    if (test.input && !isAddress(input)) return undefined;
    const tx = test.build({ client, address, input });
    return withCode ? withBuilderCode(tx) : tx;
  }, [address, input, test, withCode]);

  useEffect(() => {
    let cancelled = false;
    const tx = build();
    if (!tx) {
      setPreview("");
      return;
    }
    encode(tx)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
          setPreviewError("");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview("");
          setPreviewError(normalizeTxError(err).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [build]);

  const send = useCallback(async () => {
    const client = getThirdwebClient();
    const tx = build();
    if (!client || !writer || !tx) return;

    setIsSending(true);
    setHash(undefined);
    setStatus("aguardando assinatura…");
    try {
      await ensureOnChain(writer.wallet, base);
      const result = await sendTransaction({ account: writer.account, transaction: tx });
      const txHash = result.transactionHash as Hex;
      setHash(txHash);
      setStatus("enviada, aguardando confirmação…");
      const receipt = await waitForReceipt({ client, chain: base, transactionHash: txHash });
      setStatus(receipt.status === "success" ? "confirmada ✅" : "revertida ❌");
    } catch (err) {
      setStatus(`falhou: ${normalizeTxError(err).message}`);
    } finally {
      setIsSending(false);
    }
  }, [build, writer]);

  const suffixVisible =
    withCode && preview.toLowerCase().endsWith(BUILDER_CODE_SUFFIX.slice(2).toLowerCase());
  const body = suffixVisible
    ? preview.slice(0, preview.length - (BUILDER_CODE_SUFFIX.length - 2))
    : preview;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{test.title}</CardTitle>
        <CardDescription>{test.rationale}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{test.effect}</p>

        {test.input && (
          <div className="space-y-1">
            <Label htmlFor={`${test.id}-input`} className="text-xs">
              {test.input.label}
            </Label>
            <Input
              id={`${test.id}-input`}
              value={input}
              placeholder={test.input.placeholder}
              onChange={(e) => setInput(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">calldata que vai ser assinado</div>
          <div className="rounded-md border bg-muted/40 p-2 font-mono text-[11px] break-all">
            {previewError ? (
              <span className="text-destructive">{previewError}</span>
            ) : preview ? (
              <>
                <span>{body}</span>
                {suffixVisible && (
                  <span className="bg-yellow-300/40 dark:bg-yellow-500/30">
                    {preview.slice(body.length)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">
                {test.input && !isAddress(input)
                  ? "preencha um endereço válido"
                  : "conecte a carteira"}
              </span>
            )}
          </div>
          {preview && (
            <div className="text-[11px] text-muted-foreground">
              {(preview.length - 2) / 2} bytes
              {suffixVisible && ` — os últimos ${SUFFIX_BYTES} são o builder code (destacados)`}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={send} disabled={isSending || !preview || !writer} size="sm">
            {isSending ? "enviando…" : "Enviar"}
          </Button>
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
        </div>

        {hash && (
          <div className="text-xs font-mono break-all">
            <a
              className="underline"
              href={`https://basescan.org/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              {hash}
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
