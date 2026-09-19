"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDownWideNarrow, Check, X } from "lucide-react";
import { formatUnits } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseMarketplacePriceRange,
  type MarketplaceBrowseFilters as BrowseFilters,
} from "@/lib/marketplace/browse-filters";

export function MarketplaceBrowseFilters({
  value,
  disabled,
  onApply,
}: {
  value: BrowseFilters;
  disabled: boolean;
  onApply: (value: BrowseFilters) => void;
}) {
  const t = useTranslations("marketplace.filters");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setMin(value.minPriceWei ? formatUnits(BigInt(value.minPriceWei), 18) : "");
    setMax(value.maxPriceWei ? formatUnits(BigInt(value.maxPriceWei), 18) : "");
    setInvalid(false);
  }, [value]);
  return (
    <form
      className="mb-6 space-y-2"
      aria-label={t("label")}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onApply(parseMarketplacePriceRange(min, max));
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
        <label className="flex min-w-0 flex-col gap-1 text-xs sm:w-40 sm:shrink-0">
          {t("min")}
          <Input
            value={min}
            disabled={disabled}
            inputMode="decimal"
            placeholder="0"
            aria-invalid={invalid}
            aria-describedby={invalid ? "market-price-error" : undefined}
            onChange={(event) => {
              setMin(event.target.value);
              setInvalid(false);
            }}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs sm:w-40 sm:shrink-0">
          {t("max")}
          <Input
            value={max}
            disabled={disabled}
            inputMode="decimal"
            placeholder={t("any")}
            aria-invalid={invalid}
            aria-describedby={invalid ? "market-price-error" : undefined}
            onChange={(event) => {
              setMax(event.target.value);
              setInvalid(false);
            }}
          />
        </label>
        <div className="col-span-2 flex gap-2">
          <Button type="submit" variant="outline" disabled={disabled}>
            <Check className="size-4" />
            {t("apply")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || (!min && !max && !value.minPriceWei && !value.maxPriceWei)}
            onClick={() => onApply({ sort: "price-asc" })}
          >
            <X className="size-4" />
            {t("clear")}
          </Button>
        </div>
        <span className="col-span-2 flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
          <ArrowDownWideNarrow className="size-4 shrink-0" />
          {t("sort")}
        </span>
      </div>
      {invalid && (
        <p id="market-price-error" role="alert" className="text-xs text-destructive">
          {t("invalid")}
        </p>
      )}
    </form>
  );
}
