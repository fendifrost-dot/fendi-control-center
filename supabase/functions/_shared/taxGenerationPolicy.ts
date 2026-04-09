/**
 * Two distinct tax generation outputs:
 *
 * 1. mail_irs_ready — Analyze client Drive docs for the tax year, compute the return,
 *    fill official IRS PDFs, upload to Drive. Intended for print-and-mail filing (any year).
 *
 * 2. turbotax_efile_prep — Same analysis + persist to Control Center tax_returns; produce
 *    TXF (and related prep outputs) for TurboTax import. IRS e-file via consumer software is
 *    generally limited to the primary open filing-season year; we treat that as
 *    (calendarYear - 1). For other years we still generate TXF for data transfer / review but
 *    mark efile_eligible: false. For the e-file-eligible year we also generate IRS PDFs as a
 *    optional mail backup (same as your requirement).
 */

export type TaxGenerationMode = "mail_irs_ready" | "turbotax_efile_prep";

/** Tax year consumers typically e-file in the current calendar year (e.g. in 2026 → 2025 return). */
export function primaryEfileEligibleTaxYear(date = new Date()): number {
  return date.getFullYear() - 1;
}

export function isEfileEligibleTaxYear(taxYear: number, date = new Date()): boolean {
  return taxYear === primaryEfileEligibleTaxYear(date);
}
