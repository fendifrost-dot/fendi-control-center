import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce SIX outputs from raw tax data.

IMPORTANT: We are NOT filing taxes — only preparing documents for review. All outputs are prep documents.

1. **json_summary** — structured data with:
   - form_1040: { filing_status, total_income, adjusted_gross_income, taxable_income, total_tax, estimated_payments, amount_owed_or_refund }
   - schedule_c: { business_name, gross_income, total_expenses, net_profit, expense_categories: [{name, amount}] }
   - schedule_se: { net_earnings, se_tax, deductible_half }
   - filing_readiness: { score (0-100), missing_items: string[], warnings: string[], ready_to_file: boolean }
   - deductions: { standard_or_itemized, items: [{description, amount, category}] }

2. **worksheet** — a clean, printable text worksheet summarizing all tax data, organized by category (income, expenses, deductions, estimated payments, filing status). Include totals and notes.

3. **txf_export** — valid TXF format (Tax Exchange Format) compatible with TurboTax import. Use correct TXF line codes:
   - V042 for version header
   - N521 for wages (W-2)
   - N547 for interest income
   - N543 for dividend income
   - N1401 for Schedule C gross receipts
   - N1539 for Schedule C expenses (by category)
   - N2440 for estimated tax payments
   - D for date lines, $ for amount lines

4. **form_1040_lines** — line-by-line Form 1040 mapping for mail-in preparation:
   - An array of objects: [{ line: number (1-37), description: string, amount: number, source: string }]
   - Cover Lines 1 through 37 (income, adjustments, AGI, deductions, taxable income, tax, credits, payments, refund/owed)
   - If a line has no data, include it with amount 0 and source "N/A"

5. **csv_export** — flat CSV string with columns: field_id,form,line,description,amount,notes
   - One row per tax field for Free File import
   - Include header row
   - Cover Form 1040, Schedule C, Schedule SE fields

6. **filing_recommendation** — object with:
   - method: one of "free_file" | "turbotax" | "mail_in" | "mixed"
   - agi: number (the adjusted gross income)
   - reasoning: string explaining why this method is recommended
   - steps: string[] (ordered next steps the taxpayer should take)
   - Rules: If AGI <= 84000, recommend "free_file". If AGI > 84000 and Schedule C exists, recommend "turbotax". If no digital access, recommend "mail_in". If mixed scenarios, recommend "mixed" with explanation.

Respond with valid JSON only. Structure:
{
  "json_summary": { form_1040: {...}, schedule_c: {...}, schedule_se: {...}, filing_readiness: {...}, deductions: {...} },
  "worksheet": "string",
  "txf_export": "string",
  "form_1040_lines": [{ "line": 1, "description": "...", "amount": 0, "source": "..." }, ...],
  "csv_export": "string",
  "filing_recommendation": { "method": "...", "agi": 0, "reasoning": "...", "steps": ["..."] }
}`;

async function fetchCCTaxData(action: string, taxYear?: number): Promise<any> {
  const CC_TAX_URL = Deno.env.get("CC_TAX_URL");
  const CC_TAX_KEY = Deno.env.get("CC_TAX_KEY");
  if (!CC_TAX_URL) throw new Error("CC_TAX_URL is not configured");
  if (!CC_TAX_KEY) throw new Error("CC_TAX_KEY is not configured");

  const resp = await fetch(`${CC_TAX_URL}/functions/v1/control-center-api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CC_TAX_KEY}`,
    },
    body: JSON.stringify({ action, tax_year: taxYear }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`CC Tax ${action} failed (${resp.status}): ${detail.slice(0, 500)}`);
  }
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const taxYears: number[] = body.tax_years ?? [body.tax_year ?? new Date().getFullYear()];

    if (!Array.isArray(taxYears) || taxYears.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "tax_years must be a non-empty array of years" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    async function processYear(year: number) {
      console.log(`Processing tax year ${year}...`);

      const [
        workflowStatus,
        yearConfig,
        documents,
        transactions,
        reconciliations,
        discrepancies,
        plReport,
      ] = await Promise.all([
        fetchCCTaxData("get_workflow_status", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_year_config", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_documents", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_transactions", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_reconciliations", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_discrepancies", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_pl_report", year).catch((e) => ({ error: e.message })),
      ]);

      const taxDataPayload = JSON.stringify({
        tax_year: year,
        workflow_status: workflowStatus,
        year_config: yearConfig,
        documents,
        transactions,
        reconciliations,
        discrepancies,
        pl_report: plReport,
      });

      const userPrompt = `Generate all six tax document outputs for tax year ${year}. Here is the complete tax data:\n\n${taxDataPayload}`;

      const generated = await callClaudeJSON<{
        json_summary: Record<string, unknown>;
        worksheet: string;
        txf_export: string;
        form_1040_lines: Array<{ line: number; description: string; amount: number; source: string }>;
        csv_export: string;
        filing_recommendation: { method: string; agi: number; reasoning: string; steps: string[] };
      }>(
        TAX_SYSTEM_PROMPT,
        userPrompt,
        { required: ["json_summary", "worksheet", "txf_export", "form_1040_lines", "csv_export", "filing_recommendation"] },
        8192,
      );

      return { year: String(year), data: generated };
    }

    const yearResults = await Promise.all(taxYears.map((y) => processYear(y)));
    const results: Record<string, any> = {};
    for (const { year, data } of yearResults) {
      results[year] = data;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        tax_years: taxYears,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-tax-documents error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
