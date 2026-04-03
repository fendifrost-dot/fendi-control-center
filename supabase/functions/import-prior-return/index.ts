import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getAccessToken } from '../_shared/googleDriveUpload.ts';
import { downloadDriveFile } from '../_shared/googleDriveRead.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface PriorReturnData {
  tax_year: number;
  filing_status: string;
  dependents: Array<{ name: string; ssn_last4?: string; relationship: string; dob?: string }>;
  income: {
    wages: number;
    interest: number;
    dividends: number;
    qualified_dividends: number;
    business_income: number;
    capital_gains: number;
    capital_gains_short: number;
    capital_gains_long: number;
    ira_distributions: number;
    ira_taxable: number;
    pensions: number;
    pensions_taxable: number;
    social_security: number;
    social_security_taxable: number;
    other_income: number;
    total_income: number;
    agi: number;
  };
  deductions: {
    type: 'standard' | 'itemized';
    standard_amount: number;
    itemized: {
      medical: number;
      state_local_taxes: number;
      salt_capped: number;
      real_estate_taxes: number;
      mortgage_interest: number;
      charitable_cash: number;
      charitable_noncash: number;
      other: number;
      total: number;
    };
    qbi_deduction: number;
  };
  credits: {
    child_tax_credit: number;
    eic: number;
    education_credits: number;
    child_care_credit: number;
    other_credits: number;
    total_credits: number;
  };
  tax_payments: {
    federal_withheld: number;
    estimated_payments: number;
    amount_applied_from_prior: number;
    total_payments: number;
  };
  tax_computed: {
    taxable_income: number;
    tax: number;
    se_tax: number;
    additional_medicare: number;
    total_tax: number;
    refund_or_owed: number;
  };
  schedules_filed: string[];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function extractPriorReturn(base64Pdf: string, taxYear: number): Promise<PriorReturnData> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = `You are a tax return data extractor. You are analyzing a Form 1040 federal tax return.
Extract ALL data from this tax return and return ONLY valid JSON matching this structure exactly:
{
  "tax_year": ${taxYear},
  "filing_status": "single|married_filing_jointly|married_filing_separately|head_of_household|qualifying_widow",
  "dependents": [{"name": "...", "ssn_last4": "...", "relationship": "...", "dob": "YYYY-MM-DD"}],
  "income": {
    "wages": 0, "interest": 0, "dividends": 0, "qualified_dividends": 0,
    "business_income": 0, "capital_gains": 0, "capital_gains_short": 0, "capital_gains_long": 0,
    "ira_distributions": 0, "ira_taxable": 0, "pensions": 0, "pensions_taxable": 0,
    "social_security": 0, "social_security_taxable": 0, "other_income": 0,
    "total_income": 0, "agi": 0
  },
  "deductions": {
    "type": "standard|itemized",
    "standard_amount": 0,
    "itemized": {
      "medical": 0, "state_local_taxes": 0, "salt_capped": 0, "real_estate_taxes": 0,
      "mortgage_interest": 0, "charitable_cash": 0, "charitable_noncash": 0, "other": 0, "total": 0
    },
    "qbi_deduction": 0
  },
  "credits": {
    "child_tax_credit": 0, "eic": 0, "education_credits": 0,
    "child_care_credit": 0, "other_credits": 0, "total_credits": 0
  },
  "tax_payments": {
    "federal_withheld": 0, "estimated_payments": 0,
    "amount_applied_from_prior": 0, "total_payments": 0
  },
  "tax_computed": {
    "taxable_income": 0, "tax": 0, "se_tax": 0, "additional_medicare": 0,
    "total_tax": 0, "refund_or_owed": 0
  },
  "schedules_filed": ["Schedule C", "Schedule SE", ...]
}

Use 0 for any field not found. Negative refund_or_owed means a refund. Include ALL schedules you can identify.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Pdf,
              },
            },
            {
              type: 'text',
              text: `Extract all data from this ${taxYear} Form 1040 tax return. Be thorough â include every line item you can read.`,
            },
          ],
        },
      ],
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

  return JSON.parse(jsonMatch[0]) as PriorReturnData;
}

async function writeToTaxSupabase(
  endpoint: string,
  data: Record<string, unknown>
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
    const { client_name, client_id, tax_year, drive_file_id, pdf_base64 } = body;

    if (!client_name || !tax_year) {
      return new Response(
        JSON.stringify({ error: 'client_name and tax_year are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!drive_file_id && !pdf_base64) {
      return new Response(
        JSON.stringify({ error: 'Either drive_file_id or pdf_base64 is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[import-prior-return] Starting for ${client_name} ${tax_year}`);

    // Step 1: Get the PDF content
    let base64Content: string;

    if (pdf_base64) {
      base64Content = pdf_base64;
      console.log('[import-prior-return] Using provided PDF base64');
    } else {
      console.log(`[import-prior-return] Downloading from Drive: ${drive_file_id}`);
      const accessToken = await getAccessToken();
      const buffer = await downloadDriveFile(accessToken, drive_file_id, 'application/pdf');
      base64Content = arrayBufferToBase64(buffer);
      console.log('[import-prior-return] Downloaded from Drive');
    }

    // Step 2: Extract data with Claude Vision
    console.log('[import-prior-return] Extracting data with Claude Vision...');
    const extractedData = await extractPriorReturn(base64Content, tax_year);
    console.log(`[import-prior-return] Extracted: filing_status=${extractedData.filing_status}, AGI=${extractedData.income.agi}`);

    // Step 3: Store in Supabase
    const storedRecord = await writeToTaxSupabase('prior_returns', {
      client_id: client_id || null,
      client_name,
      tax_year,
      filing_status: extractedData.filing_status,
      dependents: extractedData.dependents,
      income_data: extractedData.income,
      deduction_data: extractedData.deductions,
      credit_data: extractedData.credits,
      payment_data: extractedData.tax_payments,
      tax_computed: extractedData.tax_computed,
      schedules_filed: extractedData.schedules_filed,
      imported_at: new Date().toISOString(),
    });

    console.log('[import-prior-return] Stored in Supabase');

    // Step 4: Return the extracted data
    return new Response(
      JSON.stringify({
        success: true,
        client_name,
        tax_year,
        filing_status: extractedData.filing_status,
        income_summary: {
          total_income: extractedData.income.total_income,
          agi: extractedData.income.agi,
          wages: extractedData.income.wages,
          business_income: extractedData.income.business_income,
          capital_gains: extractedData.income.capital_gains,
        },
        deduction_summary: {
          type: extractedData.deductions.type,
          total: extractedData.deductions.type === 'itemized'
            ? extractedData.deductions.itemized.total
            : extractedData.deductions.standard_amount,
        },
        tax_summary: {
          taxable_income: extractedData.tax_computed.taxable_income,
          total_tax: extractedData.tax_computed.total_tax,
          refund_or_owed: extractedData.tax_computed.refund_or_owed,
        },
        schedules_filed: extractedData.schedules_filed,
        full_data: extractedData,
        stored_record: storedRecord,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import-prior-return] Error: ${message}`);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
