# Community NFT Creation

## Status

Basic Base ERC-721 creation uses the user-deployed collection `0x8baf2693b2a277FbEE39e3f6055E9331c1E6b975` on Base mainnet (8453). Read-only verification confirmed matching runtime bytecode, a six-Gnars minimum, and an immutable 250 BPS (2.5%) royalty to `0x15E69fD67DcC17E061Ceeb93DaC791e0f5aF0Eae`. The production address environment variable is configured; application deployments must include it. `/create-nft` enables minting only after its status API verifies the contract. This NFT collection is separate from the Gnars marketplace settlement contract. No mint was submitted during activation verification.

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

The UI accepts PNG/JPEG/GIF/WebP up to 20 MiB, or MP4 video up to 200 MiB with a required image cover (20 MiB maximum). The browser must decode the selected media and cover before minting is enabled; MP4 must contain a video track, not only audio. No new contract is needed for video. Media uploads reuse the authenticated, rate-limited browser-to-Pinata presigned upload used by droposals, with byte-weighted progress. The video and cover upload separately; metadata signing and minting do not proceed if either upload fails or the active account changes. A failed upload can leave an unused IPFS pin, but never causes an automatic mint.

Metadata uses a separate authenticated, membership-checked and rate-limited JSON endpoint. Image NFTs retain `image` only; video NFTs use the cover in `image`, the video CID in `animation_url`, and `animation_details.type: "video/mp4"`. Both URIs must be immutable IPFS CIDs. Pinata credentials stay server-side. This flow pins through Pinata; availability through the SkateHive gateway does not establish a separate SkateHive pin.

Marketplace metadata readers retain validated MP4 URLs from indexed or onchain metadata and store them with listing metadata. Created-collection details fall back to onchain metadata when the indexer has only a cover. Cards and Farcaster miniapp images remain static covers; the NFT detail drawer has an explicit-play video player. Playback failure preserves the cover and sale information. HTML animations, audio-only NFTs, automatic transcoding, editions, and ERC-1155 creation are not included.

Mint requests are persisted before the wallet prompt and scoped by collection plus actual signing account. Bounded read-only polling recovers by the contract's request mapping and checks creator plus immutable URI. No polling sends a transaction or signature. Explicit wallet rejection or a verified reverted receipt permits a new attempt. Unknown outcomes do not. A newly confirmed mint, including pending recovery, opens the community listing form for that NFT. Restoring an already completed journal does not redirect again. Minting itself never signs a sale. The creation form omits the royalty/address summary; contract royalty verification and settlement remain unchanged.

Fresh NFT previews fall back from incomplete indexer results to onchain `tokenURI` and bounded public IPFS gateway reads. Existing listing rows with missing artwork or placeholder names are enriched at read time without modifying their signed terms, comments, or published casts.

Tests include bounded video metadata, failure of either upload, wallet changes between uploads, metadata authorization, indexed/onchain/listing media persistence, decoded MP4/cover readiness, and desktop/mobile playback with static-card and error fallbacks. `tests/fixtures/nft-preview.mp4` is a generated FFmpeg `testsrc2` H.264 fixture; tests do not submit real mints or paid uploads.

References: [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/erc721), [ERC-2981](https://docs.openzeppelin.com/contracts/5.x/api/token/common), [OpenSea media metadata](https://docs.opensea.io/docs/media-and-traits).
