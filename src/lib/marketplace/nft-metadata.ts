export const NFT_METADATA_MAX_BYTES = 256_000;
export const NFT_TOKEN_URI_MAX_LENGTH = 350_000;

export type MarketplaceTrait = { type: string; value: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trait(type: unknown, value: unknown): MarketplaceTrait {
  if (typeof type !== "string" || !type.trim() || type.length > 80)
    throw new Error("Invalid NFT trait type");
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
  )
    throw new Error("Invalid NFT trait value");
  const text = String(value);
  if (text.length > 200) throw new Error("NFT trait value is too long");
  return { type: type.trim(), value: text };
}

export function parseNftTraits(metadata: unknown): MarketplaceTrait[] {
  if (!object(metadata)) throw new Error("Invalid NFT metadata");
  if (metadata.properties !== undefined && !object(metadata.properties))
    throw new Error("Invalid NFT properties");
  if (metadata.attributes !== undefined && !Array.isArray(metadata.attributes))
    throw new Error("Invalid NFT attributes");
  // Gnars stores its authoritative traits in properties rather than attributes.
  const properties = Object.entries(metadata.properties ?? {}).filter(
    ([, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  if (properties.length > 64) throw new Error("Too many NFT traits");
  if (properties.length) return properties.map(([type, value]) => trait(type, value));
  const attributes = metadata.attributes ?? [];
  if (attributes.length > 64) throw new Error("Too many NFT traits");
  return attributes.map((value: unknown) => {
    if (!object(value)) throw new Error("Invalid NFT attribute");
    return trait(value.trait_type, value.value);
  });
}

export function parseNftMetadataJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > NFT_METADATA_MAX_BYTES)
    throw new Error("NFT metadata is too large");
  const metadata: unknown = JSON.parse(text);
  if (!object(metadata)) throw new Error("Invalid NFT metadata");
  return metadata;
}

export function decodeInlineNftMetadata(uri: string): unknown {
  if (uri.length > NFT_TOKEN_URI_MAX_LENGTH) throw new Error("NFT token URI is too large");
  const match = /^data:application\/json(?:;charset=utf-8)?(;base64)?,(.*)$/is.exec(uri);
  if (!match) throw new Error("Unsupported inline NFT metadata");
  if (!match[1]) return parseNftMetadataJson(decodeURIComponent(match[2]));
  const encoded = match[2];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("Invalid NFT metadata base64");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (bytes.byteLength > NFT_METADATA_MAX_BYTES) throw new Error("NFT metadata is too large");
  return parseNftMetadataJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
