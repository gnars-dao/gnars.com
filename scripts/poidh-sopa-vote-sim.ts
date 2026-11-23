/**
 * Read-only lifecycle check for Sopa bounty votes, simulated on Base mainnet state with
 * eth_simulateV1 (nothing is broadcast). Encodes every call with the app's own `sopaCalls`
 * builders, so it tests what the UI would actually send.
 *
 * Covers: close for vote → claims/cancel blocked → vote → +48h resolve → winners withdraw,
 * and end-without-winner → issuer withdraws the refund.
 *
 *   pnpm exec tsx scripts/poidh-sopa-vote-sim.ts
 *   (RPC: SIM_RPC_URL, else Alchemy via ALCHEMY_API_KEY, else https://mainnet.base.org)
 */
import { existsSync } from "node:fs";
import { createThirdwebClient, encode, getContract } from "thirdweb";
import { base as twBase } from "thirdweb/chains";
import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  numberToHex,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { sopaCalls } from "../src/hooks/use-poidh-sopa-write";
import { POIDH_SOPA, SWAP_FEE_SPLIT_RECIPIENT } from "../src/lib/config";
import { POIDH_SOPA_ABI } from "../src/lib/poidh-sopa/abi";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const key = process.env.ALCHEMY_API_KEY;
const rpcUrl =
  process.env.SIM_RPC_URL ??
  (key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : "https://mainnet.base.org");
const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

const SOPA = POIDH_SOPA.address as Address;
const ETH = zeroAddress;
const abi = POIDH_SOPA_ABI;
const contract = getContract({
  client: createThirdwebClient({ clientId: "sim" }),
  chain: twBase,
  address: SOPA,
  abi,
});
const appData = async (build: (c: typeof contract) => unknown) =>
  (await encode(build(contract) as never)) as Hex;
const read = (functionName: string, args: unknown[]) =>
  encodeFunctionData({ abi, functionName, args } as never);

const ISSUER = SWAP_FEE_SPLIT_RECIPIENT as Address; // team wallet
const CLAIMER_A = "0x00000000000000000000000000000000000a11ce" as Address;
const CLAIMER_B = "0x00000000000000000000000000000000000000b0" as Address;
const CLAIMER_C = "0x00000000000000000000000000000000000000c3" as Address;
const LATECOMER = "0x0000000000000000000000000000000000000c0c" as Address;
const ANYONE = "0x000000000000000000000000000000000000d00d" as Address;
const REWARD = parseEther("0.01");

type Call = {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  label: string;
  expect?: string;
};

async function main() {
  const head = await client.getBlock();
  const [bountyCounter, claimCounter, votingPeriod] = (await Promise.all(
    ["bountyCounter", "claimCounter", "votingPeriod"].map((fn) =>
      client.readContract({ address: SOPA, abi, functionName: fn } as never),
    ),
  )) as bigint[];
  const id = Number(bountyCounter); // next bounty id
  const idCancel = id + 1;
  const idExt = id + 2; // open, with an outside contributor
  const idSolo = id + 3;
  const idPay = id + 4; // open, team money only: the picker offers "Pay now" here
  const [c1, c2, cExt, cSolo, cPay] = [0, 1, 2, 3, 4].map((n) => Number(claimCounter) + n);
  console.log(
    `head ${head.number} · next bounty ${id} · next claim ${c1} · votingPeriod ${votingPeriod}s`,
  );

  const create = (kind: "open" | "solo") =>
    appData(
      sopaCalls.createBounty({
        kind,
        token: ETH,
        amount: REWARD,
        title: "sim",
        description: "sim",
        category: "skate",
      }),
    );

  const blocks: { time: bigint; calls: Call[] }[] = [
    {
      time: head.timestamp + 12n,
      calls: [
        {
          label: "create open bounty (team)",
          from: ISSUER,
          to: SOPA,
          data: await create("open"),
          value: REWARD,
        },
        {
          label: "create 2nd open bounty (team)",
          from: ISSUER,
          to: SOPA,
          data: await create("open"),
          value: REWARD,
        },
        {
          label: "claim A",
          from: CLAIMER_A,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(id, "a", "a", "ipfs://a")),
        },
        {
          label: "claim B",
          from: CLAIMER_B,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(id, "b", "b", "ipfs://b")),
        },
        {
          label: "read claims",
          from: ANYONE,
          to: SOPA,
          data: read("getClaimsByBountyId", [BigInt(id), 0n]),
        },
        // Winners picker rule: outside money forces a vote; solo bounties can only pay.
        {
          label: "create open bounty w/ outsider (team)",
          from: ISSUER,
          to: SOPA,
          data: await create("open"),
          value: REWARD,
        },
        {
          label: "create solo bounty (team)",
          from: ISSUER,
          to: SOPA,
          data: await create("solo"),
          value: REWARD,
        },
        {
          label: "claim on outsider bounty",
          from: CLAIMER_C,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(idExt, "x", "x", "ipfs://x")),
        },
        {
          label: "claim on solo bounty",
          from: CLAIMER_C,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(idSolo, "s", "s", "ipfs://s")),
        },
        {
          label: "outsider joins",
          from: LATECOMER,
          to: SOPA,
          data: await appData(sopaCalls.join(idExt, ETH, REWARD)),
          value: REWARD,
        },
        {
          label: "pay directly with outsider money",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.acceptClaims(idExt, [cExt], [10_000])),
          expect: "ANY",
        },
        {
          label: "close for vote with outsider money",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.submitWinnersForVote(idExt, [cExt], [10_000])),
        },
        {
          label: "vote on solo bounty",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.submitWinnersForVote(idSolo, [cSolo], [10_000])),
          expect: "ANY",
        },
        {
          label: "pay solo bounty directly",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.acceptClaims(idSolo, [cSolo], [10_000])),
        },
        {
          label: "create open bounty, team only",
          from: ISSUER,
          to: SOPA,
          data: await create("open"),
          value: REWARD,
        },
        {
          label: "claim on team-only bounty",
          from: CLAIMER_C,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(idPay, "p", "p", "ipfs://p")),
        },
        {
          label: "PAY NOW on open team-only bounty (picker default)",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.acceptClaims(idPay, [cPay], [10_000])),
        },
      ],
    },
    {
      time: head.timestamp + 24n,
      calls: [
        {
          label: "close for vote 60/40",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.submitWinnersForVote(id, [c1, c2], [6000, 4000])),
        },
        {
          label: "new claim during vote",
          from: LATECOMER,
          to: SOPA,
          data: await appData(sopaCalls.createClaim(id, "c", "c", "ipfs://c")),
          expect: "VotingOngoing",
        },
        {
          label: "cancel during vote",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.cancel(id, true)),
          expect: "VotingOngoing",
        },
        {
          label: "join during vote",
          from: LATECOMER,
          to: SOPA,
          data: await appData(sopaCalls.join(id, ETH, REWARD)),
          value: REWARD,
          expect: "VotingOngoing",
        },
        // The issuer's yes is cast by submitWinnersForVote; SopaVotePanel hides the button for them.
        {
          label: "issuer cannot vote twice",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.vote(id, true)),
          expect: "AlreadyVoted",
        },
        {
          label: "resolve before 48h",
          from: ANYONE,
          to: SOPA,
          data: await appData(sopaCalls.resolveVote(id)),
          expect: "VotingOngoing",
        },
        {
          label: "end 2nd bounty without winner",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.cancel(idCancel, true)),
        },
      ],
    },
    {
      time: head.timestamp + 24n + votingPeriod + 1n,
      calls: [
        {
          label: "resolve after 48h (anyone)",
          from: ANYONE,
          to: SOPA,
          data: await appData(sopaCalls.resolveVote(id)),
        },
        {
          label: "pending A",
          from: ANYONE,
          to: SOPA,
          data: read("pendingWithdrawals", [CLAIMER_A, ETH]),
        },
        {
          label: "pending B",
          from: ANYONE,
          to: SOPA,
          data: read("pendingWithdrawals", [CLAIMER_B, ETH]),
        },
        {
          label: "pending issuer (refund)",
          from: ANYONE,
          to: SOPA,
          data: read("pendingWithdrawals", [ISSUER, ETH]),
        },
        { label: "winners", from: ANYONE, to: SOPA, data: read("getWinners", [BigInt(id)]) },
        {
          label: "A withdraws",
          from: CLAIMER_A,
          to: SOPA,
          data: await appData(sopaCalls.withdraw(ETH)),
        },
        {
          label: "B withdraws",
          from: CLAIMER_B,
          to: SOPA,
          data: await appData(sopaCalls.withdraw(ETH)),
        },
        {
          label: "issuer withdraws refund",
          from: ISSUER,
          to: SOPA,
          data: await appData(sopaCalls.withdraw(ETH)),
        },
        {
          label: "A withdraws twice",
          from: CLAIMER_A,
          to: SOPA,
          data: await appData(sopaCalls.withdraw(ETH)),
          expect: "NothingToWithdraw",
        },
        {
          label: "pending A after",
          from: ANYONE,
          to: SOPA,
          data: read("pendingWithdrawals", [CLAIMER_A, ETH]),
        },
      ],
    },
  ];

  const funded = { balance: numberToHex(parseEther("10")) };
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [
      {
        blockStateCalls: blocks.map((b, i) => ({
          blockOverrides: {
            time: numberToHex(b.time),
            number: numberToHex(head.number + BigInt(i + 1)),
          },
          ...(i === 0
            ? {
                stateOverrides: Object.fromEntries(
                  [ISSUER, CLAIMER_A, CLAIMER_B, CLAIMER_C, LATECOMER, ANYONE].map((a) => [
                    a,
                    funded,
                  ]),
                ),
              }
            : {}),
          calls: b.calls.map((c) => ({
            from: c.from,
            to: c.to,
            data: c.data,
            value: numberToHex(c.value ?? 0n),
          })),
        })),
        validation: false,
      },
      numberToHex(head.number), // pin the base block: the simulated blocks follow it
    ] as never,
  })) as {
    calls: { status: Hex; returnData: Hex; error?: { message: string; data?: Hex } }[];
  }[];

  let failures = 0;
  const out: Record<string, unknown> = {};
  res.forEach((blk, i) =>
    blk.calls.forEach((r, j) => {
      const c = blocks[i].calls[j];
      const ok = r.status === "0x1";
      let why = "";
      if (!ok) {
        try {
          const data = r.error?.data ?? r.returnData;
          why = decodeErrorResult({ abi, data }).errorName;
        } catch {
          why = r.error?.message ?? r.returnData;
        }
      }
      const pass = c.expect ? !ok && (c.expect === "ANY" || why === c.expect) : ok;
      if (!pass) failures++;
      if (ok && !c.expect && /^(pending|winners|read)/.test(c.label)) {
        const fn = c.label.startsWith("pending")
          ? "pendingWithdrawals"
          : c.label === "winners"
            ? "getWinners"
            : "getClaimsByBountyId";
        out[c.label] = decodeFunctionResult({ abi, functionName: fn, data: r.returnData } as never);
      }
      console.log(
        `${pass ? "PASS" : "FAIL"}  ${c.label}${c.expect ? ` (expects ${c.expect}, got ${ok ? "success" : why})` : ok ? "" : ` — ${why}`}`,
      );
    }),
  );

  const a = out["pending A"] as bigint;
  const b = out["pending B"] as bigint;
  const refund = out["pending issuer (refund)"] as bigint;
  console.log({ pendingA: a, pendingB: b, refund, winners: out.winners });
  const net = REWARD - (REWARD * 250n) / 10_000n; // 2.5% fee per PR notes
  const check = (cond: boolean, msg: string) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures++;
  };
  check(
    a + b <= REWARD && a + b >= net - 10n,
    `winners get the reward net of fee (${a + b} vs net ${net})`,
  );
  check(
    a * 4000n >= b * 6000n - 10n ** 12n && a * 4000n <= b * 6000n + 10n ** 12n,
    "split is 60/40",
  );
  check(refund === REWARD, `ended bounty refunds the issuer in full (${refund})`);
  check(out["pending A after"] === 0n, "A's balance is zero after withdrawing");

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e, e?.details ?? "");
  process.exit(1);
});
