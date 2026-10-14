import { NextResponse } from "next/server";
import { isPoidhSopaEnabled } from "@/lib/config";
import { fetchSopaBounties } from "@/services/poidh-sopa";

export async function GET() {
  if (!isPoidhSopaEnabled()) {
    return NextResponse.json({ error: "PoidhSopa is not configured" }, { status: 404 });
  }
  const data = await fetchSopaBounties();
  // A failed read is a failure (5xx), never an empty list.
  if (data.error) return NextResponse.json(data, { status: 502 });
  // A partial read (some creation logs missing) must not be pinned at the CDN.
  if (data.partial) {
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}
