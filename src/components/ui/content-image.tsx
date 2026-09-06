import Image, { type ImageProps } from "next/image";
import { canOptimizeImage } from "@/lib/image-hosts";

export default function ContentImage(props: ImageProps) {
  const unoptimized =
    props.unoptimized || (typeof props.src === "string" && !canOptimizeImage(props.src));
  return <Image {...props} alt={props.alt} unoptimized={unoptimized} />;
}

export type { ImageProps, StaticImageData } from "next/image";
