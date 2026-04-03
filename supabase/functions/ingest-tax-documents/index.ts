import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getAccessToken } from '../_shared/googleDriveUpload.ts';
import { findClientTaxFolder, listDriveFolder, downloadDriveFile } from '../_shared/googleDriveRead.ts';

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

  if (isImage || isPdf) {
    const mediaType = isPdf ? 'application/pdf' : mimeType;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Content,
      },
    });
    content.push({
      type: 'text',
      text: `Analyze this tax document (${fileName}). Extract all financial data.`,
    });
  } else {
    const decoded = atob(base64Content);
    content.push({
      type: 'text',
      text: `Analyze this tax document (${fileName}). Content:\n\n${decoded}\n\nExtract all financial data.`,
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

    const { client_name, client_id, tax_year } = await req.json();

    if (!client_name || !tax_year) {
      return new Response(
        JSON.stringify({ error: 'client_name and tax_year are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[ingest-tax-documents] Starting ingestion for ${client_name} ${tax_year}`);

    // Step 1: Get Google Drive access
    const accessToken = await getAccessToken();
    console.log('[ingest-tax-documents] Got Drive access token');

    // Step 2: Find the client tax folder
    const folderId = await findClientTaxFolder(accessToken, client_name, tax_year);
    if (!folderId) {
      return new Response(
        JSON.stringify({
          error: `No tax folder found for ${client_name} ${tax_year}. Searched patterns: ${client_name.toUpperCase()} ${tax_year} TAXES, ${client_name.toUpperCase()} TAXES, etc.`,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    console.log(`[ingest-tax-documents] Found folder: ${folderId}`);

    // Step 3: List all files in the folder
    const files = await listDriveFolder(accessToken, folderId);
    console.log(`[ingest-tax-documents] Found ${files.length} files in folder`);

    if (files.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files found in the tax folder' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 4: Process each file
    const allExtracted: ExtractedData[] = [];
    const processedFiles: Array<{ name: string; doc_type: string; status: string }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      try {
        console.log(`[ingest-tax-documents] Processing: ${file.name} (${file.mimeType})`);

        // Download the file
        const content = await downloadDriveFile(accessToken, file.id, file.mimeType);
        const base64 = arrayBufferToBase64(content);

        // Analyze with Claude
        const extracted = await analyzeDocumentWithClaude(base64, file.name, file.mimeType);
        allExtracted.push(extracted);

        // Write document record to Supabase
        await writeToTaxSupabase('documents', {
          client_id: client_id || null,
          client_name,
          tax_year,
          file_name: file.name,
          drive_file_id: file.id,
          doc_type: extracted.doc_type,
          classification: extracted.classification,
          extracted_data: extracted.extracted_data,
          processed_at: new Date().toISOString(),
        });

        // Write individual transactions
        const transactions: Record<string, unknown>[] = [];
        for (const income of extracted.extracted_data.income_items) {
          transactions.push({
            client_id: client_id || null,
            client_name,
            tax_year,
            type: 'income',
            category: income.type,
            source: income.source,
            amount: income.amount,
            payer_name: income.payer_name || null,
            payer_ein: income.payer_ein || null,
            date: income.date || null,
            source_document: file.name,
          });
        }
        for (const expense of extracted.extracted_data.expense_items) {
          transactions.push({
            client_id: client_id || null,
            client_name,
            tax_year,
            type: 'expense',
            category: expense.category,
            source: expense.description,
            amount: expense.amount,
            payee: expense.payee || null,
            date: expense.date || null,
            source_document: file.name,
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
        console.log(`[ingest-tax-documents] Done: ${file.name} -> ${extracted.doc_type}`);
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

    // Step 5: Generate P&L summary
    const plSummary = aggregatePL(allExtracted);
    console.log(`[ingest-tax-documents] P&L: Income=${plSummary.total_income}, Expenses=${plSummary.total_expenses}, Net=${plSummary.net_income}`);

    // Write P&L report to Supabase
    await writeToTaxSupabase('pl_reports', {
      client_id: client_id || null,
      client_name,
      tax_year,
      total_income: plSummary.total_income,
      income_by_category: plSummary.income_by_category,
      total_expenses: plSummary.total_expenses,
      expenses_by_category: plSummary.expenses_by_category,
      net_income: plSummary.net_income,
      documents_processed: processedFiles.length,
      generated_at: new Date().toISOString(),
    });

    // Step 6: Return summary
    const summary = {
      success: true,
      client_name,
      tax_year,
      folder_id: folderId,
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
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
