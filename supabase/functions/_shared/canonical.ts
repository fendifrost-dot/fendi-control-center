/**
 * Canonical post-LLM tax summary shape.
 * Every numeric field is a non-negative number in dollars (2 decimal places allowed).
 * No strings, no nulls, no nested alt-shapes. The normalizer is responsible for
 * coercing any upstream representation into this exact shape.
 */
export interface CanonicalTaxSummary {
  // --- INCOME ---
  wages: number; // W-2 box 1 total across all W-2s
  business_income: number; // Schedule C gross receipts (NOT net)
  business_expenses: number; // Schedule C total expenses
  interest_income: number; // 1099-INT total
  dividend_income: number; // 1099-DIV ordinary total
  qualified_dividends: number; // 1099-DIV qualified subset (≤ dividend_income)
  capital_gains_short: number;
  capital_gains_long: number;
  other_income: number; // 1099-MISC other, 1099-NEC non-SE, etc.

  // --- ADJUSTMENTS ---
  se_tax_deduction: number; // half of SE tax, computed elsewhere — leave 0 here
  sep_ira_contribution: number;
  student_loan_interest: number;
  hsa_contribution: number;

  // --- DEDUCTIONS ---
  itemized_deductions: number; // 0 if taking standard
  uses_standard_deduction: boolean;

  // --- WITHHOLDING / PAYMENTS ---
  federal_withholding: number;
  estimated_payments: number;

  // --- METADATA ---
  tax_year: number; // e.g. 2022
  filing_status: "single" | "mfj" | "mfs" | "hoh" | "qw";
}

export const CANONICAL_NUMERIC_FIELDS: ReadonlyArray<keyof CanonicalTaxSummary> = [
  "wages",
  "business_income",
  "business_expenses",
  "interest_income",
  "dividend_income",
  "qualified_dividends",
  "capital_gains_short",
  "capital_gains_long",
  "other_income",
  "se_tax_deduction",
  "sep_ira_contribution",
  "student_loan_interest",
  "hsa_contribution",
  "itemized_deductions",
  "federal_withholding",
  "estimated_payments",
] as const;

function coerceNumber(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.abs(raw);
  }
  if (typeof raw === "string") {
    const s = raw.replace(/\$/g, "").replace(/,/g, "").trim();
    const n = Number(s);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Negative inputs become absolute so expenses stay positive in canonical form. */
function coerceNumberAllowNegativeForNet(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const s = raw.replace(/\$/g, "").replace(/,/g, "").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function getAtPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function firstFromPaths(obj: unknown, paths: readonly (readonly string[])[]): unknown {
  for (const p of paths) {
    const v = getAtPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const WAGES_KEY_PATHS = [
  ["wages"],
  ["w2_wages"],
  ["w2", "box1_total"],
  ["w2", "wages"],
  ["total_wages"],
  ["form_1040", "wages"],
  ["form_1040", "wages_salaries_tips"],
  ["form_1040", "line_1"],
] as const;

const BUSINESS_INCOME_KEY_PATHS = [
  ["business_income"],
  ["gross_receipts"],
  ["gross"],
  ["schedule_c", "gross_receipts"],
  ["schedule_c", "business_income"],
  ["schedule_c", "gross"],
  ["schedule_c", "line_1"],
] as const;

const BUSINESS_EXPENSES_KEY_PATHS = [
  ["business_expenses"],
  ["total_expenses"],
  ["schedule_c", "total_expenses"],
  ["schedule_c", "expenses"],
] as const;

const NET_PROFIT_PATHS = [
  ["schedule_c", "net_profit"],
  ["schedule_c", "net_profit_or_loss"],
  ["schedule_c", "line_31"],
  ["schedule_c", "net_income"],
  ["net_profit"],
] as const;

const INTEREST_KEY_PATHS = [
  ["interest_income"],
  ["1099_int_total"],
  ["interest"],
  ["form_1040", "interest_income"],
  ["form_1040", "line_2b"],
] as const;

const DIVIDEND_KEY_PATHS = [
  ["dividend_income"],
  ["dividends"],
  ["form_1040", "dividend_income"],
  ["form_1040", "line_3b"],
] as const;

const QUAL_DIV_KEY_PATHS = [
  ["qualified_dividends"],
  ["form_1040", "qualified_dividends"],
] as const;

const CG_SHORT_PATHS = [
  ["capital_gains_short"],
  ["short_term_capital_gains"],
  ["form_1040", "capital_gains_short"],
] as const;

const CG_LONG_PATHS = [
  ["capital_gains_long"],
  ["long_term_capital_gains"],
  ["form_1040", "capital_gains_long"],
] as const;

const OTHER_INCOME_PATHS = [
  ["other_income"],
  ["form_1040", "other_income"],
] as const;

const SE_TAX_DEDUCTION_PATHS = [
  ["se_tax_deduction"],
  ["self_employment_tax_deduction"],
  ["form_1040", "self_employment_tax_deduction"],
] as const;

const SEP_IRA_PATHS = [["sep_ira_contribution"], ["sep_ira"]] as const;
const STUDENT_LOAN_PATHS = [["student_loan_interest"], ["form_1040", "student_loan_interest"]] as const;
const HSA_PATHS = [["hsa_contribution"], ["form_1040", "hsa_contribution"]] as const;

const ITEMIZED_PATHS = [
  ["itemized_deductions"],
  ["itemized"],
  ["form_1040", "itemized_deductions"],
] as const;

const USES_STANDARD_PATHS = [
  ["uses_standard_deduction"],
  ["form_1040", "uses_standard_deduction"],
] as const;

const FEDERAL_WH_PATHS = [
  ["federal_withholding"],
  ["withholding"],
  ["form_1040", "federal_withholding"],
  ["form_1040", "withholding"],
] as const;

const EST_PAYMENTS_PATHS = [["estimated_payments"], ["form_1040", "estimated_payments"]] as const;

const SCHEDULE_SE_NET_PATHS = [
  ["schedule_se", "net_earnings_from_self_employment"],
  ["schedule_se", "net_earnings"],
  ["schedule_se", "net_profit"],
] as const;

function inferUsesStandard(raw: unknown): boolean {
  const v = firstFromPaths(raw, USES_STANDARD_PATHS);
  if (typeof v === "boolean") return v;
  const item = coerceNumber(firstFromPaths(raw, ITEMIZED_PATHS));
  if (item > 0) return false;
  return true;
}

/**
 * Normalize arbitrary LLM output into canonical shape.
 * - Coerces string numerics ("120,000.00", "$1,234", " 500 ") to numbers
 * - Flattens known alt-shapes:
 *     { schedule_c: { gross: X, expenses: Y } } -> business_income=X, business_expenses=Y
 *     { w2: { box1_total: X } } or { w2_wages: X } -> wages=X
 *     { 1099_int_total: X } or { interest: X } -> interest_income=X
 * - Fills missing numeric fields with 0
 * - Does NOT throw. Returns best-effort canonical; guards.ts decides if it's valid.
 */
export function normalizeToCanonical(
  raw: unknown,
  taxYear: number,
  filingStatus: CanonicalTaxSummary["filing_status"],
): CanonicalTaxSummary {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  let wages = coerceNumber(firstFromPaths(raw, WAGES_KEY_PATHS));

  let businessIncome = coerceNumber(firstFromPaths(raw, BUSINESS_INCOME_KEY_PATHS));
  let businessExpenses = coerceNumber(firstFromPaths(raw, BUSINESS_EXPENSES_KEY_PATHS));

  const netFromPaths = coerceNumberAllowNegativeForNet(firstFromPaths(raw, NET_PROFIT_PATHS));
  if (
    businessIncome === 0 &&
    businessExpenses === 0 &&
    Number.isFinite(netFromPaths) &&
    netFromPaths !== 0
  ) {
    businessIncome = Math.max(0, netFromPaths);
    businessExpenses = Math.max(0, businessIncome - netFromPaths);
  }

  const seNetRaw = firstFromPaths(raw, SCHEDULE_SE_NET_PATHS);
  const seNet = coerceNumberAllowNegativeForNet(seNetRaw);
  if (
    businessIncome === 0 &&
    businessExpenses === 0 &&
    Number.isFinite(seNet) &&
    seNet !== 0
  ) {
    businessIncome = Math.max(0, seNet);
    businessExpenses = 0;
  }

  let interestIncome = coerceNumber(firstFromPaths(raw, INTEREST_KEY_PATHS));
  let dividendIncome = coerceNumber(firstFromPaths(raw, DIVIDEND_KEY_PATHS));
  let qualifiedDividends = coerceNumber(firstFromPaths(raw, QUAL_DIV_KEY_PATHS));
  let capitalGainsShort = coerceNumber(firstFromPaths(raw, CG_SHORT_PATHS));
  let capitalGainsLong = coerceNumber(firstFromPaths(raw, CG_LONG_PATHS));
  let otherIncome = coerceNumber(firstFromPaths(raw, OTHER_INCOME_PATHS));

  const seTaxDeduction = coerceNumber(firstFromPaths(raw, SE_TAX_DEDUCTION_PATHS));
  const sepIra = coerceNumber(firstFromPaths(raw, SEP_IRA_PATHS));
  const studentLoan = coerceNumber(firstFromPaths(raw, STUDENT_LOAN_PATHS));
  const hsa = coerceNumber(firstFromPaths(raw, HSA_PATHS));

  const itemizedDeductions = coerceNumber(firstFromPaths(raw, ITEMIZED_PATHS));
  const usesStandard = inferUsesStandard(raw);

  const federalWithholding = coerceNumber(firstFromPaths(raw, FEDERAL_WH_PATHS));
  const estimatedPayments = coerceNumber(firstFromPaths(raw, EST_PAYMENTS_PATHS));

  const form1040 = root.form_1040;
  const f1040 = form1040 && typeof form1040 === "object"
    ? (form1040 as Record<string, unknown>)
    : undefined;

  const formTotalRaw = f1040?.total_income;
  const formTotal = coerceNumberAllowNegativeForNet(formTotalRaw);

  const netBusiness = businessIncome - businessExpenses;
  const sumParts =
    wages +
    interestIncome +
    dividendIncome +
    capitalGainsShort +
    capitalGainsLong +
    otherIncome +
    netBusiness;

  if (Number.isFinite(formTotal) && formTotal !== 0 && Math.abs(formTotal - sumParts) > 0.015) {
    otherIncome = Math.max(0, otherIncome + (formTotal - sumParts));
  }

  qualifiedDividends = Math.min(qualifiedDividends, dividendIncome);

  return {
    wages,
    business_income: businessIncome,
    business_expenses: businessExpenses,
    interest_income: interestIncome,
    dividend_income: dividendIncome,
    qualified_dividends: qualifiedDividends,
    capital_gains_short: capitalGainsShort,
    capital_gains_long: capitalGainsLong,
    other_income: otherIncome,
    se_tax_deduction: seTaxDeduction,
    sep_ira_contribution: sepIra,
    student_loan_interest: studentLoan,
    hsa_contribution: hsa,
    itemized_deductions: itemizedDeductions,
    uses_standard_deduction: usesStandard,
    federal_withholding: federalWithholding,
    estimated_payments: estimatedPayments,
    tax_year: taxYear,
    filing_status: filingStatus,
  };
}
