import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce three outputs from raw tax data:

1. **JSON summary** — structured data with:
   - form_1040: { filing_status, total_income, adjusted_gross_income, taxable_income, total_tax, estimated_payments, amount_owed_or_refund }
   - schedule_c: { business_name, gross_income, total_expenses, net_profit, expense_categories: [{name, amount}] }
   - filing_readiness: { score (0-100), missing_items: string[], warnings: string[], ready_to_file: boolean }
   - deductions: { standard_or_itemized, items: [{description, amount, category}] }

2. **Human-readable worksheet** — a clean, printable text worksheet summarizing all tax data, organized by category (income, expenses, deductions, estimated payments, filing status). Include totals and notes.

3. **TXF export** — valid TXF format (Tax Exchange Format) compatible with TurboTax import. Use correct TXF line codes:
   - V042 for version header
   - N521 for wages (W-2)
   - N547 for interest income
   - N543 for dividend income  
   - N1401 for Schedule C gross receipts
   - N1539 for Schedule C expenses (by category)
   - N2440 for estimated tax payments
   - D for date lines, $ for amount lines

Respond with valid JSON only. Structure:
{
  "json_summary": { form_1040: {...}, schedule_c: {...}, filing_readiness: {...}, deductions: {...} },
  "worksheet": "string (the full human-readable worksheet text)",
  "txf_export": "string (the complete TXF file content)"
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

    const results: Record<string, any> = {};

    for (const year of taxYears) {
      console.log(`Processing tax year ${year}...`);

      // Pull all relevant data from CC Tax in parallel
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

      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Here is the complete tax data:\n\n${taxDataPayload}`;

      const generated = await callClaudeJSON<{
        json_summary: Record<string, unknown>;
        worksheet: string;
        txf_export: string;
      }>(
        TAX_SYSTEM_PROMPT,
        userPrompt,
        { required: ["json_summary", "worksheet", "txf_export"] },
        8192,
      );

      results[String(year)] = {
        json_summary: generated.json_summary,
        worksheet: generated.worksheet,
        txf_export: generated.txf_export,
      };
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
