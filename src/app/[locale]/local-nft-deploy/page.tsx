import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LocalNftDeploy } from "@/components/create-nft/LocalNftDeploy";
import { isLocalNftDeploymentHost } from "@/lib/create-nft-deployment";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Gnars | Local NFT deployment",
  robots: { index: false, follow: false },
};
export default async function LocalNftDeploymentPage() {
  if (!isLocalNftDeploymentHost((await headers()).get("host"), process.env.NODE_ENV)) notFound();
  return <LocalNftDeploy />;
}
