import type { ReactNode } from "react";
import { getMessages } from "next-intl/server";
import { ROUTE_NAMESPACES, selectMessages } from "./client-messages";
import { RouteMessagesClient } from "./RouteMessagesClient";

export async function RouteMessages({
  route,
  children,
}: {
  route: keyof typeof ROUTE_NAMESPACES;
  children: ReactNode;
}) {
  const messages = await getMessages();
  return (
    <RouteMessagesClient messages={selectMessages(messages, ROUTE_NAMESPACES[route])}>
      {children}
    </RouteMessagesClient>
  );
}
