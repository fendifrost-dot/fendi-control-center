export type StatementTx = {
  date: string;
  description: string;
  amount: number;
  confidence?: number;
};

function normalizeDesc(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function dedupeTransactions(transactions: StatementTx[]): StatementTx[] {
  const out: StatementTx[] = [];
  const seen = new Set<string>();
  for (const t of transactions) {
    const key = `${t.date}|${Math.round(Math.abs(Number(t.amount) || 0) * 100)}|${normalizeDesc(t.description)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function mergeChunkResults(results: StatementTx[][]): StatementTx[] {
  const merged: StatementTx[] = [];
  for (const r of results) merged.push(...r);
  return dedupeTransactions(merged);
}
