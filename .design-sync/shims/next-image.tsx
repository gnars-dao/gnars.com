/* Stands in for `next/image` in the Claude Design bundle.
 *
 * The real next/image rewrites every src into `/_next/image?url=...`, which is
 * served by the Next.js server. Nothing serves that route inside a rendered
 * design, so keeping the real component would render a broken image in every
 * card AND in every design the agent builds. A plain <img> is the honest
 * substitute: same layout, no optimizer.
 *
 * Aliased in via .design-sync/tsconfig.ds.json `compilerOptions.paths`. */
import * as React from "react";

type StaticImageData = { src: string; width?: number; height?: number };

export interface ImageProps extends Omit<React.ComponentProps<"img">, "src" | "alt"> {
  src: string | StaticImageData;
  alt?: string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  sizes?: string;
  loader?: unknown;
  placeholder?: string;
  blurDataURL?: string;
  unoptimized?: boolean;
}

export default function Image({
  src,
  alt = "",
  fill,
  // Swallowed: optimizer-only props that are invalid DOM attributes and would
  // trip React's unknown-prop warning on a bare <img>.
  priority: _priority,
  quality: _quality,
  loader: _loader,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  unoptimized: _unoptimized,
  style,
  ...rest
}: ImageProps) {
  const url = typeof src === "string" ? src : src?.src;
  // `fill` means "absolutely fill the nearest positioned ancestor" - the
  // callers pair it with object-cover, so the layout only reads right if the
  // shim reproduces the positioning too.
  const fillStyle: React.CSSProperties | undefined = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
    : undefined;
  return <img src={url} alt={alt} style={{ ...fillStyle, ...style }} {...rest} />;
}

export { Image };
