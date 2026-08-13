import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const DATA_FILE = new URL("../data/payments.jsonl", import.meta.url).pathname;

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

export interface Stats {
  total_requests: number;
  total_volume_usd: number;
  unique_wallets: number;
  by_model: { model: string; count: number; volume_usd: number }[];
}

export function readStats(): Stats {
  if (!existsSync(DATA_FILE)) {
    return { total_requests: 0, total_volume_usd: 0, unique_wallets: 0, by_model: [] };
  }
  const lines = readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean);
  const records: PaymentRecord[] = lines.map((l) => JSON.parse(l));

  const wallets = new Set<string>();
  const byModel = new Map<string, { count: number; volume_usd: number }>();
  let totalVolume = 0;

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
    unique_wallets: wallets.size,
    by_model: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.count - a.count),
  };
}
