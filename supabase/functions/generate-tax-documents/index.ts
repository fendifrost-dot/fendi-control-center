import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { callGPTJSON } from "../_shared/openai.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { upsertTaxReturn, logAudit } from "../_shared/taxReturns.ts";
import { crossCheckReturn } from "../_shared/crossCheckReturn.ts";
import { normalizeToCanonical, type CanonicalTaxSummary } from "../_shared/canonical.ts";
import { validateCanonical } from "../_shared/guards.ts";
import {
  mapManualUiCategoryToScheduleC,
  MANUAL_CATEGORY_MAP,
  SCHEDULE_C_CATEGORIES,
  UNCLASSIFIED_SCHEDULE_C,
  type ScheduleCCategoryKey,
} from "../_shared/categories.ts";

function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Resolve real client UUID when Telegram/API sent client_id \"unknown\" but client_name is present. */
async function resolveClientIdForGenerate(
  supabase: SupabaseClient,
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
      const c = client as { id: string; name: string };
      return { client_id: c.id, client_name: c.name };
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
const MILEAGE_RATE_2022 = 0.585;

type WorkflowIntentState = {
  client_id: string;
  client_name: string;
  tax_year: number;
  workflow: "generate_tax_return";
  statement_processing?: "in_progress" | "idle";
  statement_job_ids?: string[];
};

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

function toCanonicalFiling(fs: FilingStatus): CanonicalTaxSummary["filing_status"] {
  switch (fs) {
    case "married_filing_jointly":
      return "mfj";
    case "married_filing_separately":
      return "mfs";
    case "head_of_household":
      return "hoh";
    case "qualifying_widow":
      return "qw";
    default:
      return "single";
  }
}

function totalIncomeFromCanonical(c: CanonicalTaxSummary): number {
  const netBusiness = c.business_income - c.business_expenses;
  return Math.round(
    (c.wages +
      c.interest_income +
      c.dividend_income +
      c.capital_gains_short +
      c.capital_gains_long +
      c.other_income +
      netBusiness) *
      100,
  ) / 100;
}

/**
 * Same selection order as netSelfEmploymentIncomeFromSummary, but reads only CanonicalTaxSummary
 * (schedule_se net is folded into business_* during normalization).
 */
function netSelfEmploymentIncomeFromCanonical(c: CanonicalTaxSummary): number {
  const fromScheduleC = c.business_income - c.business_expenses;
  if (Number.isFinite(fromScheduleC) && fromScheduleC !== 0) {
    return fromScheduleC;
  }

  const totalIncome = totalIncomeFromCanonical(c);
  const wages = c.wages;
  if (totalIncome > 0 && wages === 0) {
    console.log(
      `[generate] netSEIncome: using canonical component total=$${totalIncome} (no wages; Schedule C/SE lines empty)`,
    );
    return totalIncome;
  }
  return 0;
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
  const form1040 = ingestionData.form_1040;
  if (form1040 && typeof form1040 === "object") {
    const f = form1040 as Record<string, unknown>;
    for (const k of ["total_income", "adjusted_gross_income"] as const) {
      const n = Number(f[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const schedC = ingestionData.schedule_c;
  if (schedC && typeof schedC === "object") {
    const c = schedC as Record<string, unknown>;
    for (const k of ["gross_receipts", "net_profit", "net_profit_or_loss", "line_31", "net_income"] as const) {
      const n = Number(c[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
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

/**
 * Net profit subject to SE tax — MUST prefer Schedule C over Schedule SE.
 * Bug we fixed: `(schedule_se || schedule_c).net_profit` used schedule_se first; Claude often
 * sends a partial schedule_se object without net_profit, so Schedule C net profit was ignored.
 */
function netSelfEmploymentIncomeFromSummary(summary: Record<string, unknown>): number {
  const c = (summary.schedule_c || {}) as Record<string, unknown>;
  const se = (summary.schedule_se || {}) as Record<string, unknown>;
  const fromScheduleC =
    Number(c.net_profit) ||
    Number(c.net_profit_or_loss) ||
    Number(c.line_31) ||
    Number(c.net_income) ||
    0;
  if (Number.isFinite(fromScheduleC) && fromScheduleC !== 0) {
    return fromScheduleC;
  }
  const fromSe =
    Number(se.net_earnings_from_self_employment) ||
    Number(se.net_earnings) ||
    Number(se.net_profit) ||
    0;
  if (Number.isFinite(fromSe) && fromSe !== 0) {
    return fromSe;
  }

  // Claude often omits Schedule C lines when totals are only on form_1040 — if there are no
  // wages but total_income > 0, treat total as net self-employment for SE tax (manual / 1099-K flows).
  const f = (summary.form_1040 || {}) as Record<string, unknown>;
  const totalIncome = Number(f.total_income) || 0;
  const wages = Number(f.wages ?? f.wages_salaries_tips ?? (f as Record<string, unknown>).line_1) || 0;
  if (totalIncome > 0 && wages === 0) {
    console.log(
      `[generate] netSEIncome: using form_1040.total_income=$${totalIncome} (no wages; Schedule C/SE lines empty)`,
    );
    return totalIncome;
  }
  return 0;
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
    total_income: Math.max(Number(form1040.total_income) || 0, ingestionIncome),
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
  year: number,
  driveFolderMapping?: Record<string, unknown>,
): Promise<any> {
  const ingestUrl = `${SUPABASE_URL}/functions/v1/ingest-tax-documents`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const baseBody = {
    client_name: clientName,
    client_id: clientId,
    tax_year: year,
    ...(driveFolderMapping && typeof driveFolderMapping === "object"
      ? { drive_folder_mapping: driveFolderMapping }
      : {}),
  };

  try {
    console.log(`[generate] Running chunked Drive ingestion for ${clientName} (${clientId}) year ${year}...`);

    const listRes = await fetch(ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...baseBody, mode: "list" }),
    });
    const listJson = await listRes.json();
    if (!listRes.ok || listJson.error) {
      console.warn(`[generate] ingest list failed:`, listJson?.error ?? listRes.status);
      return listJson;
    }

    const folderId = listJson.folder_id as string;
    const folderName = listJson.folder_name as string;
    const files = (listJson.files ?? []) as Array<{
      id: string;
      name: string;
      mimeType: string;
  }>;

    const chunkErrors: Array<{ name: string; error: string }> = [];
    for (const f of files) {
      const pr = await fetch(ingestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...baseBody,
          mode: "process_single",
          file_id: f.id,
          file_name: f.name,
          file_mime: f.mimeType,
          folder_id: folderId,
          folder_name: folderName,
        }),
      });
      const pj = await pr.json();
      if (!pr.ok || pj.success === false) {
        chunkErrors.push({
          name: f.name,
          error: (pj.error as string) || `HTTP ${pr.status}`,
        });
      }
    }

    const aggRes = await fetch(ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...baseBody,
        mode: "aggregate",
        folder_id: folderId,
        folder_name: folderName,
      }),
    });
    const result = await aggRes.json();
    if (!aggRes.ok) {
      console.warn(`[generate] ingest aggregate failed:`, result?.error ?? aggRes.status);
      return {
        ...result,
        ingest_chunk_errors: chunkErrors.length ? chunkErrors : undefined,
      };
    }

    if (chunkErrors.length > 0) {
      result.ingest_chunk_errors = chunkErrors;
    }
    console.log(`[generate] Ingestion result for ${clientName} ${year}:`, JSON.stringify(result).slice(0, 500));
    return result;
  } catch (e) {
    console.error(`[generate] Ingestion error for ${clientName} ${year}:`, String(e));
    return { ok: false, error: String(e) };
  }
}

function parseGenerateIntentLock(body: Record<string, unknown>): {
  taxYear?: number;
  clientName?: string;
  isGenerateTaxReturn: boolean;
  isCheckDrive: boolean;
} {
  const raw = String(
    body.command ?? body.message ?? body.text ?? body.user_input ?? body.prompt ?? "",
  ).trim();
  if (!raw) {
    return { isGenerateTaxReturn: false, isCheckDrive: false };
  }
  const lower = raw.toLowerCase();
  const gen = /generate\s+(\d{4})\s+tax\s+return\s+for\s+(.+)/i.exec(raw);
  return {
    taxYear: gen ? Number(gen[1]) : undefined,
    clientName: gen?.[2]?.trim(),
    isGenerateTaxReturn: /\bgenerate\b.*\btax return\b/i.test(lower),
    isCheckDrive: /\bcheck\s+drive\b/i.test(lower),
  };
}

async function dispatchExternalStatements(limit = 10): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/statement-external-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ limit }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function collectAsyncJobIds(ingestionResult: Record<string, unknown> | null): string[] {
  if (!ingestionResult) return [];
  const out = new Set<string>();
  const files = Array.isArray(ingestionResult.processed_files)
    ? ingestionResult.processed_files as Array<Record<string, unknown>>
    : [];
  for (const f of files) {
    const status = String(f.status ?? "");
    const jid = f.chunk_job_id ?? f.job_id;
    if ((status === "requires_async_processing" || status === "processing_chunked") && typeof jid === "string") {
      out.add(jid);
    }
  }
  const jobs = Array.isArray(ingestionResult.statement_chunk_jobs)
    ? ingestionResult.statement_chunk_jobs as Array<Record<string, unknown>>
    : [];
  for (const j of jobs) {
    const jid = j.job_id ?? j.id;
    if (typeof jid === "string") out.add(jid);
  }
  return Array.from(out);
}

async function persistWorkflowIntentState(
  supabase: SupabaseClient,
  state: WorkflowIntentState,
): Promise<void> {
  const { data: existing } = await supabase
    .from("tax_returns")
    .select("json_summary")
    .eq("client_id", state.client_id)
    .eq("tax_year", state.tax_year)
    .maybeSingle();

  const js = ((existing?.json_summary ?? {}) as Record<string, unknown>);
  await upsertTaxReturn(supabase, {
    client_id: state.client_id,
    client_name: state.client_name,
    tax_year: state.tax_year,
    status: "in_progress",
    json_summary: {
      ...js,
      workflow_intent_lock: state,
    },
    created_by: "generate-tax-documents",
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const intent = parseGenerateIntentLock(body);
    let taxYears: number[] = Array.isArray(body.tax_years)
      ? (body.tax_years as number[])
      : [Number(body.tax_year ?? new Date().getFullYear())];
    if (intent.taxYear && Number.isFinite(intent.taxYear)) {
      taxYears = [intent.taxYear];
    }
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

    // Intent lock: run only against the locked year to prevent year drift.
    taxYears = [taxYears[0]];

    // Run ingestion for locked year (fresh, no "no documents" shortcut).
    const t_start = Date.now();
    const ingestionResults: Record<string, any> = {};
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { client_id: effectiveClientId, client_name: effectiveClientName } =
      await resolveClientIdForGenerate(supabaseAdmin, body);
    const requestClientName = typeof body.client_name === "string" ? body.client_name : "";
    const requestClientId = typeof body.client_id === "string" ? body.client_id : "";
    const resolvedClientLabel = effectiveClientName || requestClientName || requestClientId || "unknown";

    if (effectiveClientId !== "unknown") {
      await persistWorkflowIntentState(supabaseAdmin, {
        client_id: effectiveClientId,
        client_name: effectiveClientName,
        tax_year: taxYears[0],
        workflow: "generate_tax_return",
        statement_processing: "idle",
        statement_job_ids: [],
      });
    }

    if (body.client_name || body.client_id) {
      const ingestionPromises = taxYears.map(async (y) => {
        const result = await runIngestion(
          resolvedClientLabel,
          effectiveClientId,
          y,
          (body.drive_folder_mapping as Record<string, unknown> | undefined),
        );
        return { year: String(y), result };
      });
      const ingestionDone = await Promise.all(ingestionPromises);
      for (const { year, result } of ingestionDone) {
        ingestionResults[year] = result;
      }

      for (const y of taxYears) {
        const key = String(y);
        const ing = (ingestionResults[key] || null) as Record<string, unknown> | null;
        const asyncJobIds = collectAsyncJobIds(ing);
        if (asyncJobIds.length > 0 && effectiveClientId !== "unknown") {
          const dispatch = await dispatchExternalStatements(10);
          await persistWorkflowIntentState(supabaseAdmin, {
            client_id: effectiveClientId,
            client_name: effectiveClientName,
            tax_year: y,
            workflow: "generate_tax_return",
            statement_processing: "in_progress",
            statement_job_ids: asyncJobIds,
          });
          ingestionResults[key] = {
            ...(ingestionResults[key] || {}),
            statement_processing: "in_progress",
            statement_job_ids: asyncJobIds,
            external_dispatch: dispatch,
          };
        }
      }
      console.log(`[generate] Ingestion took ${Date.now() - t_start}ms for ${taxYears.join(", ")}.`);

    // Cache fallback: if ingestion failed, try reading previously stored analyzed_data
    for (const y of taxYears) {
      const key = String(y);
      const ingResult = ingestionResults[key];
      const isFailed = !ingResult || ingResult.code === "WORKER_LIMIT" || ingResult.error;

      if (isFailed && effectiveClientId !== "unknown") {
        console.log(`[generate] Ingestion failed for ${key} (${ingResult?.code || ingResult?.error || "null"}) — checking cached analyzed_data`);
        const { data: cached } = await supabaseAdmin
          .from("tax_returns")
          .select("analyzed_data")
          .eq("client_id", effectiveClientId)
          .eq("tax_year", y)
          .maybeSingle();

        if (cached?.analyzed_data && typeof cached.analyzed_data === "object") {
          const ad = cached.analyzed_data as Record<string, unknown>;
          if (ad.pl_summary || ad.aggregated_data || ad.processed_files) {
            console.log(`[generate] Using cached analyzed_data for ${key} (source: ${ad.source || "unknown"}, updated: ${ad.updated_at || "?"})`);
            ingestionResults[key] = {
              success: true,
              source: "cache_fallback",
              pl_summary: ad.pl_summary,
              aggregated_data: ad.aggregated_data || ad.pl_summary,
              processed_files: ad.processed_files,
              documents: ad.documents,
              files_processed: Array.isArray(ad.processed_files) ? (ad.processed_files as unknown[]).length : 0,
            };
          }
        }

        if (!ingestionResults[key] || ingestionResults[key].code === "WORKER_LIMIT") {
          console.warn(`[generate] No cached data available for ${key} — proceeding with manual data only`);
        }
      }
    }
    } else {
      console.warn("[generate] No client_name or client_id — skipping ingestion step");
    }

    async function runTaxReturnPipeline(state: WorkflowIntentState) {
      const year = state.tax_year;
      console.log(`Processing tax year ${year}...`);
      console.log(`[generate] year=${year} entry: client_id=${effectiveClientId}`);
      let manualIncomeEntries: Array<Record<string, unknown>> = [];
      let manualDeductionEntries: Array<Record<string, unknown>> = [];
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

      let priorYearBlock = "";
      if (effectiveClientId !== "unknown" && !intent.isGenerateTaxReturn) {
        const priorYear = year - 1;
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
        if (Array.isArray(mi)) manualIncomeEntries = mi as Array<Record<string, unknown>>;
        if (Array.isArray(md)) manualDeductionEntries = md as Array<Record<string, unknown>>;
        console.log(
          `[generate] year=${year} loaded ${manualIncomeEntries.length} manual_income entries, ${manualDeductionEntries.length} manual_deduction entries (NOT passed to Claude)`,
        );
      }

      const userPrompt = `Generate all three tax document outputs for tax year ${year}. Be concise.

CRITICAL: ingestion_income and ingestion_totals contain the REAL aggregated income from analyzed documents. Use them as the PRIMARY source for total_income and AGI. Do NOT return AGI=$0 if ingestion_income > 0 or ingestion_totals.total_income > 0.

IMPORTANT: The "ingested_documents" section contains data extracted directly from the client's actual tax documents (1099-K forms, W-2s, receipts, etc.) found in their Google Drive folder. Use this data as the PRIMARY source of truth for income figures, especially if the CC Tax data (transactions, pl_report) is empty or shows errors.

REQUIRED OUTPUT SHAPE:
- json_summary.form_1040.filing_status must be one of: single, married_filing_jointly, married_filing_separately, head_of_household, qualifying_widow
- If uncertain, default filing_status to "single"

Here is the tax data:

${taxDataPayload}${priorYearBlock}`;

      // Only require json_summary and worksheet — filing_recommendation is optional
      console.log(`[generate] CC Tax fetches took ${Date.now() - t0}ms`);
      const t_claude = Date.now();
      const { data: existingForFallback } = await supabaseAdmin
        .from("tax_returns")
        .select("json_summary, worksheet, filing_recommendation")
        .eq("client_id", effectiveClientId)
        .eq("tax_year", year)
        .maybeSingle();
      const fallbackSummary = (existingForFallback?.json_summary && typeof existingForFallback.json_summary === "object")
        ? existingForFallback.json_summary as Record<string, unknown>
        : { form_1040: {}, schedule_c: {}, schedule_se: {}, filing_readiness: {} };
      const fallbackWorksheet = typeof existingForFallback?.worksheet === "string"
        ? existingForFallback.worksheet
        : `Tax prep worksheet fallback for ${year} (model unavailable).`;

      let generated: {
        json_summary: Record<string, unknown>;
        worksheet: string;
        filing_recommendation?: Record<string, unknown>;
      } = {
        json_summary: fallbackSummary,
        worksheet: fallbackWorksheet,
        filing_recommendation: (existingForFallback?.filing_recommendation &&
            typeof existingForFallback.filing_recommendation === "object")
          ? existingForFallback.filing_recommendation as Record<string, unknown>
          : undefined,
      };
      let llmUsed = "state_fallback";
      let llmError: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          generated = await callClaudeJSON<{
            json_summary: Record<string, unknown>;
            worksheet: string;
            filing_recommendation?: Record<string, unknown>;
          }>(
            TAX_SYSTEM_PROMPT,
            userPrompt,
            { required: ["json_summary", "worksheet"] },
            4096,
          );
          llmUsed = "claude";
          llmError = undefined;
          break;
        } catch (e) {
          llmError = e instanceof Error ? e.message : String(e);
        }
      }
      if (llmUsed !== "claude") {
        try {
          generated = await callGPTJSON<{
            json_summary: Record<string, unknown>;
            worksheet: string;
            filing_recommendation?: Record<string, unknown>;
          }>(
            TAX_SYSTEM_PROMPT,
            userPrompt,
            { required: ["json_summary", "worksheet"] },
            4096,
          );
          llmUsed = "gpt-4o-mini";
          llmError = undefined;
        } catch (e) {
          llmError = e instanceof Error ? e.message : String(e);
        }
      }
      console.log(`[generate] model step took ${Date.now() - t_claude}ms for year ${year} via ${llmUsed}`);

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

      // Deterministic manual-income application. Claude does not see manual_income in its
      // prompt (fix for Bug 3: prevents the cache->prompt->Claude double-count loop where
      // each Generate click re-adds manual_income to the previously-inflated total).
      const manualIncomeTotal = manualIncomeEntries.reduce((sum, entry) => {
        const n = Number((entry as Record<string, unknown>).amount);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);
      const mileageMiles = manualDeductionEntries.reduce((sum, entry) => {
        const n = Number((entry as Record<string, unknown>).miles);
        return Number.isFinite(n) && n > 0 ? sum + n : sum;
      }, 0);
      const mileageDeduction = Math.round(mileageMiles * MILEAGE_RATE_2022 * 100) / 100;
      const manualDeductionTotal = manualDeductionEntries.reduce((sum, entry) => {
        const n = Number((entry as Record<string, unknown>).amount);
        return Number.isFinite(n) ? sum + n : sum;
      }, 0);

      if (manualIncomeTotal > 0 || manualDeductionTotal > 0) {
        const scheduleCRaw = (summary.schedule_c || {}) as Record<string, unknown>;
        const scheduleC = { ...scheduleCRaw };

        const ingestionDerivedBusinessIncome =
          Number(taxDataPayloadObj.ingestion_income) || 0;

        const businessIncome =
          Math.round((ingestionDerivedBusinessIncome + manualIncomeTotal) * 100) / 100;

        for (const entry of manualDeductionEntries) {
          const amt = Number((entry as Record<string, unknown>).amount);
          if (!Number.isFinite(amt) || amt === 0) continue;
          const uiCat = String((entry as Record<string, unknown>).category || "");
          const mapped: ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C =
            MANUAL_CATEGORY_MAP[uiCat] !== undefined
              ? MANUAL_CATEGORY_MAP[uiCat]!
              : mapManualUiCategoryToScheduleC(uiCat);
          const key = mapped === UNCLASSIFIED_SCHEDULE_C ? "unclassified" : mapped;
          const prev = Number(scheduleC[key]) || 0;
          scheduleC[key] = Math.round((prev + amt) * 100) / 100;
        }

        let computedTotal = 0;
        for (const cat of Object.keys(SCHEDULE_C_CATEGORIES) as ScheduleCCategoryKey[]) {
          computedTotal += Number(scheduleC[cat]) || 0;
        }
        computedTotal += Number(scheduleC.unclassified) || 0;

        const totalExpenses = Math.round(computedTotal * 100) / 100;
        const netProfit = Math.round((businessIncome - totalExpenses) * 100) / 100;

        scheduleC.gross_receipts = businessIncome;
        scheduleC.business_income = businessIncome;
        scheduleC.total_expenses = totalExpenses;
        scheduleC.net_profit = netProfit;
        scheduleC.net_profit_or_loss = netProfit;
        scheduleC.line_31 = netProfit;
        summary.schedule_c = scheduleC;
        summary.mileage_calculation = {
          rate: MILEAGE_RATE_2022,
          miles: mileageMiles,
          amount: mileageDeduction,
        };

        const wages = Number(form1040.wages) || 0;
        form1040.total_income = Math.round((netProfit + wages) * 100) / 100;

        console.log(
          `[generate] Applied deterministic manual entries (per-line + total): manualIncome=$${manualIncomeTotal}, manualDeductions=$${manualDeductionTotal}, businessIncome=$${businessIncome}, netProfit=$${netProfit}, form_1040.total_income=$${form1040.total_income}`,
        );
      }

      const llmRaw = generated.json_summary;
      console.log("[generate-tax-documents] normalizing LLM output", {
        client_id: effectiveClientId,
        tax_year: year,
        raw_keys: Object.keys(
          llmRaw != null && typeof llmRaw === "object" ? (llmRaw as object) : {},
        ),
      });

      const canonical = normalizeToCanonical(
        summary as Record<string, unknown>,
        year,
        toCanonicalFiling(filingStatus),
      );
      const guarded = validateCanonical(canonical);

      if (!guarded.ok) {
        console.error("[generate-tax-documents] canonical validation failed", {
          client_id: effectiveClientId,
          tax_year: year,
          issues: guarded.issues,
        });
        throw new Response(
          JSON.stringify({
            error: "canonical_validation_failed",
            issues: guarded.issues,
          }),
          {
            status: 422,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (guarded.warnings.length > 0) {
        console.warn("[generate-tax-documents] canonical warnings", {
          client_id: effectiveClientId,
          tax_year: year,
          warnings: guarded.warnings,
        });
      }

      // Validate and normalize core tax math so persisted totals are deterministic.
      // SE tax: 92.35% of net SE income × 15.3%, capped at SS wage base ($147,000 for 2022)
      const netSEIncome = netSelfEmploymentIncomeFromCanonical(guarded.value);
      console.log(
        `[generate] SE base: netSEIncome=${netSEIncome} (from canonical summary; see netSelfEmploymentIncomeFromCanonical)`,
      );
      const seBase = Math.max(0, netSEIncome * 0.9235);  // clamp: no SE tax on net losses
      const ssWageBase2022 = 147000;
      const ssTax = Math.min(seBase, ssWageBase2022) * 0.124;
      const medicareTax = seBase * 0.029;
      const seTax = Math.round((ssTax + medicareTax) * 100) / 100;
      const deductibleHalfSE = Math.round(seTax / 2 * 100) / 100;

      // AGI = total income - deductible half of SE tax (Schedule 1 line 15)
      const totalIncome = totalIncomeFromCanonical(guarded.value);
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
      if (!summary.schedule_se || typeof summary.schedule_se !== "object") {
        summary.schedule_se = {};
      }
      const seOut = summary.schedule_se as Record<string, unknown>;
      seOut.se_tax = seTax;
      seOut.deductible_half = deductibleHalfSE;
      if (netSEIncome > 0) {
        seOut.net_earnings = seOut.net_earnings ?? seBase;
      }
      console.log(
        `[generate] Tax math: total_income=$${totalIncome} - SE deduction (½ SE tax)=$${deductibleHalfSE} => AGI=$${adjustedAgi} (form1040.agi persisted); seTax=$${seTax}, taxable=$${taxableIncome}, incomeTax=$${Math.round(calculatedTax * 100) / 100}, total=$${Math.round(totalTaxCalculated * 100) / 100}`,
      );

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
        client_name: resolvedClientLabel,
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
        model: llmUsed,
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
            resolvedClientLabel,
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
          income_summary: {
            total_income: Number(form1040.total_income) || 0,
            adjusted_gross_income: Number(form1040.adjusted_gross_income) || 0,
            ingestion_income: ingestionIncome,
          },
          expense_summary: {
            total_expenses: Number((summary.schedule_c as Record<string, unknown> | undefined)?.total_expenses) || 0,
            net_profit: Number((summary.schedule_c as Record<string, unknown> | undefined)?.net_profit) || 0,
            manual_deductions_total: manualDeductionTotal,
          },
          mileage_calculation: (summary.mileage_calculation && typeof summary.mileage_calculation === "object")
            ? summary.mileage_calculation
            : {
              rate: MILEAGE_RATE_2022,
              miles: 0,
              amount: 0,
            },
          missing_items: [
            ...(Number(form1040.total_income) > 0 ? [] : ["income"]),
            ...(Number((summary.schedule_c as Record<string, unknown> | undefined)?.total_expenses) > 0 ? [] : ["expenses"]),
            ...(Number(form1040.filing_status ? 1 : 0) > 0 ? [] : ["filing_status"]),
          ],
          readiness_status: {
            status: Number(readiness.score) >= 80 ? "ready" : "needs_review",
            score: Number(readiness.score) || 0,
          },
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
          llm_model_used: llmUsed,
          llm_error: llmError,
        },
      };
    }

    const yearResults = await Promise.all(
      taxYears.map((y) =>
        runTaxReturnPipeline({
          client_id: effectiveClientId,
          client_name: resolvedClientLabel,
          tax_year: y,
          workflow: "generate_tax_return",
        })
      ),
    );

    const results: Record<string, any> = {};
    for (const r of yearResults) {
      results[r.year] = r.data;
    }

    return new Response(
      JSON.stringify({ ok: true, tax_years: taxYears, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    if (err instanceof Response) {
      return err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-tax-documents error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
