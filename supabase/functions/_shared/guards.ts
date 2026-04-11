import type { CanonicalTaxSummary } from "./canonical.ts";
import { CANONICAL_NUMERIC_FIELDS } from "./canonical.ts";

export interface GuardIssue {
  field: keyof CanonicalTaxSummary | "(structural)";
  severity: "error" | "warn";
  message: string;
}

export type GuardResult =
  | { ok: true; value: CanonicalTaxSummary; warnings: GuardIssue[] }
  | { ok: false; issues: GuardIssue[] };

const FILING: readonly CanonicalTaxSummary["filing_status"][] = [
  "single",
  "mfj",
  "mfs",
  "hoh",
  "qw",
];

function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = n.toString();
  const i = s.indexOf(".");
  if (i === -1) return 0;
  return s.length - i - 1;
}

export function validateCanonical(c: CanonicalTaxSummary): GuardResult {
  const issues: GuardIssue[] = [];
  const warnings: GuardIssue[] = [];

  for (const key of CANONICAL_NUMERIC_FIELDS) {
    const v = c[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        field: key,
        severity: "error",
        message: `Expected finite number, got ${typeof v}`,
      });
      continue;
    }
    if (v < 0) {
      issues.push({
        field: key,
        severity: "error",
        message: "Numeric field must be non-negative",
      });
      continue;
    }
    if (decimalPlaces(v) > 2) {
      warnings.push({
        field: key,
        severity: "warn",
        message: "More than 2 decimal places",
      });
    }
  }

  if (
    c.qualified_dividends > c.dividend_income + 1e-9
  ) {
    issues.push({
      field: "qualified_dividends",
      severity: "error",
      message: "qualified_dividends cannot exceed dividend_income",
    });
  }

  if (c.tax_year < 2019 || c.tax_year > 2025) {
    issues.push({
      field: "tax_year",
      severity: "error",
      message: "tax_year must be between 2019 and 2025 inclusive",
    });
  }

  if (!FILING.includes(c.filing_status)) {
    issues.push({
      field: "filing_status",
      severity: "error",
      message: `filing_status must be one of: ${FILING.join(", ")}`,
    });
  }

  if (c.uses_standard_deduction && c.itemized_deductions > 0) {
    issues.push({
      field: "itemized_deductions",
      severity: "error",
      message: "Cannot use standard deduction while itemized_deductions > 0",
    });
  }

  if (c.business_expenses > 0 && c.business_income === 0) {
    issues.push({
      field: "business_expenses",
      severity: "error",
      message: "business_expenses > 0 requires business_income > 0",
    });
  }

  if (c.wages === 0 && c.business_income === 0 && c.other_income === 0) {
    warnings.push({
      field: "wages",
      severity: "warn",
      message: "no income sources found",
    });
  }

  if (c.wages > 0 && c.federal_withholding > c.wages * 0.5 + 1e-9) {
    warnings.push({
      field: "federal_withholding",
      severity: "warn",
      message: "withholding > 50% of wages, possible ingestion error",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: c, warnings };
}
