import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { upsertTaxReturn, logAudit } from "../_shared/taxReturns.ts";
import { crossCheckReturn } from "../_shared/crossCheckReturn.ts";

function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Resolve real client UUID when Telegram/API sent client_id \"unknown\" but client_name is present. */
async function resolveClientIdForGenerate(
  supabase: ReturnType<typeof createClient>,
  body: { client_id?: string; client_name?: string },
): Promise<{ client_id: string; client_name: string }> {
  const rawId = (body.client_id ?? "").trim();
  const rawName = (body.client_name ?? "").trim();
  if (rawId && rawId !== "unknown") {
    return { client_id: rawId, client_name: rawName || rawId };
  }
  if (rawName) {
    const { data: client } = await supabase
      .from("clients")
      .select("id, name")
      .ilike("name", `%${escapeIlike(rawName)}%`)
      .limit(1)
      .maybeSingle();
    if (client) {
      return { client_id: client.id, client_name: client.name };
    }
  }
  return { client_id: rawId || "unknown", client_name: rawName || rawId || "unknown" };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FREE_FILE_AGI_HINT = 85000;

const VALID_FILING_STATUSES = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_widow",
] as const;
type FilingStatus = typeof VALID_FILING_STATUSES[number];

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

REQUIRED in json_summary.form_1040:
- filing_status: must be one of "single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_widow"
- If not determinable from documents, default to "single" for individual filers

Respond with valid JSON only. The json_summary MUST include form_1040.adjusted_gross_income as a real number based on the data provided. Always include a "filing_recommendation" key with at minimum { "method": "...", "agi": <number>, "steps": ["..."] }.`;

function normalizeFilingStatus(raw: unknown): FilingStatus {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (VALID_FILING_STATUSES.includes(normalized as FilingStatus)) {
    return normalized as FilingStatus;
  }
  if (normalized.includes("joint")) return "married_filing_jointly";
  if (normalized.includes("separate")) return "married_filing_separately";
  if (normalized.includes("head")) return "head_of_household";
  if (normalized.includes("widow")) return "qualifying_widow";
  return "single";
}

function calculate2022FederalIncomeTax(taxableIncome: number, filingStatus: FilingStatus): number {
  const taxable = Math.max(0, taxableIncome);

  const brackets: Record<FilingStatus, Array<{ upto: number; base: number; rate: number; floor: number }>> = {
    single: [
      { upto: 10275, base: 0, rate: 0.10, floor: 0 },
      { upto: 41775, base: 1027.5, rate: 0.12, floor: 10275 },
      { upto: 89075, base: 4807.5, rate: 0.22, floor: 41775 },
      { upto: 170050, base: 15213.5, rate: 0.24, floor: 89075 },
      { upto: 215950, base: 34647.5, rate: 0.32, floor: 170050 },
      { upto: 539900, base: 49335.5, rate: 0.35, floor: 215950 },
      { upto: Number.POSITIVE_INFINITY, base: 162718, rate: 0.37, floor: 539900 },
    ],
    married_filing_jointly: [
      { upto: 20550, base: 0, rate: 0.10, floor: 0 },
      { upto: 83550, base: 2055, rate: 0.12, floor: 20550 },
      { upto: 178150, base: 9615, rate: 0.22, floor: 83550 },
      { upto: 340100, base: 30427, rate: 0.24, floor: 178150 },
      { upto: 431900, base: 69295, rate: 0.32, floor: 340100 },
      { upto: 647850, base: 98671, rate: 0.35, floor: 431900 },
      { upto: Number.POSITIVE_INFINITY, base: 174253.5, rate: 0.37, floor: 647850 },
    ],
    married_filing_separately: [
      { upto: 10275, base: 0, rate: 0.10, floor: 0 },
      { upto: 41775, base: 1027.5, rate: 0.12, floor: 10275 },
      { upto: 89075, base: 4807.5, rate: 0.22, floor: 41775 },
      { upto: 170050, base: 15213.5, rate: 0.24, floor: 89075 },
      { upto: 215950, base: 34647.5, rate: 0.32, floor: 170050 },
      { upto: 323925, base: 49335.5, rate: 0.35, floor: 215950 },
      { upto: Number.POSITIVE_INFINITY, base: 87126.75, rate: 0.37, floor: 323925 },
    ],
    head_of_household: [
      { upto: 14650, base: 0, rate: 0.10, floor: 0 },
      { upto: 55900, base: 1465, rate: 0.12, floor: 14650 },
      { upto: 89050, base: 6415, rate: 0.22, floor: 55900 },
      { upto: 170050, base: 13708, rate: 0.24, floor: 89050 },
      { upto: 215950, base: 33148, rate: 0.32, floor: 170050 },
      { upto: 539900, base: 47836, rate: 0.35, floor: 215950 },
      { upto: Number.POSITIVE_INFINITY, base: 161218.5, rate: 0.37, floor: 539900 },
    ],
    qualifying_widow: [
      { upto: 20550, base: 0, rate: 0.10, floor: 0 },
      { upto: 83550, base: 2055, rate: 0.12, floor: 20550 },
      { upto: 178150, base: 9615, rate: 0.22, floor: 83550 },
      { upto: 340100, base: 30427, rate: 0.24, floor: 178150 },
      { upto: 431900, base: 69295, rate: 0.32, floor: 340100 },
      { upto: 647850, base: 98671, rate: 0.35, floor: 431900 },
      { upto: Number.POSITIVE_INFINITY, base: 174253.5, rate: 0.37, floor: 647850 },
    ],
  };

  const bracket = brackets[filingStatus].find((b) => taxable <= b.upto);
  if (!bracket) return 0;
  return bracket.base + (taxable - bracket.floor) * bracket.rate;
}

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
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { client_id: effectiveClientId, client_name: effectiveClientName } =
      await resolveClientIdForGenerate(supabaseAdmin, body);

    if (body.client_name || body.client_id) {
      const clientKey = effectiveClientId !== "unknown" ? effectiveClientId : (body.client_id || body.client_name);
      const ONE_HOUR = 60 * 60 * 1000;
      const ingestionPromises = taxYears.map(async (y) => {
        // Check for recent ingestion data (< 1 hour old) to skip expensive re-ingestion
        const { data: recentReturn } = await supabaseAdmin
          .from("tax_returns")
          .select("id, json_summary, updated_at")
          .eq("client_id", clientKey)
          .eq("tax_year", y)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const recentlyIngested = recentReturn?.updated_at &&
          (Date.now() - new Date(recentReturn.updated_at).getTime()) < ONE_HOUR;

        let result: Record<string, any>;
        if (recentlyIngested && recentReturn?.json_summary) {
          console.log(`[generate] Skipping ingestion for ${y} — recent data exists (${recentReturn.id}, ${Math.round((Date.now() - new Date(recentReturn.updated_at).getTime()) / 1000)}s old)`);
          result = { success: true, cached: true, ...recentReturn.json_summary };
        } else {
          result = await runIngestion(
            effectiveClientName || body.client_name || body.client_id || "unknown",
            effectiveClientId,
            y
          );
        }
        return { year: String(y), result };
      });
      const ingestionDone = await Promise.all(ingestionPromises);
      for (const { year, result } of ingestionDone) {
        ingestionResults[year] = result;
      }
      console.log(`[generate] Ingestion took ${Date.now() - t_start}ms for ${taxYears.join(", ")}.`);
    } else {
      console.warn("[generate] No client_name or client_id — skipping ingestion step");
    }

    async function processYear(year: number) {
      console.log(`Processing tax year ${year}...`);
      const t0 = Date.now();

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

      const priorYear = year - 1;
      let priorYearBlock = "";
      let manualBlock = "";
      if (effectiveClientId !== "unknown") {
        const { data: priorReturn } = await supabaseAdmin
          .from("tax_returns")
          .select("json_summary, filing_status, agi, total_income, client_name")
          .eq("client_id", effectiveClientId)
          .eq("tax_year", priorYear)
          .maybeSingle();

        if (priorReturn?.json_summary) {
          priorYearBlock = `

PRIOR YEAR (${priorYear}) DATA for comparison:
- Filing status: ${priorReturn.filing_status ?? "unknown"}
- AGI: $${priorReturn.agi ?? "N/A"}
- Total Income: $${priorReturn.total_income ?? "N/A"}
- Full summary: ${JSON.stringify(priorReturn.json_summary)}

Use this to:
1. Pre-populate recurring income sources
2. Flag deductions taken last year but missing this year
3. Carry forward any applicable items (depreciation, NOL, etc.)
4. Note significant changes in income for estimated tax planning`;
        }

        const { data: existingYearReturn } = await supabaseAdmin
          .from("tax_returns")
          .select("json_summary")
          .eq("client_id", effectiveClientId)
          .eq("tax_year", year)
          .maybeSingle();

        const existingJs = (existingYearReturn?.json_summary || {}) as Record<string, unknown>;
        const mi = existingJs.manual_income;
        const md = existingJs.manual_deductions;
        if (Array.isArray(mi) && mi.length > 0) {
          manualBlock += `\n\nMANUAL INCOME (already entered — include in totals):\n${JSON.stringify(mi)}`;
        }
        if (Array.isArray(md) && md.length > 0) {
          manualBlock +=
            `\n\nMANUAL DEDUCTIONS (already entered — include in Schedule C / Schedule A as appropriate):\n${JSON.stringify(md)}`;
        }
      }

      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Be concise.

CRITICAL: ingestion_income and ingestion_totals contain the REAL aggregated income from analyzed documents. Use them as the PRIMARY source for total_income and AGI. Do NOT return AGI=$0 if ingestion_income > 0 or ingestion_totals.total_income > 0.

IMPORTANT: The "ingested_documents" section contains data extracted directly from the client's actual tax documents (1099-K forms, W-2s, receipts, etc.) found in their Google Drive folder. Use this data as the PRIMARY source of truth for income figures, especially if the CC Tax data (transactions, pl_report) is empty or shows errors.

REQUIRED OUTPUT SHAPE:
- json_summary.form_1040.filing_status must be one of: single, married_filing_jointly, married_filing_separately, head_of_household, qualifying_widow
- If uncertain, default filing_status to "single"

Here is the tax data:

${taxDataPayload}${priorYearBlock}${manualBlock}`;

      // Only require json_summary and worksheet — filing_recommendation is optional
      console.log(`[generate] CC Tax fetches took ${Date.now() - t0}ms`);
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
      const filingStatus = normalizeFilingStatus(form1040.filing_status);
      form1040.filing_status = filingStatus;
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

      // Validate and normalize core tax math so persisted totals are deterministic.
      // SE tax: 92.35% of net SE income × 15.3%, capped at SS wage base ($147,000 for 2022)
      const netSEIncome = Number((summary?.schedule_se || summary?.schedule_c || {})?.net_profit) ||
        Number((summary?.schedule_se || {})?.net_earnings) || 0;
      const seBase = netSEIncome * 0.9235;
      const ssWageBase2022 = 147000;
      const ssTax = Math.min(seBase, ssWageBase2022) * 0.124;
      const medicareTax = seBase * 0.029;
      const seTax = Math.round((ssTax + medicareTax) * 100) / 100;
      const deductibleHalfSE = Math.round(seTax / 2 * 100) / 100;

      // AGI = total income - deductible half of SE tax (Schedule 1 line 15)
      const totalIncome = Number(form1040.total_income) || 0;
      const adjustedAgi = Math.round((totalIncome - deductibleHalfSE) * 100) / 100;
      agi = adjustedAgi;
      form1040.adjusted_gross_income = adjustedAgi;
      form1040.self_employment_tax_deduction = deductibleHalfSE;

      const standardDeductionDefault = filingStatus === "married_filing_jointly" || filingStatus === "qualifying_widow"
        ? 25900
        : 12950;
      const standardDeduction = Number(form1040.standard_deduction) || standardDeductionDefault;
      const taxableIncome = Math.max(0, adjustedAgi - standardDeduction);
      const calculatedTax = calculate2022FederalIncomeTax(taxableIncome, filingStatus);
      const totalTaxCalculated = calculatedTax + seTax;

      // Persist all calculated values
      form1040.standard_deduction = standardDeduction;
      form1040.taxable_income = Math.round(taxableIncome * 100) / 100;
      form1040.tax = Math.round(calculatedTax * 100) / 100;
      form1040.self_employment_tax = seTax;
      form1040.total_tax = Math.round(totalTaxCalculated * 100) / 100;
      if (summary.schedule_se) {
        summary.schedule_se.se_tax = seTax;
        summary.schedule_se.deductible_half = deductibleHalfSE;
      }
      console.log(`[generate] Tax math: income=$${totalIncome} - SE deduction=$${deductibleHalfSE} = AGI=$${adjustedAgi}, taxable=$${taxableIncome}, incomeTax=$${Math.round(calculatedTax*100)/100}, seTax=$${seTax}, total=$${Math.round(totalTaxCalculated*100)/100}`);

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

      if (effectiveClientId !== "unknown") {
        const { data: existingTr } = await supabaseAdmin
          .from("tax_returns")
          .select("json_summary")
          .eq("client_id", effectiveClientId)
          .eq("tax_year", year)
          .maybeSingle();
        const prev = (existingTr?.json_summary || {}) as Record<string, unknown>;
        if (Array.isArray(prev.manual_income) && prev.manual_income.length > 0) {
          (summary as Record<string, unknown>).manual_income = prev.manual_income;
        }
        if (Array.isArray(prev.manual_deductions) && prev.manual_deductions.length > 0) {
          (summary as Record<string, unknown>).manual_deductions = prev.manual_deductions;
        }
      }

      const accuracyWarnings = crossCheckReturn(summary as Record<string, unknown>);

      // Persist to Supabase
      const t_upsert = Date.now();
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      const { id: taxReturnId } = await upsertTaxReturn(supabase, {
        client_id: effectiveClientId,
        client_name: effectiveClientName || body.client_name || body.client_id || "unknown",
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

      const { error: analyzedDataError } = await supabase
        .from("tax_returns")
        .update({ analyzed_data: summary, updated_at: new Date().toISOString() })
        .eq("id", taxReturnId);
      if (analyzedDataError) {
        console.warn("[generate] analyzed_data update failed:", analyzedDataError.message);
      }
      await logAudit(supabase, {
        tax_return_id: taxReturnId,
        action: "generated",
        actor: "generate-tax-documents",
        new_values: { status: "draft", year },
      });

      // Always produce both IRS PDF drafts (Drive + storage) and TXF — AGI only affects filing *recommendation* text.
      const pdfBody = {
        tax_return_id: taxReturnId,
        client_id: effectiveClientId,
        client_name: effectiveClientName || body.client_name || body.client_id || "unknown",
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

      // Run PDF/TXF synchronously — ingestion cache makes this feasible within 150s timeout.
      // waitUntil is unreliable in Lovable's edge runtime.
      const t_pdftxf = Date.now();
      let pdfResults: any = null;
      let txfResults: any = null;
      try {
        [pdfResults, txfResults] = await Promise.all([
          runPdfFill(),
          runTxfExport(
            taxReturnId,
            effectiveClientName || body.client_name || body.client_id || "unknown",
            year
          ),
        ]);
        console.log(`[generate] PDF+TXF took ${Date.now() - t_pdftxf}ms`);
        console.log('[generate-tax-documents] PDF results:', JSON.stringify(pdfResults));
        console.log('[generate-tax-documents] TXF results:', JSON.stringify(txfResults));
      } catch (e) {
        console.error("[generate] PDF/TXF error:", String(e));
        pdfResults = { ok: false, error: String(e) };
        txfResults = { ok: false, error: String(e) };
      }
      console.log(`[generate] Total pipeline (year ${year}): ${Date.now() - t0}ms (full inc. ingestion: ${Date.now() - t_start}ms)`);

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
          accuracy_warnings: accuracyWarnings,
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
