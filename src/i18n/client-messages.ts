export const ROOT_NAMESPACES = ["common", "footer", "nav", "stake", "wallet"] as const;

// Include namespaces used by shared dialogs and descendants, not just each page.
export const ROUTE_NAMESPACES = {
  home: ["auctions", "bounties", "home", "installations", "map", "newhome", "swap", "tv"],
  auctions: ["auctions"],
  marketplace: ["marketplace"],
  base: ["auctions", "base", "droposals", "newhome", "swap"],
  blogs: ["blogs"],
  "coin-proposal": ["coinProposal", "proposals", "propose"],
  community: ["bounties"],
  "create-coin": ["createCoin"],
  droposals: ["droposals"],
  feed: ["feed"],
  installations: ["installations"],
  map: ["map"],
  members: ["auctions", "members", "proposals"],
  migrate: ["migrate"],
  nogglesrails: ["installations", "map", "propdates"],
  oldhome: ["auctions", "feed", "home", "proposals", "treasury", "tv"],
  propdates: ["propdates", "proposals"],
  proposals: ["feed", "propdates", "proposals"],
  propose: ["proposals", "propose"],
  shop: ["shop"],
  store: ["store"],
  swap: ["swap"],
  treasury: ["auctions", "treasury"],
  tv: ["tv"],
} as const;

export function selectMessages<T extends Record<string, unknown>>(
  messages: T,
  namespaces: readonly string[],
): Partial<T> {
  return Object.fromEntries(
    namespaces.map((namespace) => {
      if (!(namespace in messages)) throw new Error(`Missing translation namespace: ${namespace}`);
      return [namespace, messages[namespace]];
    }),
  ) as Partial<T>;
}
