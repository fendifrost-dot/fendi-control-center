import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { findClientTaxFolder, listFilesInFolder, downloadFile } from '../_shared/googleDriveRead.ts';
import { upsertTaxReturn } from '../_shared/taxReturns.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

async function analyzeDocumentWithClaude(
  base64Content: string,
  fileName: string,
  mimeType: string
): Promise<ExtractedData> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  const systemPrompt = `You are a tax document analyzer. Extract ALL financial data from this document.

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

  return JSON.parse(jsonMatch[0]) as ExtractedData;
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

      const extracted = await analyzeDocumentWithClaude(base64, row.file_name, mime);
      allExtracted.push(extracted);

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
        type: extracted.doc_type,
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
    const { client_name, client_id, tax_year, analyze_storage_uploads } = body as {
      client_name?: string;
      client_id?: string;
      tax_year?: number;
      analyze_storage_uploads?: boolean;
    };

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

    console.log(`[ingest-tax-documents] Starting Drive ingestion for ${client_name} ${yearNum}`);

    const folderResult = await findClientTaxFolder(client_name, yearNum);

    if (!folderResult) {
      return new Response(
        JSON.stringify({
          error: `No tax folder found for ${client_name} ${yearNum}. Searched patterns: ${client_name.toUpperCase()} ${yearNum} TAXES, ${client_name.toUpperCase().split(/\s+/)[0]} ${yearNum} TAXES, etc.`,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { folderId, folderName } = folderResult;
    console.log(`[ingest-tax-documents] Found folder: ${folderName} (${folderId})`);

    const files = await listFilesInFolder(folderId);
    console.log(`[ingest-tax-documents] Found ${files.length} files in folder`);

    if (files.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files found in the tax folder' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const allExtracted: ExtractedData[] = [];
    const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      try {
        console.log(`[ingest-tax-documents] Processing: ${file.name} (${file.mimeType})`);

        const { base64, downloadMime } = await downloadFile(file.id, file.mimeType);
        console.log(`[ingest-tax-documents] Downloaded ${file.name}, mime: ${downloadMime}, base64 length: ${base64.length}`);

        const extracted = await analyzeDocumentWithClaude(base64, file.name, downloadMime);
        allExtracted.push(extracted);

        await writeToTaxSupabase('documents', {
          tax_year: yearNum,
          file_name: file.name,
          type: extracted.doc_type,
          source_reference: file.id,
        });

        const transactions: Record<string, unknown>[] = [];

        for (const income of extracted.extracted_data.income_items) {
          transactions.push({
            tax_year: yearNum,
            description: `${income.type}: ${income.source}`,
            source: income.payer_name || income.source,
            amount: income.amount,
            date: income.date || new Date().toISOString().split('T')[0],
          });
        }

        for (const expense of extracted.extracted_data.expense_items) {
          transactions.push({
            tax_year: yearNum,
            description: `${expense.category}: ${expense.description}`,
            source: expense.payee || expense.description,
            amount: -Math.abs(expense.amount),
            date: expense.date || new Date().toISOString().split('T')[0],
          });
        }

        if (transactions.length > 0) {
          await writeToTaxSupabase('transactions', transactions);
        }

        processedFiles.push({
          name: file.name,
          doc_type: extracted.doc_type,
          status: 'success',
        });

        console.log(`[ingest-tax-documents] Done: ${file.name} -> ${extracted.doc_type} (${extracted.extracted_data.income_items.length} income, ${extracted.extracted_data.expense_items.length} expense items)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ingest-tax-documents] Error processing ${file.name}: ${message}`);
        errors.push({ name: file.name, error: message });
        processedFiles.push({
          name: file.name,
          doc_type: 'unknown',
          status: 'error',
        });
      }
    }

    const plSummary = aggregatePL(allExtracted);
    console.log(
      `[ingest-tax-documents] P&L: Income=${plSummary.total_income}, Expenses=${plSummary.total_expenses}, Net=${plSummary.net_income}`
    );

    await writeToTaxSupabase('pl_reports', {
      tax_year: yearNum,
      period: `${yearNum} Annual`,
      gross_income: plSummary.total_income,
      total_expenses: plSummary.total_expenses,
      net_profit: plSummary.net_income,
      category_breakdown: {
        income_by_category: plSummary.income_by_category,
        expenses_by_category: plSummary.expenses_by_category,
      },
      generated_at: new Date().toISOString(),
    });

    const summary = {
      success: true,
      client_name,
      tax_year: yearNum,
      folder_id: folderId,
      folder_name: folderName,
      files_processed: processedFiles.length,
      files_with_errors: errors.length,
      processed_files: processedFiles,
      errors: errors.length > 0 ? errors : undefined,
      pl_summary: plSummary,
    };

    console.log(`[ingest-tax-documents] Complete. ${processedFiles.length} files processed.`);

    return new Response(JSON.stringify(summary), {
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
