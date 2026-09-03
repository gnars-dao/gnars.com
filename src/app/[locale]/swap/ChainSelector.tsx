"use client";

import { useTranslations } from "next-intl";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SWAP_CHAINS } from "./chains";
import { useSwapChain } from "./SwapChainContext";

export function ChainSelector() {
  const t = useTranslations("swap");
  const { chain, setChainId } = useSwapChain();

  return (
    <DropdownMenu>
      {/*
        A BUTTON, not a badge. This was a small tinted pill that read as
        decoration next to the title, and people looked straight past it —
        the network mark and the border are what say "you can change this".
      */}
      <DropdownMenuTrigger
        className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("chain.selectLabel")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={chain.logo} alt="" width={16} height={16} className="rounded-full" />
        {chain.name}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        {SWAP_CHAINS.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => setChainId(c.id)} className="gap-2 text-sm">
            <Check
              className={c.id === chain.id ? "h-3.5 w-3.5 opacity-100" : "h-3.5 w-3.5 opacity-0"}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.logo} alt="" width={16} height={16} className="rounded-full" />
            {c.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
