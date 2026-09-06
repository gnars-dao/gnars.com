import { pinataUploadSchema } from "@/lib/pinata-policy";
import {
  enforceRateLimit,
  readJsonBody,
  RequestSecurityError,
  requestSecurityResponse,
  verifyWalletAuthorization,
} from "@/lib/server/request-security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, { scope: "pinata-ip", limit: 60, windowSeconds: 3600 });
    const body = (await readJsonBody(request, 24_000)) as {
      upload?: unknown;
      authorization?: unknown;
    };
    const parsed = pinataUploadSchema.safeParse(body?.upload);
    if (!parsed.success) throw new RequestSecurityError(400, "Invalid file type, name, or size.");
    const upload = parsed.data;
    const wallet = await verifyWalletAuthorization({
      authorization: body.authorization,
      method: "POST",
      path: "/api/pinata/signed-url",
      payload: upload,
    });
    await enforceRateLimit(request, {
      scope: "pinata-wallet",
      subject: wallet,
      limit: 20,
      windowSeconds: 3600,
    });
    await enforceRateLimit(request, {
      scope: "pinata-bytes",
      subject: wallet,
      limit: 1024 * 1024 * 1024,
      windowSeconds: 3600,
      cost: upload.size,
    });
    const pinataJWT = process.env.PINATA_JWT;
    if (!pinataJWT) throw new RequestSecurityError(503, "Uploads are not configured.");
    const response = await fetch("https://uploads.pinata.cloud/v3/files/sign", {
      method: "POST",
      headers: { Authorization: `Bearer ${pinataJWT}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        network: "public",
        date: Math.floor(Date.now() / 1000),
        expires: 60,
        filename: upload.filename,
        max_file_size: upload.size,
        allow_mime_types: [upload.mimeType],
        keyvalues: { wallet },
      }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) throw new RequestSecurityError(502, "Failed to authorize upload.");
    const result = await response.json();
    if (typeof result.data !== "string")
      throw new RequestSecurityError(502, "Invalid upload response.");
    return Response.json(
      { success: true, data: result.data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return requestSecurityResponse(error);
  }
}
