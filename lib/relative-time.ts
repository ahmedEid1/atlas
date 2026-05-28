/**
 * Render a past timestamp as a relative-time string using
 * `Intl.RelativeTimeFormat` so locale negotiation works correctly
 * server-side without a separate i18n library.
 *
 * Resolution buckets:
 *   < 60s              → "just now"
 *   60s..1h            → "5 minutes ago"
 *   1h..24h            → "3 hours ago"
 *   1d..30d            → "12 days ago"
 *   30d..365d          → "4 months ago"
 *   >365d              → "2 years ago"
 *
 * Clamps a future timestamp (clock skew) to "just now" rather than
 * rendering "in 3 seconds" — surface-level absurdity not worth the
 * negative-branch logic.
 *
 * Exported separately from any React code so it can be reused server-
 * side (e.g. in metadata) without dragging in component imports.
 */
export function relativeTime(thenMs: number, nowMs: number, locale = "en"): string {
  const deltaSec = Math.floor((nowMs - thenMs) / 1000);
  if (deltaSec < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = Math.floor(deltaSec / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  const months = Math.floor(days / 30);
  if (months < 12) return rtf.format(-months, "month");
  const years = Math.floor(days / 365);
  return rtf.format(-years, "year");
}
