const TRUNCATED_ADDRESS_HANDLE = /^0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}$/;

export function isUsableCreatorHandle(handle: string | null | undefined): boolean {
  if (!handle) return false;
  const trimmed = handle.trim();
  if (trimmed.length === 0) return false;
  return !TRUNCATED_ADDRESS_HANDLE.test(trimmed);
}

export type CreatorContentReport =
  | { status: "ok"; items: number; creatorsAsked: number; creatorsSkipped: number }
  | {
      status: "incomplete";
      itemsSoFar: number;
      creatorsAsked: number;
      creatorsSkipped: number;
      creatorsFailed: number;
      reason: string;
    }
  | { status: "unavailable"; creatorsFailed: number; reason: string };

export function buildCreatorContentReport({
  items,
  creatorsAsked,
  creatorsSkipped,
  creatorsFailed,
  reason,
}: {
  items: number;
  creatorsAsked: number;
  creatorsSkipped: number;
  creatorsFailed: number;
  reason?: string;
}): CreatorContentReport {
  const why = reason || "Zora profile read failed";
  if (creatorsFailed === 0) {
    return { status: "ok", items, creatorsAsked, creatorsSkipped };
  }
  if (creatorsAsked > 0 && creatorsFailed >= creatorsAsked) {
    return { status: "unavailable", creatorsFailed, reason: why };
  }
  return {
    status: "incomplete",
    itemsSoFar: items,
    creatorsAsked,
    creatorsSkipped,
    creatorsFailed,
    reason: why,
  };
}
