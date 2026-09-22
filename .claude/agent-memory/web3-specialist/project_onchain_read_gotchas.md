---
name: project_onchain_read_gotchas
description: Empirically verified gotchas when reading Gnars/Morpheus contracts on Base with viem — checksums, public RPC rate limits, usersData ambiguity, thirdweb SA prediction
metadata:
  type: project
---

Facts about external systems that cost real debugging time, verified live on Base. None of these are
derivable from reading the repo — they are properties of viem, the public RPCs, and the deployed
contracts.

**Why:** Each one produces a failure that does NOT look like its cause. A bad checksum looks like an
outage, a rate limit looks like an empty wallet, and the wrong `usersData` overload returns a
plausible number that means something else entirely.

**How to apply:** Check this before writing any new server-side contract read, in either
gnars-website or gnars-playstation.

## viem asserts EIP-55 on every call target

`readContract` / `multicall` throw `InvalidAddressError` when the `to` address is not correctly
checksummed. It is NOT a wrong read — it is a hard throw, so a hand-typed checksum turns into a
permanent 5xx for every user, and mocked tests cannot see it because they never touch an address.

Never hand-checksum. Wrap every hardcoded address in viem's `getAddress()` at module load, the way
`src/lib/morpheus-builder.ts` already does. Verified 2026-09-09: the Gnars token checksums to
`0x880Fb3Cf5c6Cc2d7DFC13a993E839a9411200C17` (capital F at index 5) — hand-typing produced
`0x880fB3Cf…`, which viem rejected outright.

## mainnet.base.org rate-limits at a handful of consecutive reads

Measured 2026-09-09: three sequential `eth_call`s from one process got `-32016 over rate limit`,
after viem's own retry had already fired. On a request path this reads as an outage, and if the code
swallows the error it reads as "this address holds nothing".

Always build a fallback transport even when no custom RPC is configured. Healthy-first order that
works: `base-rpc.publicnode.com`, `base.drpc.org`, then `mainnet.base.org`. Same list as
`BASE_RPCS` in [[project_web3_patterns]].

## Two different `usersData` — reading the wrong index is silent

| Contract | Chain | Signature | Staked amount at |
|---|---|---|---|
| Morpheus **Capital** | mainnet | `usersData(address, uint256 poolIndex)` | index **[1]** |
| Morpheus **BuildersV4** | Base | `usersData(address, bytes32 subnetId)` | index **[2]** |

Gnars uses BuildersV4 on Base (`0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9`), subnet
`0xf129111951997d1c386be9b7de27d4c74490c42ad0ffbcb65e380d17f8a8ea3d`. Both decode without reverting,
so picking the wrong index gates on a number that looks fine. Verified 2026-09-09 against the subnet
admin `0x8Bf5941d27176242745B716251943Ae4892a3C26`: 601 MOR at index [2]; subnet total 9236 MOR.

## thirdweb smart accounts need no thirdweb package

The default v0.6 account factory on Base, `0x85e23b94e7F5E9cC1fF78BCe78cfb15B81f0DF00`, exposes
`getAddress(address adminSigner, bytes data) view returns (address)`. Called with empty salt `"0x"`
it reproduces `predictSmartAccountAddress` exactly, as a pure view call that answers for accounts
that were never deployed. A plain viem `readContract` is enough — no need for the `thirdweb`
dependency that `src/services/members.ts` pulls in for the same job.

Note the name collision: that factory method is `getAddress`, same identifier as viem's checksum
helper. Alias one of them or the file gets confusing fast.

## Counting a holder's NFTs takes two round trips, not one

The SA balance depends on the factory's answer, so it cannot join the first multicall. Batch
`balanceOf(eoa)` + `usersData(eoa)` + `factory.getAddress(eoa)` into one multicall, then read
`balanceOf(predictedSA)`. Multicall3 is at `0xcA11bde05977b3631167028862bE2a173976CA11` on Base
(blockCreated 5022) — you can define a minimal chain locally instead of importing `viem/chains`,
which drags the whole chain registry (and an `ox/tempo` dynamic-require warning) into a server bundle.
