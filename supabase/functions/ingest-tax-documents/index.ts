import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { findClientTaxFolder, listFilesInFolder, downloadFile } from '../_shared/googleDriveRead.ts';
import { upsertTaxReturn, getTaxReturn } from '../_shared/taxReturns.ts';
import { classifyDocument, type DocClass, type DocClassification } from '../_shared/docClassifier.ts';
import { pickSystemPrompt } from '../_shared/ingestPrompts.ts';
import { analyzeDocumentWithGemini } from '../_shared/geminiParser.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Persisted between process_single calls; aggregate reads this from tax_returns.analyzed_data */
const DRIVE_INGEST_SESSION_KEY = 'drive_ingest_session';

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
  date?: string;
}

interface ExtractedData {
  doc_type: string;
  classification: string;
  extracted_data: {
    income_items: IncomeItem[];
    expense_items: ExpenseItem[];
    payer_info: Record<string, string>;
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
}

interface DriveIngestSession {
  folder_id: string;
  folder_name: string;
  client_name: string;
  tax_year: number;
  files: Record<string, DriveIngestFileRecord>;
  started_at?: string;
}

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
function normalizeToExtractedData(raw: Record<string, unknown>): ExtractedData {
  // Already in ExtractedData format (default prompt or already normalized)
  if (
    typeof raw.doc_type === 'string' &&
    raw.doc_type !== 'other' &&
    raw.extracted_data &&
    typeof raw.extracted_data === 'object'
  ) {
    const ed = raw.extracted_data as Record<string, unknown>;
    return {
      doc_type: raw.doc_type as string,
      classification: (raw.classification as string) || 'mixed',
      extracted_data: {
        income_items: (ed.income_items as IncomeItem[]) || [],
        expense_items: (ed.expense_items as ExpenseItem[]) || [],
        payer_info: (ed.payer_info as Record<string, string>) || { name: '', ein: '', address: '' },
      },
    };
  }

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

  // ── Financial statement format (from FINANCIAL_STATEMENT_PROMPT) ─
  if ('account_type' in raw && 'institution_name' in raw) {
    // Financial statements contribute $0 income by design (dedup rule)
    return {
      doc_type: 'bank_statement',
      classification: 'mixed',
      extracted_data: {
        income_items: [],
        expense_items: [],
        payer_info: {
          name: String(raw.institution_name || ''),
          ein: '',
          address: '',
        },
      },
    };
  }

  // ── Receipt / invoice format (from RECEIPT_OR_INVOICE_PROMPT) ───
  if ('vendor_name' in raw && 'line_items' in raw) {
    const lineItems = (raw.line_items || []) as Array<Record<string, unknown>>;
    const expenseItems: ExpenseItem[] = lineItems.map((item) => ({
      category: String(item.category || 'other'),
      description: String(item.description || ''),
      amount: Number(item.amount) || 0,
      payee: String(raw.vendor_name || ''),
      date: String(item.date || raw.date || ''),
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

  const expensesByCategory: Record<string, number> = {
    business: 0,
    medical: 0,
    charitable: 0,
    education: 0,
    home_office: 0,
    vehicle: 0,
    supplies: 0,
    other: 0,
  };

  for (const doc of allExtracted) {
    for (const item of doc.extracted_data.income_items) {
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
      const cat = item.category in expensesByCategory ? item.category : 'other';
      expensesByCategory[cat] += amount;
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

  const allExtracted: ExtractedData[] = [];
  const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];
  const results: IngestResult[] = [];

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
      const mime =
        row.mime_type || row.original_mime_type || 'application/pdf';

      // Change 2: classify before the Claude call
      const classification: DocClassification = classifyDocument({
        filename: row.file_name ?? "",
        mimeType: mime,
        textSample: "",
      });
      console.log(
        `[ingest] doc=${row.id} class=${classification.docClass} confidence=${classification.confidence} reasons=${classification.reasons.join("|")}`
      );

      const systemPrompt = pickSystemPrompt(classification.docClass);
      if (systemPrompt === null) {
        console.log(`[ingest] doc=${row.id} class=${classification.docClass} → skipping LLM pass, recording as filed-only`);
        results.push({
          documentId: row.id,
          docClass: classification.docClass,
          skipped: true,
          skipReason: "non-dollar-bearing document class",
        });
        processedFiles.push({ name: row.file_name, doc_type: classification.docClass, status: 'skipped' });
        continue;
      }

      const extracted = await analyzeDocumentRouter(base64, row.file_name, mime, systemPrompt);
      allExtracted.push(extracted);
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
      processedFiles.push({
        name: row.file_name,
        doc_type: 'unknown',
        status: 'error',
      });
    }
  }

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
      processed_files: processedFiles,
      errors: errors.length ? errors : undefined,
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
    files_with_errors: errors.length,
    processed_files: processedFiles,
    errors: errors.length > 0 ? errors : undefined,
    pl_summary: plSummary,
    aggregated_data,
    documents: allExtracted,
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
  const files = await listFilesInFolder(folderId);
  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: 'No files found in the tax folder' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const outFiles = files.map((f) => {
    const classification = classifyDocument({
      filename: f.name ?? "",
      mimeType: f.mimeType,
      textSample: "",
    });
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      analyzable: fileAnalyzable(classification),
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

  try {
    const { base64, downloadMime } = await downloadFile(fileId, mimeHint);
    const classification: DocClassification = classifyDocument({
      filename: fileName ?? "",
      mimeType: downloadMime,
      textSample: "",
    });

    const systemPrompt = pickSystemPrompt(classification.docClass);
    if (systemPrompt === null) {
      const rec: DriveIngestFileRecord = {
        file_id: fileId,
        file_name: fileName,
        file_mime: downloadMime,
        docClass: classification.docClass,
        skipped: true,
        skipReason: 'non-dollar-bearing document class',
        status: 'skipped',
      };
      await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'process_single',
          document_id: fileId,
          doc_type: classification.docClass,
          status: 'skipped',
          skip_reason: rec.skipReason,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const extracted = await analyzeDocumentRouter(base64, fileName, downloadMime, systemPrompt);

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
    };
    await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'process_single',
        document_id: fileId,
        doc_type: extracted.doc_type,
        status: 'success',
        extracted_data: extracted,
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
      docClass: 'unknown',
      status: 'error',
      error: message,
    };
    await mergeDriveIngestSession(hub, clientId, clientName, taxYear, folderId, folderName, rec);

    return new Response(
      JSON.stringify({
        success: false,
        mode: 'process_single',
        document_id: fileId,
        status: 'error',
        error: message,
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
  const allExtracted: ExtractedData[] = [];
  const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const fr of fileRecords) {
    if (fr.status === 'success' && fr.extracted) {
      driveResults.push({
        documentId: fr.file_id,
        docClass: fr.docClass,
        extracted: fr.extracted,
      });
      allExtracted.push(fr.extracted);
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
      processedFiles.push({
        name: fr.file_name,
        doc_type: 'unknown',
        status: 'error',
      });
      if (fr.error) errors.push({ name: fr.file_name, error: fr.error });
    }
  }

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
      processed_files: processedFiles,
      errors: errors.length > 0 ? errors : undefined,
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
    files_with_errors: errors.length,
    processed_files: processedFiles,
    errors: errors.length > 0 ? errors : undefined,
    pl_summary: plSummary,
    aggregated_data,
  };

  return new Response(JSON.stringify(summary), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
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
