/**
 * IRS fillable PDF URLs (TAX_ENGINE_ARCHITECTURE.md).
 * Current tax year uses /irs-pdf/; prior years use /irs-prior/ with --YEAR suffix.
 */

export type CoreFormType = "f1040" | "schedule_c" | "schedule_se" | "schedule_1" | "schedule_2";

const PRIOR_SLUG: Record<CoreFormType, string> = {
  f1040: "f1040",
  schedule_c: "f1040sc",
  schedule_se: "f1040sse",
  schedule_1: "f1040s1",
  schedule_2: "f1040s2",
};

/** IRS "current" PDF (no year in filename) — typically latest published revision. */
const CURRENT_HOST = "https://www.irs.gov/pub/irs-pdf";
const PRIOR_HOST = "https://www.irs.gov/pub/irs-prior";

const CURRENT_SLUG: Record<CoreFormType, string> = {
  f1040: "f1040.pdf",
  schedule_c: "f1040sc.pdf",
  schedule_se: "f1040sse.pdf",
  schedule_1: "f1040s1.pdf",
  schedule_2: "f1040s2.pdf",
};

/**
 * @param taxYear Tax return year (e.g. 2024)
 * @param useCurrentStyle If true, use /irs-pdf/*.pdf (no year). Use for the latest IRS "current" revision only.
 */
export function irsFormPdfUrl(
  formType: CoreFormType,
  taxYear: number,
  options?: { useCurrentStyle?: boolean },
): string {
  const slug = PRIOR_SLUG[formType];
  if (options?.useCurrentStyle) {
    return `${CURRENT_HOST}/${CURRENT_SLUG[formType]}`;
  }
  return `${PRIOR_HOST}/${slug}--${taxYear}.pdf`;
}
