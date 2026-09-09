# NFT Creation Options

Research date: 2026-09-09. Recommendations, not implemented features or deployment approval.

## Existing Integration

- Marketplace submission currently lists existing Base ERC721s, from the active
  wallet or a manual contract/token entry. It does not mint uploaded media.
- Droposals use Zora `createEdition` (ERC721Drop) through proposal execution;
  see `src/lib/proposal-utils.ts`. The creator-coin factory is a different contract.
- `usePinataUpload` already uploads browser-to-Pinata using a short-lived signed
  URL. Reuse it and its wallet authorization, MIME/size checks and upload budgets.
  Keep `PINATA_JWT` server-only. This avoids routing media bytes through Vercel.
- Current upload policy accepts image/video/audio, not NFT metadata JSON. Add a
  small authenticated, schema-validated metadata endpoint when implementing mint.
  Store `ipfs://` media/metadata URIs; pinning needs ongoing retention, not merely a CID.
- Keep recovery checkpoints: upload, metadata, mint submission, confirmed token
  identity, approval, signed listing, publication. Reload must not mint twice.
- ERC1155 is not currently supported by the community marketplace validator.
  Adding editions requires quantity-aware inventory, order and settlement changes.
- Do not inherit droposal default royalties into community mint. Creator royalties,
  marketplace 1% split and any mint fee are separate policies requiring explicit review.

## Factory Options

| Option                                                     | Fit                                                                                 | Tradeoff                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shared Gnars ERC721 collection                             | Simplest media-to-1/1 flow; one existing collection, per-token creator and metadata | Creators share a collection identity; mint authorization must prevent impersonation                                                     |
| Gnars factory using OpenZeppelin ERC721 and ERC1167 clones | Separate creator-owned collections, cheap repeated deployment                       | Our initialization, roles and mint/payment logic still need independent review; using audited primitives does not audit the composition |
| Manifold Creator Core                                      | Established ERC721/ERC1155 creator contracts and extension ecosystem                | Pin deployed versions, inspect admin/extension powers and fees before integration; platform extensions can introduce separate fees      |
| Existing Zora droposal factory                             | Reuse for governance-approved editions                                              | Not the same as direct community mint; Zora NFT documentation is explicitly legacy                                                      |

Recommendation: first deliver a plain ERC721 media mint. Choose shared collection
for the fewest deployment steps, or creator-owned clones if independent collection
ownership is required. Do not create a new collection for every individual NFT.
Keep a versioned implementation pinned and initialize clones atomically. No generic
user-supplied Solidity or arbitrary executable extension upload.

Sources: [OpenZeppelin token implementations](https://docs.openzeppelin.com/contracts/5.x/api),
[minimal clones](https://docs.openzeppelin.com/contracts/5.x/api/proxy),
[Manifold extensions](https://github.com/manifoldxyz/creator-core-extensions-solidity),
[Manifold published deployments](https://github.com/manifoldxyz/manifold-contract-addresses),
[Zora legacy NFT docs](https://nft-docs.zora.co/).

## Useful Advanced Directions

1. **NFT as a wallet:** ERC6551 accounts can hold tokens and other NFTs, controlled
   through ownership of the parent NFT. For Gnars: a rider's collectible with gear,
   donated assets or acquired collectibles. It is not automatically a safe financial vault.
2. **Sealed basket:** deposit explicitly supported assets, mint a transferable
   ERC721 receipt, and burn/redeem it for the contents. This is a proposed product
   architecture, not a feature granted by ERC721. Start with ordinary NFTs or ETH/USDC,
   no yield, leverage or arbitrary external calls. Define treatment of unsolicited deposits.
3. **Dynamic achievements:** visual traits updated from authenticated competition,
   participation or riding milestones. ERC7496 proposes onchain trait interfaces;
   event updates, authority and dispute handling remain application responsibilities.
4. **Physical redemption:** a collectible redeemable for a deck, print or event
   benefit. ERC7498 describes redemption campaigns and receipt references; real-world
   fulfillment still needs an accountable operator and private shipping data.
5. **Editions and packs:** ERC1155 for many copies; an ERC721 wrapper for a specific
   sealed pack. Selling a wrapper, selling several independent orders in a sweep,
   and selling multiple NFTs in one signed order are different settlement paths.
6. **Multi-format collectibles:** ERC5773 describes different assets for different
   contexts, such as a photo, video and game representation associated with one NFT.
   Start with standard image/animation metadata; extra interfaces need compatible viewers.
7. **Agent identity NFTs:** ERC8004 uses ERC721-based identities with reputation
   and validation registries. A community curation assistant could have portable
   identity. Ownership of that NFT is not proof that a model is truthful, nor does
   it transfer model weights, hosting or service credentials automatically.

Sources: [ERC6551](https://ercs.ethereum.org/ERCS/erc-6551),
[ERC7496](https://ercs.ethereum.org/ERCS/erc-7496),
[ERC7498](https://ercs.ethereum.org/ERCS/erc-7498),
[ERC1155](https://ercs.ethereum.org/ERCS/erc-1155),
[ERC5773](https://eips.ethereum.org/EIPS/eip-5773),
[ERC8004](https://eips.ethereum.org/EIPS/eip-8004).
Treat proposal availability as research, not evidence of broad marketplace support.

## Stock-Backed NFTs

Technically, a vault may hold compatible tokenized-stock assets and issue an ERC721
redemption receipt. That does not make the NFT a directly registered share, remove
issuer/custodian risk, guarantee liquidity, or remove issuer and jurisdiction rules.
Each asset needs verified chain/address, transfer behavior, redemption eligibility,
rebasing/dividend accounting, freeze/upgrade powers and legal distribution review.
Do not infer Base availability from a ticker or bridge an unsupported representation.

[xStocks documentation](https://docs.xstocks.fi/docs) describes transferable,
collateralized equity/ETF exposure but also jurisdiction restrictions.
[Ondo eligibility](https://docs.ondo.finance/ondo-stocks/eligibility) likewise needs
product-specific review. These are issuer descriptions, not verification of a
particular reserve or endorsement of an asset. No stock-backed launch is approved.

### Critical Basket Sale Invariant

ERC6551 explicitly warns that a seller can withdraw contents before selling the
parent NFT. Our current community settlement checks ownership of the wrapper only.
Never label that as verified backing. A sealed vault must prohibit withdrawals,
old approvals/session keys and administrator escape paths from draining the basket;
alternatively settlement must atomically validate a signed composition commitment.
Read-only UI balance checks are not sufficient against transaction ordering races.
An immutable redeem-only basket is a simpler first design than a freely executable
token-bound wallet sold on an unrestricted order.

## Suggested Sequence

1. IPFS media + metadata, plain ERC721 mint, durable recovery, existing listing flow.
2. Creator-owned collection factory, optional editions after ERC1155 integration.
3. Physical redemption or dynamic rider collectibles.
4. Separately reviewed sealed baskets of ordinary onchain assets.
5. Tokenized-stock experiment only after asset-specific technical and legal review.

All writes must use the active EOA/smart-wallet identity and builder attribution.
Preserve the existing six-Gnars community publication gate. No new mint fee,
royalty default, administrator power or contract deployment is implied by this research.
