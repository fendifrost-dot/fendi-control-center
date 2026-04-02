import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { upsertTaxReturn, logAudit } from "../_shared/taxReturns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
  const resp = await fetch(`${CC_TAX_URL}/functions/v1/control-center-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CC_TAX_KEY}` },
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
      return new Response(JSON.stringify({ ok: false, error: "tax_years must be a non-empty array" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    async function processYear(year: number) {
      console.log(`Processing tax year ${year}...`);
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
      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Be concise. Here is the tax data:\n\n${taxDataPayload}`;
      const generated = await callClaudeJSON<{ json_summary: Record<string, unknown>; worksheet: string; filing_recommendation: Record<string, unknown>; }>(
        TAX_SYSTEM_PROMPT, userPrompt, { required: ["json_summary", "worksheet", "filing_recommendation"] }, 4096,
      );

      // === Persist to tax_returns table ===
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const summary = generated.json_summary as Record<string, any>;
      const form1040 = (summary?.form_1040 || {}) as Record<string, any>;
      const readiness = (summary?.filing_readiness || {}) as Record<string, any>;
      const recommendation = generated.filing_recommendation as Record<string, any>;

      const { id: taxReturnId } = await upsertTaxReturn(supabase, {
        client_id: body.client_id || "unknown",
        client_name: body.client_name || body.client_id || "unknown",
        tax_year: year,
        status: "draft",
        filing_status: form1040.filing_status || "unknown",
        json_summary: summary,
        worksheet: generated.worksheet,
        filing_recommendation: recommendation,
        agi: form1040.adjusted_gross_income,
        total_income: form1040.total_income,
        total_tax: form1040.total_tax,
        amount_owed_or_refund: form1040.amount_owed_or_refund,
        filing_readiness_score: readiness.score,
        filing_method: recommendation?.method,
        model: "claude",
        created_by: "generate-tax-documents",
      });

      await logAudit(supabase, {
        tax_return_id: taxReturnId,
        action: "generated",
        actor: "generate-tax-documents",
        new_values: { status: "draft", year },
      });

      // === Trigger PDF filling ===
      let pdfResults: any = null;
      try {
        const pdfResp = await fetch(`${SUPABASE_URL}/functions/v1/fill-tax-forms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            tax_return_id: taxReturnId,
            client_id: body.client_id || "unknown",
            client_name: body.client_name || body.client_id || "unknown",
            tax_year: year,
            computed_data: summary,
            draft_mode: true,
          }),
        });
        pdfResults = await pdfResp.json();
        console.log(`PDF filling complete for year ${year}:`, pdfResults?.ok);
      } catch (pdfErr) {
        console.error("PDF filling error:", pdfErr);
        pdfResults = { ok: false, error: String(pdfErr) };
      }

      return { year: String(year), data: { json_summary: generated.json_summary, worksheet: generated.worksheet, filing_recommendation: generated.filing_recommendation, tax_return_id: taxReturnId, pdf_results: pdfResults } };
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
