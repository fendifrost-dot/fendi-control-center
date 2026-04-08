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

const FREE_FILE_AGI_HINT = 85000;

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce THREE outputs from raw tax data.

IMPORTANT: We are NOT filing taxes — only preparing documents so the client is READY to file.

1. JSON summary — structured data with form_1040, schedule_c, schedule_se, filing_readiness.
2. Worksheet — clean printable text.
3. Filing method recommendation based on AGI.

CRITICAL: The "ingestion_income" field contains VERIFIED income extracted directly from analyzed tax documents (1099-K, W-2, etc.). If the CC Tax data (transactions, pl_report) is empty, shows errors, or shows $0, you MUST use ingestion_income as the adjusted_gross_income. NEVER return AGI=$0 when ingestion_income > 0.

IMPORTANT: The ingestion_income field contains verified income from analyzed documents. If other income data is $0 or empty, use ingestion_income as the adjusted_gross_income.

PRODUCT RULES (non-negotiable):
- Do NOT tell the user their only option is to "hire a CPA", "see a tax professional", or "use a professional preparer" as the primary path. This product always generates mail-in IRS PDF drafts and a TurboTax (TXF) export regardless of AGI.
- For filing_recommendation.steps: prefer concrete product actions (review worksheet, open TXF in TurboTax, print IRS PDFs from Drive, use IRS Free File if AGI under ~$85k) — not generic "consult a professional" unless you also list the generated deliverables first.

Respond with valid JSON only. The json_summary MUST include form_1040.adjusted_gross_income as a real number based on the data provided. Always include a "filing_recommendation" key with at minimum { "method": "...", "agi": <number>, "steps": ["..."] }.`;

/** Ingest response uses pl_summary (ingest-tax-documents); aggregated_data is legacy/alternate. */
function extractIngestionIncome(ingestionData: Record<string, unknown> | null): number {
  if (!ingestionData) return 0;
  const pl = ingestionData.pl_summary;
  if (pl && typeof pl === "object") {
    const n = Number((pl as Record<string, unknown>).total_income);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const agg = ingestionData.aggregated_data;
  if (agg && typeof agg === "object") {
    const n = Number((agg as Record<string, unknown>).total_income);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const top = Number(ingestionData.total_income);
  return Number.isFinite(top) && top > 0 ? top : 0;
}

function currentAgiFromJsonSummary(
  jsonSummary: Record<string, unknown> | undefined,
): unknown {
  const f = jsonSummary?.form_1040;
  if (f && typeof f === "object") {
    return (f as Record<string, unknown>).adjusted_gross_income;
  }
  return undefined;
}

/** After Claude: if AGI is missing/zero, fall back to document ingestion total. */
function normalizeTaxGenerationOutput(
  result: { json_summary: Record<string, unknown> },
  taxDataPayload: { ingestion_income?: number },
): void {
  const currentAgi = currentAgiFromJsonSummary(result.json_summary);
  console.log(
    `AGI override check: ingestion_income=${taxDataPayload?.ingestion_income}, current AGI=${currentAgi}`,
  );

  const ingestionIncome = Number(taxDataPayload?.ingestion_income) || 0;
  if (ingestionIncome <= 0) return;

  const summary = result.json_summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== "object") return;

  const form1040Raw = summary.form_1040;
  const form1040 =
    form1040Raw && typeof form1040Raw === "object"
      ? (form1040Raw as Record<string, unknown>)
      : {};

  const agiRaw = form1040.adjusted_gross_income;
  const agiNum = Number(agiRaw);
  const missingOrZero =
    agiRaw == null ||
    agiRaw === "" ||
    !Number.isFinite(agiNum) ||
    agiNum === 0;

  if (!missingOrZero) return;

  summary.form_1040 = {
    ...form1040,
    adjusted_gross_income: ingestionIncome,
  };
}

const PRO_PREP_REGEX =
  /tax\s+professional|hire\s+a\s+cpa|\bcpa\b|enrolled\s+agent|tax\s+preparer|professional\s+preparer|see\s+a\s+professional|consult\s+a\s+pro/i;

function sanitizeFilingRecommendation(
  rec: Record<string, unknown> | undefined,
  agi: number,
): Record<string, unknown> {
  const softwareHint =
    agi <= FREE_FILE_AGI_HINT
      ? "Use IRS Free File or import the TXF into TurboTax (your AGI is within typical Free File limits)."
      : "Import the TXF into TurboTax or similar paid software; IRS Free File guided partners often cap around $85k AGI.";

  const base: Record<string, unknown> = {
    method: typeof rec?.method === "string" && rec.method.trim() && !PRO_PREP_REGEX.test(rec.method)
      ? rec.method
      : (agi <= FREE_FILE_AGI_HINT
        ? "IRS Free File or TurboTax (TXF import)"
        : "TurboTax/paid software or mail-in IRS PDF drafts"),
    agi,
    steps: [] as string[],
  };

  const rawSteps = Array.isArray(rec?.steps) ? rec.steps as unknown[] : [];
  const kept = rawSteps
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0 && !PRO_PREP_REGEX.test(s))
    .slice(0, 12);

  const defaults = [
    "Review the generated worksheet and JSON summary for accuracy.",
    softwareHint,
    "Open the client tax folder on Google Drive: draft IRS PDFs (mail-in) and the .txf file should both be present.",
  ];

  base.steps = kept.length > 0 ? kept : defaults;
  return { ...rec, ...base };
}

/** Never throws — returns { error: string } on failure so ingestion + Claude still run. */
async function fetchCCTaxData(action: string, taxYear?: number): Promise<any> {
  try {
    const CC_TAX_URL = Deno.env.get("CC_TAX_URL");
    const CC_TAX_KEY = Deno.env.get("CC_TAX_KEY");
    if (!CC_TAX_URL) {
      return { error: "CC_TAX_URL is not configured" };
    }
    if (!CC_TAX_KEY) {
      return { error: "CC_TAX_KEY is not configured" };
    }

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
      return {
        error: `CC Tax ${action} failed (${resp.status}): ${detail.slice(0, 500)}`,
      };
    }
    return await resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `CC Tax ${action} request failed: ${msg}` };
  }
}

async function runTxfExport(
  taxReturnId: string,
  clientName: string,
  year: number
): Promise<any> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/export-txf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        tax_return_id: taxReturnId,
        client_name: clientName,
        tax_year: year,
      }),
    });
    return await r.json();
  } catch (e) {
    console.error('[generate-tax-documents] runTxfExport failed:', String(e));
    return { ok: false, error: String(e) };
  }
}

async function runIngestion(
  clientName: string,
  clientId: string,
  year: number
): Promise<any> {
  try {
    console.log(`[generate] Running ingestion for ${clientName} (${clientId}) year ${year}...`);
    const r = await fetch(
      `${SUPABASE_URL}/functions/v1/ingest-tax-documents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          client_name: clientName,
          client_id: clientId,
          tax_year: year,
        }),
      }
    );
    const result = await r.json();
    console.log(`[generate] Ingestion result for ${clientName} ${year}:`, JSON.stringify(result).slice(0, 500));
    return result;
  } catch (e) {
    console.error(`[generate] Ingestion error for ${clientName} ${year}:`, String(e));
    return { ok: false, error: String(e) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const taxYears: number[] =
      body.tax_years ?? [body.tax_year ?? new Date().getFullYear()];
    if (!Array.isArray(taxYears) || taxYears.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "tax_years must be a non-empty array of years",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Run ingestion for all years in parallel first (skip if recent data exists)
    const t_start = Date.now();
    const ingestionResults: Record<string, any> = {};
    if (body.client_name || body.client_id) {
      const ingestionSupa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const ingestionPromises = taxYears.map(async (y) => {
        // Check for recent ingestion data (< 1 hour old) to skip expensive re-ingestion
        const { data: recentReturn } = await ingestionSupa
          .from("tax_returns")
          .select("id, json_summary, updated_at")
          .eq("client_name", body.client_name || body.client_id)
          .eq("tax_year", y)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const ONE_HOUR = 60 * 60 * 1000;
        const recentlyIngested = recentReturn?.updated_at &&
          (Date.now() - new Date(recentReturn.updated_at).getTime()) < ONE_HOUR;
        if (recentlyIngested && recentReturn?.json_summary) {
          console.log(`[generate] Skipping ingestion for ${y} — recent data exists (${recentReturn.id}, ${Math.round((Date.now() - new Date(recentReturn.updated_at).getTime()) / 1000)}s old)`);
          return { year: String(y), result: { success: true, cached: true, ...recentReturn.json_summary } };
        }
        const result = await runIngestion(
          body.client_name || body.client_id,
          body.client_id || "unknown",
          y
        );
        return { year: String(y), result };
      });
      const ingestionDone = await Promise.all(ingestionPromises);
      for (const { year, result } of ingestionDone) {
        ingestionResults[year] = result;
      }
      console.log(`[generate] Ingestion took ${Date.now() - t_start}ms for ${taxYears.join(", ")}. Results:`, JSON.stringify(Object.keys(ingestionResults)));
    } else {
      console.warn("[generate] No client_name or client_id — skipping ingestion step");
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
        fetchCCTaxData("get_workflow_status", year),
        fetchCCTaxData("get_year_config", year),
        fetchCCTaxData("get_documents", year),
        fetchCCTaxData("get_transactions", year),
        fetchCCTaxData("get_reconciliations", year),
        fetchCCTaxData("get_discrepancies", year),
        fetchCCTaxData("get_pl_report", year),
      ]);

      // Merge CC Tax data with ingestion results so Claude sees real document data
      const ingestionData = (ingestionResults[String(year)] || null) as
        | Record<string, unknown>
        | null;
      const ingestionIncome = extractIngestionIncome(ingestionData);
      const ingestTotals =
        (ingestionData?.aggregated_data && typeof ingestionData.aggregated_data === "object"
          ? ingestionData.aggregated_data
          : null) ??
        (ingestionData?.pl_summary && typeof ingestionData.pl_summary === "object"
          ? ingestionData.pl_summary
          : null);

      const taxDataPayloadObj = {
        tax_year: year,
        workflow_status: workflowStatus,
        year_config: yearConfig,
        documents,
        transactions,
        reconciliations,
        discrepancies,
        pl_report: plReport,
        // CRITICAL: Verified income from analyzed documents — use as AGI if CC Tax data is empty
        ingestion_income: ingestionIncome,
        // Ingestion results from actual Drive documents (1099s, W-2s, receipts)
        ingested_documents: Array.isArray(ingestionData?.processed_files)
          ? ingestionData.processed_files
          : (ingestionData?.documents || []),
        ingestion_totals: ingestTotals,
        ingestion_pl: ingestTotals,
        ingestion_summary: ingestionData
          ? {
            files_processed: Number(ingestionData.files_processed) ||
              (Array.isArray(ingestionData.processed_files)
                ? ingestionData.processed_files.length
                : 0),
            total_income: extractIngestionIncome(ingestionData),
            total_expenses:
              ingestTotals && typeof ingestTotals === "object"
                ? Number((ingestTotals as Record<string, unknown>).total_expenses) || 0
                : 0,
            net_profit:
              ingestTotals && typeof ingestTotals === "object"
                ? Number((ingestTotals as Record<string, unknown>).net_income) ||
                  Number((ingestTotals as Record<string, unknown>).net_profit) ||
                  0
                : 0,
            document_types: Array.isArray(ingestionData.processed_files)
              ? (ingestionData.processed_files as { doc_type?: string; name?: string }[]).map(
                (d) => d.doc_type || d.name || "unknown",
              )
              : [],
          }
          : null,
      };

      const taxDataPayload = JSON.stringify(taxDataPayloadObj);

      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Be concise.

CRITICAL: ingestion_income and ingestion_totals contain the REAL aggregated income from analyzed documents. Use them as the PRIMARY source for total_income and AGI. Do NOT return AGI=$0 if ingestion_income > 0 or ingestion_totals.total_income > 0.

IMPORTANT: The "ingested_documents" section contains data extracted directly from the client's actual tax documents (1099-K forms, W-2s, receipts, etc.) found in their Google Drive folder. Use this data as the PRIMARY source of truth for income figures, especially if the CC Tax data (transactions, pl_report) is empty or shows errors.

Here is the tax data:

${taxDataPayload}`;

      // Only require json_summary and worksheet — filing_recommendation is optional
      const t_claude = Date.now();
      const generated = await callClaudeJSON<{
        json_summary: Record<string, unknown>;
        worksheet: string;
        filing_recommendation?: Record<string, unknown>;
      }>(
        TAX_SYSTEM_PROMPT,
        userPrompt,
        { required: ["json_summary", "worksheet"] }, 4096);
      console.log(`[generate] Claude analysis took ${Date.now() - t_claude}ms for year ${year}`);

      normalizeTaxGenerationOutput(generated, taxDataPayloadObj);

      // Provide sensible default for filing_recommendation if Claude didn't return it
      const summary = generated.json_summary as Record<string, any>;
      const form1040 = (summary?.form_1040 || {}) as Record<string, any>;
      const readiness = (summary?.filing_readiness || {}) as Record<
        string,
        any
      >;
      // AGI fallback: if Claude returned $0 but ingestion found real income, override
      let agi = Number(form1040.adjusted_gross_income) || 0;
      if (agi === 0 && ingestionIncome > 0) {
        console.log(`[generate] AGI was $0 but ingestion_income is $${ingestionIncome} — overriding AGI`);
        agi = ingestionIncome;
        form1040.adjusted_gross_income = ingestionIncome;
        form1040.total_income = ingestionIncome;
      }

      const recommendation = sanitizeFilingRecommendation(
        (generated.filing_recommendation || {
          method: agi <= FREE_FILE_AGI_HINT
            ? "IRS Free File / TurboTax import (TXF)"
            : "TurboTax (TXF) and mail-in IRS PDF drafts",
          agi: agi,
          steps: [
            "Review the generated worksheet for accuracy",
            "Verify all income sources are accounted for",
            agi <= FREE_FILE_AGI_HINT
              ? "Import the TXF file into TurboTax or use IRS Free File"
              : "Use TurboTax or similar with TXF import, and/or print IRS PDF drafts to mail",
          ],
        }) as Record<string, unknown>,
        agi,
      ) as Record<string, any>;

      // Persist to Supabase
      const t_upsert = Date.now();
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

      console.log(`[generate] Upsert took ${Date.now() - t_upsert}ms — taxReturnId: ${taxReturnId}`);

      await logAudit(supabase, {
        tax_return_id: taxReturnId,
        action: "generated",
        actor: "generate-tax-documents",
        new_values: { status: "draft", year },
      });

      // Always produce both IRS PDF drafts (Drive + storage) and TXF — AGI only affects filing *recommendation* text.
      const t_pdftxf = Date.now();
      const pdfBody = {
        tax_return_id: taxReturnId,
        client_id: body.client_id || "unknown",
        client_name: body.client_name || body.client_id || "unknown",
        tax_year: year,
        computed_data: summary,
        draft_mode: true,
      };

      async function runPdfFill() {
        try {
          const r = await fetch(
            `${SUPABASE_URL}/functions/v1/fill-tax-forms`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              },
              body: JSON.stringify(pdfBody),
            }
          );
          return await r.json();
        } catch (e) {
          console.error('[generate-tax-documents] runPdfFill failed:', String(e));
          return { ok: false, error: String(e) };
        }
      }

      console.log(
        `[generate] AGI $${agi} — kicking off IRS PDFs + TXF as background work (Free File hint threshold $${FREE_FILE_AGI_HINT})`,
      );

      // Run PDF/TXF generation synchronously — IRS PDFs are cached in Supabase storage
      // so fetches are sub-second. Synchronous avoids EdgeRuntime.waitUntil compatibility issues.
      const [pdfResults, txfResults] = await Promise.all([
        runPdfFill(),
        runTxfExport(
          taxReturnId,
          body.client_name || body.client_id || "unknown",
          year
        ),
      ]);
      console.log(`[generate] PDF+TXF took ${Date.now() - t_pdftxf}ms`);
      console.log(`[generate] Total pipeline: ${Date.now() - t_start}ms`);
      console.log('[generate-tax-documents] PDF results:', JSON.stringify(pdfResults));
      console.log('[generate-tax-documents] TXF results:', JSON.stringify(txfResults));

      return {
        year: String(year),
        data: {
          json_summary: generated.json_summary,
          worksheet: generated.worksheet,
          filing_recommendation: recommendation,
          tax_return_id: taxReturnId,
          pdf_results: pdfResults,
          txf_results: txfResults,
          pdf_txf_status: "completed",
          ingestion_results: ingestionResults[String(year)] || null,
          agi,
          output_strategy: "pdf_and_txf_always",
        },
      };
    }

    const yearResults = await Promise.all(taxYears.map((y) => processYear(y)));

    const results: Record<string, any> = {};
    for (const r of yearResults) {
      results[r.year] = r.data;
    }

    return new Response(
      JSON.stringify({ ok: true, tax_years: taxYears, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-tax-documents error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
