import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

const DATA_FILE = new URL("../data/payments.jsonl", import.meta.url).pathname;
const RECONCILIATION_FILE = new URL("../data/reconciliation.jsonl", import.meta.url).pathname;

export interface PaymentRecord {
  ts: string; // ISO timestamp
  model: string; // real model id, not the slug
  payer: string; // wallet address
  amount_usd: number;
  tx: string; // settlement transaction hash
}

export function recordPayment(record: PaymentRecord): void {
  const dir = dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(DATA_FILE, JSON.stringify(record) + "\n");
}

// Verified-real revenue that arrived on-chain but isn't attributable to a
// specific logged request/payer/model — e.g. settlements that landed
// while a router restart cut the request off before recordPayment() ran.
// Not fabricated: each entry must be backed by an actual balance check
// against PAY_TO_ADDRESS, cited in `verified_via`. Kept separate from
// PaymentRecord (which is one row per real, fully-attributed request) so
// the two are never confused.
export interface ReconciliationRecord {
  ts: string;
  amount_usd: number;
  reason: string;
  verified_via: string;
}

export function recordReconciliation(record: ReconciliationRecord): void {
  const dir = dirname(RECONCILIATION_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(RECONCILIATION_FILE, JSON.stringify(record) + "\n");
}

function readReconciliations(): ReconciliationRecord[] {
  if (!existsSync(RECONCILIATION_FILE)) return [];
  return readFileSync(RECONCILIATION_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export interface Stats {
  total_requests: number;
  total_volume_usd: number;
  unattributed_volume_usd: number;
  unique_wallets: number;
  by_model: { model: string; count: number; volume_usd: number }[];
  by_day: { date: string; requests: number; unique_wallets: number }[];
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD, UTC (ISO timestamps are UTC)
}

function computeByDay(records: PaymentRecord[]): Stats["by_day"] {
  if (records.length === 0) return [];

  const walletsByDay = new Map<string, Set<string>>();
  const countByDay = new Map<string, number>();
  for (const r of records) {
    const day = dayKey(r.ts);
    countByDay.set(day, (countByDay.get(day) ?? 0) + 1);
    if (!walletsByDay.has(day)) walletsByDay.set(day, new Set());
    walletsByDay.get(day)!.add(r.payer.toLowerCase());
  }

  const days = [...countByDay.keys()].sort();
  const first = new Date(days[0] + "T00:00:00Z");
  const last = new Date(days[days.length - 1] + "T00:00:00Z");

  const result: Stats["by_day"] = [];
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    result.push({
      date: key,
      requests: countByDay.get(key) ?? 0,
      unique_wallets: walletsByDay.get(key)?.size ?? 0,
    });
  }
  return result;
}

// /dashboard is public and the payment log grows without bound, so stats
// are cached and recomputed only when either data file changes size —
// otherwise every dashboard hit would re-parse the full log.
let statsCache: { key: string; stats: Stats } | null = null;

function cacheKey(): string {
  const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);
  return `${size(DATA_FILE)}:${size(RECONCILIATION_FILE)}`;
}

export function readStats(): Stats {
  const key = cacheKey();
  if (statsCache?.key === key) return statsCache.stats;
  const stats = computeStats();
  statsCache = { key, stats };
  return stats;
}

function computeStats(): Stats {
  const reconciliations = readReconciliations();
  const unattributed = reconciliations.reduce((sum, r) => sum + r.amount_usd, 0);

  if (!existsSync(DATA_FILE)) {
    return { total_requests: 0, total_volume_usd: unattributed, unattributed_volume_usd: unattributed, unique_wallets: 0, by_model: [], by_day: [] };
  }
  const lines = readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean);
  const records: PaymentRecord[] = lines.map((l) => JSON.parse(l));

  const wallets = new Set<string>();
  const byModel = new Map<string, { count: number; volume_usd: number }>();
  let totalVolume = unattributed;

  for (const r of records) {
    wallets.add(r.payer.toLowerCase());
    totalVolume += r.amount_usd;
    const entry = byModel.get(r.model) ?? { count: 0, volume_usd: 0 };
    entry.count += 1;
    entry.volume_usd += r.amount_usd;
    byModel.set(r.model, entry);
  }

  return {
    total_requests: records.length,
    total_volume_usd: totalVolume,
    unattributed_volume_usd: unattributed,
    unique_wallets: wallets.size,
    by_model: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.count - a.count),
    by_day: computeByDay(records),
  };
}
