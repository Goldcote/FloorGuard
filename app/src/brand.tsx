/** The FloorGuard mark: a shield cut by the floor line, with the bid rising from it. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 2.5 27 6.5v8.2c0 6.6-4.3 11.9-11 14.8C9.3 26.6 5 21.300 5 14.7V6.5L16 2.5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path className="logo-floor" d="M2 19.500h28" stroke="var(--accent)" strokeWidth="2.400" strokeLinecap="round" />
      <path d="M11 19.500 16 11l5 8.500" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      Floor<span>Guard</span>
    </span>
  );
}

/** The recurring motif: a glowing horizontal line that things rest on. Decorative. */
export function FloorLine() {
  return <div className="floorline" aria-hidden="true" />;
}

const NAV_ICONS: Record<string, JSX.Element> = {
  Overview: (
    <>
      <path d="M20 12a8 8 0 0 1-13.700 5.600M4 12a8 8 0 0 1 13.700-5.600" />
      <path d="M18 3v4h-4M6 21v-4h4" />
    </>
  ),
  Trade: (
    <>
      <path d="M4 8h14l-3.500-3.500M20 16H6l3.500 3.500" />
    </>
  ),
  Vault: (
    <>
      <rect x="3.500" y="4" width="17" height="15" rx="2.500" />
      <circle cx="12" cy="11.500" r="3" />
      <path d="M12 8.500v-1.500M12 16v-1.500M7 19v2M17 19v2" />
    </>
  ),
  Play: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.500" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="15" r="1" fill="currentColor" />
      <circle cx="15" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
    </>
  ),
  Fairness: (
    <>
      <path d="M12 3 20 6v5.500c0 4.600-3.100 8.200-8 10-4.900-1.800-8-5.400-8-10V6l8-3Z" />
      <path d="m8.500 12 2.500 2.500 4.500-5" />
    </>
  ),
};

/** Line icons for the navigation, drawn here so nothing is fetched. */
export function NavIcon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg className="nav-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.800" strokeLinecap="round" strokeLinejoin="round">
      {NAV_ICONS[name]}
    </svg>
  );
}
