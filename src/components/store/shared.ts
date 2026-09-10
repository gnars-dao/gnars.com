import type { Currency } from "@/types/store";

/** Labels passed from server components (translated) down into the card UI. */
export interface StoreCardLabels {
  buy: string;
  viewDetails: string;
  outOfStock: string;
  preorder: string;
  unavailable: string;
  featured: string;
}

const CURRENCY_LOCALE: Record<Currency, string> = {
  USD: "en-US",
  EUR: "en-IE",
  BRL: "pt-BR",
};

/** Format a price in its own currency, e.g. 59.95 USD → "$59.95". */
export function formatPrice(price: number | undefined, currency: Currency): string {
  if (price === undefined) return "";
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(price);
}

/** Nogenta prices are entered in reais and shown in dollars on the English site. */
export function displayCurrency(currency: Currency, locale: string): Currency {
  return currency === "BRL" && locale.toLowerCase().startsWith("en") ? "USD" : currency;
}
