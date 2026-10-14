import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SopaBountyDetailView } from "@/components/bounties/sopa/SopaBountyDetailView";
import { isPoidhSopaEnabled } from "@/lib/config";
import { formatSopaReward } from "@/lib/poidh-sopa/tokens";
import { fetchSopaBounty } from "@/services/poidh-sopa";

export const revalidate = 60;

interface PageProps {
  params: Promise<{ locale: string; id: string }>;
}

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id: raw } = await params;
  const id = parseId(raw);
  if (!isPoidhSopaEnabled() || id === null) return { title: "Bounty Not Found — Gnars" };
  const bounty = await fetchSopaBounty(id).catch(() => null);
  if (!bounty) return { title: "Bounty Not Found — Gnars" };

  const title = `${bounty.title} — Gnars Challenges`;
  const reward = formatSopaReward(bounty.amount, bounty.token);
  const description = `${reward} bounty on Base: ${bounty.description.slice(0, 160)}`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function SopaBountyPage({ params }: PageProps) {
  const { id: raw } = await params;
  const id = parseId(raw);
  if (!isPoidhSopaEnabled() || id === null) notFound();

  const bounty = await fetchSopaBounty(id);
  if (!bounty) notFound();

  return <SopaBountyDetailView initialBounty={bounty} />;
}
