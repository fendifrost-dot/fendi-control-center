/** Canonical shape for Claude + PDF fill (Option C review model). */

export type Form1040Draft = {
  first_name?: string;
  last_name?: string;
  ssn?: string;
  address?: string;
  city_state_zip?: string;
  filing_status?: string;
  wages?: number;
  taxable_interest?: number;
  ordinary_dividends?: number;
  total_income?: number;
  adjusted_gross_income?: number;
  standard_deduction?: number;
  taxable_income?: number;
  total_tax?: number;
  total_payments?: number;
  refund?: number;
  amount_owed_or_refund?: number;
};

export type ScheduleCDraft = {
  business_name?: string;
  gross_receipts?: number;
  total_expenses?: number;
  net_profit?: number;
};

export type ScheduleSEDraft = {
  net_earnings?: number;
  se_tax?: number;
  deductible_half?: number;
};

export type FilingReadinessDraft = {
  score?: number;
  missing_items?: string[];
  ready_to_file?: boolean;
};

export type TaxJsonSummary = {
  form_1040?: Form1040Draft;
  schedule_c?: ScheduleCDraft;
  schedule_se?: ScheduleSEDraft;
  filing_readiness?: FilingReadinessDraft;
  /** Internal: validation warnings, last review timestamp */
  _review_meta?: {
    warnings?: string[];
    validated_at?: string;
  };
};

export function parseJsonSummary(raw: unknown): TaxJsonSummary {
  if (!raw || typeof raw !== "object") return {};
  return raw as TaxJsonSummary;
}

export function validateTaxSummary(s: TaxJsonSummary): string[] {
  const w: string[] = [];
  const f = s.form_1040 || {};
  const wages = Number(f.wages) || 0;
  const interest = Number(f.taxable_interest) || 0;
  const div = Number(f.ordinary_dividends) || 0;
  const totalIncome = Number(f.total_income) || 0;
  const agi = Number(f.adjusted_gross_income) || 0;

  if (totalIncome > 0 && wages + interest + div > totalIncome * 1.5) {
    w.push("Total income looks lower than major line items combined — double-check Line 9 / AGI.");
  }
  if (agi > 0 && totalIncome > 0 && agi > totalIncome) {
    w.push("AGI is higher than total income — confirm adjustments and deductions.");
  }
  if (agi > 0 && agi < totalIncome * 0.5) {
    w.push("AGI is much lower than total income — confirm adjustments are correct.");
  }

  const tax = Number(f.total_tax) || 0;
  const payments = Number(f.total_payments) || 0;
  const owed = Number(f.amount_owed_or_refund);
  if (tax > 0 && payments > 0 && Number.isFinite(owed) && Math.abs(payments - tax - owed) > 1 && Math.abs(payments - tax + owed) > 1) {
    w.push("Refund/owed may not match tax vs payments — verify Line 24 / 33 / 34 / 37.");
  }

  return w;
}

export function summaryToRowPatch(summary: TaxJsonSummary, filingRec: Record<string, unknown>) {
  const f = summary.form_1040 || {};
  return {
    json_summary: summary as unknown as Record<string, unknown>,
    filing_recommendation: filingRec,
    filing_status: f.filing_status ?? null,
    agi: f.adjusted_gross_income ?? null,
    total_income: f.total_income ?? null,
    total_tax: f.total_tax ?? null,
    amount_owed_or_refund: f.amount_owed_or_refund ?? null,
    filing_readiness_score: summary.filing_readiness?.score ?? null,
    filing_method: typeof filingRec.method === "string" ? filingRec.method : null,
    updated_at: new Date().toISOString(),
  };
}
