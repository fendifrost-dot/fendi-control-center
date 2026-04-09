// Logical key → IRS AcroForm field names.
// Verified against pypdf extraction from IRS fillable PDFs (tax year 2022):
//   f1040--2022.pdf, f1040sc--2022.pdf, f1040sse--2022.pdf
// Field IDs change when IRS restructures the XFA/fillable PDF; re-run scripts/irs-forms
// extraction when supporting a new tax year.

export type SupportedTaxYear = 2022 | 2023 | 2024 | 2025;

/** Form 1040 — main return (2022 layout) */
const IRS_FIELD_MAP_1040_2022: Record<string, string> = {
  first_name: "topmostSubform[0].Page1[0].f1_02[0]",
  last_name: "topmostSubform[0].Page1[0].f1_03[0]",
  ssn: "topmostSubform[0].Page1[0].YourSocial[0].f1_04[0]",
  spouse_ssn: "topmostSubform[0].Page1[0].SpousesSocial[0].f1_07[0]",
  address: "topmostSubform[0].Page1[0].Address[0].f1_08[0]",
  apt: "topmostSubform[0].Page1[0].Address[0].f1_09[0]",
  city: "topmostSubform[0].Page1[0].Address[0].f1_10[0]",
  state: "topmostSubform[0].Page1[0].Address[0].f1_11[0]",
  zip: "topmostSubform[0].Page1[0].Address[0].f1_12[0]",
  filing_status_single: "topmostSubform[0].Page1[0].c1_01[0]",
  filing_status_mfj: "topmostSubform[0].Page1[0].c1_01[1]",
  filing_status_mfs: "topmostSubform[0].Page1[0].c1_01[2]",
  filing_status_hoh: "topmostSubform[0].Page1[0].c1_01[3]",
  filing_status_qw: "topmostSubform[0].Page1[0].c1_01[4]",
  // Line 1a wages (Form W-2 box 1); also accept common aliases from json_summary / TXF
  wages: "topmostSubform[0].Page1[0].f1_28[0]",
  line_1: "topmostSubform[0].Page1[0].f1_28[0]",
  // Line 2b taxable interest (approximate position in Lines1–3 block)
  interest_income: "topmostSubform[0].Page1[0].f1_30[0]",
  line_2b: "topmostSubform[0].Page1[0].f1_30[0]",
  // Page 1 income / AGI summary lines (2022 layout)
  total_income: "topmostSubform[0].Page1[0].f1_54[0]",
  adjusted_gross_income: "topmostSubform[0].Page1[0].f1_55[0]",
  standard_deduction: "topmostSubform[0].Page2[0].f2_02[0]",
  taxable_income: "topmostSubform[0].Page2[0].f2_04[0]",
  tax: "topmostSubform[0].Page2[0].f2_06[0]",
  total_tax: "topmostSubform[0].Page2[0].f2_14[0]",
  total_payments: "topmostSubform[0].Page2[0].f2_18[0]",
  refund: "topmostSubform[0].Page2[0].f2_20[0]",
  amount_owed: "topmostSubform[0].Page2[0].f2_24[0]",
};

/** Form 1040 — main return (2023 layout) */
const IRS_FIELD_MAP_1040_2023: Record<string, string> = {
  first_name: "topmostSubform[0].Page1[0].f1_02[0]",
  last_name: "topmostSubform[0].Page1[0].f1_03[0]",
  ssn: "topmostSubform[0].Page1[0].f1_04[0]",
  spouse_ssn: "topmostSubform[0].Page1[0].f1_07[0]",
  address: "topmostSubform[0].Page1[0].f1_08[0]",
  apt: "topmostSubform[0].Page1[0].f1_09[0]",
  filing_status_single: "topmostSubform[0].Page1[0].c1_1[0]",
  filing_status_mfj: "topmostSubform[0].Page1[0].c1_2[0]",
  filing_status_mfs: "topmostSubform[0].Page1[0].c1_3[0]",
  filing_status_hoh: "topmostSubform[0].Page1[0].c1_4[0]",
  filing_status_qw: "topmostSubform[0].Page1[0].c1_5[0]",
  wages: "topmostSubform[0].Page1[0].f1_31[0]",
  line_1: "topmostSubform[0].Page1[0].f1_31[0]",
  interest_income: "topmostSubform[0].Page1[0].f1_33[0]",
  line_2b: "topmostSubform[0].Page1[0].f1_33[0]",
  total_income: "topmostSubform[0].Page1[0].Line4a-11_ReadOrder[0].f1_54[0]",
  adjusted_gross_income: "topmostSubform[0].Page1[0].Line4a-11_ReadOrder[0].f1_55[0]",
  standard_deduction: "topmostSubform[0].Page2[0].f2_02[0]",
  taxable_income: "topmostSubform[0].Page2[0].f2_04[0]",
  tax: "topmostSubform[0].Page2[0].f2_06[0]",
  total_tax: "topmostSubform[0].Page2[0].f2_14[0]",
  total_payments: "topmostSubform[0].Page2[0].f2_18[0]",
  refund: "topmostSubform[0].Page2[0].f2_20[0]",
  amount_owed: "topmostSubform[0].Page2[0].f2_24[0]",
};

/** Form 1040 — main return (2024 layout) */
const IRS_FIELD_MAP_1040_2024: Record<string, string> = {
  ...IRS_FIELD_MAP_1040_2023,
  wages: "topmostSubform[0].Page1[0].f1_32[0]",
  line_1: "topmostSubform[0].Page1[0].f1_32[0]",
  interest_income: "topmostSubform[0].Page1[0].f1_34[0]",
  line_2b: "topmostSubform[0].Page1[0].f1_34[0]",
  total_income: "topmostSubform[0].Page1[0].Line4a-11_ReadOrder[0].f1_55[0]",
  adjusted_gross_income: "topmostSubform[0].Page1[0].Line4a-11_ReadOrder[0].f1_56[0]",
};

/** Form 1040 — main return (2025 layout) */
const IRS_FIELD_MAP_1040_2025: Record<string, string> = {
  first_name: "topmostSubform[0].Page1[0].f1_02[0]",
  last_name: "topmostSubform[0].Page1[0].f1_03[0]",
  ssn: "topmostSubform[0].Page1[0].f1_04[0]",
  spouse_ssn: "topmostSubform[0].Page1[0].f1_07[0]",
  address: "topmostSubform[0].Page1[0].f1_08[0]",
  apt: "topmostSubform[0].Page1[0].f1_09[0]",
  filing_status_single: "topmostSubform[0].Page1[0].c1_1[0]",
  filing_status_mfj: "topmostSubform[0].Page1[0].c1_2[0]",
  filing_status_mfs: "topmostSubform[0].Page1[0].c1_3[0]",
  filing_status_hoh: "topmostSubform[0].Page1[0].c1_4[0]",
  filing_status_qw: "topmostSubform[0].Page1[0].c1_5[0]",
  wages: "topmostSubform[0].Page1[0].f1_47[0]",
  line_1: "topmostSubform[0].Page1[0].f1_47[0]",
  interest_income: "topmostSubform[0].Page1[0].f1_49[0]",
  line_2b: "topmostSubform[0].Page1[0].f1_49[0]",
  total_income: "topmostSubform[0].Page1[0].f1_54[0]",
  adjusted_gross_income: "topmostSubform[0].Page1[0].f1_55[0]",
  standard_deduction: "topmostSubform[0].Page2[0].f2_02[0]",
  taxable_income: "topmostSubform[0].Page2[0].f2_04[0]",
  tax: "topmostSubform[0].Page2[0].f2_06[0]",
  total_tax: "topmostSubform[0].Page2[0].f2_14[0]",
  total_payments: "topmostSubform[0].Page2[0].f2_18[0]",
  refund: "topmostSubform[0].Page2[0].f2_20[0]",
  amount_owed: "topmostSubform[0].Page2[0].f2_24[0]",
};

/** Schedule C — business */
const IRS_FIELD_MAP_1040SC: Record<string, string> = {
  principal_business: "topmostSubform[0].Page1[0].Pg1Header[0].f1_1[0]",
  business_code: "topmostSubform[0].Page1[0].f1_2[0]",
  business_name: "topmostSubform[0].Page1[0].BComb[0].f1_4[0]",
  ein: "topmostSubform[0].Page1[0].DComb[0].f1_6[0]",
  gross_receipts: "topmostSubform[0].Page1[0].f1_10[0]",
  total_expenses: "topmostSubform[0].Page1[0].Lines18-27[0].f1_38[0]",
  net_profit: "topmostSubform[0].Page1[0].Lines18-27[0].f1_41[0]",
};

/** Schedule SE — self-employment tax */
const IRS_FIELD_MAP_1040SSE: Record<string, string> = {
  net_earnings: "topmostSubform[0].Page1[0].Line8a_ReadOrder[0].f1_14[0]",
  net_se_income: "topmostSubform[0].Page1[0].Line8a_ReadOrder[0].f1_14[0]",
  se_tax: "topmostSubform[0].Page1[0].f1_11[0]",
  deduction: "topmostSubform[0].Page1[0].f1_12[0]",
  deductible_se_tax: "topmostSubform[0].Page1[0].f1_12[0]",
};

/** Schedule 1 — additional income and adjustments (2022-2024 layout) */
const IRS_FIELD_MAP_1040S1_2022_2024: Record<string, string> = {
  taxable_refunds: "form1[0].Page1[0].f1_01[0]",
  alimony_received: "form1[0].Page1[0].f1_02[0]",
  business_income: "form1[0].Page1[0].f1_03[0]",
  capital_gain_loss: "form1[0].Page1[0].f1_04[0]",
  rental_income: "form1[0].Page1[0].f1_05[0]",
  other_income: "form1[0].Page1[0].f1_10[0]",
  total_additional_income: "form1[0].Page1[0].f1_11[0]",
  educator_expenses: "form1[0].Page1[0].f1_12[0]",
  self_employment_tax_deduction: "form1[0].Page1[0].f1_16[0]",
  self_employed_health_insurance: "form1[0].Page1[0].f1_18[0]",
  ira_deduction: "form1[0].Page1[0].f1_21[0]",
  student_loan_interest: "form1[0].Page1[0].f1_22[0]",
  total_adjustments: "form1[0].Page2[0].f2_03[0]",
};

/** Schedule 1 — additional income and adjustments (2025 layout) */
const IRS_FIELD_MAP_1040S1_2025: Record<string, string> = {
  taxable_refunds: "topmostSubform[0].Page1[0].f1_01[0]",
  alimony_received: "topmostSubform[0].Page1[0].f1_02[0]",
  business_income: "topmostSubform[0].Page1[0].f1_03[0]",
  capital_gain_loss: "topmostSubform[0].Page1[0].f1_04[0]",
  rental_income: "topmostSubform[0].Page1[0].f1_05[0]",
  other_income: "topmostSubform[0].Page1[0].Line8z_ReadOrder[0].f1_35[0]",
  total_additional_income: "topmostSubform[0].Page1[0].Line7_ReadOrder[0].f1_11[0]",
  educator_expenses: "topmostSubform[0].Page1[0].f1_12[0]",
  self_employment_tax_deduction: "topmostSubform[0].Page1[0].f1_16[0]",
  self_employed_health_insurance: "topmostSubform[0].Page1[0].f1_18[0]",
  ira_deduction: "topmostSubform[0].Page1[0].f1_21[0]",
  student_loan_interest: "topmostSubform[0].Page1[0].f1_22[0]",
  total_adjustments: "topmostSubform[0].Page2[0].f2_03[0]",
};

/** Schedule 2 — additional taxes (2022-2024 layout) */
const IRS_FIELD_MAP_1040S2_2022_2024: Record<string, string> = {
  self_employment_tax: "form1[0].Page1[0].f1_04[0]",
  total_schedule_2: "form1[0].Page2[0].f2_21[0]",
};

/** Schedule 2 — additional taxes (2025 layout) */
const IRS_FIELD_MAP_1040S2_2025: Record<string, string> = {
  self_employment_tax: "form1[0].Page1[0].Line4_ReadOrder[0].f1_14[0]",
  total_schedule_2: "form1[0].Page2[0].f2_21[0]",
};

const FORM_MAPS_BY_YEAR: Record<SupportedTaxYear, Record<string, Record<string, string>>> = {
  2022: {
    "1040": IRS_FIELD_MAP_1040_2022,
    "1040sc": IRS_FIELD_MAP_1040SC,
    "1040sse": IRS_FIELD_MAP_1040SSE,
    "1040s1": IRS_FIELD_MAP_1040S1_2022_2024,
    "1040s2": IRS_FIELD_MAP_1040S2_2022_2024,
  },
  2023: {
    "1040": IRS_FIELD_MAP_1040_2023,
    "1040sc": IRS_FIELD_MAP_1040SC,
    "1040sse": IRS_FIELD_MAP_1040SSE,
    "1040s1": IRS_FIELD_MAP_1040S1_2022_2024,
    "1040s2": IRS_FIELD_MAP_1040S2_2022_2024,
  },
  2024: {
    "1040": IRS_FIELD_MAP_1040_2024,
    "1040sc": IRS_FIELD_MAP_1040SC,
    "1040sse": IRS_FIELD_MAP_1040SSE,
    "1040s1": IRS_FIELD_MAP_1040S1_2022_2024,
    "1040s2": IRS_FIELD_MAP_1040S2_2022_2024,
  },
  2025: {
    "1040": IRS_FIELD_MAP_1040_2025,
    "1040sc": IRS_FIELD_MAP_1040SC,
    "1040sse": IRS_FIELD_MAP_1040SSE,
    "1040s1": IRS_FIELD_MAP_1040S1_2025,
    "1040s2": IRS_FIELD_MAP_1040S2_2025,
  },
};

const DEFAULT_YEAR: SupportedTaxYear = 2025;

function normalizeSupportedYear(year: number | string | undefined): SupportedTaxYear {
  const y = Number(year);
  if (y === 2022 || y === 2023 || y === 2024 || y === 2025) return y;
  return DEFAULT_YEAR;
}

const FORM_MAPS: Record<string, Record<string, string>> = {
  "1040": IRS_FIELD_MAP_1040_2025,
  "1040sc": IRS_FIELD_MAP_1040SC,
  "1040sse": IRS_FIELD_MAP_1040SSE,
  "1040s1": IRS_FIELD_MAP_1040S1_2025,
  "1040s2": IRS_FIELD_MAP_1040S2_2025,
};

/**
 * Duplicate logical keys under json_summary prefixes so flattenComputedData hits
 * the same AcroForm fields (e.g. form_1040.wages and wages).
 */
export function getExpandedFieldMappings(
  formType: string,
  taxYear?: number | string,
): Record<string, string> {
  const year = normalizeSupportedYear(taxYear);
  const base = FORM_MAPS_BY_YEAR[year]?.[formType] ?? FORM_MAPS[formType];
  if (!base) return {};

  const out: Record<string, string> = { ...base };

  if (formType === "1040") {
    for (const [k, v] of Object.entries(base)) {
      out[`form_1040.${k}`] = v;
    }
  } else if (formType === "1040sc") {
    for (const [k, v] of Object.entries(base)) {
      out[`schedule_c.${k}`] = v;
      out[`form_1040.schedule_c.${k}`] = v;
    }
  } else if (formType === "1040sse") {
    for (const [k, v] of Object.entries(base)) {
      out[`schedule_se.${k}`] = v;
      out[`form_1040.schedule_se.${k}`] = v;
    }
  } else if (formType === "1040s1") {
    for (const [k, v] of Object.entries(base)) {
      out[`schedule_1.${k}`] = v;
      out[`form_1040.schedule_1.${k}`] = v;
    }
  } else if (formType === "1040s2") {
    for (const [k, v] of Object.entries(base)) {
      out[`schedule_2.${k}`] = v;
      out[`form_1040.schedule_2.${k}`] = v;
    }
  }

  return out;
}
