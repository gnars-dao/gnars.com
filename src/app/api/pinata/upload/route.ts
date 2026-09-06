/** File bytes go directly to Pinata through the signed upload flow. */
export async function POST() {
  return Response.json(
    { error: "Use the signed direct upload flow." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
