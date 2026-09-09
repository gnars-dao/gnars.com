import { z } from "zod";
import { nftMetadataSchema } from "@/lib/create-nft";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
  verifyWalletAuthorization,
} from "@/lib/server/request-security";
import { getCommunityEligibility } from "@/services/marketplace-community";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "nft-metadata-ip", limit: 30, windowSeconds: 3600 });
    const envelope = z
      .object({ metadata: z.unknown(), authorization: z.unknown().optional() })
      .strict()
      .safeParse(await readJsonBody(request, 24000));
    if (!envelope.success) throw new RequestSecurityError(400, "Invalid NFT metadata request.");
    const body = envelope.data;
    const parsed = nftMetadataSchema.safeParse(body.metadata);
    if (!parsed.success) throw new RequestSecurityError(400, "Invalid NFT metadata.");
    const metadata = parsed.data;
    const wallet = await verifyWalletAuthorization({
      authorization: body.authorization,
      method: "POST",
      path: "/api/create-nft/metadata",
      payload: metadata,
    });
    if (!(await getCommunityEligibility(wallet)).eligible)
      throw new RequestSecurityError(403, "At least 6 Gnars are required.");
    await enforceRateLimit(request, {
      scope: "nft-metadata-wallet",
      subject: wallet,
      limit: 10,
      windowSeconds: 3600,
    });
    const jwt = process.env.PINATA_JWT;
    if (!jwt) throw new RequestSecurityError(503, "Uploads are not configured.");
    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pinataContent: {
          ...metadata,
          external_url: "https://www.gnars.com/marketplace",
          attributes: [{ trait_type: "Creator", value: wallet }],
        },
        pinataMetadata: { name: metadata.name },
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) throw new RequestSecurityError(502, "Metadata upload failed.");
    const result = (await response.json()) as { IpfsHash?: unknown };
    if (typeof result.IpfsHash !== "string" || !/^[a-zA-Z0-9]{32,100}$/.test(result.IpfsHash))
      throw new RequestSecurityError(502, "Invalid metadata response.");
    return Response.json(
      { uri: `ipfs://${result.IpfsHash}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
