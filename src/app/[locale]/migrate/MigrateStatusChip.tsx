"use client";

import { useTranslations } from "next-intl";
import { useUpgraderPosition } from "@/hooks/use-upgrader-position";
import { cn } from "@/lib/utils";
import { depositStatusKey, depositStatusTone } from "./status";

/**
 * The state of the deposit window, next to the page title. Reads the same
 * contract state the widget does, so the headline can never claim the window
 * is open while the terminal is off.
 */
export function MigrateStatusChip() {
  const t = useTranslations("migrate");
  const position = useUpgraderPosition();
  const key = depositStatusKey(position);
  const tone = depositStatusTone(key);

  return (
    <div className="flex w-fit max-w-full items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "ok"
            ? "bg-emerald-500"
            : tone === "bad"
              ? "bg-destructive"
              : "bg-muted-foreground/50",
        )}
      />
      <span className="font-medium whitespace-nowrap">{t(`deposit.${key}`)}</span>
      {key === "live" && (
        <span className="whitespace-nowrap text-muted-foreground">{t("deposit.liveHint")}</span>
      )}
    </div>
  );
}
