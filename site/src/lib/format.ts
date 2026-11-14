// Non-finite values (no price, no benchmark) read as a dash rather than "NaN".
export const pct = (x: number) => (!Number.isFinite(x) ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(2) + "%");
export const dir = (x: number) => (x > 0.00005 ? "up" : x < -0.00005 ? "down" : "flat");
export const usd = (x: number) => (!Number.isFinite(x) ? "—" : "$" + x.toFixed(2));

export function leagueClock(at: number, total = 14 * 86400) {
  const left = Math.max(0, total - at), d = Math.floor(left / 86400);
  return `${d}d ${new Date((left % 86400) * 1000).toISOString().slice(11, 19)}`;
}

export function ago(at: number, now: number) {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const cssVar = (name: string) =>
  typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
