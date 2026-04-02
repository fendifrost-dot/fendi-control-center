import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce THREE outputs from raw tax data.
IMPORTANT: We are NOT filing taxes — only preparing documents so the client is READY to file (mail-in or e-file).

1. **JSON summary** — structured data with:
   - form_1040: { filing_status, total_income, adjusted_gross_income, taxable_income, standard_deduction, total_tax, estimated_payments, amount_owed_or_refund }
   - schedule_c: { business_name, gross_income, total_expenses, net_profit }
   - schedule_se: { net_earnings, self_employment_tax, deductible_half }
   - filing_readiness: { score (0-100), missing_items: string[], warnings: string[], ready_to_file: boolean }

2. **Worksheet** — a clean, printable text worksheet summarizing all tax data, organized by category (income, expenses, deductions, estimated payments, filing status). Include totals, notes, and Form 1040 line mappings where applicable.

3. **Filing method recommendation** — based on AGI:
   - If AGI <= $84,000: recommend IRS Free File
   - If AGI > $84,000: recommend TurboTax or H&R Block
   - Include step-by-step instructions for the recommended method
   Structure: { method: "free_file"|"turbotax"|"mail_in"|"mixed", agi: number, reasoning: string, steps: string[] }

Respond with valid JSON only. Be concise. Structure:
{
  "json_summary": { form_1040: {...}, schedule_c: {...}, schedule_se: {...}, filing_readiness: {...} },
  "worksheet": "string (the full worksheet text)",
  "filing_recommendation": { method: "...", agi: 0, reasoning: "...", steps: ["..."] }
}`;

async function fetchCCTaxData(action: string, taxYear?: number): Promise<any> {
  const CC_TAX_URL = Deno.env.get("CC_TAX_URL");
  const CC_TAX_KEY = Deno.env.get("CC_TAX_KEY");
  if (!CC_TAX_URL) throw new Error("CC_TAX_URL is not configured");
  if (!CC_TAX_KEY) throw new Error("CC_TAX_KEY is not configured");
  const resp = await fetch(\`\${CC_TAX_URL}/functions/v1/control-center-api\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${CC_TAX_KEY}\` },
    body: JSON.stringify({ action, tax_year: taxYear }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(\`CC Tax \${action} failed (\${resp.status}): \${detail.slice(0, 500)}\`);
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
      return new Response(JSON.stringify({ ok: false, error: "tax_years must be a non-empty array" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    async function processYear(year: number) {
      console.log(\`Processing tax year \${year}...\`);
      const [workflowStatus, yearConfig, documents, transactions, reconciliations, discrepancies, plReport] = await Promise.all([
        fetchCCTaxData("get_workflow_status", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_year_config", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_documents", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_transactions", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_reconciliations", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_discrepancies", year).catch((e) => ({ error: e.message })),
        fetchCCTaxData("get_pl_report", year).catch((e) => ({ error: e.message })),
      ]);
      const taxDataPayload = JSON.stringify({ tax_year: year, workflow_status: workflowStatus, year_config: yearConfig, documents, transactions, reconciliations, discrepancies, pl_report: plReport });
      const userPrompt = \`Generate all three tax document outputs for tax year \${year}. Be concise. Here is the tax data:\n\n\${taxDataPayload}\`;
      const generated = await callClaudeJSON<{ json_summary: Record<string, unknown>; worksheet: string; filing_recommendation: Record<string, unknown>; }>(
        TAX_SYSTEM_PROMPT, userPrompt, { required: ["json_summary", "worksheet", "filing_recommendation"] }, 4096,
      );
      return { year: String(year), data: { json_summary: generated.json_summary, worksheet: generated.worksheet, filing_recommendation: generated.filing_recommendation } };
    }
    const yearResults = await Promise.all(taxYears.map((y) => processYear(y)));
    const results: Record<string, any> = {};
    for (const r of yearResults) { results[r.year] = r.data; }
    return new Response(JSON.stringify({ ok: true, tax_years: taxYears, results }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-tax-documents error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
