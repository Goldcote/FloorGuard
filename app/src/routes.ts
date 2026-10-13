import { useEffect, useState } from "react";

/** The app's pages. Paths live in the URL hash (`#/play/slots`), so no server routing is needed. */
export const ROUTES = [
  { path: "/", group: "Home", label: "FloorGuard", needsCollection: false },
  // `ownHead`: the page draws its own heading, so the shell does not repeat the route label above it.
  { path: "/app", group: "Overview", label: "Overview", needsCollection: true, ownHead: true },
  { path: "/trade/marketplace", group: "Trade", label: "Marketplace", needsCollection: true, ownHead: true },
  { path: "/trade/floor-bid", group: "Trade", label: "Floor bid", needsCollection: true, ownHead: true },
  { path: "/vault/holdings", group: "Vault", label: "Holdings & auctions", needsCollection: false, ownHead: true },
  { path: "/vault/licences", group: "Vault", label: "Licences", needsCollection: false, ownHead: true },
  { path: "/vault/raffles", group: "Vault", label: "Vault raffles", needsCollection: false },
  { path: "/play/dice", group: "Play", label: "Dice", needsCollection: true },
  { path: "/play/slots", group: "Play", label: "Slots", needsCollection: true },
  { path: "/play/lottery", group: "Play", label: "Lottery", needsCollection: true },
  { path: "/play/ticket-raffles", group: "Play", label: "Ticket raffles", needsCollection: true },
  { path: "/play/predictions", group: "Play", label: "Predictions", needsCollection: true },
  { path: "/play/house", group: "Play", label: "The house", needsCollection: false, ownHead: true },
  { path: "/fairness", group: "Fairness", label: "Fairness", needsCollection: false, ownHead: true },
] as const;

export type Route = (typeof ROUTES)[number];
export type RoutePath = Route["path"];
/** Groups shown in the navigation. "Home" is the landing page, reached through the logo. */
export const GROUPS = ["Overview", "Trade", "Vault", "Play", "Fairness"] as const;
export type Group = (typeof GROUPS)[number] | "Home";

export const routesOf = (group: Group): Route[] => ROUTES.filter((route) => route.group === group);
export const href = (path: string) => `#${path}`;

/** The hash without its "#" and without a "?query" (pages may carry a selection there). */
function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "").split("?")[0];
  return hash === "" ? "/" : hash;
}

const currentQuery = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");

/** One value from the hash query, e.g. `#/vault/licences?holding=2`. Follows hash changes. */
export function useRouteParam(name: string): string | undefined {
  const [value, setValue] = useState(() => currentQuery().get(name) ?? undefined);
  useEffect(() => {
    const onChange = () => setValue(currentQuery().get(name) ?? undefined);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [name]);
  return value;
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
