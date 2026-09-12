"use client";

/**
 * The bag's sound switch. Deliberately tiny and quiet: the sound is a garnish
 * on the pile animation, so its control should read as one too — a ghost icon
 * button that sits in the corner of the stage and never competes with the ETH
 * figure next to it.
 *
 * The caller is responsible for not rendering this at all when the bag itself
 * is not on screen, and `available` is false when the browser has no Web Audio
 * (nothing to toggle, so nothing is shown).
 */
import { useTranslations } from "next-intl";
import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface BagMuteToggleProps {
  muted: boolean;
  available: boolean;
  onToggle: () => void;
  className?: string;
}

export function BagMuteToggle({ muted, available, onToggle, className }: BagMuteToggleProps) {
  const t = useTranslations("migrate");
  if (!available) return null;

  const Icon = muted ? VolumeX : Volume2;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // `aria-pressed` carries the state, so the label stays the ACTION the
      // press performs — a screen reader otherwise announces the state twice.
      aria-label={muted ? t("bag.soundUnmute") : t("bag.soundMute")}
      aria-pressed={muted}
      onClick={onToggle}
      className={cn(
        "size-7 cursor-pointer text-muted-foreground/70 hover:text-foreground",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
