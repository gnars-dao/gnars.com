# Community NFT Creation

## Status

Basic Base ERC-721 creation is implemented. No production NFT creation address is assumed or deployed by this change. `/create-nft` disables minting until a configured contract passes runtime and immutable configuration verification. It is separate from the deployed Gnars marketplace settlement contract.

## Contract

`contracts/gnars-community-nft/src/GnarsCommunityNFT.sol` is a shared collection, not a per-user factory. OpenZeppelin Contracts 5.4.0 is vendored from commit `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0`; `upstream-lock.json` and `source-hashes.json` pin the upstream reference. Solidity 0.8.24, optimizer 200, Cancun. Build using `node scripts/community-nft-build.mjs`; `--fetch` explicitly refreshes the pinned vendor sources. Contract tests: `~/.foundry/bin/forge test --root contracts/gnars-community-nft`.

- Non-upgradeable, no owner/admin mint or metadata editing privileges.
- At least six Gnars in the actual calling wallet, enforced onchain.
- One ERC-721 minted to the calling EOA or smart account. Creator tracked permanently.
- IPFS metadata URI fixed at creation. Request IDs scoped to creator prevent duplicate minting after ambiguous wallet responses.
- Mint price is zero; users pay network gas. Listing is a separate user-approved action using existing community listing policy.
- ERC-2981 royalty recipient is the configured builders/treasury split. The deployer must explicitly choose a nonzero royalty in basis points; there is no guessed default. Both royalty rate and recipient are immutable. ERC-2981 signals payment information but does not force every external marketplace to pay.
- No reveal, pack escrow, optional creator splits, Ethereum deployment, or mint factory is included.
- This custom composition has not received an independent security audit. Upstream libraries being audited does not make this deployment audited.

## Local Deployment

Open `/pt-br/local-nft-deploy` on localhost in development. Enter the royalty basis points, prepare, review recipient/rate/source checksum, acknowledge, and submit with an external wallet. It targets Base mainnet only, including EIP-7702 EOAs; smart-account CREATE is not supported by the temporary tool. Smart accounts are supported for subsequent NFT minting.

Unknown creation requests remain blocked and preserve the deployment hash. The verification API checks actual zero-value CREATE input, builder suffix, creator/nonce-derived address, receipt, runtime code and royalty parameters. There is no automatic second deployment.

After verification set `NEXT_PUBLIC_GNARS_COMMUNITY_NFT_ADDRESS` locally and in Vercel, then redeploy the app. Existing `PINATA_JWT` handles storage. No new private keys are required. No credentials are written by this feature.

## Media and Recovery

The initial UI accepts PNG/JPEG/GIF/WebP up to 20 MB. Media uploads reuse the authenticated, rate-limited browser-to-Pinata presigned upload used by droposals. Metadata uses a separate authenticated, membership-checked and rate-limited JSON endpoint. Pinata credentials stay server-side.

Mint requests are persisted before the wallet prompt and scoped by collection plus actual signing account. Bounded read-only polling recovers by the contract's request mapping and checks creator plus immutable URI. No polling sends a transaction or signature. Explicit wallet rejection or a verified reverted receipt permits a new attempt. Unknown outcomes do not. Successful mint links back to the marketplace community listing flow; minting itself never signs a sale.

References: [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/erc721), [ERC-2981](https://docs.openzeppelin.com/contracts/5.x/api/token/common).
