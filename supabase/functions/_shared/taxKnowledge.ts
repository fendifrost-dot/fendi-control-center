/**
 * Deterministic retrieval of IRS anchors and classification hints.
 * Layer 5+ may extend this with embeddings — not implemented here.
 */

import type { Pattern } from "./financialState.ts";

export type TaxKnowledge = {
  type: "deduction_rule" | "classification_rule";
  trigger: string;
  content: string;
  confidence: number;
};

const IRS_SEC_162: TaxKnowledge = {
  type: "deduction_rule",
  trigger: "business_expense",
  content:
    "IRC §162: ordinary and necessary expenses paid or incurred in carrying on a trade or business. " +
    "Does not automatically classify a transaction — adjudication required.",
  confidence: 1,
};

const PATTERN_HINTS: Record<string, TaxKnowledge> = {
  duplicate_charge: {
    type: "classification_rule",
    trigger: "duplicate_charge",
    content: "Review duplicate lines before deducting — may be posting errors or true duplicates.",
    confidence: 0.8,
  },
  subscription: {
    type: "classification_rule",
    trigger: "subscription",
    content: "Recurring charges are often deductible if ordinary and necessary for the business; verify business use.",
    confidence: 0.6,
  },
  transfer: {
    type: "classification_rule",
    trigger: "transfer",
    content: "Transfers between accounts are generally not deductible expenses.",
    confidence: 0.85,
  },
  high_value_transaction: {
    type: "classification_rule",
    trigger: "high_value_transaction",
    content: "Large transactions warrant documentation (invoice, contract) before deduction.",
    confidence: 0.7,
  },
  uncategorized_expense: {
    type: "classification_rule",
    trigger: "uncategorized_expense",
    content: "Assign to a Schedule C line or exclude before filing.",
    confidence: 0.9,
  },
};

export type RetrieveTaxKnowledgeInput = {
  strict?: boolean;
  broad?: boolean;
  patterns?: Pattern[];
};

export function retrieveTaxKnowledge(input: RetrieveTaxKnowledgeInput = {}): TaxKnowledge[] {
  const strict = input.strict === true;
  const broad = input.broad !== false;

  const out: TaxKnowledge[] = [IRS_SEC_162];

  const patternTypes = new Set<string>();
  for (const p of input.patterns ?? []) {
    patternTypes.add(p.type);
  }

  for (const pt of patternTypes) {
    const hint = PATTERN_HINTS[pt];
    if (!hint) continue;
    if (strict && hint.confidence < 0.75) continue;
    out.push(hint);
  }

  if (broad && !strict) {
    out.push({
      type: "classification_rule",
      trigger: "schedule_c_lines",
      content:
        "Schedule C Part II lines 8–27 are the standard buckets for business expenses; map each candidate to one line or exclude.",
      confidence: 0.85,
    });
  }

  return out;
}
