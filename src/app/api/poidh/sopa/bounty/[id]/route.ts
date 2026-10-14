import { NextRequest, NextResponse } from "next/server";
import { isPoidhSopaEnabled } from "@/lib/config";
import { fetchSopaBountyFresh } from "@/services/poidh-sopa";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isPoidhSopaEnabled()) {
    return NextResponse.json({ error: "PoidhSopa is not configured" }, { status: 404 });
  }
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) {
    return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
  }
  try {
    const bounty = await fetchSopaBountyFresh(Number(idStr));
    if (!bounty) return NextResponse.json({ error: "Bounty not found" }, { status: 404 });
    // Uncached: the detail view refetches right after a write and must see it.
    return NextResponse.json({ bounty }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("PoidhSopa bounty API error:", error);
    return NextResponse.json({ error: "Failed to fetch bounty" }, { status: 502 });
  }
}
