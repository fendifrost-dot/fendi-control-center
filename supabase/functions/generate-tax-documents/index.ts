import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { upsertTaxReturn, logAudit } from "../_shared/taxReturns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce THREE outputs from raw tax data.\n\nIMPORTANT: We are NOT filing taxes â only preparing documents so the client is READY to file.\n\n1. JSON summary â structured data with form_1040, schedule_c, schedule_se, filing_readiness.\n2. Worksheet â clean printable text.\n3. Filing method recommendation based on AGI.\n\nRespond with valid JSON only.`;
et_transactions", year).catch((e) => ({
          error: e.message,
        })),
        fetchCCTaxData("get_reconciliations", year).catch((e) => ({
          error: e.message,
        })),
        fetchCCTaxData("get_discrepancies", year).catch((e) => ({
          error: e.message,
        })),
        fetchCCTaxData("get_pl_report", year).catch((e) => ({
          error: e.message,
        })),
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

      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Be concise.\n\nHere is the tax data:\n\n${taxDataPayload}`;

      const generated = await callClaudeJSON<{
        json_summary: Record<string, unknown>;
        worksheet: string;
        filing_recommendation: Record<string, unknown>;
      }>(
        TAX_SYSTEM_PROMPT,
        userPrompt,
        { required: ["json_summary", "worksheet", "filing_recommendation"] },
        4096,
      );

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const summary = generated.json_summary as Record<string, any>;
      const form1040 = (summary?.form_1040 || {}) as Record<string, any>;
      const readiness = (summary?.filing_readiness || {}) as Record<string, any>;
      const recommendation = generated.filing_recommendation as Record<string, any>;

      const { id: taxReturnId } = await upsertTaxReturn(supabase, {
        client_id: body.client_id || "unknown", client_name: body.client_name || body.client_id || "unknown",
        tax_year: year, status: "draft", filing_status: form1040.filing_status || "unknown",
        json_summary: summary, worksheet: generated.worksheet, filing_recommendation: recommendation,
        agi: form1040.adjusted_gross_income, total_income: form1040.total_income,
        total_tax: form1040.total_tax, amount_owed_or_refund: form1040.amount_owed_or_refund,
        filing_readiness_score: readiness.score, filing_method: recommendation?.method,
        model: "claude", created_by: "generate-tax-documents",
      });
      await logAudit(supabase, { tax_return_id: taxReturnId, action: "generated", actor: "generate-tax-documents", new_values: { status: "draft", year } });

      const agi = Number(form1040.adjusted_gross_income) || 0;
      let pdfResults: any = null; let txfResults: any = null;
      const pdfBody = { tax_return_id: taxReturnId, client_id: body.client_id || "unknown", client_name: body.client_name || body.client_id || "unknown", tax_year: year, computed_data: summary, draft_mode: true };

      if (agi <= 84000) {
        console.log(`[generate] AGI $${agi} <= $84,000 â generating TXF for Free File/TurboTax import`);
        txfResults = await runTxfExport(taxReturnId, body.client_name || body.client_id || "unknown", year);
        try { const r = await fetch(`${SUPABASE_URL}/functions/v1/fill-tax-forms`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify(pdfBody) }); pdfResults = await r.json(); } catch (e) { pdfResults = { ok: false, error: String(e) }; }
      } else {
        console.log(`[generate] AGI $${agi} > $84,000 â generating IRS PDF forms`);
        try { const r = await fetch(`${SUPABASE_URL}/functions/v1/fill-tax-forms`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify(pdfBody) }); pdfResults = await r.json(); } catch (e) { pdfResults = { ok: false, error: String(e) }; }
        txfResults = await runTxfExport(taxReturnId, body.client_name || body.client_id || "unknown", year);
      }

      return { year: String(year), data: { json_summary: generated.json_summary, worksheet: generated.worksheet, filing_recommendation: generated.filing_recommendation, tax_return_id: taxReturnId, pdf_results: pdfResults, txf_results: txfResults, ingestion_results: ingestionResults[String(year)] || null, agi, output_strategy: agi <= 84000 ? "txf_primary_pdf_backup" : "pdf_primary_txf_supplementary" } };
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
