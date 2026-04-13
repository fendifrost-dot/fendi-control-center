/**
 * Central structured state for tax intelligence pipeline (deterministic-first).
 * Persisted under tax_returns.analyzed_data.financial_state by ingest-tax-documents.
 */

export type IngestStatus =
  | "ingested" // successfully extracted transactions
  | "classified_only" // classified but not yet processed (policy skip)
  | "deferred_large_pdf" // classified, too large for single LLM call, needs chunking
  | "requires_chunking" // queued for chunked processing
  | "requires_review" // could not be classified or processed automatically
  | "skipped_duplicate" // identified as duplicate of another document
  | "image_not_processed"; // image file detected, vision processing not yet implemented

export type ReviewReason =
  | "image_file_not_processed"
  | "large_pdf_requires_chunking"
  | "cross_year_mismatch"
  | "duplicate_candidate"
  | "ambiguous_doc_type"
  | "low_confidence_extraction"
  | "parse_failure";

/** Structured audit warning — replaces ad-hoc string union on FinancialState */
export type WarningFlag = {
  type: ReviewReason;
  detail: string;
  documentId: string;
  transactionId?: string;
};

export type FinancialDocument = {
  id: string;
  fileName: string;
  relativePath: string | null;
  classification: string;
  confidence: number;
  ingestStatus: IngestStatus;
  /** True when ingestStatus !== ingested (human or system follow-up expected) */
  requiresReview: boolean;
  fileSizeBytes: number | null;
};

export type Transaction = {
  id: string;
  date: string | null;
  description: string;
  amount: number;
  direction: "inflow" | "outflow";
  rawCategory: string | null;
  scheduleCCategory: string | null;
  confidence: number;
  flags: string[];
  sourceDocumentId: string;
};

export type ExpenseCandidate = {
  id: string;
  amount: number;
  description: string;
  date: string | null;
  sourceDocumentId: string;
  scheduleCCategory: string | null;
  flags: string[];
};

export type Pattern = {
  id: string;
  type: string;
  transactionIds: string[];
  confidence: number;
  signals: string[];
};

export type AuditRef = {
  documentId: string;
  transactionId?: string;
};

export type FinancialState = {
  documents: FinancialDocument[];
  transactions: Transaction[];
  expenseCandidates: ExpenseCandidate[];
  patterns: Pattern[];
  warnings: WarningFlag[];
  confidence: number;
  auditTrail: AuditRef[];
};

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/** Build expense candidates + transactions from normalized ingest expense line items */
export function buildTransactionsFromExpenseItems(
  sourceDocumentId: string,
  _fileName: string,
  items: Array<{
    category: string;
    description: string;
    amount: number;
    date?: string;
    schedule_c_category?: string | null;
    confidence?: number;
    flags?: string[];
  }>,
): { transactions: Transaction[]; candidates: ExpenseCandidate[] } {
  const transactions: Transaction[] = [];
  const candidates: ExpenseCandidate[] = [];

  for (const item of items) {
    const amt = Math.abs(Number(item.amount) || 0);
    if (amt <= 0) continue;

    const tid = nextId("tx");
    const sched = item.schedule_c_category ?? null;
    const flags = Array.isArray(item.flags) ? [...item.flags] : [];
    if (!sched) flags.push("uncategorized");

    const tx: Transaction = {
      id: tid,
      date: item.date || null,
      description: item.description || "",
      amount: amt,
      direction: "outflow",
      rawCategory: item.category || null,
      scheduleCCategory: sched,
      confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
      flags,
      sourceDocumentId,
    };
    transactions.push(tx);

    candidates.push({
      id: nextId("ex"),
      amount: amt,
      description: item.description || "",
      date: item.date || null,
      sourceDocumentId,
      scheduleCCategory: sched,
      flags,
    });
  }

  return { transactions, candidates };
}

export function emptyFinancialState(): FinancialState {
  return {
    documents: [],
    transactions: [],
    expenseCandidates: [],
    patterns: [],
    warnings: [],
    confidence: 1,
    auditTrail: [],
  };
}
