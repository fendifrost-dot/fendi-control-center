import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { findClientTaxFolder, listFilesRecursiveWithPaths, downloadFile } from '../_shared/googleDriveRead.ts';
import { upsertTaxReturn, getTaxReturn } from '../_shared/taxReturns.ts';
import { classifyDocument, type DocClass, type DocClassification } from '../_shared/docClassifier.ts';
import { pickSystemPrompt } from '../_shared/ingestPrompts.ts';
import { analyzeDocumentWithGemini } from '../_shared/geminiParser.ts';
import { extractStatementChunk, type StatementChunkTx } from '../_shared/geminiParser.ts';
import { splitPdfIntoPages, isScannedPage } from '../_shared/pdfSplitter.ts';
import { chunkPages } from '../_shared/chunker.ts';
import { ocrPage } from '../_shared/ocr.ts';
import { mergeChunkResults } from '../_shared/statementMerger.ts';
import {
  SCHEDULE_C_CATEGORIES,
  UNCLASSIFIED_SCHEDULE_C,
  emptyScheduleCExpenseTotals,
  type ScheduleCCategoryKey,
} from '../_shared/categories.ts';
import {
  buildTransactionsFromExpenseItems,
  emptyFinancialState,
  type FinancialState,
  type Transaction,
  type IngestStatus,
  type ReviewReason,
} from '../_shared/financialState.ts';
import { detectPatterns } from '../_shared/patternEngine.ts';
import { retrieveTaxKnowledge } from '../_shared/taxKnowledge.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const INGEST_VERSION = "async-chunk-v3";
const EDGE_SAFE_BYTE_LIMIT = 80_000_000;

/** Persisted between process_single calls; aggregate reads this from tax_returns.analyzed_data */
const DRIVE_INGEST_SESSION_KEY = 'drive_ingest_session';
const STATEMENT_CHUNK_JOBS_KEY = 'statement_chunk_jobs';

interface IncomeItem {
  source: string;
  type: string;
  amount: number;
  payer_name?: string;
  payer_ein?: string;
  date?: string;
}

interface ExpenseItem {
  category: string;
  description: string;
  amount: number;
  payee?: string;
  /** Bank / institution from statement header (normalized ingest) */
  source_institution?: string;
  date?: string;
  /** Banking / receipt raw label — not IRS */
  raw_category?: string;
  /** Schedule C key when adjudicated; null until Layer 5+ */
  schedule_c_category?: string | null;
  confidence?: number;
  flags?: string[];
  needs_review?: boolean;
}

interface ExtractedData {
  doc_type: string;
  classification: string;
  extracted_data: {
    income_items: IncomeItem[];
    expense_items: ExpenseItem[];
    payer_info: Record<string, string>;
    metadata?: Record<string, unknown>;
  };
}

interface PLSummary {
  total_income: number;
  income_by_category: Record<string, number>;
  total_expenses: number;
  expenses_by_category: Record<string, number>;
  net_income: number;
}

interface IngestResult {
  documentId: string;
  docClass: DocClass;
  extracted?: ExtractedData;
  skipped?: boolean;
  skipReason?: string;
}

interface DriveIngestFileRecord {
  file_id: string;
  file_name: string;
  file_mime?: string;
  docClass: DocClass;
  extracted?: ExtractedData;
  skipped?: boolean;
  skipReason?: string;
  status: 'success' | 'skipped' | 'error';
  error?: string;
  /** From mode=list / classify — e.g. CHASE 2022/2022.pdf */
  relative_path?: string;
  file_size_bytes?: number;
  ingest_status?: IngestStatus | LineageStatus;
  duplicate_status?: 'none' | 'duplicate_exact' | 'duplicate_probable';
  canonical_file_id?: string;
  warning_flags?: string[];
  reason_codes?: string[];
}

interface DriveIngestSession {
  folder_id: string;
  folder_name: string;
  client_name: string;
  tax_year: number;
  files: Record<string, DriveIngestFileRecord>;
  started_at?: string;
}

type LineageStatus =
  | 'processed'
  | 'processing_chunked'
  | 'requires_async_processing'
  | 'chunk_processing_failed'
  | 'chunk_failed'
  | 'partial_success'
  | 'requires_review'
  | 'requires_chunking'
  | 'failed_extraction'
  | 'duplicate_exact'
  | 'duplicate_probable'
  | 'year_mismatch';

type IngestFileLineage = {
  file_id: string;
  file_name: string;
  relative_path: string | null;
  doc_class: DocClass;
  status: LineageStatus;
  file_size: number | null;
  duplicate_status: 'none' | 'duplicate_exact' | 'duplicate_probable';
  canonical_file_id: string | null;
  extracted_income_total: number;
  extracted_expense_total: number;
  income_item_count: number;
  expense_item_count: number;
  warning_flags: string[];
  reason_codes: string[];
  chunk_count?: number;
  pages_total?: number;
  pages_processed?: number;
  pages_failed?: number;
  transactions_extracted?: number;
};

type StatementChunkJob = {
  job_id: string;
  client_id: string;
  tax_year: number;
  file_id: string;
  file_name: string;
  relative_path: string | null;
  file_size_bytes: number;
  chunk_size_pages: number;
  chunk_count: number;
  pages_total: number;
  status: 'requires_async_processing' | 'processing_chunked' | 'completed' | 'chunk_processing_failed';
  created_at: string;
  updated_at: string;
};

function useGeminiForTax(): boolean {
  const k = Deno.env.get('Frost_Gemini');
  return typeof k === 'string' && k.length > 0;
}

async function analyzeDocumentWithClaude(
  base64Content: string,
  fileName: string,
  mimeType: string,
  injectedSystemPrompt?: string,
): Promise<ExtractedData> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  const systemPrompt = injectedSystemPrompt ?? `You are a tax document analyzer. Extract ALL financial data from this document.

Return ONLY valid JSON with this exact structure:
{
  "doc_type": "W-2" | "1099-NEC" | "1099-K" | "1099-MISC" | "1099-INT" | "1099-DIV" | "1099-B" | "1098" | "receipt" | "invoice" | "bank_statement" | "other",
  "classification": "income" | "expense" | "deduction" | "mixed",
  "extracted_data": {
    "income_items": [{ "source": "...", "type": "wages|contractor|interest|dividends|capital_gains|other", "amount": 0.00, "payer_name": "...", "payer_ein": "...", "date": "YYYY-MM-DD" }],
    "expense_items": [{ "category": "business|medical|charitable|education|home_office|vehicle|supplies|other", "description": "...", "amount": 0.00, "payee": "...", "date": "YYYY-MM-DD" }],
    "payer_info": { "name": "...", "ein": "...", "address": "..." }
  }
}`;

  const content: Array<Record<string, unknown>> = [];

  if (isPdf) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Content,
      },
    });
    content.push({
      type: 'text',
      text: `Analyze this tax document (${fileName}). Extract all financial data including dollar amounts, payer names, EINs, and dates.`,
    });
  } else if (isImage) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: base64Content,
      },
    });
    content.push({
      type: 'text',
      text: `Analyze this tax document (${fileName}). Extract all financial data including dollar amounts, payer names, EINs, and dates.`,
    });
  } else {
    let decodedText: string;
    try {
      decodedText = atob(base64Content);
    } catch {
      decodedText = base64Content;
    }
    content.push({
      type: 'text',
      text: `Analyze this tax document (${fileName}). Content:\n\n${decodedText}\n\nExtract all financial data.`,
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  const textContent = result.content?.find((c: Record<string, unknown>) => c.type === 'text');
  if (!textContent?.text) throw new Error('No text response from Claude');

  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Claude response');

  const parsed = JSON.parse(jsonMatch[0]);
  // Spread raw parsed JSON onto defaults so that normalizeToExtractedData()
  // in analyzeDocumentRouter can detect the specialized prompt response shape
  // (form_subtype, boxes, employer, federal, etc.) and convert properly.
  return {
    doc_type: parsed.doc_type || 'other',
    classification: parsed.classification || 'mixed',
    extracted_data: {
      income_items: parsed.extracted_data?.income_items || [],
      expense_items: parsed.extracted_data?.expense_items || [],
      payer_info: parsed.extracted_data?.payer_info || { name: '', ein: '', address: '' },
    },
    ...parsed,
  } as ExtractedData;
}

/**
 * Normalize raw LLM JSON into the canonical ExtractedData shape.
 *
 * The specialized prompts (INCOME_1099_PROMPT, INCOME_W2_PROMPT, etc.) return
 * different JSON schemas than the default ExtractedData format. This function
 * detects the response shape and converts it so that aggregatePL() always
 * receives uniform data.
 */
function isDebitExpense(tx: Record<string, unknown>): boolean {
  const amount = Number(tx.amount);
  const type = String(tx.type || '').toLowerCase();
  const cat = String(tx.category || '').toLowerCase();
  if (Number.isFinite(amount) && amount < 0) return true;
  if (['withdrawal', 'payment', 'fee', 'debit', 'purchase'].includes(type)) return true;
  return ['withdrawal', 'payment', 'fee', 'debit', 'purchase'].some((k) => cat.includes(k));
}

function normalizeToExtractedData(raw: Record<string, unknown>): ExtractedData {
  // ── 1099 format (from INCOME_1099_PROMPT) ──────────────────────
  if ('form_subtype' in raw || ('boxes' in raw && 'payer' in raw)) {
    const subtype = String(raw.form_subtype || 'other').toUpperCase();
    const docType = subtype === 'OTHER' ? '1099' : `1099-${subtype}`;
    const boxes = (raw.boxes || {}) as Record<string, number>;
    const payer = (raw.payer || {}) as Record<string, string>;

    const incomeItems: IncomeItem[] = [];
    for (const [label, amount] of Object.entries(boxes)) {
      if (typeof amount !== 'number' || amount <= 0) continue;
      // Skip withholding / indicator boxes — they are not income
      if (label.includes('withheld') || label.includes('tax') || label.includes('indicator')) continue;
      incomeItems.push({
        source: label,
        type: 'contractor',
        amount,
        payer_name: payer.name || '',
        payer_ein: payer.tin || '',
      });
    }

    return {
      doc_type: docType,
      classification: 'income',
      extracted_data: {
        income_items: incomeItems,
        expense_items: [],
        payer_info: {
          name: payer.name || '',
          ein: payer.tin || '',
          address: payer.address || '',
        },
      },
    };
  }

  // ── W-2 format (from INCOME_W2_PROMPT) ─────────────────────────
  if ('employer' in raw && 'federal' in raw) {
    const employer = (raw.employer || {}) as Record<string, string>;
    const federal = (raw.federal || {}) as Record<string, number>;

    const wages = Number(federal.box_1_wages_tips_other) || 0;
    const incomeItems: IncomeItem[] = [];
    if (wages > 0) {
      incomeItems.push({
        source: 'W-2 Wages',
        type: 'wages',
        amount: wages,
        payer_name: employer.name || '',
        payer_ein: employer.ein || '',
      });
    }

    return {
      doc_type: 'W-2',
      classification: 'income',
      extracted_data: {
        income_items: incomeItems,
        expense_items: [],
        payer_info: {
          name: employer.name || '',
          ein: employer.ein || '',
          address: '',
        },
      },
    };
  }

  // ── Financial statement format (from FINANCIAL_STATEMENT_PROMPT / requires_review) ─
  if ('account_type' in raw && 'institution_name' in raw) {
    const transactions = Array.isArray(raw.transactions) ? (raw.transactions as Record<string, unknown>[]) : [];
    const expenseTransactions = transactions.filter((tx) => isDebitExpense(tx));

    const institution = String(raw.institution_name || '');
    const expense_items: ExpenseItem[] = expenseTransactions.map((tx) => {
      const rawCat = String(tx.type || tx.category || 'unknown');
      return {
        category: rawCat,
        raw_category: rawCat,
        description: String(tx.description || ''),
        amount: Math.abs(Number(tx.amount) || 0),
        payee: institution,
        source_institution: institution,
        date: tx.date != null && tx.date !== '' ? String(tx.date) : '',
        schedule_c_category: null,
        confidence: typeof tx.confidence === 'number' ? tx.confidence : 0.5,
        flags: ['bank_extract', 'needs_review'],
        needs_review: true,
      };
    });

    const meta = {
      account_type: raw.account_type,
      institution: raw.institution_name,
      statement_period: raw.statement_period ?? null,
      total_transactions: transactions.length,
      expense_transactions: expenseTransactions.length,
      skipped_income_transactions: transactions.length - expenseTransactions.length,
    };

    return {
      doc_type: 'bank_statement',
      classification: 'expense',
      extracted_data: {
        income_items: [],
        expense_items,
        payer_info: {
          name: institution,
          ein: '',
          address: '',
        },
        metadata: meta,
      },
    };
  }

  // ── Receipt / invoice format (from RECEIPT_OR_INVOICE_PROMPT) ───
  if ('vendor_name' in raw && 'line_items' in raw) {
    const lineItems = (raw.line_items || []) as Array<Record<string, unknown>>;
    const expenseItems: ExpenseItem[] = lineItems.map((item) => ({
      category: String(item.category || 'other'),
      raw_category: String(item.category || 'other'),
      description: String(item.description || ''),
      amount: Number(item.amount) || 0,
      payee: String(raw.vendor_name || ''),
      date: String(item.date || raw.date || ''),
      schedule_c_category: null,
      confidence: 0.6,
      flags: ['receipt_extract', 'needs_review'],
      needs_review: true,
    }));

    return {
      doc_type: 'receipt',
      classification: 'expense',
      extracted_data: {
        income_items: [],
        expense_items: expenseItems,
        payer_info: {
          name: String(raw.vendor_name || ''),
          ein: '',
          address: '',
        },
      },
    };
  }

  // Already in ExtractedData shape (default prompt)
  if (
    typeof raw.doc_type === 'string' &&
    raw.doc_type !== 'other' &&
    raw.extracted_data &&
    typeof raw.extracted_data === 'object'
  ) {
    const ed = raw.extracted_data as Record<string, unknown>;
    const expense_items = ((ed.expense_items as ExpenseItem[]) || []).map((e) => ({
      ...e,
      schedule_c_category: e.schedule_c_category ?? null,
      raw_category: e.raw_category ?? e.category,
      flags: e.flags ?? [],
    }));
    return {
      doc_type: raw.doc_type as string,
      classification: (raw.classification as string) || 'mixed',
      extracted_data: {
        income_items: (ed.income_items as IncomeItem[]) || [],
        expense_items,
        payer_info: (ed.payer_info as Record<string, string>) || { name: '', ein: '', address: '' },
        metadata: (ed.metadata as Record<string, unknown>) || undefined,
      },
    };
  }

  // ── Fallback — try to salvage whatever fields exist ─────────────
  const fallbackEd = (raw.extracted_data || {}) as Record<string, unknown>;
  return {
    doc_type: String(raw.doc_type || raw.document_type || 'other'),
    classification: String(raw.classification || 'mixed'),
    extracted_data: {
      income_items: (fallbackEd.income_items as IncomeItem[]) || [],
      expense_items: (fallbackEd.expense_items as ExpenseItem[]) || [],
      payer_info: (fallbackEd.payer_info as Record<string, string>) || { name: '', ein: '', address: '' },
    },
  };
}

async function analyzeDocumentRouter(
  base64Content: string,
  fileName: string,
  mimeType: string,
  systemPrompt: string,
): Promise<ExtractedData> {
  let raw: ExtractedData;
  if (useGeminiForTax()) {
    raw = await analyzeDocumentWithGemini(base64Content, fileName, mimeType, systemPrompt);
  } else {
    raw = await analyzeDocumentWithClaude(base64Content, fileName, mimeType, systemPrompt);
  }
  // Normalize: the specialized prompts return different JSON schemas
  // than the default ExtractedData shape. normalizeToExtractedData()
  // detects the response format and converts it uniformly.
  const normalized = normalizeToExtractedData(raw as unknown as Record<string, unknown>);
  console.log(`[ingest] normalized doc_type=${normalized.doc_type} income_items=${normalized.extracted_data.income_items.length} expense_items=${normalized.extracted_data.expense_items.length}`);
  return normalized;
}

function expenseBucket(item: ExpenseItem): ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C {
  const s = item.schedule_c_category;
  if (typeof s === 'string' && s in SCHEDULE_C_CATEGORIES) return s as ScheduleCCategoryKey;
  return UNCLASSIFIED_SCHEDULE_C;
}

function toLowerSafe(v: unknown): string {
  return String(v ?? '').toLowerCase();
}

function normalizedNameForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\(\s*\d+\s*\)/g, '')
    .replace(/\bcopy\b/g, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

function statementLike(docClass: DocClass, fileName: string, relativePath: string | null, extracted?: ExtractedData): boolean {
  if (docClass === 'financial_statement') return true;
  const hay = `${toLowerSafe(fileName)} ${toLowerSafe(relativePath)} ${toLowerSafe(extracted?.doc_type)}`;
  if (/(statement|sttmnt|stmt|chase|chime|checking|account)/.test(hay)) return true;
  const md = extracted?.extracted_data?.metadata ?? {};
  if ('account_type' in md || 'institution' in md || 'statement_period' in md) return true;
  return false;
}

function enforceStatementIncomeHardBlock(
  extracted: ExtractedData,
  docClass: DocClass,
  fileName: string,
  relativePath: string | null,
): { blocked: boolean; reason?: string } {
  if (!statementLike(docClass, fileName, relativePath, extracted)) return { blocked: false };
  if (extracted.extracted_data.income_items.length === 0) return { blocked: false };
  extracted.extracted_data.income_items = [];
  return { blocked: true, reason: 'statement_income_hard_block' };
}

function extractYearHint(fileName: string, relativePath: string | null, extracted?: ExtractedData): number | null {
  const hay = `${fileName} ${relativePath ?? ''}`;
  const m = hay.match(/\b(20\d{2})\b/);
  if (m) return Number(m[1]);
  const period = extracted?.extracted_data?.metadata?.statement_period;
  const periodMatch = String(period ?? '').match(/\b(20\d{2})\b/);
  return periodMatch ? Number(periodMatch[1]) : null;
}

function summarizeExtracted(extracted?: ExtractedData): {
  incomeTotal: number;
  expenseTotal: number;
  incomeCount: number;
  expenseCount: number;
} {
  if (!extracted) return { incomeTotal: 0, expenseTotal: 0, incomeCount: 0, expenseCount: 0 };
  const incomeTotal = extracted.extracted_data.income_items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const expenseTotal = extracted.extracted_data.expense_items.reduce((s, i) => s + Math.abs(Number(i.amount) || 0), 0);
  return {
    incomeTotal: Math.round(incomeTotal * 100) / 100,
    expenseTotal: Math.round(expenseTotal * 100) / 100,
    incomeCount: extracted.extracted_data.income_items.length,
    expenseCount: extracted.extracted_data.expense_items.length,
  };
}

function buildCoverage(lineage: IngestFileLineage[]): Record<string, number> {
  const statements = lineage.filter((l) => l.doc_class === 'financial_statement');
  const incomeDocs = lineage.filter((l) => l.doc_class === 'income_1099' || l.doc_class === 'income_w2');
  return {
    statements_detected: statements.length,
    statements_processed: statements.filter((l) => l.status === 'processed' || l.status === 'partial_success').length,
    statements_requires_chunking: statements.filter((l) => l.status === 'requires_chunking').length,
    statements_failed: statements.filter((l) =>
      l.status === 'failed_extraction' ||
      l.status === 'chunk_processing_failed' ||
      l.status === 'requires_async_processing'
    ).length,
    income_docs_detected: incomeDocs.length,
    income_docs_processed: incomeDocs.filter((l) => l.status === 'processed').length,
  };
}

function isErrorLikeStatus(status: string): boolean {
  return status === 'error' ||
    status === 'failed_extraction' ||
    status === 'chunk_processing_failed' ||
    status === 'requires_async_processing' ||
    status === 'requires_chunking';
}

async function processChunkedStatement(
  bytes: Uint8Array,
  fileName: string,
  maxPages = 150,
): Promise<{
  extracted: ExtractedData | null;
  status: LineageStatus;
  chunk_count: number;
  pages_total: number;
  pages_processed: number;
  pages_failed: number;
  transactions_extracted: number;
  reason_codes: string[];
}> {
  const pages = await splitPdfIntoPages(bytes);
  const bounded = pages.slice(0, maxPages);
  const chunks = chunkPages(bounded, 5);
  const chunkResults: StatementChunkTx[][] = [];
  let pagesProcessed = 0;
  let pagesFailed = 0;
  const reason_codes: string[] = [];

  for (const chunk of chunks) {
    let chunkText = '';
    for (const page of chunk.pages) {
      let t = page.text ?? '';
      if (isScannedPage(page)) {
        t = await ocrPage(page);
      }
      if (t.trim().length === 0) {
        pagesFailed += 1;
      } else {
        pagesProcessed += 1;
      }
      chunkText += `\n--- PAGE ${page.pageNumber} ---\n${t}`;
    }

    let ok = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const extracted = await extractStatementChunk(chunkText);
        chunkResults.push(extracted.transactions);
        ok = true;
        break;
      } catch (e) {
        if (attempt === 1) {
          reason_codes.push(`chunk_failed:${chunk.index}:${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (!ok) {
      pagesFailed += chunk.pages.length;
    }
  }

  const merged = mergeChunkResults(chunkResults);
  const expense_items: ExpenseItem[] = merged.map((t) => ({
    category: 'withdrawal',
    raw_category: 'statement_chunk_extract',
    description: t.description,
    amount: Math.abs(Number(t.amount) || 0),
    date: t.date,
    schedule_c_category: null,
    confidence: 0.55,
    flags: ['chunk_extract', 'needs_review'],
    needs_review: true,
  }));

  if (merged.length === 0) {
    return {
      extracted: null,
      status: reason_codes.length > 0 ? 'failed_extraction' : 'requires_chunking',
      chunk_count: chunks.length,
      pages_total: bounded.length,
      pages_processed: pagesProcessed,
      pages_failed: pagesFailed,
      transactions_extracted: 0,
      reason_codes: reason_codes.length > 0 ? reason_codes : ['no_transactions_extracted'],
    };
  }

  const extracted: ExtractedData = {
    doc_type: 'bank_statement',
    classification: 'expense',
    extracted_data: {
      income_items: [],
      expense_items,
      payer_info: { name: '', ein: '', address: '' },
      metadata: {
        chunk_count: chunks.length,
        pages_total: bounded.length,
        pages_processed: pagesProcessed,
        pages_failed: pagesFailed,
      },
    },
  };

  const partial = pagesFailed > 0 || reason_codes.some((r) => r.startsWith('chunk_failed:'));
  return {
    extracted,
    status: partial ? 'partial_success' : 'processed',
    chunk_count: chunks.length,
    pages_total: bounded.length,
    pages_processed: pagesProcessed,
    pages_failed: pagesFailed,
    transactions_extracted: merged.length,
    reason_codes,
  };
}

function aggregatePL(allExtracted: ExtractedData[]): PLSummary {
  const incomeByCategory: Record<string, number> = {
    'W-2 Wages': 0,
    '1099-NEC': 0,
    '1099-K': 0,
    '1099-MISC': 0,
    '1099-INT': 0,
    '1099-DIV': 0,
    'Capital Gains': 0,
    'Other Income': 0,
  };

  const expensesByCategory = emptyScheduleCExpenseTotals() as unknown as Record<string, number>;

  for (const doc of allExtracted) {
    const md = doc.extracted_data.metadata ?? {};
    const docTypeLower = toLowerSafe(doc.doc_type);
    const statementDoc =
      docTypeLower.includes('statement') ||
      docTypeLower.includes('bank') ||
      ('account_type' in md || 'institution' in md || 'statement_period' in md);
    for (const item of doc.extracted_data.income_items) {
      if (statementDoc) continue;
      const amount = Number(item.amount) || 0;
      switch (doc.doc_type) {
        case 'W-2':
          incomeByCategory['W-2 Wages'] += amount;
          break;
        case '1099-NEC':
          incomeByCategory['1099-NEC'] += amount;
          break;
        case '1099-K':
          incomeByCategory['1099-K'] += amount;
          break;
        case '1099-MISC':
          incomeByCategory['1099-MISC'] += amount;
          break;
        case '1099-INT':
          incomeByCategory['1099-INT'] += amount;
          break;
        case '1099-DIV':
          incomeByCategory['1099-DIV'] += amount;
          break;
        case '1099-B':
          incomeByCategory['Capital Gains'] += amount;
          break;
        default:
          if (item.type === 'wages') incomeByCategory['W-2 Wages'] += amount;
          else if (item.type === 'contractor') incomeByCategory['1099-NEC'] += amount;
          else if (item.type === 'interest') incomeByCategory['1099-INT'] += amount;
          else if (item.type === 'dividends') incomeByCategory['1099-DIV'] += amount;
          else if (item.type === 'capital_gains') incomeByCategory['Capital Gains'] += amount;
          else incomeByCategory['Other Income'] += amount;
      }
    }

    for (const item of doc.extracted_data.expense_items) {
      const amount = Number(item.amount) || 0;
      const bucket = expenseBucket(item);
      expensesByCategory[bucket] = (expensesByCategory[bucket] ?? 0) + amount;
    }
  }

  const totalIncome = Object.values(incomeByCategory).reduce((s, v) => s + v, 0);
  const totalExpenses = Object.values(expensesByCategory).reduce((s, v) => s + v, 0);

  return {
    total_income: Math.round(totalIncome * 100) / 100,
    income_by_category: incomeByCategory,
    total_expenses: Math.round(totalExpenses * 100) / 100,
    expenses_by_category: expensesByCategory,
    net_income: Math.round((totalIncome - totalExpenses) * 100) / 100,
  };
}

type StagedIngestDoc = {
  docId: string;
  fileName: string;
  docClass: DocClass;
  extracted: ExtractedData;
  relativePath: string | null;
  fileSizeBytes: number | null;
  /** True when file exceeds single-call LLM size guidance (chunking not yet implemented) */
  largePdfWarning?: boolean;
};

type SkippedIngestDoc = {
  docId: string;
  fileName: string;
  docClass: DocClass;
  skipReason: string;
  relativePath: string | null;
  fileSizeBytes: number | null;
  kind: 'policy_skip' | 'error';
};

function dedupeAndBuildLineage(
  taxYear: number,
  staged: StagedIngestDoc[],
  skippedDocs: SkippedIngestDoc[],
): { canonical: StagedIngestDoc[]; lineage: IngestFileLineage[]; suppressed: SkippedIngestDoc[] } {
  const canonical: StagedIngestDoc[] = [];
  const lineage: IngestFileLineage[] = [];
  const suppressed: SkippedIngestDoc[] = [];
  const seenStrong = new Map<string, StagedIngestDoc>();
  const seenProbable = new Map<string, StagedIngestDoc>();

  for (const s of staged) {
    const norm = normalizedNameForDedup(s.fileName);
    const sz = s.fileSizeBytes ?? 0;
    const strongKey = `${norm}|${sz}`;
    const idSig = (() => {
      const z = summarizeExtracted(s.extracted);
      const payer = toLowerSafe(s.extracted.extracted_data.payer_info?.name);
      const yr = extractYearHint(s.fileName, s.relativePath, s.extracted) ?? 0;
      return `${s.docClass}|${payer}|${yr}|${z.incomeTotal}|${z.expenseTotal}`;
    })();

    const existingStrong = seenStrong.get(strongKey);
    const existingProbable = seenProbable.get(idSig);
    const dupeOf = existingStrong ?? existingProbable;
    const yearHint = extractYearHint(s.fileName, s.relativePath, s.extracted);
    const crossYear = yearHint != null && yearHint !== taxYear;
    const z = summarizeExtracted(s.extracted);
    const md = (s.extracted.extracted_data.metadata ?? {}) as Record<string, unknown>;
    const chunk_count = Number(md.chunk_count) || undefined;
    const pages_total = Number(md.pages_total) || undefined;
    const pages_processed = Number(md.pages_processed) || undefined;
    const pages_failed = Number(md.pages_failed) || undefined;
    const flags: string[] = [];
    const reasons: string[] = [];
    let status: LineageStatus = 'processed';
    let duplicate_status: IngestFileLineage['duplicate_status'] = 'none';
    let canonical_file_id: string | null = null;

    if (dupeOf) {
      canonical_file_id = dupeOf.docId;
      if (existingStrong) {
        status = 'duplicate_exact';
        duplicate_status = 'duplicate_exact';
      } else {
        status = 'duplicate_probable';
        duplicate_status = 'duplicate_probable';
      }
      flags.push('duplicate_candidate');
      reasons.push('duplicate_suppressed_from_totals');
      suppressed.push({
        docId: s.docId,
        fileName: s.fileName,
        docClass: s.docClass,
        skipReason: existingStrong ? 'duplicate_exact' : 'duplicate_probable',
        relativePath: s.relativePath,
        fileSizeBytes: s.fileSizeBytes,
        kind: 'policy_skip',
      });
    } else if (crossYear) {
      status = 'year_mismatch';
      flags.push('cross_year_candidate');
      reasons.push(`year_mismatch:${yearHint}->${taxYear}`);
      suppressed.push({
        docId: s.docId,
        fileName: s.fileName,
        docClass: s.docClass,
        skipReason: `cross_year_mismatch:${yearHint}->${taxYear}`,
        relativePath: s.relativePath,
        fileSizeBytes: s.fileSizeBytes,
        kind: 'policy_skip',
      });
    } else {
      canonical.push(s);
      seenStrong.set(strongKey, s);
      seenProbable.set(idSig, s);
    }

    lineage.push({
      file_id: s.docId,
      file_name: s.fileName,
      relative_path: s.relativePath,
      doc_class: s.docClass,
      status,
      file_size: s.fileSizeBytes,
      duplicate_status,
      canonical_file_id,
      extracted_income_total: status.startsWith('duplicate') || status === 'year_mismatch' ? 0 : z.incomeTotal,
      extracted_expense_total: status.startsWith('duplicate') || status === 'year_mismatch' ? 0 : z.expenseTotal,
      income_item_count: status.startsWith('duplicate') || status === 'year_mismatch' ? 0 : z.incomeCount,
      expense_item_count: status.startsWith('duplicate') || status === 'year_mismatch' ? 0 : z.expenseCount,
      warning_flags: flags,
      reason_codes: reasons,
      chunk_count,
      pages_total,
      pages_processed,
      pages_failed,
      transactions_extracted: status.startsWith('duplicate') || status === 'year_mismatch' ? 0 : z.expenseCount,
    });
  }

  for (const sk of skippedDocs) {
    lineage.push({
      file_id: sk.docId,
      file_name: sk.fileName,
      relative_path: sk.relativePath,
      doc_class: sk.docClass,
      status: sk.kind === 'error' ? 'failed_extraction' : 'requires_review',
      file_size: sk.fileSizeBytes,
      duplicate_status: 'none',
      canonical_file_id: null,
      extracted_income_total: 0,
      extracted_expense_total: 0,
      income_item_count: 0,
      expense_item_count: 0,
      warning_flags: ['requires_review'],
      reason_codes: [sk.skipReason],
    });
  }

  return { canonical, lineage, suppressed };
}

function inferPolicySkipIngestStatus(docClass: DocClass): IngestStatus {
  if (docClass === 'requires_review') return 'requires_review';
  return 'classified_only';
}

function inferIngestStatusFromSkip(skipReason: string, docClass: DocClass): IngestStatus {
  if (skipReason.includes('requires_async_processing')) return 'requires_async_processing';
  if (skipReason.includes('chunk_processing_failed')) return 'chunk_processing_failed';
  if (skipReason.includes('large_pdf_requires_chunking')) return 'requires_chunking';
  if (skipReason.includes('image_file_not_processed')) return 'image_not_processed';
  if (skipReason.includes('duplicate_exact')) return 'duplicate_exact';
  if (skipReason.includes('duplicate_probable')) return 'duplicate_probable';
  if (skipReason.includes('duplicate_')) return 'skipped_duplicate';
  if (skipReason.includes('cross_year_mismatch')) return 'requires_review';
  return inferPolicySkipIngestStatus(docClass);
}

function buildIngestFinancialState(
  staged: StagedIngestDoc[],
  skippedDocs: SkippedIngestDoc[] = [],
): FinancialState {
  const state = emptyFinancialState();
  const allTx: Transaction[] = [];

  for (const sk of skippedDocs) {
    const ingestStatus: IngestStatus = sk.kind === 'error'
      ? 'requires_review'
      : inferIngestStatusFromSkip(sk.skipReason, sk.docClass);
    const wr: ReviewReason = sk.kind === 'error'
      ? 'parse_failure'
      : sk.skipReason.includes('image_file_not_processed')
      ? 'image_file_not_processed'
      : sk.skipReason.includes('large_pdf_requires_chunking')
      ? 'large_pdf_requires_chunking'
      : sk.skipReason.includes('cross_year_mismatch')
      ? 'cross_year_mismatch'
      : sk.skipReason.includes('duplicate_')
      ? 'duplicate_candidate'
      : 'ambiguous_doc_type';
    state.documents.push({
      id: sk.docId,
      fileName: sk.fileName,
      relativePath: sk.relativePath,
      classification: sk.docClass,
      confidence: 0.55,
      ingestStatus,
      requiresReview: ingestStatus !== 'ingested',
      fileSizeBytes: sk.fileSizeBytes,
    });
    state.warnings.push({
      type: wr,
      detail: sk.skipReason,
      documentId: sk.docId,
    });
  }

  for (const s of staged) {
    const ingestStatus: IngestStatus = 'ingested';
    state.documents.push({
      id: s.docId,
      fileName: s.fileName,
      relativePath: s.relativePath,
      classification: s.docClass,
      confidence: 0.7,
      ingestStatus,
      requiresReview: false,
      fileSizeBytes: s.fileSizeBytes,
    });

    if (s.largePdfWarning) {
      state.warnings.push({
        type: 'large_pdf_requires_chunking',
        detail:
          'PDF exceeds single-call size guidance; chunked ingest not yet implemented — review extraction quality',
        documentId: s.docId,
      });
    }

    const { transactions, candidates } = buildTransactionsFromExpenseItems(
      s.docId,
      s.fileName,
      s.extracted.extracted_data.expense_items.map((e) => ({
        category: e.category,
        description: e.description,
        amount: e.amount,
        date: e.date,
        schedule_c_category: e.schedule_c_category ?? null,
        confidence: e.confidence,
        flags: e.flags,
      })),
    );
    state.transactions.push(...transactions);
    state.expenseCandidates.push(...candidates);
    allTx.push(...transactions);
    for (const t of transactions) {
      state.auditTrail.push({ documentId: s.docId, transactionId: t.id });
    }

    const uncat = transactions.filter((t) => !t.scheduleCCategory);
    if (uncat.length > 0) {
      state.warnings.push({
        type: 'ambiguous_doc_type',
        detail:
          `${uncat.length} bank expense line(s) have no Schedule C line (schedule_c_category null — pending adjudication)`,
        documentId: s.docId,
      });
    }
  }

  state.patterns = detectPatterns(allTx);
  state.confidence = staged.length + skippedDocs.length > 0 ? 0.85 : 1;
  return state;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    for (let j = i; j < Math.min(i + chunk, bytes.length); j++) {
      binary += String.fromCharCode(bytes[j]!);
    }
  }
  return btoa(binary);
}

async function safeWriteToTaxSupabase(
  endpoint: string,
  data: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  try {
    await writeToTaxSupabase(endpoint, data);
  } catch (e) {
    console.warn(`[ingest-tax-documents] CC Tax write skipped (${endpoint}):`, e);
  }
}

function fileAnalyzable(classification: DocClassification): boolean {
  return pickSystemPrompt(classification.docClass) !== null;
}

async function mergeDriveIngestSession(
  hub: SupabaseClient,
  clientId: string,
  clientName: string,
  taxYear: number,
  folderId: string,
  folderName: string,
  fileRecord: DriveIngestFileRecord,
): Promise<void> {
  const existing = await getTaxReturn(hub, clientId, taxYear);
  const prev = (existing?.analyzed_data as Record<string, unknown> | null) || {};
  const sessionRaw = prev[DRIVE_INGEST_SESSION_KEY] as DriveIngestSession | undefined;
  const session: DriveIngestSession = sessionRaw ?? {
    folder_id: folderId,
    folder_name: folderName,
    client_name: clientName,
    tax_year: taxYear,
    files: {},
    started_at: new Date().toISOString(),
  };
  session.folder_id = folderId;
  session.folder_name = folderName;
  session.client_name = clientName;
  session.tax_year = taxYear;
  session.files[fileRecord.file_id] = fileRecord;

  await upsertTaxReturn(hub, {
    client_id: clientId,
    client_name: clientName,
    tax_year: taxYear,
    status: 'in_progress',
    analyzed_data: {
      ...prev,
      [DRIVE_INGEST_SESSION_KEY]: session,
    },
    created_by: 'ingest-tax-documents',
  });
}

async function createStatementChunkJob(
  hub: SupabaseClient,
  clientId: string,
  clientName: string,
  taxYear: number,
  input: {
    file_id: string;
    file_name: string;
    relative_path: string | null;
    file_size_bytes: number;
  },
): Promise<StatementChunkJob> {
  // Lightweight enqueue only (do NOT split/ocr in request path; avoids worker limits).
  // Temporary estimate: ~1 chunk per 5MB, bounded to [1, 150].
  const estimatedPages = Math.max(1, Math.min(150, Math.ceil(input.file_size_bytes / 1_000_000)));
  const estimatedChunkCount = Math.max(1, Math.ceil(estimatedPages / 5));
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const job: StatementChunkJob = {
    job_id: jobId,
    client_id: clientId,
    tax_year: taxYear,
    file_id: input.file_id,
    file_name: input.file_name,
    relative_path: input.relative_path,
    file_size_bytes: input.file_size_bytes,
    chunk_size_pages: 5,
    chunk_count: estimatedChunkCount,
    pages_total: estimatedPages,
    status: 'requires_async_processing',
    created_at: now,
    updated_at: now,
  };

  // Determine source_type: if file_id looks like a storage path (contains '/'), it's storage
  const sourceType = input.file_id.includes('/') ? 'storage' : 'drive';

  // Persist durable job record in statement_chunk_jobs table
  const { error: insertErr } = await hub.from('statement_chunk_jobs').insert({
    id: jobId,
    client_id: clientId,
    tax_year: taxYear,
    file_id: input.file_id,
    file_name: input.file_name,
    relative_path: input.relative_path,
    source_type: sourceType,
    file_size_bytes: input.file_size_bytes,
    chunk_size_pages: 5,
    chunk_count: estimatedChunkCount,
    pages_total: estimatedPages,
    status: 'requires_async_processing',
    // Phase 2: pre-stage fields
    source_drive_file_id: sourceType === 'drive' ? input.file_id : null,
    prep_status: 'pending',
  });
  if (insertErr) {
    console.error(`[ingest] Failed to insert statement_chunk_jobs row: ${insertErr.message}`);
    // Non-fatal: continue with analyzed_data blob write as fallback
  } else {
    console.log(`[ingest] Durable chunk job created: id=${jobId} source_type=${sourceType}`);
  }

  const existing = await getTaxReturn(hub, clientId, taxYear);
  const prev = (existing?.analyzed_data as Record<string, unknown> | null) || {};
  const jobs = Array.isArray(prev[STATEMENT_CHUNK_JOBS_KEY]) ? (prev[STATEMENT_CHUNK_JOBS_KEY] as StatementChunkJob[]) : [];
  jobs.push(job);
  await upsertTaxReturn(hub, {
    client_id: clientId,
    client_name: clientName,
    tax_year: taxYear,
    status: 'in_progress',
    analyzed_data: {
      ...prev,
      [STATEMENT_CHUNK_JOBS_KEY]: jobs,
      updated_at: now,
    },
    created_by: 'ingest-tax-documents',
  });
  return job;
}

/** Analyze documents uploaded to Supabase Storage (dashboard tax workflow). */
async function ingestFromUploadedDocuments(
  hub: SupabaseClient,
  clientId: string,
  clientNameIn: string | undefined,
  taxYear: number,
): Promise<Record<string, unknown>> {
  let client_name = clientNameIn?.trim() || '';
  if (!client_name) {
    const { data: c } = await hub.from('clients').select('name').eq('id', clientId).maybeSingle();
    client_name = (c?.name as string) || 'Client';
  }

  const { data: rows, error: qErr } = await hub
    .from('documents')
    .select('id,file_name,mime_type,original_mime_type,storage_object_path')
    .eq('client_id', clientId)
    .eq('tax_year', taxYear)
    .eq('source', 'upload')
    .eq('is_deleted', false)
    .not('storage_object_path', 'is', null);

  if (qErr) throw new Error(`Failed to list upload documents: ${qErr.message}`);

  const docRows = (rows || []).filter(
    (r: { storage_object_path: string | null }) =>
      r.storage_object_path && String(r.storage_object_path).length > 0,
  );

  if (docRows.length === 0) {
    throw new Error(
      'No uploaded documents found for this client and year. Upload files on the Documents tab first.',
    );
  }

  const staged: StagedIngestDoc[] = [];
  const skippedDocs: SkippedIngestDoc[] = [];
  const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];
  const results: IngestResult[] = [];
  const ingestWarnings: Array<{ document_id: string; file_name: string; reason: string }> = [];

  for (const row of docRows as Array<{
    id: string;
    file_name: string;
    mime_type: string;
    original_mime_type: string;
    storage_object_path: string;
  }>) {
    try {
      console.log(`[ingest-tax-documents] Storage file: ${row.file_name} (${row.storage_object_path})`);
      const { data: blob, error: dlErr } = await hub.storage
        .from('tax-source-documents')
        .download(row.storage_object_path);

      if (dlErr || !blob) {
        throw new Error(dlErr?.message || 'Download failed');
      }

      const ab = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(ab);
      const byteLen = ab.byteLength;
      const mime =
        row.mime_type || row.original_mime_type || 'application/pdf';

      // Change 2: classify before the Claude call
      const classification: DocClassification = classifyDocument({
        filename: row.file_name ?? "",
        mimeType: mime,
        textSample: "",
        relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? "",
      });
      console.log(
        `[ingest] doc=${row.id} class=${classification.docClass} confidence=${classification.confidence} reasons=${classification.reasons.join("|")}`
      );

      // Explicit image policy: no silent skip, no income contribution.
      if (mime.startsWith('image/')) {
        const reason = 'image_file_not_processed';
        ingestWarnings.push({ document_id: row.id, file_name: row.file_name, reason });
        skippedDocs.push({
          docId: row.id,
          fileName: row.file_name,
          docClass: 'requires_review',
          skipReason: reason,
          relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
          fileSizeBytes: byteLen,
          kind: 'policy_skip',
        });
        results.push({ documentId: row.id, docClass: 'requires_review', skipped: true, skipReason: reason });
        processedFiles.push({ name: row.file_name, doc_type: 'requires_review', status: 'requires_review' });
        continue;
      }

      // Large scanned statements are queued for async chunk processing.
      if (classification.docClass === 'financial_statement' && mime === 'application/pdf' && byteLen > 50_000_000) {
        try {
          const job = await createStatementChunkJob(hub, clientId, client_name, taxYear, {
            file_id: row.id,
            file_name: row.file_name,
            relative_path: row.storage_object_path?.replace(/^\/+/, "") ?? null,
            file_size_bytes: byteLen,
          });
          skippedDocs.push({
            docId: row.id,
            fileName: row.file_name,
            docClass: classification.docClass,
            skipReason: 'requires_async_processing',
            relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
            fileSizeBytes: byteLen,
            kind: 'policy_skip',
          });
          results.push({ documentId: row.id, docClass: classification.docClass, skipped: true, skipReason: 'requires_async_processing' });
          processedFiles.push({ name: row.file_name, doc_type: classification.docClass, status: 'requires_async_processing' });
          ingestWarnings.push({
            document_id: row.id,
            file_name: row.file_name,
            reason: `requires_async_processing:job=${job.job_id}:chunks=${job.chunk_count}:pages=${job.pages_total}`,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          skippedDocs.push({
            docId: row.id,
            fileName: row.file_name,
            docClass: classification.docClass,
            skipReason: `job_creation_failed:${message}`,
            relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
            fileSizeBytes: byteLen,
            kind: 'error',
          });
          results.push({ documentId: row.id, docClass: classification.docClass, skipped: true, skipReason: 'chunk_processing_failed' });
          processedFiles.push({ name: row.file_name, doc_type: classification.docClass, status: 'chunk_processing_failed' });
          errors.push({ name: row.file_name, error: message });
        }
        continue;
      }

      const systemPrompt = pickSystemPrompt(classification.docClass);
      if (systemPrompt === null) {
        const reason = `policy_skip:${classification.docClass}`;
        console.log(`[ingest] doc=${row.id} class=${classification.docClass} → ${reason}`);
        ingestWarnings.push({ document_id: row.id, file_name: row.file_name, reason });
        skippedDocs.push({
          docId: row.id,
          fileName: row.file_name,
          docClass: classification.docClass,
          skipReason: reason,
          relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
          fileSizeBytes: null,
          kind: 'policy_skip',
        });
        results.push({
          documentId: row.id,
          docClass: classification.docClass,
          skipped: true,
          skipReason: reason,
        });
        processedFiles.push({ name: row.file_name, doc_type: classification.docClass, status: 'skipped' });
        continue;
      }

      const extracted = await analyzeDocumentRouter(base64, row.file_name, mime, systemPrompt);
      const blocked = enforceStatementIncomeHardBlock(
        extracted,
        classification.docClass,
        row.file_name,
        row.storage_object_path?.replace(/^\/+/, "") ?? null,
      );
      if (blocked.blocked && blocked.reason) {
        ingestWarnings.push({ document_id: row.id, file_name: row.file_name, reason: blocked.reason });
      }
      staged.push({
        docId: row.id,
        fileName: row.file_name,
        docClass: classification.docClass,
        extracted,
        relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
        fileSizeBytes: byteLen,
        largePdfWarning: byteLen > 50_000_000,
      });
      results.push({ documentId: row.id, docClass: classification.docClass, extracted });

      await hub
        .from('documents')
        .update({
          doc_type: extracted.doc_type,
          status: 'processed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      await safeWriteToTaxSupabase('documents', {
        tax_year: taxYear,
        file_name: row.file_name,
        type: extracted.doc_type || classification.docClass || 'other',
        source_reference: row.id,
      });

      const transactions: Record<string, unknown>[] = [];
      for (const income of extracted.extracted_data.income_items) {
        transactions.push({
          tax_year: taxYear,
          description: `${income.type}: ${income.source}`,
          source: income.payer_name || income.source,
          amount: income.amount,
          date: income.date || new Date().toISOString().split('T')[0],
        });
      }
      for (const expense of extracted.extracted_data.expense_items) {
        transactions.push({
          tax_year: taxYear,
          description: `${expense.category}: ${expense.description}`,
          source: expense.payee || expense.description,
          amount: -Math.abs(expense.amount),
          date: expense.date || new Date().toISOString().split('T')[0],
        });
      }
      if (transactions.length > 0) {
        await safeWriteToTaxSupabase('transactions', transactions);
      }

      processedFiles.push({
        name: row.file_name,
        doc_type: extracted.doc_type,
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ingest-tax-documents] Storage error ${row.file_name}: ${message}`);
      errors.push({ name: row.file_name, error: message });
      skippedDocs.push({
        docId: row.id,
        fileName: row.file_name,
        docClass: 'requires_review',
        skipReason: message,
        relativePath: row.storage_object_path?.replace(/^\/+/, "") ?? null,
        fileSizeBytes: null,
        kind: 'error',
      });
      processedFiles.push({
        name: row.file_name,
        doc_type: 'requires_review',
        status: 'error',
      });
    }
  }

  const { canonical: canonicalStaged, lineage, suppressed } = dedupeAndBuildLineage(taxYear, staged, skippedDocs);
  const coverage = buildCoverage(lineage);
  const filesWithErrors = processedFiles.filter((p) => isErrorLikeStatus(p.status)).length;
  const allExtracted = canonicalStaged.map((s) => s.extracted);
  const financialState = buildIngestFinancialState(canonicalStaged, [...skippedDocs, ...suppressed]);
  const taxKnowledge = retrieveTaxKnowledge({ patterns: financialState.patterns, broad: true });

  // Change 3: Cross-document dedup — financial statements never contribute income.
  // Bug 2 fix — previously 1099 income and the matching bank deposit were both summed.
  const incomeSources = results.filter(
    (r) => r.docClass === "income_1099" || r.docClass === "income_w2"
  );
  const financialStatements = results.filter((r) => r.docClass === "financial_statement");

  for (const stmt of financialStatements) {
    if (stmt.extracted && "reported_income" in stmt.extracted) {
      // The prompt should have set this to null. If it isn't, clobber it.
      if ((stmt.extracted as Record<string, unknown>)["reported_income"] != null) {
        console.warn(
          `[ingest] financial_statement doc=${stmt.documentId} reported non-null income despite prompt — forcing to null`
        );
        (stmt.extracted as Record<string, unknown>)["reported_income"] = null;
        (stmt.extracted as Record<string, unknown>)["reported_income_reason"] = "clobbered by dedup pass (prompt rule violated)";
      }
    }
  }

  console.log(
    `[ingest] dedup summary: ${incomeSources.length} authoritative income docs, ${financialStatements.length} financial statements (contributing $0 income), ${results.length - incomeSources.length - financialStatements.length} other docs`
  );

  const plSummary = aggregatePL(allExtracted);
  console.log(
    `[ingest-tax-documents] Storage P&L: Income=${plSummary.total_income}, Expenses=${plSummary.total_expenses}`,
  );

  await safeWriteToTaxSupabase('pl_reports', {
    tax_year: taxYear,
    period: `${taxYear} Annual`,
    gross_income: plSummary.total_income,
    total_expenses: plSummary.total_expenses,
    net_profit: plSummary.net_income,
    category_breakdown: {
      income_by_category: plSummary.income_by_category,
      expenses_by_category: plSummary.expenses_by_category,
    },
    generated_at: new Date().toISOString(),
  });

  await upsertTaxReturn(hub, {
    client_id: clientId,
    client_name,
    tax_year: taxYear,
    status: 'in_progress',
    analyzed_data: {
      pl_summary: plSummary,
      documents: allExtracted,
      ingest_file_results: lineage,
      coverage,
      financial_state: financialState,
      tax_knowledge: taxKnowledge,
      ingest_warnings: ingestWarnings.length ? ingestWarnings : undefined,
      processed_files: processedFiles,
      errors: errors.length ? errors : undefined,
      files_with_errors: filesWithErrors,
      source: 'storage_upload',
      updated_at: new Date().toISOString(),
    },
    created_by: 'ingest-tax-documents',
  });

  const aggregated_data = {
    total_income: plSummary.total_income,
    total_expenses: plSummary.total_expenses,
    net_profit: plSummary.net_income,
  };

  return {
    success: true,
    client_name,
    client_id: clientId,
    tax_year: taxYear,
    source: 'storage',
    folder_name: 'Uploaded documents',
    folder_id: null,
    files_processed: processedFiles.length,
    files_with_errors: filesWithErrors,
    processed_files: processedFiles,
    errors: errors.length > 0 ? errors : undefined,
    pl_summary: plSummary,
    aggregated_data,
    documents: allExtracted,
    ingest_file_results: lineage,
    coverage,
    financial_state: financialState,
    tax_knowledge: taxKnowledge,
    ingest_warnings: ingestWarnings.length ? ingestWarnings : undefined,
  };
}

async function writeToTaxSupabase(
  endpoint: string,
  data: Record<string, unknown> | Record<string, unknown>[]
): Promise<unknown> {
  const taxUrl = Deno.env.get('CC_TAX_URL');
  const taxKey = Deno.env.get('CC_TAX_KEY');
  if (!taxUrl || !taxKey) throw new Error('CC_TAX_URL or CC_TAX_KEY not set');

  const res = await fetch(`${taxUrl}/rest/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: taxKey,
      Authorization: `Bearer ${taxKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase write error (${endpoint}): ${res.status} - ${errText}`);
  }

  return res.json();
}

async function handleDriveList(
  clientName: string,
  taxYear: number,
  hub: SupabaseClient | null,
  clientId?: string,
): Promise<Response> {
  const folderResult = await findClientTaxFolder(clientName, taxYear);
  if (!folderResult) {
    return new Response(
      JSON.stringify({
        error: `No tax folder found for ${clientName} ${taxYear}. Searched patterns: ${clientName.toUpperCase()} ${taxYear} TAXES, ${clientName.toUpperCase().split(/\s+/)[0]} ${taxYear} TAXES, etc.`,
      }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const { folderId, folderName } = folderResult;
  const files = await listFilesRecursiveWithPaths(folderId, '', 0, 6);
  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: 'No files found in the tax folder (recursive listing)' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const outFiles = files.map((f) => {
    const classification = classifyDocument({
      filename: f.name ?? "",
      mimeType: f.mimeType,
      textSample: "",
      relativePath: f.relativePath,
    });
    return {
      id: f.id,
      name: f.name,
      relativePath: f.relativePath,
      mimeType: f.mimeType,
      size: f.size,
      analyzable: fileAnalyzable(classification),
      doc_class: classification.docClass,
    };
  });

  if (hub && clientId && clientId.length > 10 && clientId !== 'unknown') {
    const existing = await getTaxReturn(hub, clientId, taxYear);
    const prev = (existing?.analyzed_data as Record<string, unknown> | null) || {};
    await upsertTaxReturn(hub, {
      client_id: clientId,
      client_name: clientName,
      tax_year: taxYear,
      status: 'in_progress',
      analyzed_data: {
        ...prev,
        [DRIVE_INGEST_SESSION_KEY]: {
          folder_id: folderId,
          folder_name: folderName,
          client_name: clientName,
          tax_year: taxYear,
          files: {},
          started_at: new Date().toISOString(),
        },
      },
      created_by: 'ingest-tax-documents',
    });
  }

  return new Response(
    JSON.stringify({
      success: true,
      mode: 'list',
      client_name: clientName,
      tax_year: taxYear,
      folder_id: folderId,
      folder_name: folderName,
      files: outFiles,
      meta: { version: INGEST_VERSION },
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

async function handleDriveProcessSingle(
  hub: SupabaseClient,
  clientName: string,
  clientId: string,
  taxYear: number,
  fileId: string,
  fileName: string,
  fileMime: string | undefined,
  folderIdIn: string | undefined,
  folderNameIn: string | undefined,
  /** From mode=list: e.g. CHASE 2022/2022.pdf — required for generic filenames */
  relativePathIn?: string,
  /** From mode=list: file size in bytes — enables pre-download async routing */
  fileSizeHint?: number,
): Promise<Response> {
  let folderId = folderIdIn ?? '';
  let folderName = folderNameIn ?? '';

  if (!folderId) {
    const folderResult = await findClientTaxFolder(clientName, taxYear);
    if (!folderResult) {
      return new Response(
        JSON.stringify({
          error: `No tax folder found for ${clientName} ${taxYear}.`,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    folderId = folderResult.folderId;
    folderName = folderResult.folderName;
  }

  const mimeHint = fileMime && fileMime.length > 0 ? fileMime : 'application/pdf';

  // Pre-download size check: if caller provided file_size from list and it's >50MB + PDF,
  // route to async chunk processing WITHOUT downloading (avoids WORKER_LIMIT).
  if (fileSizeHint && fileSizeHint > 50_000_000 && mimeHint === 'application/pdf') {
    const classification: DocClassification = classifyDocument({
      filename: fileName ?? "",
      mimeType: mimeHint,
      textSample: "",
      relativePath: relativePathIn,
    });
    if (classification.docClass === 'financial_statement') {
      console.log(`[ingest] pre-download async route: ${fileName} (${Math.round(fileSizeHint / 1e6)}MB)`);
      try {
        const job = await createStatementChunkJob(hub, clientId, clientName, taxYear, {
          file_id: fileId,
          file_name: fileName,
          relative_path: relativePathIn ?? null,
          file_size_bytes: fileSizeHint,
        });
        const reason = 'requires_async_processing';
        const rec: DriveIngestFileRecord = {
          file_id: fileId,
          file_name: fileName,
          file_mime: mimeHint,
          docClass: classification.docClass,
          skipped: true,
          skipReason: reason,
          status: 'skipped',
          ingest_status: 'requires_async_processing',
          relative_path: relativePathIn,
          file_size_bytes: fileSizeHint,
          reason_codes: [reason],
        };
        await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);
        return new Response(
          JSON.stringify({
            success: true,
            mode: 'process_single',
            document_id: fileId,
            doc_class: classification.docClass,
            relative_path: relativePathIn,
            file_size_bytes: fileSizeHint,
            ingest_status: 'requires_async_processing',
            status: 'requires_async_processing',
            skip_reason: reason,
            chunk_job_id: job.job_id,
            chunk_count: job.chunk_count,
            pages_total: job.pages_total,
            processing_mode: (fileSizeHint ?? 0) > EDGE_SAFE_BYTE_LIMIT ? 'edge_or_external' : 'edge',
            edge_safe_limit_bytes: EDGE_SAFE_BYTE_LIMIT,
            meta: { version: INGEST_VERSION },
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const reason = 'job_creation_failed';
        const message = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            success: false,
            mode: 'process_single',
            status: 'chunk_processing_failed',
            ingest_status: 'chunk_processing_failed',
            reason,
            error: message,
            meta: { version: INGEST_VERSION },
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }
  }

  try {
    const { base64, downloadMime, bytes } = await downloadFile(fileId, mimeHint);
    const largeFileBytes = bytes.length;
    const largeFileWarning =
      largeFileBytes > 50_000_000
        ? `file is ${Math.round(largeFileBytes / 1e6)}MB — single-shot LLM may fail; chunked PDF ingest not yet implemented`
        : undefined;
    if (largeFileWarning) {
      console.warn(`[ingest] process_single ${fileName}: ${largeFileWarning}`);
    }

    const classification: DocClassification = classifyDocument({
      filename: fileName ?? "",
      mimeType: downloadMime,
      textSample: "",
      relativePath: relativePathIn,
    });

    if (downloadMime.startsWith('image/')) {
      const reason = 'image_file_not_processed';
      const rec: DriveIngestFileRecord = {
        file_id: fileId,
        file_name: fileName,
        file_mime: downloadMime,
        docClass: 'requires_review',
        skipped: true,
        skipReason: reason,
        status: 'skipped',
        ingest_status: 'image_not_processed',
        relative_path: relativePathIn,
        file_size_bytes: largeFileBytes,
        reason_codes: [reason],
      };
      await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);
      return new Response(
        JSON.stringify({
          success: true,
          mode: 'process_single',
          document_id: fileId,
          doc_class: rec.docClass,
          relative_path: relativePathIn,
          file_size_bytes: largeFileBytes,
          ingest_status: rec.ingest_status,
          status: 'skipped',
          skip_reason: reason,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (classification.docClass === 'financial_statement' && downloadMime === 'application/pdf' && largeFileBytes > 50_000_000) {
      try {
        const job = await createStatementChunkJob(hub, clientId, clientName, taxYear, {
          file_id: fileId,
          file_name: fileName,
          relative_path: relativePathIn ?? null,
          file_size_bytes: largeFileBytes,
        });
        const reason = 'requires_async_processing';
        const rec: DriveIngestFileRecord = {
          file_id: fileId,
          file_name: fileName,
          file_mime: downloadMime,
          docClass: classification.docClass,
          skipped: true,
          skipReason: reason,
          status: 'skipped',
          ingest_status: 'requires_async_processing',
          relative_path: relativePathIn,
          file_size_bytes: largeFileBytes,
          reason_codes: [reason],
        };
        await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);
        return new Response(
          JSON.stringify({
            success: true,
            mode: 'process_single',
            document_id: fileId,
            doc_class: classification.docClass,
            relative_path: relativePathIn,
            file_size_bytes: largeFileBytes,
            ingest_status: rec.ingest_status,
            status: 'requires_async_processing',
            skip_reason: reason,
            chunk_job_id: job.job_id,
            chunk_count: job.chunk_count,
            pages_total: job.pages_total,
            meta: { version: INGEST_VERSION },
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      } catch (e) {
        const reason = 'job_creation_failed';
        const message = e instanceof Error ? e.message : String(e);
        const rec: DriveIngestFileRecord = {
          file_id: fileId,
          file_name: fileName,
          file_mime: downloadMime,
          docClass: classification.docClass,
          skipped: true,
          skipReason: `${reason}:${message}`,
          status: 'error',
          ingest_status: 'chunk_processing_failed',
          relative_path: relativePathIn,
          file_size_bytes: largeFileBytes,
          reason_codes: [reason],
          error: message,
        };
        await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);
        return new Response(
          JSON.stringify({
            success: false,
            mode: 'process_single',
            document_id: fileId,
            doc_class: classification.docClass,
            relative_path: relativePathIn,
            file_size_bytes: largeFileBytes,
            ingest_status: 'chunk_processing_failed',
            status: 'chunk_processing_failed',
            reason,
            error: message,
            meta: { version: INGEST_VERSION },
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const systemPrompt = pickSystemPrompt(classification.docClass);
    if (systemPrompt === null) {
      const rec: DriveIngestFileRecord = {
        file_id: fileId,
        file_name: fileName,
        file_mime: downloadMime,
        docClass: classification.docClass,
        skipped: true,
        skipReason: `policy_skip:${classification.docClass}`,
        status: 'skipped',
        ingest_status: inferPolicySkipIngestStatus(classification.docClass),
        relative_path: relativePathIn,
        file_size_bytes: largeFileBytes,
      };
      await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'process_single',
          document_id: fileId,
          doc_type: classification.docClass,
          doc_class: classification.docClass,
          relative_path: relativePathIn,
          file_size_bytes: largeFileBytes,
          status: 'skipped',
          skip_reason: rec.skipReason,
          meta: { version: INGEST_VERSION },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const extracted = await analyzeDocumentRouter(base64, fileName, downloadMime, systemPrompt);
    const blocked = enforceStatementIncomeHardBlock(
      extracted,
      classification.docClass,
      fileName,
      relativePathIn ?? null,
    );

    await writeToTaxSupabase('documents', {
      tax_year: taxYear,
      file_name: fileName,
      type: extracted.doc_type,
      source_reference: fileId,
    });

    const transactions: Record<string, unknown>[] = [];
    for (const income of extracted.extracted_data.income_items) {
      transactions.push({
        tax_year: taxYear,
        description: `${income.type}: ${income.source}`,
        source: income.payer_name || income.source,
        amount: income.amount,
        date: income.date || new Date().toISOString().split('T')[0],
      });
    }
    for (const expense of extracted.extracted_data.expense_items) {
      transactions.push({
        tax_year: taxYear,
        description: `${expense.category}: ${expense.description}`,
        source: expense.payee || expense.description,
        amount: -Math.abs(expense.amount),
        date: expense.date || new Date().toISOString().split('T')[0],
      });
    }
    if (transactions.length > 0) {
      await writeToTaxSupabase('transactions', transactions);
    }

    const rec: DriveIngestFileRecord = {
      file_id: fileId,
      file_name: fileName,
      file_mime: downloadMime,
      docClass: classification.docClass,
      extracted,
      status: 'success',
      ingest_status: 'processed',
      relative_path: relativePathIn,
      file_size_bytes: largeFileBytes,
      reason_codes: blocked.blocked && blocked.reason ? [blocked.reason] : undefined,
    };
    await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'process_single',
        document_id: fileId,
        doc_type: extracted.doc_type,
        doc_class: classification.docClass,
        relative_path: relativePathIn,
        file_size_bytes: largeFileBytes,
        ingest_status: 'processed',
        large_file_warning: largeFileWarning,
        status: 'success',
        extracted_data: extracted,
        meta: { version: INGEST_VERSION },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest-tax-documents] process_single ${fileName}: ${message}`);
    const rec: DriveIngestFileRecord = {
      file_id: fileId,
      file_name: fileName,
      file_mime: fileMime,
      docClass: 'requires_review',
      status: 'error',
      ingest_status: 'failed_extraction',
      error: message,
      relative_path: relativePathIn,
    };
    await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

    return new Response(
      JSON.stringify({
        success: false,
        mode: 'process_single',
        document_id: fileId,
        status: 'error',
        error: message,
        meta: { version: INGEST_VERSION },
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
}

async function handleDriveAggregate(
  hub: SupabaseClient,
  clientName: string,
  clientId: string,
  taxYear: number,
  folderIdHint: string | undefined,
  folderNameHint: string | undefined,
): Promise<Response> {
  const tr = await getTaxReturn(hub, clientId, taxYear);
  const analyzed = (tr?.analyzed_data as Record<string, unknown> | null) || {};
  const session = analyzed[DRIVE_INGEST_SESSION_KEY] as DriveIngestSession | undefined;

  let folderId = folderIdHint ?? session?.folder_id ?? '';
  let folderName = folderNameHint ?? session?.folder_name ?? '';

  const fileCount = session?.files ? Object.keys(session.files).length : 0;
  if (!folderId || !session || fileCount === 0) {
    return new Response(
      JSON.stringify({
        error:
          'No drive_ingest_session with processed files. Run mode=list (with client_id to reset session), then mode=process_single for each file.',
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const fileRecords = Object.values(session.files);
  const driveResults: IngestResult[] = [];
  const stagedDrive: StagedIngestDoc[] = [];
  const skippedDrive: SkippedIngestDoc[] = [];
  const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const fr of fileRecords) {
    if (fr.status === 'success' && fr.extracted) {
      const sz = fr.file_size_bytes ?? 0;
      driveResults.push({
        documentId: fr.file_id,
        docClass: fr.docClass,
        extracted: fr.extracted,
      });
      stagedDrive.push({
        docId: fr.file_id,
        fileName: fr.file_name,
        docClass: fr.docClass,
        extracted: fr.extracted,
        relativePath: fr.relative_path ?? null,
        fileSizeBytes: fr.file_size_bytes ?? null,
        largePdfWarning: sz > 50_000_000,
      });
      processedFiles.push({
        name: fr.file_name,
        doc_type: fr.extracted.doc_type,
        status: 'success',
      });
    } else if (fr.status === 'skipped') {
      driveResults.push({
        documentId: fr.file_id,
        docClass: fr.docClass,
        skipped: true,
        skipReason: fr.skipReason,
      });
      skippedDrive.push({
        docId: fr.file_id,
        fileName: fr.file_name,
        docClass: fr.docClass,
        skipReason: fr.skipReason ?? 'skipped',
        relativePath: fr.relative_path ?? null,
        fileSizeBytes: fr.file_size_bytes ?? null,
        kind: 'policy_skip',
      });
      processedFiles.push({
        name: fr.file_name,
        doc_type: fr.docClass,
        status: 'skipped',
      });
    } else if (fr.status === 'error') {
      driveResults.push({
        documentId: fr.file_id,
        docClass: fr.docClass,
      });
      skippedDrive.push({
        docId: fr.file_id,
        fileName: fr.file_name,
        docClass: fr.docClass,
        skipReason: fr.error ?? 'error',
        relativePath: fr.relative_path ?? null,
        fileSizeBytes: fr.file_size_bytes ?? null,
        kind: 'error',
      });
      processedFiles.push({
        name: fr.file_name,
        doc_type: 'requires_review',
        status: 'error',
      });
      if (fr.error) errors.push({ name: fr.file_name, error: fr.error });
    }
  }

  const { canonical: canonicalDrive, lineage: driveLineage, suppressed: suppressedDrive } = dedupeAndBuildLineage(taxYear, stagedDrive, skippedDrive);
  const coverage = buildCoverage(driveLineage);
  const filesWithErrors = processedFiles.filter((p) => isErrorLikeStatus(p.status)).length;
  const allExtracted = canonicalDrive.map((s) => s.extracted);
  const financialStateDrive = buildIngestFinancialState(canonicalDrive, [...skippedDrive, ...suppressedDrive]);
  const taxKnowledgeDrive = retrieveTaxKnowledge({ patterns: financialStateDrive.patterns, broad: true });

  const driveIncomeSources = driveResults.filter(
    (r) => r.docClass === "income_1099" || r.docClass === "income_w2"
  );
  const driveFinancialStatements = driveResults.filter((r) => r.docClass === "financial_statement");

  for (const stmt of driveFinancialStatements) {
    if (stmt.extracted && "reported_income" in stmt.extracted) {
      if ((stmt.extracted as Record<string, unknown>)["reported_income"] != null) {
        console.warn(
          `[ingest] financial_statement doc=${stmt.documentId} reported non-null income despite prompt — forcing to null`
        );
        (stmt.extracted as Record<string, unknown>)["reported_income"] = null;
        (stmt.extracted as Record<string, unknown>)["reported_income_reason"] = "clobbered by dedup pass (prompt rule violated)";
      }
    }
  }

  console.log(
    `[ingest] dedup summary: ${driveIncomeSources.length} authoritative income docs, ${driveFinancialStatements.length} financial statements (contributing $0 income), ${driveResults.length - driveIncomeSources.length - driveFinancialStatements.length} other docs`
  );

  const plSummary = aggregatePL(allExtracted);
  console.log(
    `[ingest-tax-documents] P&L: Income=${plSummary.total_income}, Expenses=${plSummary.total_expenses}, Net=${plSummary.net_income}`
  );

  await writeToTaxSupabase('pl_reports', {
    tax_year: taxYear,
    period: `${taxYear} Annual`,
    gross_income: plSummary.total_income,
    total_expenses: plSummary.total_expenses,
    net_profit: plSummary.net_income,
    category_breakdown: {
      income_by_category: plSummary.income_by_category,
      expenses_by_category: plSummary.expenses_by_category,
    },
    generated_at: new Date().toISOString(),
  });

  const aggregated_data = {
    total_income: plSummary.total_income,
    total_expenses: plSummary.total_expenses,
    net_profit: plSummary.net_income,
  };

  const prev = analyzed;
  await upsertTaxReturn(hub, {
    client_id: clientId,
    client_name: clientName,
    tax_year: taxYear,
    status: 'in_progress',
    analyzed_data: {
      ...prev,
      pl_summary: plSummary,
      aggregated_data,
      documents: allExtracted,
      ingest_file_results: driveLineage,
      coverage,
      financial_state: financialStateDrive,
      tax_knowledge: taxKnowledgeDrive,
      processed_files: processedFiles,
      errors: errors.length > 0 ? errors : undefined,
      files_with_errors: filesWithErrors,
      source: 'drive_ingest',
      folder_id: folderId,
      folder_name: folderName,
      updated_at: new Date().toISOString(),
      [DRIVE_INGEST_SESSION_KEY]: session,
    },
    created_by: 'ingest-tax-documents',
  });

  const summary = {
    success: true,
    mode: 'aggregate',
    client_name: clientName,
    client_id: clientId,
    tax_year: taxYear,
    folder_id: folderId,
    folder_name: folderName,
    files_processed: processedFiles.length,
    files_with_errors: filesWithErrors,
    processed_files: processedFiles,
    errors: errors.length > 0 ? errors : undefined,
    pl_summary: plSummary,
    aggregated_data,
    financial_state: financialStateDrive,
    tax_knowledge: taxKnowledgeDrive,
    ingest_file_results: driveLineage,
    coverage,
    statements_failed: Number(coverage.statements_failed ?? 0),
    meta: { version: INGEST_VERSION },
  };

  return new Response(JSON.stringify(summary), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  console.log(`INGEST VERSION: ${INGEST_VERSION}`);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const {
      client_name,
      client_id,
      tax_year,
      analyze_storage_uploads,
      mode,
      file_id,
      file_name,
      file_mime,
      folder_id: body_folder_id,
      folder_name: body_folder_name,
      relative_path,
      file_size,
    } = body as {
      client_name?: string;
      client_id?: string;
      tax_year?: number;
      analyze_storage_uploads?: boolean;
      mode?: string;
      file_id?: string;
      file_name?: string;
      file_mime?: string;
      folder_id?: string;
      folder_name?: string;
      relative_path?: string;
      file_size?: number;
    };
    const hubUrl = Deno.env.get('SUPABASE_URL');
    const hubKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (tax_year == null || !Number.isFinite(Number(tax_year))) {
      return new Response(JSON.stringify({ error: 'tax_year is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const yearNum = Number(tax_year);

    if (analyze_storage_uploads === true) {
      if (!client_id || typeof client_id !== 'string') {
        return new Response(
          JSON.stringify({ error: 'client_id is required when analyze_storage_uploads is true' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const url = Deno.env.get('SUPABASE_URL');
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !key) {
        return new Response(JSON.stringify({ error: 'Supabase env not configured' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const hub = createClient(url, key);
      console.log(`[ingest-tax-documents] Storage ingestion client=${client_id} year=${yearNum}`);
      try {
        const summary = await ingestFromUploadedDocuments(hub, client_id, client_name, yearNum);
        return new Response(JSON.stringify(summary), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const isNoDocs = message.includes('No uploaded documents');
        return new Response(JSON.stringify({ error: message }), {
          status: isNoDocs ? 400 : 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (!client_name || !yearNum) {
      return new Response(
        JSON.stringify({ error: 'client_name and tax_year are required (or use analyze_storage_uploads with client_id)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const hub =
      hubUrl && hubKey ? createClient(hubUrl, hubKey) : null;

    const m = typeof mode === 'string' ? mode.trim().toLowerCase() : '';

    if (m === 'list') {
      return await handleDriveList(client_name, yearNum, hub, typeof client_id === 'string' ? client_id : undefined);
    }

    if (m === 'process_single') {
      if (!hub) {
        return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!client_id || typeof client_id !== 'string' || client_id.length < 10) {
        return new Response(
          JSON.stringify({ error: 'client_id is required for mode=process_single' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (!file_id || !file_name) {
        return new Response(
          JSON.stringify({ error: 'file_id and file_name are required for mode=process_single' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      return await handleDriveProcessSingle(
        hub,
        client_name,
        client_id,
        yearNum,
        file_id,
        file_name,
        typeof file_mime === 'string' ? file_mime : undefined,
        typeof body_folder_id === 'string' ? body_folder_id : undefined,
        typeof body_folder_name === 'string' ? body_folder_name : undefined,
        typeof relative_path === 'string' && relative_path.length > 0 ? relative_path : undefined,
        typeof file_size === 'number' ? file_size : undefined,
      );
    }

    if (m === 'aggregate') {
      if (!hub) {
        return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!client_id || typeof client_id !== 'string' || client_id.length < 10) {
        return new Response(
          JSON.stringify({ error: 'client_id is required for mode=aggregate' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      return await handleDriveAggregate(
        hub,
        client_name,
        client_id,
        yearNum,
        typeof body_folder_id === 'string' ? body_folder_id : undefined,
        typeof body_folder_name === 'string' ? body_folder_name : undefined,
      );
    }

    // Default (no mode): cannot run full Drive ingest in one invocation (Supabase ~2s CPU cap). Callers with client_id must
    // use mode=list → process_single (per file) → aggregate as separate HTTP requests. Without client_id, behave like list.
    if (!m) {
      if (
        typeof client_id === 'string' &&
        client_id.length > 10 &&
        client_id !== 'unknown'
      ) {
        return new Response(
          JSON.stringify({
            error:
              'Drive ingestion must be split across invocations. Send mode=list, then one mode=process_single per file, then mode=aggregate. (Supabase edge CPU limit.)',
            modes: ['list', 'process_single', 'aggregate'],
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      return await handleDriveList(client_name, yearNum, null, undefined);
    }

    return new Response(JSON.stringify({ error: `Unknown mode: ${mode}` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest-tax-documents] Fatal error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
