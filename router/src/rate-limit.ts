// Fixed-window RPM limiter, one window per upstream id. Deliberately simple
// (no token bucket, no external store) — this is a single-process router on
// one machine, per CLAUDE.md's "routing logic v1 is deliberately dumb."

const windows = new Map<string, { windowStart: number; count: number }>();
const WINDOW_MS = 60_000;

export function checkRateLimit(id: string, rpm: number): boolean {
  const now = Date.now();
  const w = windows.get(id);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    windows.set(id, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= rpm) return false;
  w.count++;
  return true;
}
