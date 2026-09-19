"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, LoaderCircle, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  parseTraitSelection,
  type MarketplaceBrowseFilters,
} from "@/lib/marketplace/browse-filters";

const facetsSchema = z.object({
  snapshotId: z.string().regex(/^0x[0-9a-f]{64}$/),
  blockNumber: z.union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative().safe()]),
  collectionAddress: z
    .string()
    .refine((value) => value.toLowerCase() === DAO_ADDRESSES.token.toLowerCase()),
  total: z.number().int().nonnegative().safe(),
  traits: z
    .array(
      z.object({
        type: z.string().min(1).max(80),
        values: z
          .array(
            z.object({
              value: z.string().max(200),
              count: z.number().int().nonnegative().safe(),
            }),
          )
          .max(1000),
      }),
    )
    .max(64),
});

export function MarketplaceTraitFilters({
  value,
  disabled,
  onApply,
}: {
  value: MarketplaceBrowseFilters;
  disabled: boolean;
  onApply: (value: Pick<MarketplaceBrowseFilters, "traits" | "traitSnapshot">) => void;
}) {
  const t = useTranslations("marketplace.traitFilters");
  const [open, setOpen] = useState(false);
  const [selectionInvalid, setSelectionInvalid] = useState(false);
  const selected: Record<string, string[]> = value.traits ? JSON.parse(value.traits) : {};
  const selectedCount = Object.values(selected).reduce((count, values) => count + values.length, 0);
  const facets = useQuery({
    queryKey: ["marketplace", "trait-facets", value.traitSnapshot ?? null],
    enabled: open && !disabled,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/marketplace/trait-facets${value.traitSnapshot ? `?snapshotId=${value.traitSnapshot}` : ""}`,
        { signal },
      );
      if (!response.ok) throw new Error("Trait index unavailable");
      const result = facetsSchema.parse(await response.json());
      if (value.traitSnapshot && result.snapshotId !== value.traitSnapshot)
        throw new Error("Trait snapshot mismatch");
      return result;
    },
    staleTime: 300_000,
    retry: 1,
    placeholderData: (previous) => previous,
  });

  function toggle(type: string, traitValue: string) {
    if (!facets.data) return;
    const values = new Set(selected[type] ?? []);
    if (values.has(traitValue)) values.delete(traitValue);
    else values.add(traitValue);
    const next = { ...selected, [type]: [...values].sort() };
    const canonical = Object.fromEntries(
      Object.keys(next)
        .sort()
        .filter((key) => next[key].length)
        .map((key) => [key, next[key]]),
    );
    try {
      onApply(
        Object.keys(canonical).length
          ? {
              traits: JSON.stringify(parseTraitSelection(JSON.stringify(canonical))),
              traitSnapshot: facets.data.snapshotId,
            }
          : { traits: undefined, traitSnapshot: undefined },
      );
      setSelectionInvalid(false);
    } catch {
      setSelectionInvalid(true);
    }
  }

  return (
    <section className="mb-6 border-y" aria-label={t("label")}>
      <div className="flex min-h-11 items-center gap-2">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm font-medium disabled:cursor-default disabled:opacity-50"
          aria-expanded={open}
          aria-controls="market-trait-options"
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal className="size-4 shrink-0" />
          {t("label")}
          {selectedCount > 0 && (
            <span className="rounded bg-yellow-400 px-1.5 py-0.5 text-xs text-black">
              {selectedCount}
            </span>
          )}
          <ChevronDown
            className={`ml-auto size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {selectedCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={disabled}
                aria-label={t("clear")}
                onClick={() => {
                  onApply({ traits: undefined, traitSnapshot: undefined });
                  setSelectionInvalid(false);
                }}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("clear")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {open && (
        <div id="market-trait-options" className="pb-3">
          {selectionInvalid && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {t("limit")}
            </p>
          )}
          {facets.isPending ? (
            <p role="status" className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : facets.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-xs">
              <span>{t("error")}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={facets.isFetching}
                onClick={() => void facets.refetch()}
              >
                <RefreshCw className="size-3.5" />
                {t("retry")}
              </Button>
            </div>
          ) : (
            facets.data && (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("count", { count: facets.data.total })}
                  {" · "}
                  <a
                    className="underline underline-offset-4"
                    href={`https://basescan.org/block/${facets.data.blockNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{facets.data.blockNumber}
                  </a>
                </p>
                <div className="grid items-start gap-x-5 sm:grid-cols-2 lg:grid-cols-3">
                  {facets.data.traits.map((trait) => (
                    <details key={trait.type} className="min-w-0 border-t">
                      <summary className="cursor-pointer break-words py-2 text-sm font-medium">
                        {trait.type}
                        {selected[trait.type]?.length ? ` (${selected[trait.type].length})` : ""}
                      </summary>
                      <div className="max-h-56 space-y-1 overflow-y-auto pb-2">
                        {trait.values.map((option) => (
                          <label
                            key={option.value}
                            className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-1 text-xs hover:bg-muted"
                          >
                            <input
                              type="checkbox"
                              className="size-4 shrink-0 accent-yellow-400"
                              checked={selected[trait.type]?.includes(option.value) ?? false}
                              disabled={disabled}
                              onChange={() => toggle(trait.type, option.value)}
                            />
                            <span className="min-w-0 flex-1 break-words">
                              {option.value || t("emptyValue")}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {option.count}
                            </span>
                          </label>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
