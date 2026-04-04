import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getAccessToken } from '../_shared/googleDriveUpload.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// TXF N-codes mapped to 1040 line items
const TXF_CODES: Record<string, { code: number; description: string }> = {
  wages: { code: 521, description: 'Wages, salaries, tips (Line 1)' },
  interest: { code: 523, description: 'Taxable interest (Line 2b)' },
  dividends: { code: 525, description: 'Ordinary dividends (Line 3b)' },
  qualified_dividends: { code: 526, description: 'Qualified dividends (Line 3a)' },
  business_income: { code: 1091, description: 'Business income/loss (Line 8)' },
  capital_gains: { code: 1101, description: 'Capital gain/loss (Line 7)' },
  capital_gains_short: { code: 1102, description: 'Short-term capital gains' },
  capital_gains_long: { code: 1103, description: 'Long-term capital gains' },
  ira_distributions: { code: 530, description: 'IRA distributions (Line 4a)' },
  ira_taxable: { code: 531, description: 'IRA taxable amount (Line 4b)' },
  pensions: { code: 532, description: 'Pensions/annuities (Line 5a)' },
  pensions_taxable: { code: 533, description: 'Pensions taxable (Line 5b)' },
  social_security: { code: 534, description: 'Social security (Line 6a)' },
  social_security_taxable: { code: 535, description: 'Social security taxable (Line 6b)' },
  other_income: { code: 540, description: 'Other income (Line 8)' },
  agi: { code: 543, description: 'Adjusted gross income (Line 11)' },
  standard_deduction: { code: 544, description: 'Standard deduction' },
  itemized_medical: { code: 545, description: 'Medical and dental expenses' },
  itemized_salt: { code: 546, description: 'State and local taxes' },
  itemized_mortgage: { code: 547, description: 'Home mortgage interest' },
  itemized_charitable: { code: 548, description: 'Charitable contributions' },
  taxable_income: { code: 550, description: 'Taxable income (Line 15)' },
  tax: { code: 551, description: 'Tax (Line 16)' },
  child_tax_credit: { code: 552, description: 'Child tax credit (Line 19)' },
  eic: { code: 553, description: 'Earned income credit (Line 27)' },
  se_tax: { code: 560, description: 'Self-employment tax (Line 23)' },
  federal_withheld: { code: 570, description: 'Federal income tax withheld (Line 25)' },
  estimated_payments: { code: 571, description: 'Estimated tax payments (Line 26)' },
  total_tax: { code: 575, description: 'Total tax (Line 24)' },
  total_payments: { code: 576, description: 'Total payments (Line 33)' },
  refund: { code: 577, description: 'Overpayment/refund (Line 34)' },
  amount_owed: { code: 578, description: 'Amount owed (Line 37)' },
  schedule_c_gross: { code: 1092, description: 'Schedule C gross income' },
  schedule_c_expenses: { code: 1093, description: 'Schedule C total expenses' },
  schedule_c_net: { code: 1094, description: 'Schedule C net profit/loss' },
  qbi_deduction: { code: 555, description: 'QBI deduction (Line 13)' },
};

interface TaxReturnData {
  client_name: string;
  tax_year: number;
  filing_status: string;
  income: Record<string, number>;
  deductions: {
    type: string;
    standard_amount: number;
    itemized: Record<string, number>;
    qbi_deduction: number;
  };
  credits: Record<string, number>;
  tax_payments: Record<string, number>;
  tax_computed: Record<string, number>;
  schedule_c?: {
    gross_income: number;
    total_expenses: number;
    net_profit: number;
  };
}

function formatDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function addTxfRecord(lines: string[], nCode: number, amount: number, description: string): void {
  if (amount === 0) return;
  lines.push(`TD`);
  lines.push(`N${nCode}`);
  lines.push(`C1`);
  lines.push(`L1`);
  lines.push(`$${amount.toFixed(2)}`);
  lines.push(`^`);
}

function generateTxfContent(data: TaxReturnData): string {
  const lines: string[] = [];
  const now = new Date();

  // TXF Header
  lines.push('V042');
  lines.push('Afendifrost');
  lines.push(`D${formatDate(now)}`);
  lines.push('^');

  // Income items
  const incomeFields: Array<[string, string]> = [
    ['wages', 'wages'],
    ['interest', 'interest'],
    ['dividends', 'dividends'],
    ['qualified_dividends', 'qualified_dividends'],
    ['business_income', 'business_income'],
    ['capital_gains', 'capital_gains'],
    ['capital_gains_short', 'capital_gains_short'],
    ['capital_gains_long', 'capital_gains_long'],
    ['ira_distributions', 'ira_distributions'],
    ['ira_taxable', 'ira_taxable'],
    ['pensions', 'pensions'],
    ['pensions_taxable', 'pensions_taxable'],
    ['social_security', 'social_security'],
    ['social_security_taxable', 'social_security_taxable'],
    ['other_income', 'other_income'],
    ['agi', 'agi'],
  ];

  for (const [dataKey, txfKey] of incomeFields) {
    const amount = data.income[dataKey] || 0;
    const txfInfo = TXF_CODES[txfKey];
    if (txfInfo && amount !== 0) {
      addTxfRecord(lines, txfInfo.code, amount, txfInfo.description);
    }
  }

  // Deductions
  if (data.deductions.type === 'standard' && data.deductions.standard_amount > 0) {
    addTxfRecord(lines, TXF_CODES.standard_deduction.code, data.deductions.standard_amount, 'Standard deduction');
  } else if (data.deductions.type === 'itemized') {
    const itemized = data.deductions.itemized;
    if (itemized.medical > 0) addTxfRecord(lines, TXF_CODES.itemized_medical.code, itemized.medical, 'Medical expenses');
    if (itemized.state_local_taxes > 0 || itemized.salt_capped > 0) {
      addTxfRecord(lines, TXF_CODES.itemized_salt.code, itemized.salt_capped || itemized.state_local_taxes, 'State/local taxes');
    }
    if (itemized.mortgage_interest > 0) addTxfRecord(lines, TXF_CODES.itemized_mortgage.code, itemized.mortgage_interest, 'Mortgage interest');
    const charitable = (itemized.charitable_cash || 0) + (itemized.charitable_noncash || 0);
    if (charitable > 0) addTxfRecord(lines, TXF_CODES.itemized_charitable.code, charitable, 'Charitable contributions');
  }

  if (data.deductions.qbi_deduction > 0) {
    addTxfRecord(lines, TXF_CODES.qbi_deduction.code, data.deductions.qbi_deduction, 'QBI deduction');
  }

  // Tax computed
  const taxFields: Array<[string, string]> = [
    ['taxable_income', 'taxable_income'],
    ['tax', 'tax'],
    ['se_tax', 'se_tax'],
    ['total_tax', 'total_tax'],
  ];

  for (const [dataKey, txfKey] of taxFields) {
    const amount = data.tax_computed[dataKey] || 0;
    const txfInfo = TXF_CODES[txfKey];
    if (txfInfo && amount !== 0) {
      addTxfRecord(lines, txfInfo.code, amount, txfInfo.description);
    }
  }

  // Credits
  if (data.credits.child_tax_credit > 0) addTxfRecord(lines, TXF_CODES.child_tax_credit.code, data.credits.child_tax_credit, 'Child tax credit');
  if (data.credits.eic > 0) addTxfRecord(lines, TXF_CODES.eic.code, data.credits.eic, 'EIC');

  // Payments
  if (data.tax_payments.federal_withheld > 0) addTxfRecord(lines, TXF_CODES.federal_withheld.code, data.tax_payments.federal_withheld, 'Federal withheld');
  if (data.tax_payments.estimated_payments > 0) addTxfRecord(lines, TXF_CODES.estimated_payments.code, data.tax_payments.estimated_payments, 'Estimated payments');
  if (data.tax_payments.total_payments > 0) addTxfRecord(lines, TXF_CODES.total_payments.code, data.tax_payments.total_payments, 'Total payments');

  // Refund or amount owed
  const refundOrOwed = data.tax_computed.refund_or_owed || 0;
  if (refundOrOwed < 0) {
    addTxfRecord(lines, TXF_CODES.refund.code, Math.abs(refundOrOwed), 'Refund');
  } else if (refundOrOwed > 0) {
    addTxfRecord(lines, TXF_CODES.amount_owed.code, refundOrOwed, 'Amount owed');
  }

  // Schedule C if present
  if (data.schedule_c) {
    if (data.schedule_c.gross_income > 0) addTxfRecord(lines, TXF_CODES.schedule_c_gross.code, data.schedule_c.gross_income, 'Sched C gross');
    if (data.schedule_c.total_expenses > 0) addTxfRecord(lines, TXF_CODES.schedule_c_expenses.code, data.schedule_c.total_expenses, 'Sched C expenses');
    if (data.schedule_c.net_profit !== 0) addTxfRecord(lines, TXF_CODES.schedule_c_net.code, data.schedule_c.net_profit, 'Sched C net');
  }

  return lines.join('\n');
}

async function readFromTaxSupabase(endpoint: string, query: string): Promise<unknown> {
  const taxUrl = Deno.env.get('CC_TAX_URL');
  const taxKey = Deno.env.get('CC_TAX_KEY');
  if (!taxUrl || !taxKey) throw new Error('CC_TAX_URL or CC_TAX_KEY not set');

  const res = await fetch(`${taxUrl}/rest/v1/${endpoint}?${query}`, {
    headers: {
      apikey: taxKey,
      Authorization: `Bearer ${taxKey}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase read error (${endpoint}): ${res.status} - ${errText}`);
  }
  return res.json();
}

async function uploadToStorage(fileName: string, content: string): Promise<string> {
  const taxUrl = Deno.env.get('CC_TAX_URL');
  const taxKey = Deno.env.get('CC_TAX_KEY');
  if (!taxUrl || !taxKey) throw new Error('CC_TAX_URL or CC_TAX_KEY not set');

  const res = await fetch(`${taxUrl}/storage/v1/object/tax-exports/${fileName}`, {
    method: 'POST',
    headers: {
      apikey: taxKey,
      Authorization: `Bearer ${taxKey}`,
      'Content-Type': 'text/plain',
      'x-upsert': 'true',
    },
    body: content,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Storage upload error: ${res.status} - ${errText}`);
  }

  return `${taxUrl}/storage/v1/object/public/tax-exports/${fileName}`;
}

async function uploadToDrive(accessToken: string, fileName: string, content: string, folderId?: string): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: fileName,
    mimeType: 'text/plain',
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const boundary = 'boundary_txf_upload';
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive upload error: ${res.status} - ${errText}`);
  }

  const data = await res.json();
  return data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`;
}

Deno.serve(async (req: Request) => {
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
    const { tax_return_id, client_name, tax_year } = body;

    if (!tax_return_id && (!client_name || !tax_year)) {
      return new Response(
        JSON.stringify({ error: 'Either tax_return_id or (client_name + tax_year) required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[export-txf] Starting export for ${client_name || tax_return_id} ${tax_year || ''}`);

    // Step 1: Read tax return data from Supabase
    let query: string;
    if (tax_return_id) {
      query = `id=eq.${tax_return_id}&select=*`;
    } else {
      query = `client_name=eq.${encodeURIComponent(client_name)}&tax_year=eq.${tax_year}&select=*&order=created_at.desc&limit=1`;
    }

    const returns = await readFromTaxSupabase('tax_returns', query) as Array<Record<string, unknown>>;
    if (!returns || returns.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No tax return found matching the criteria' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const taxReturn = returns[0];
    console.log(`[export-txf] Found tax return: ${taxReturn.id}`);

    // Step 2: Build TaxReturnData from the Supabase record
    const returnData = taxReturn.return_data as Record<string, unknown> || {};
    const incomeData = (returnData.income || taxReturn.income_data || {}) as Record<string, number>;
    const deductionData = (returnData.deductions || taxReturn.deduction_data || {}) as Record<string, unknown>;
    const creditData = (returnData.credits || taxReturn.credit_data || {}) as Record<string, number>;
    const paymentData = (returnData.tax_payments || taxReturn.payment_data || {}) as Record<string, number>;
    const taxComputed = (returnData.tax_computed || taxReturn.tax_computed || {}) as Record<string, number>;

    const txfData: TaxReturnData = {
      client_name: (taxReturn.client_name as string) || client_name,
      tax_year: (taxReturn.tax_year as number) || tax_year,
      filing_status: (taxReturn.filing_status as string) || 'single',
      income: incomeData,
      deductions: {
        type: (deductionData.type as string) || 'standard',
        standard_amount: (deductionData.standard_amount as number) || 0,
        itemized: (deductionData.itemized as Record<string, number>) || {},
        qbi_deduction: (deductionData.qbi_deduction as number) || 0,
      },
      credits: creditData,
      tax_payments: paymentData,
      tax_computed: taxComputed,
      schedule_c: returnData.schedule_c as TaxReturnData['schedule_c'] || undefined,
    };

    // Step 3: Generate TXF content
    const txfContent = generateTxfContent(txfData);
    const fileName = `${txfData.client_name.replace(/\s+/g, '_')}_${txfData.tax_year}_1040.txf`;
    console.log(`[export-txf] Generated TXF: ${fileName} (${txfContent.length} chars)`);

    // Step 4: Upload to Supabase storage
    let storageUrl = '';
    try {
      storageUrl = await uploadToStorage(fileName, txfContent);
      console.log(`[export-txf] Uploaded to storage: ${storageUrl}`);
    } catch (err) {
      console.error(`[export-txf] Storage upload failed: ${err instanceof Error ? err.message : err}`);
    }

    // Step 5: Upload to Google Drive
    let driveUrl = '';
    try {
      const accessToken = await getAccessToken();

      // Try to find the client's tax folder for upload
      const { findClientTaxFolder } = await import('../_shared/googleDriveRead.ts');
      const folderResult = await findClientTaxFolder(txfData.client_name, txfData.tax_year);

      driveUrl = await uploadToDrive(accessToken, fileName, txfContent, folderResult?.folderId || undefined);
      console.log(`[export-txf] Uploaded to Drive: ${driveUrl}`);
    } catch (err) {
      console.error(`[export-txf] Drive upload failed: ${err instanceof Error ? err.message : err}`);
    }

    // Step 6: Return results
    return new Response(
      JSON.stringify({
        success: true,
        client_name: txfData.client_name,
        tax_year: txfData.tax_year,
        file_name: fileName,
        storage_url: storageUrl || null,
        drive_url: driveUrl || null,
        txf_preview: txfContent.substring(0, 500),
        fields_exported: txfContent.split('TD\n').length - 1,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[export-txf] Error: ${message}`);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
