// supabase/functions/generate-tax-documents/index.ts
// UPDATED: Full pipeline — ingest → load manual data → Claude classification → deterministic math → persist → TXF → PDF.
//
// Pipeline:
// 1. Call ingest-tax-documents to analyze all Drive docs for the client/year
// 2. Load existing manual_income/manual_deductions from tax_returns table
// 3. Call CC Tax API to get any additional data
// 4. Use Claude to generate the tax return (classification, worksheet, filing recommendation)
// 5. OVERRIDE Claude's math with deterministic computation (taxConstants.ts)
// 6. Persist to tax_returns table (preserving manual data)
// 7. If e-file eligible: generate TXF file for TurboTax via export-txf
// 8. Trigger fill-tax-forms for IRS PDF generation
// 9. Return everything

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { upsertTaxReturn, logAudit } from "../_shared/taxReturns.ts";
import { recomputeTaxDeterministic, normalizeFilingStatus, getStandardDeduction } from "../_shared/taxConstants.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TAX_SYSTEM_PROMPT = `You are a senior tax accountant AI assistant. You produce THREE outputs from raw tax data.

IMPORTANT: We are NOT filing taxes — only preparing documents so the client is READY to file (mail-in or e-file).

1. **JSON summary** — structured data with:
   - form_1040: { filing_status, wages_salaries, interest_income, dividend_income, total_income, adjusted_gross_income, taxable_income, standard_deduction, total_tax, estimated_payments, federal_withheld, amount_owed_or_refund }
   - schedule_c: { business_name, ein, business_address, business_city_state_zip, business_code, gross_receipts, gross_income, total_expenses, net_profit, expense_breakdown: { advertising, car_truck, commissions, contract_labor, depreciation, insurance, interest_mortgage, interest_other, legal_professional, office_expense, rent_other, repairs, supplies, taxes_licenses, travel, meals, utilities, wages_paid, other } }
   - schedule_se: { net_earnings, self_employment_tax, deductible_half }
   - filing_readiness: { score (0-100), missing_items: string[], warnings: string[], ready_to_file: boolean }

2. **Worksheet** — a clean, printable text worksheet summarizing all tax data, organized by category (income, expenses, deductions, estimated payments, filing status). Include totals, notes, and Form 1040 line mappings where applicable.

3. **Filing method recommendation** — based on AGI:
   - If AGI <= $84,000: recommend IRS Free File + TurboTax import via TXF
   - If AGI > $84,000: recommend TurboTax paid or H&R Block
   - For multi-year unfiled: recommend paper filing for all years
   - Include step-by-step instructions

Structure:
{
  "json_summary": { form_1040: {...}, schedule_c: {...}, schedule_se: {...}, filing_readiness: {...} },
  "worksheet": "string (the full worksheet text)",
  "filing_recommendation": { method: "free_file"|"turbotax"|"mail_in"|"mixed", agi: number, reasoning: string, steps: ["..."] }
}

Respond with valid JSON only. Use REAL numbers from the provided data. Do not make up numbers.`;

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

async function callIngestDocuments(
  clientName: string,
  clientId: string,
  taxYear: number
): Promise<any> {
  console.log("[PIPELINE] Step 1: Ingesting documents from Drive...");
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/ingest-tax-documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        client_name: clientName,
        client_id: clientId,
        tax_year: taxYear,
      }),
    });

    const result = await resp.json();
    if (result.ok || result.success) {
      console.log("[PIPELINE] Ingestion complete: " + (result.documents_processed || result.files_processed || 0) + " docs, $" +
        (result.aggregated_data?.total_income || result.pl_summary?.total_income || 0) + " income");
    } else {
      console.warn("[PIPELINE] Ingestion returned error: " + (result.error || "unknown"));
    }
    return result;
  } catch (err) {
    console.error("[PIPELINE] Ingestion failed: " + err);
    return { ok: false, error: String(err) };
  }
}

async function callExportTXF(
  taxReturnId: string,
  clientId: string,
  clientName: string,
  taxYear: number,
  computedData: any
): Promise<any> {
  console.log("[PIPELINE] Exporting TXF for TurboTax import...");
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/export-txf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        tax_return_id: taxReturnId,
        client_id: clientId,
        client_name: clientName,
        tax_year: taxYear,
        computed_data: computedData,
        upload_to_drive: true,
      }),
    });

    const result = await resp.json();
    if (result.ok || result.success) {
      console.log("[PIPELINE] TXF export complete: " + (result.txf_file?.file_name || result.file_name || "unknown"));
    } else {
      console.warn("[PIPELINE] TXF export error: " + (result.error || "unknown"));
    }
    return result;
  } catch (err) {
    console.error("[PIPELINE] TXF export failed: " + err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Load existing manual_income and manual_deductions from the tax_returns table.
 * These are entered via the UI and should NOT be overwritten by re-generation.
 */
async function loadManualData(
  supabase: any,
  clientId: string,
  taxYear: number
): Promise<{ manualIncome: any[]; manualDeductions: any[]; manualMileage: any; existingReturnId: string | null }> {
  console.log("[PIPELINE] Loading manual data for " + clientId + " " + taxYear + "...");
  try {
    const { data, error } = await supabase
      .from("tax_returns")
      .select("id, json_summary")
      .eq("client_id", clientId)
      .eq("tax_year", taxYear)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[PIPELINE] Manual data query error: " + error.message);
      return { manualIncome: [], manualDeductions: [], manualMileage: null, existingReturnId: null };
    }

    if (!data || !data.json_summary) {
      console.log("[PIPELINE] No existing tax return found — no manual data to load.");
      return { manualIncome: [], manualDeductions: [], manualMileage: null, existingReturnId: null };
    }

    const summary = data.json_summary as Record<string, any>;
    const manualIncome = Array.isArray(summary.manual_income) ? summary.manual_income : [];
    const manualDeductions = Array.isArray(summary.manual_deductions) ? summary.manual_deductions : [];
    const manualMileage = summary.manual_mileage || null;

    console.log("[PIPELINE] Loaded manual data: " +
      manualIncome.length + " income entries, " +
      manualDeductions.length + " deduction entries" +
      (manualMileage ? ", mileage data present" : ""));

    return { manualIncome, manualDeductions, manualMileage, existingReturnId: data.id };
  } catch (err) {
    console.error("[PIPELINE] Manual data load failed: " + err);
    return { manualIncome: [], manualDeductions: [], manualMileage: null, existingReturnId: null };
  }
}

/**
 * Apply manual data to the income/expense totals.
 * Manual income with mode "override" REPLACES ingested income.
 * Manual income with mode "add" (or no mode) ADDS to ingested income.
 * Manual deductions are always additive (they represent real expenses).
 */
function applyManualData(params: {
  ingestedIncome: number;
  ingestedExpenses: number;
  manualIncome: any[];
  manualDeductions: any[];
  manualMileage: any;
}): {
  grossReceipts: number;
  totalExpenses: number;
  expenseBreakdown: Record<string, number>;
  mileageDeduction: number;
  dataSourceNotes: string[];
} {
  const notes: string[] = [];
  let grossReceipts = params.ingestedIncome;
  let totalExpenses = params.ingestedExpenses;
  const expenseBreakdown: Record<string, number> = {};

  // Process manual income
  if (params.manualIncome.length > 0) {
    let manualIncomeTotal = 0;
    for (const entry of params.manualIncome) {
      const amount = Number(entry.amount) || 0;
      manualIncomeTotal += amount;
    }

    // Check for override vs add mode
    const hasOverride = params.manualIncome.some((e: any) => e.mode === "override");
    if (hasOverride) {
      // Override mode: manual income REPLACES ingested income
      notes.push(`Manual income (override mode): $${manualIncomeTotal.toFixed(2)} replacing ingested $${grossReceipts.toFixed(2)}`);
      grossReceipts = manualIncomeTotal;
    } else {
      // Add mode (default): if ingestion found income AND manual has income,
      // use the LARGER of the two to avoid double-counting
      if (grossReceipts > 0 && manualIncomeTotal > 0) {
        notes.push(`Both ingested ($${grossReceipts.toFixed(2)}) and manual ($${manualIncomeTotal.toFixed(2)}) income found — using MANUAL as source of truth to avoid double-counting.`);
        grossReceipts = manualIncomeTotal;
      } else if (manualIncomeTotal > 0) {
        notes.push(`Manual income: $${manualIncomeTotal.toFixed(2)} (no ingested income)`);
        grossReceipts = manualIncomeTotal;
      } else {
        notes.push(`Ingested income: $${grossReceipts.toFixed(2)} (no manual income)`);
      }
    }
  } else {
    notes.push(`Ingested income only: $${grossReceipts.toFixed(2)}`);
  }

  // Process manual deductions (always additive — these are real expenses)
  if (params.manualDeductions.length > 0) {
    let manualExpenseTotal = 0;
    for (const entry of params.manualDeductions) {
      const amount = Number(entry.amount) || 0;
      const category = String(entry.category || "other").toLowerCase().replace(/\s+/g, "_");
      manualExpenseTotal += amount;
      expenseBreakdown[category] = (expenseBreakdown[category] || 0) + amount;
    }
    totalExpenses += manualExpenseTotal;
    notes.push(`Manual deductions: $${manualExpenseTotal.toFixed(2)} across ${params.manualDeductions.length} entries`);
  }

  // Process mileage
  let mileageDeduction = 0;
  if (params.manualMileage) {
    const miles = Number(params.manualMileage.business_miles) || 0;
    const rate = Number(params.manualMileage.rate) || 0.585; // 2022 IRS rate
    mileageDeduction = Math.round(miles * rate * 100) / 100;
    if (mileageDeduction > 0) {
      totalExpenses += mileageDeduction;
      expenseBreakdown["car_truck"] = (expenseBreakdown["car_truck"] || 0) + mileageDeduction;
      notes.push(`Mileage deduction: ${miles} miles × $${rate}/mi = $${mileageDeduction.toFixed(2)}`);
    }
  }

  return { grossReceipts, totalExpenses, expenseBreakdown, mileageDeduction, dataSourceNotes: notes };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const taxYears: number[] = body.tax_years ?? [body.tax_year ?? new Date().getFullYear()];
    const clientName = body.client_name || body.client_id || "unknown";
    const clientId = body.client_id || clientName;
    const skipIngestion = body.skip_ingestion === true || body.skip_drive_ingestion === true;
    const forceGenerate = body.force_generate === true;

    if (!Array.isArray(taxYears) || taxYears.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "tax_years must be a non-empty array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    async function processYear(year: number) {
      console.log("========================================");
      console.log("Processing tax year " + year + " for " + clientName);
      console.log("========================================");

      // ─── Step 1: Ingest documents from Google Drive ─────────
      let ingestionResult: any = null;
      if (!skipIngestion) {
        ingestionResult = await callIngestDocuments(clientName, clientId, year);
      } else {
        console.log("[PIPELINE] Skipping ingestion (skip_ingestion=true)");
      }

      // ─── Step 2: Load existing manual data from tax_returns ──
      console.log("[PIPELINE] Step 2: Loading manual data...");
      const { manualIncome, manualDeductions, manualMileage, existingReturnId } =
        await loadManualData(supabase, clientId, year);

      // ─── Step 3: Fetch data from CC Tax API ─────────────────
      console.log("[PIPELINE] Step 3: Fetching data from CC Tax API...");
      const [
        workflowStatus,
        yearConfig,
        documents,
        transactions,
        reconciliations,
        discrepancies,
        plReport,
      ] = await Promise.all([
        fetchCCTaxData("get_workflow_status", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_year_config", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_documents", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_transactions", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_reconciliations", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_discrepancies", year).catch((e: any) => ({ error: e.message })),
        fetchCCTaxData("get_pl_report", year).catch((e: any) => ({ error: e.message })),
      ]);

      // ─── Step 4: Build data payload for Claude ──────────────
      // Include manual data context so Claude knows about it
      const ingestionIncome = Number(
        ingestionResult?.aggregated_data?.total_income ||
        ingestionResult?.pl_summary?.total_income || 0
      );
      const ingestionExpenses = Number(
        ingestionResult?.aggregated_data?.total_expenses ||
        ingestionResult?.pl_summary?.total_expenses || 0
      );

      const taxDataPayload = JSON.stringify({
        tax_year: year,
        client_name: clientName,
        workflow_status: workflowStatus,
        year_config: yearConfig,
        documents,
        transactions,
        reconciliations,
        discrepancies,
        pl_report: plReport,
        ingestion_summary: ingestionResult?.aggregated_data || ingestionResult?.pl_summary || null,
        manual_income: manualIncome.length > 0 ? manualIncome : undefined,
        manual_deductions: manualDeductions.length > 0 ? manualDeductions : undefined,
        manual_mileage: manualMileage || undefined,
      });

      console.log("[PIPELINE] Step 4: Generating tax return with Claude...");
      const userPrompt = `Generate all three tax document outputs for tax year ${year} for client "${clientName}".

CRITICAL: Use the REAL financial data below. The ingestion_summary contains aggregated totals from analyzed documents.
If manual_income or manual_deductions are present, those are operator-entered values and should be treated as the primary source.
If transactions and pl_report have data, use those as a secondary reference.

Here is the tax data:\n\n${taxDataPayload}`;

      const generated = await callClaudeJSON<{
        json_summary: Record<string, unknown>;
        worksheet: string;
        filing_recommendation: Record<string, unknown>;
      }>(
        TAX_SYSTEM_PROMPT,
        userPrompt,
        { required: ["json_summary", "worksheet", "filing_recommendation"] },
        8192,
      );

      // ─── Step 5: DETERMINISTIC OVERRIDE ─────────────────────
      // Claude classifies and organizes data; we do the math.
      console.log("[PIPELINE] Step 5: Applying deterministic tax computation...");

      const claudeSummary = generated.json_summary as Record<string, any>;
      const claudeForm1040 = (claudeSummary?.form_1040 || {}) as Record<string, any>;
      const claudeScheduleC = (claudeSummary?.schedule_c || {}) as Record<string, any>;
      const filingStatus = normalizeFilingStatus(claudeForm1040.filing_status || "single");

      // Get Claude's raw income/expense classification
      const claudeGrossReceipts = Number(claudeScheduleC.gross_receipts || claudeScheduleC.gross_income || claudeScheduleC.business_income || 0);
      const claudeExpenses = Number(claudeScheduleC.total_expenses || 0);
      const otherIncome = Number(claudeForm1040.wages_salaries || 0) +
                          Number(claudeForm1040.interest_income || 0) +
                          Number(claudeForm1040.dividend_income || 0);
      const estimatedPayments = Number(claudeForm1040.estimated_payments || 0);
      const federalWithheld = Number(claudeForm1040.federal_withheld || 0);

      // Apply manual data on top of ingested/Claude data
      const mergedData = applyManualData({
        ingestedIncome: claudeGrossReceipts > 0 ? claudeGrossReceipts : ingestionIncome,
        ingestedExpenses: claudeExpenses > 0 ? claudeExpenses : ingestionExpenses,
        manualIncome,
        manualDeductions,
        manualMileage,
      });

      // Run deterministic computation
      const deterministic = recomputeTaxDeterministic({
        grossReceipts: mergedData.grossReceipts,
        totalExpenses: mergedData.totalExpenses,
        otherIncome,
        filingStatus,
        year,
        estimatedPayments,
        federalWithheld,
      });

      // Log discrepancies between Claude and deterministic
      const claudeTotalTax = Number(claudeForm1040.total_tax || 0);
      if (Math.abs(claudeTotalTax - deterministic.totalTax) > 25) {
        console.warn(`[PIPELINE] Tax discrepancy: Claude=$${claudeTotalTax}, Deterministic=$${deterministic.totalTax}`);
        deterministic.warnings.push(
          `Claude computed total_tax=$${claudeTotalTax.toFixed(2)} but deterministic computation gives $${deterministic.totalTax.toFixed(2)} — using deterministic.`
        );
      }

      // Build the corrected summary — Claude's classification + our math
      const correctedSummary: Record<string, any> = {
        form_1040: {
          filing_status: filingStatus,
          wages_salaries: otherIncome,
          interest_income: Number(claudeForm1040.interest_income || 0),
          dividend_income: Number(claudeForm1040.dividend_income || 0),
          business_income: deterministic.netProfit,
          total_income: deterministic.totalIncome,
          adjusted_gross_income: deterministic.agi,
          standard_deduction: deterministic.standardDeduction,
          taxable_income: deterministic.taxableIncome,
          federal_tax: deterministic.federalTax,
          self_employment_tax: deterministic.seTax,
          self_employment_tax_deduction: deterministic.seDeduction,
          total_tax: deterministic.totalTax,
          estimated_payments: estimatedPayments,
          federal_withheld: federalWithheld,
          total_payments: deterministic.totalPayments,
          amount_owed_or_refund: deterministic.amountOwedOrRefund,
        },
        schedule_c: {
          business_name: claudeScheduleC.business_name || "",
          ein: claudeScheduleC.ein || "",
          business_address: claudeScheduleC.business_address || "",
          business_city_state_zip: claudeScheduleC.business_city_state_zip || "",
          business_code: claudeScheduleC.business_code || "",
          gross_receipts: mergedData.grossReceipts,
          gross_income: mergedData.grossReceipts,
          total_expenses: mergedData.totalExpenses,
          net_profit: deterministic.netProfit,
          expense_breakdown: {
            ...(claudeScheduleC.expense_breakdown || {}),
            ...mergedData.expenseBreakdown,
          },
        },
        schedule_se: {
          net_earnings: deterministic.netProfit > 0 ? Math.round(deterministic.netProfit * 0.9235 * 100) / 100 : 0,
          self_employment_tax: deterministic.seTax,
          deductible_half: deterministic.seDeduction,
        },
        filing_readiness: claudeSummary.filing_readiness || { score: 0, missing_items: [], warnings: [], ready_to_file: false },
        // Preserve manual data for next run
        manual_income: manualIncome.length > 0 ? manualIncome : undefined,
        manual_deductions: manualDeductions.length > 0 ? manualDeductions : undefined,
        manual_mileage: manualMileage || undefined,
        // Metadata
        computation_method: "deterministic_v1",
        data_sources: mergedData.dataSourceNotes,
        accuracy_warnings: deterministic.warnings,
      };

      // ─── Step 6: Validate before persisting ─────────────────
      const validationErrors: string[] = [];
      const validationWarnings: string[] = [...deterministic.warnings];

      if (mergedData.grossReceipts === 0 && ingestionResult?.files_processed > 0) {
        validationWarnings.push("Zero income computed despite " + ingestionResult.files_processed + " ingested documents.");
      }
      if (ingestionResult?.files_with_errors > 0) {
        validationWarnings.push(ingestionResult.files_with_errors + " documents failed during ingestion — income may be incomplete.");
      }

      const schedCCheck = Math.abs(deterministic.netProfit - (mergedData.grossReceipts - mergedData.totalExpenses));
      if (schedCCheck > 1) {
        validationErrors.push(`Schedule C math mismatch: net_profit=${deterministic.netProfit} but gross-expenses=${mergedData.grossReceipts - mergedData.totalExpenses}`);
      }

      const validationResult = {
        passed: validationErrors.length === 0,
        errors: validationErrors,
        warnings: validationWarnings,
      };

      if (!validationResult.passed && !forceGenerate) {
        console.error("[PIPELINE] Validation FAILED: " + validationErrors.join("; "));
        // Still persist but mark as validation_failed
      }

      // ─── Step 7: Persist to tax_returns table ───────────────
      console.log("[PIPELINE] Step 6: Persisting tax return...");

      const { id: taxReturnId } = await upsertTaxReturn(supabase, {
        client_id: clientId,
        client_name: clientName,
        tax_year: year,
        status: validationResult.passed ? "draft" : "validation_failed",
        filing_status: filingStatus,
        json_summary: correctedSummary,
        worksheet: generated.worksheet,
        filing_recommendation: generated.filing_recommendation as Record<string, any>,
        agi: deterministic.agi,
        total_income: deterministic.totalIncome,
        total_tax: deterministic.totalTax,
        amount_owed_or_refund: deterministic.amountOwedOrRefund,
        filing_readiness_score: (correctedSummary.filing_readiness as any)?.score,
        filing_method: (generated.filing_recommendation as any)?.method,
        model: "claude+deterministic",
        created_by: "generate-tax-documents",
      });

      await logAudit(supabase, {
        tax_return_id: taxReturnId,
        action: "generated",
        actor: "generate-tax-documents",
        new_values: {
          status: validationResult.passed ? "draft" : "validation_failed",
          year,
          computation_method: "deterministic_v1",
          ingestion_docs: ingestionResult?.documents_processed || ingestionResult?.files_processed || 0,
          manual_income_entries: manualIncome.length,
          manual_deduction_entries: manualDeductions.length,
          validation: validationResult,
        },
      });

      // ─── Step 8: Export TXF if income exists ────────────────
      let txfResult: any = null;
      if (deterministic.agi > 0) {
        txfResult = await callExportTXF(taxReturnId, clientId, clientName, year, correctedSummary);
        console.log("[PIPELINE] Step 7: TXF export " + (txfResult?.ok || txfResult?.success ? "success" : "failed"));
      } else {
        console.log("[PIPELINE] Step 7: Skipping TXF (AGI is 0 or negative)");
      }

      // ─── Step 9: Fill IRS PDF forms ─────────────────────────
      console.log("[PIPELINE] Step 8: Filling IRS PDF forms...");
      let pdfResults: any = null;
      try {
        const pdfResp = await fetch(`${SUPABASE_URL}/functions/v1/fill-tax-forms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            tax_return_id: taxReturnId,
            client_id: clientId,
            client_name: clientName,
            tax_year: year,
            computed_data: correctedSummary,
            draft_mode: true,
          }),
        });
        pdfResults = await pdfResp.json();
        console.log("[PIPELINE] PDF filling complete: " + (pdfResults?.ok ? "success" : "failed — " + (pdfResults?.error || "unknown")));
      } catch (pdfErr) {
        console.error("[PIPELINE] PDF filling error:", pdfErr);
        pdfResults = { ok: false, error: String(pdfErr) };
      }

      return {
        year: String(year),
        data: {
          json_summary: correctedSummary,
          worksheet: generated.worksheet,
          filing_recommendation: generated.filing_recommendation,
          tax_return_id: taxReturnId,
          computation_method: "deterministic_v1",
          validation: validationResult,
          data_sources: mergedData.dataSourceNotes,
          ingestion_result: ingestionResult ? {
            ok: ingestionResult.ok || ingestionResult.success,
            documents_processed: ingestionResult.documents_processed || ingestionResult.files_processed,
            aggregated_income: ingestionResult.aggregated_data?.total_income || ingestionResult.pl_summary?.total_income,
            aggregated_expenses: ingestionResult.aggregated_data?.total_expenses || ingestionResult.pl_summary?.total_expenses,
            files_with_errors: ingestionResult.files_with_errors || 0,
          } : null,
          txf_result: txfResult ? {
            ok: txfResult.ok || txfResult.success,
            efile_eligible: txfResult.efile_eligible,
            txf_url: txfResult.txf_file?.storage_url || txfResult.storage_url || txfResult.txf_file?.drive_url,
            import_instructions: txfResult.import_instructions,
          } : null,
          pdf_results: pdfResults,
          accuracy_warnings: deterministic.warnings,
        },
      };
    }

    const yearResults = await Promise.all(taxYears.map((y) => processYear(y)));

    const results: Record<string, any> = {};
    for (const r of yearResults) {
      results[r.year] = r.data;
    }

    return new Response(JSON.stringify({ ok: true, tax_years: taxYears, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generate-tax-documents error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
