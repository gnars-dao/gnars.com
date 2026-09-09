import { NATIVE_TOKEN, type SwapToken, type WalletToken } from "./chains";

export const tokenKey = (address: string) => address.toLowerCase();

export function mergePickerTokens(...lists: readonly (readonly SwapToken[])[]): SwapToken[] {
  const merged = new Map<string, SwapToken>();
  for (const list of lists) {
    for (const token of list) {
      const previous = merged.get(tokenKey(token.address));
      merged.set(tokenKey(token.address), {
        ...previous,
        ...token,
        logo: token.logo ?? previous?.logo,
      });
    }
  }
  return [...merged.values()];
}

export function filterPickerTokens(tokens: readonly SwapToken[], query: string): SwapToken[] {
  const search = query.trim().toLowerCase();
  return tokens.filter(
    (token) =>
      !search ||
      [token.symbol, token.name, token.address].some((value) =>
        value.toLowerCase().includes(search),
      ),
  );
}

export function walletPickerTokens(
  tokens: readonly SwapToken[],
  holdings: readonly WalletToken[],
  usdValues?: Map<string, number>,
): SwapToken[] {
  const positive = new Set(
    holdings.filter((token) => Number(token.balance) > 0).map((token) => tokenKey(token.address)),
  );
  return tokens
    .filter((token) => positive.has(tokenKey(token.address)))
    .sort((a, b) => {
      const aUsd = usdValues?.get(tokenKey(a.address));
      const bUsd = usdValues?.get(tokenKey(b.address));
      if (aUsd !== undefined && bUsd !== undefined) return bUsd - aUsd;
      if (aUsd !== undefined) return -1;
      if (bUsd !== undefined) return 1;
      // Unpriced token quantities are not comparable across assets.
      return a.symbol.localeCompare(b.symbol);
    });
}

export function tokenAddressLabel(token: SwapToken): string {
  return token.address === NATIVE_TOKEN
    ? ""
    : `${token.address.slice(0, 6)}...${token.address.slice(-4)}`;
}

export function prioritizeOwnedTokens(
  tokens: readonly SwapToken[],
  holdings: readonly WalletToken[],
  usdValues?: Map<string, number>,
): SwapToken[] {
  const owned = walletPickerTokens(tokens, holdings, usdValues);
  const ownedAddresses = new Set(owned.map((token) => tokenKey(token.address)));
  return [...owned, ...tokens.filter((token) => !ownedAddresses.has(tokenKey(token.address)))];
}

export function compactTokenBalance(value: string, locale: string): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "--";
  if (number > 0 && number < 0.0001) return number.toExponential(2);
  return new Intl.NumberFormat(locale, {
    notation: number >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: number < 1 ? 4 : 2,
  }).format(number);
}
