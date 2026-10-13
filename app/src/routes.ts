import { useEffect, useState } from "react";

/** The app's pages. Paths live in the URL hash (`#/play/slots`), so no server routing is needed. */
export const ROUTES = [
  { path: "/", group: "Home", label: "FloorGuard", needsCollection: false },
  { path: "/app", group: "Overview", label: "Overview", needsCollection: true },
  { path: "/trade/marketplace", group: "Trade", label: "Marketplace", needsCollection: true },
  { path: "/trade/floor-bid", group: "Trade", label: "Floor bid", needsCollection: true },
  { path: "/vault/holdings", group: "Vault", label: "Holdings & auctions", needsCollection: false },
  { path: "/vault/licences", group: "Vault", label: "Licences", needsCollection: false },
  { path: "/vault/raffles", group: "Vault", label: "Vault raffles", needsCollection: false },
  { path: "/play/dice", group: "Play", label: "Dice", needsCollection: true },
  { path: "/play/slots", group: "Play", label: "Slots", needsCollection: true },
  { path: "/play/lottery", group: "Play", label: "Lottery", needsCollection: true },
  { path: "/play/ticket-raffles", group: "Play", label: "Ticket raffles", needsCollection: true },
  { path: "/play/predictions", group: "Play", label: "Predictions", needsCollection: true },
  { path: "/fairness", group: "Fairness", label: "Fairness", needsCollection: false },
] as const;

export type Route = (typeof ROUTES)[number];
export type RoutePath = Route["path"];
/** Groups shown in the navigation. "Home" is the landing page, reached through the logo. */
export const GROUPS = ["Overview", "Trade", "Vault", "Play", "Fairness"] as const;
export type Group = (typeof GROUPS)[number] | "Home";

export const routesOf = (group: Group): Route[] => ROUTES.filter((route) => route.group === group);
export const href = (path: string) => `#${path}`;

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? "/" : hash;
}

/** The route for the current hash; unknown hashes fall back to the overview. Follows back/forward. */
export function useRoute(): Route {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  // "/trade" and the like open the group's first page.
  return ROUTES.find((route) => route.path === path) ?? ROUTES.find((route) => route.path.startsWith(`${path}/`)) ?? ROUTES[0];
}
