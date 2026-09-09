import { NextRequest, NextResponse } from "next/server";
import { listProposals } from "@/services/proposals";

export const dynamic = "force-dynamic";
// Dynamic (reads search params), so `revalidate` is ignored — the response is
// cached at the Vercel CDN via the Cache-Control header on the success response.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const rawLimit = searchParams.get("limit") ?? "200";
    const rawPage = searchParams.get("page") ?? "0";
    const limit = Number(rawLimit);
    const page = Number(rawPage);
    if (
      !/^[1-9]\d{0,2}$/.test(rawLimit) ||
      limit > 200 ||
      !/^(0|[1-9]\d{0,3})$/.test(rawPage) ||
      page > 1000
    ) {
      return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
    }

    const proposals = await listProposals(limit, page);

    return NextResponse.json(proposals, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("Failed to fetch proposals:", error);
    return NextResponse.json({ error: "Failed to fetch proposals" }, { status: 500 });
  }
}
