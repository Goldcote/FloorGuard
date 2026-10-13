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
