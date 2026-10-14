// Framing. The app may run inside an iframe only as a Safe App, i.e. framed by the Safe web app.
// `frame-ancestors` cannot be set from a <meta> tag, so the deployment must send that header (see
// README); this is the in-page second line: when framed by anything else the app does not render.

/** Hosts allowed to frame the app, and to talk to the Safe connector. */
export const SAFE_ALLOWED_DOMAINS = [/^app\.safe\.global$/];

/**
 * Whether the page may render. `ancestorOrigins` is `location.ancestorOrigins` (Chromium, Safari),
 * `referrer` is `document.referrer` for browsers without it (Firefox): it names the embedding page
 * unless that page suppressed it, in which case the app refuses.
 */
export function framingAllowed(isFramed: boolean, ancestorOrigins: readonly string[] | undefined, referrer: string): boolean {
  if (!isFramed) return true;
  const allowed = (origin: string) => {
    try {
      const url = new URL(origin);
      return url.protocol === "https:" && SAFE_ALLOWED_DOMAINS.some((pattern) => pattern.test(url.hostname));
    } catch {
      return false;
    }
  };
  // every ancestor, not only the nearest: an allowed page framed by another one is still refused
  if (ancestorOrigins && ancestorOrigins.length > 0) return ancestorOrigins.every(allowed);
  return allowed(referrer);
}

/** Reads the browser's view of the framing and applies `framingAllowed`. */
export function pageMayRender(): boolean {
  let isFramed = true;
  try {
    isFramed = window.top !== window.self;
  } catch {
    // a cross-origin top that cannot even be compared: framed
  }
  const origins = window.location.ancestorOrigins ? Array.from(window.location.ancestorOrigins) : undefined;
  return framingAllowed(isFramed, origins, document.referrer);
}
