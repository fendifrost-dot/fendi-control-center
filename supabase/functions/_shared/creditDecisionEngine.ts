/**
 * Layer-2 decision engine: natural language → workflow key + confidence.
 * Deterministic regex first; callers may blend LLM classification later.
 *
 * Layer-1 case memory lives in DB (see migration credit_case_memory); inject snippets via fetchCaseMemorySnippet.
 */

export type CreditWorkflowKey = "analyze_credit_strategy" | "credit_analysis_and_disputes" | "drive_ingest";

export interface CreditWorkflowDecision {
  workflowKey: CreditWorkflowKey;
  confidence: number;
  reasons: string[];
}

const DISPUTE_LETTER_PATTERNS: RegExp[] = [
  /\bdispute\s+letter/i,
  /\bgenerate\s+(updated?\s+)?(dispute|rebuttal)/i,
  /\brebuttal/i,
  /\bcompare\b.*\b(credit\s+)?report/i,
  /\bcompare\b.*\b(dispute|bureau|removal)/i,
  /\bwhat\b.*\bremoved\b/i,
  /\bbureau(s)?\s+removed/i,
  /\bdelet(ed|ion)\b.*\b(tradeline|account|negative)/i,
  /\bre-?insert/i,
  /\bstagnat/i,
  /\bupdated?\s+dispute/i,
  /\bnew\s+dispute\s+letter/i,
];

const ANALYSIS_PATTERNS: RegExp[] = [
  /\banalyze\b.*\bcredit\b/i,
  /\bcredit\s+analysis/i,
  /\bcredit\s+strateg/i,
  /\bcredit\s+report\b/i,
  /\bpull\b.*\breport\b/i,
  /\bdispute\s+strateg/i,
  /\bcredit\b.*\bdispute/i,
  /\b(experian|equifax|transunion)\b.*\breport/i,
  /\bcheck\b.*\bcredit\b/i,
  /\breview\b.*\bcredit\b/i,
];

const DRIVE_INGEST_PATTERNS: RegExp[] = [
  /\bsync\b.*\bdrive/i,
  /\bingest\b.*\b(drive|folder|client)/i,
  /\bpull\b.*\b(files?|documents?)\b.*\bdrive/i,
  /\bimport\b.*\b(drive|folder)/i,
  /\bscan\b.*\bdrive/i,
];

function firstMatchReason(patterns: RegExp[], text: string, label: string): string | null {
  for (const p of patterns) {
    if (p.test(text)) return label;
  }
  return null;
}

/**
 * Pick Credit Guardian execution workflow from user text (lowercase trimmed).
 */
export function inferCreditWorkflowKey(lowerText: string): CreditWorkflowDecision {
  const reasons: string[] = [];
  let workflowKey: CreditWorkflowKey = "analyze_credit_strategy";
  let confidence = 0.55;

  const drive = firstMatchReason(DRIVE_INGEST_PATTERNS, lowerText, "drive_ingest");
  if (drive) {
    reasons.push(drive);
    return { workflowKey: "drive_ingest", confidence: 0.82, reasons };
  }

  const dispute = firstMatchReason(DISPUTE_LETTER_PATTERNS, lowerText, "dispute_or_compare");
  if (dispute) {
    reasons.push(dispute);
    workflowKey = "credit_analysis_and_disputes";
    confidence = 0.88;
    return { workflowKey, confidence, reasons };
  }

  const analysis = firstMatchReason(ANALYSIS_PATTERNS, lowerText, "credit_analysis");
  if (analysis) {
    reasons.push(analysis);
    workflowKey = "analyze_credit_strategy";
    confidence = 0.85;
    return { workflowKey, confidence, reasons };
  }

  // Weak fallback: any "credit" near dispute/bureau nouns
  if (/\bcredit\b/i.test(lowerText) && /\b(dispute|bureau|tradeline|score|report)\b/i.test(lowerText)) {
    reasons.push("credit_domain_keywords");
    return { workflowKey: "analyze_credit_strategy", confidence: 0.62, reasons };
  }

  reasons.push("no_credit_match");
  return { workflowKey: "analyze_credit_strategy", confidence: 0.2, reasons };
}

/** Broad gate for Lane-1 auto-execution (no /do). */
export function shouldAutoExecuteCreditIntent(lowerText: string): boolean {
  const d = inferCreditWorkflowKey(lowerText);
  return d.confidence >= 0.6;
}

export interface CaseMemorySnippetRow {
  case_phase: string | null;
  memory_summary: string | null;
  cg_client_id: string | null;
}

/**
 * Optional memory blob for agentic prompt injection (Layer-3 grounding).
 * Safe to call with service-role Supabase client; returns empty string if no row.
 */
export function formatCaseMemorySnippet(row: CaseMemorySnippetRow | null, clientName: string): string {
  if (!row || (!row.memory_summary && !row.case_phase)) return "";
  const parts = [`Case memory for "${clientName}":`];
  if (row.case_phase) parts.push(`Phase: ${row.case_phase}.`);
  if (row.memory_summary) parts.push(row.memory_summary);
  if (row.cg_client_id) parts.push(`Credit Guardian client id: ${row.cg_client_id}.`);
  return parts.join(" ");
}
