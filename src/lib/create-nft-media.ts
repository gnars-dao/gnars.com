import type { Account } from "thirdweb/wallets";
import { isNftImageFile, isNftMediaFile, nftMetadataSchema } from "@/lib/create-nft";
import { uploadToPinata } from "@/lib/pinata";

export async function uploadNftMedia({
  account,
  file,
  cover,
  name,
  description,
  checkAccount,
  onProgress,
}: {
  account: Account;
  file: File;
  cover?: File;
  name: string;
  description: string;
  checkAccount: () => void;
  onProgress: (percent: number) => void;
}) {
  const video = file.type === "video/mp4";
  if (!isNftMediaFile(file) || (video && (!cover || !isNftImageFile(cover))))
    throw new Error("invalidMedia");
  checkAccount();
  const totalBytes = file.size + (video ? cover!.size : 0);
  onProgress(0);
  const media = await uploadToPinata(account, file, file.name, (percent) =>
    onProgress(Math.floor((percent * file.size) / totalBytes)),
  );
  if (!media.success || !media.data) throw new Error("uploadError");
  checkAccount();
  let imageUri = media.data.ipfsUrl;
  if (video && cover) {
    const artwork = await uploadToPinata(account, cover, cover.name, (percent) =>
      onProgress(Math.floor((100 * file.size + percent * cover.size) / totalBytes)),
    );
    if (!artwork.success || !artwork.data) throw new Error("uploadError");
    imageUri = artwork.data.ipfsUrl;
    checkAccount();
  }
  return nftMetadataSchema.parse({
    name: name.trim(),
    description: description.trim(),
    image: imageUri,
    ...(video
      ? { animation_url: media.data.ipfsUrl, animation_details: { type: "video/mp4" } }
      : {}),
  });
}
