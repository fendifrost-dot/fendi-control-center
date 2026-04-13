/**
 * Deterministic pattern detection — no AI.
 * Multiple patterns may match the same transaction.
 */

import type { Pattern, Transaction } from "./financialState.ts";

const DAY = 86400000;

function sameMerchant(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return x.length >= 6 && y.length >= 6 && (x === y || x.includes(y) || y.includes(x));
}

export function detectPatterns(transactions: Transaction[]): Pattern[] {
  const patterns: Pattern[] = [];
  const byDesc = new Map<string, Transaction[]>();

  for (const t of transactions) {
    const key = `${t.description.toLowerCase().slice(0, 40)}|${t.amount}`;
    const arr = byDesc.get(key) ?? [];
    arr.push(t);
    byDesc.set(key, arr);
  }

  // duplicate_charge
  for (const [, group] of byDesc) {
    if (group.length >= 2) {
      patterns.push({
        id: `pat_dup_${group[0]!.id}`,
        type: "duplicate_charge",
        transactionIds: group.map((g) => g.id),
        confidence: 0.85,
        signals: [`${group.length} transactions with same amount and similar description`],
      });
    }
  }

  // recurring_expense / subscription — same merchant, ~30d apart, similar amount
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const m = t.description.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 30);
    if (!m) continue;
    const arr = byMerchant.get(m) ?? [];
    arr.push(t);
    byMerchant.set(m, arr);
  }
  for (const [merchant, txs] of byMerchant) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => {
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return da - db;
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const d0 = prev.date ? Date.parse(prev.date) : NaN;
      const d1 = cur.date ? Date.parse(cur.date) : NaN;
      if (!Number.isFinite(d0) || !Number.isFinite(d1)) continue;
      const gap = Math.abs(d1 - d0);
      const amtRatio = Math.abs(prev.amount) > 0
        ? Math.abs(cur.amount - prev.amount) / Math.abs(prev.amount)
        : 1;
      if (gap >= 25 * DAY && gap <= 35 * DAY && amtRatio < 0.05) {
        patterns.push({
          id: `pat_sub_${cur.id}`,
          type: "subscription",
          transactionIds: [prev.id, cur.id],
          confidence: 0.7,
          signals: ["~monthly interval similar amount", merchant],
        });
        break;
      }
    }
  }

  // transfer — description keywords
  for (const t of transactions) {
    const d = t.description.toLowerCase();
    if (
      /\btransfer\b/.test(d) ||
      /\bxfer\b/.test(d) ||
      /\bvenmo\b/.test(d) && /\btransfer\b/.test(d) ||
      /\bzelle\b/.test(d) && /to /.test(d)
    ) {
      patterns.push({
        id: `pat_tr_${t.id}`,
        type: "transfer",
        transactionIds: [t.id],
        confidence: 0.65,
        signals: ["transfer keyword in description"],
      });
    }
  }

  // high_value_transaction
  for (const t of transactions) {
    if (t.amount >= 5000) {
      patterns.push({
        id: `pat_hv_${t.id}`,
        type: "high_value_transaction",
        transactionIds: [t.id],
        confidence: 0.9,
        signals: [`amount >= 5000`],
      });
    }
  }

  // uncategorized_expense
  for (const t of transactions) {
    if (!t.scheduleCCategory || t.flags.includes("uncategorized")) {
      patterns.push({
        id: `pat_uc_${t.id}`,
        type: "uncategorized_expense",
        transactionIds: [t.id],
        confidence: 0.95,
        signals: ["no Schedule C line assigned"],
      });
    }
  }

  // possible_business_expense / possible_personal_expense — light heuristics only (no AI)
  const businessHints =
    /office|staples|adobe|google|aws|hosting|legal|cpa|contract|inventory|supplier|wholesale|square|stripe/i;
  const personalHints =
    /grocery|netflix|spotify|gym|salon|uber eats|doordash|personal|atm withdrawal|cash out/i;

  for (const t of transactions) {
    const d = t.description;
    if (businessHints.test(d)) {
      patterns.push({
        id: `pat_pb_${t.id}`,
        type: "possible_business_expense",
        transactionIds: [t.id],
        confidence: 0.4,
        signals: ["keyword suggests business"],
      });
    }
    if (personalHints.test(d)) {
      patterns.push({
        id: `pat_pp_${t.id}`,
        type: "possible_personal_expense",
        transactionIds: [t.id],
        confidence: 0.35,
        signals: ["keyword suggests personal"],
      });
    }
  }

  return patterns;
}
