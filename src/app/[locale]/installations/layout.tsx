import { RouteMessages } from "@/i18n/RouteMessages";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RouteMessages route="installations">{children}</RouteMessages>;
}
