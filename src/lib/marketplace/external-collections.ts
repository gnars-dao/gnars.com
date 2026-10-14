/**
 * Collections browsed inside gnars.com but settled on OpenSea. Both live on Ethereum
 * mainnet, so the Base-only Seaport purchase path cannot fulfil them: cards are read-only
 * and hand checkout to OpenSea.
 */
export const EXTERNAL_COLLECTIONS = {
  og: {
    slug: "gnars",
    chain: "ethereum",
    address: "0x494715b2a3c75dadd24929835b658a1c19bd4552",
  },
  nouns: {
    slug: "nouns",
    chain: "ethereum",
    address: "0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03",
  },
} as const;

export type ExternalCollectionKey = keyof typeof EXTERNAL_COLLECTIONS;

export const EXTERNAL_COLLECTION_KEYS = Object.keys(EXTERNAL_COLLECTIONS) as [
  ExternalCollectionKey,
  ...ExternalCollectionKey[],
];

export function isExternalCollectionKey(value: string): value is ExternalCollectionKey {
  return Object.hasOwn(EXTERNAL_COLLECTIONS, value);
}

export function externalCollectionUrl(key: ExternalCollectionKey) {
  return `https://opensea.io/collection/${EXTERNAL_COLLECTIONS[key].slug}`;
}

export function externalCollectionItemUrl(key: ExternalCollectionKey, tokenId: string) {
  const { chain, address } = EXTERNAL_COLLECTIONS[key];
  return `https://opensea.io/item/${chain}/${address}/${tokenId}`;
}
