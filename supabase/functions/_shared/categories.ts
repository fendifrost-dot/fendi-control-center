/**
 * Single source of truth: IRS Schedule C Part II expense lines (lines 8–27).
 * All ingest prompts, aggregation, manual UI keys, and generation map here.
 */

export const SCHEDULE_C_CATEGORIES = {
  advertising: { line: 8, label: "Advertising" },
  car_truck: { line: 9, label: "Car and truck expenses" },
  commissions_fees: { line: 10, label: "Commissions and fees" },
  contract_labor: { line: 11, label: "Contract labor" },
  depletion: { line: 12, label: "Depletion" },
  depreciation: { line: 13, label: "Depreciation and section 179" },
  employee_benefit: { line: 14, label: "Employee benefit programs" },
  insurance: { line: 15, label: "Insurance (other than health)" },
  interest_mortgage: { line: "16a", label: "Interest on business mortgage" },
  interest_other: { line: "16b", label: "Other interest" },
  legal_professional: { line: 17, label: "Legal and professional services" },
  office_expense: { line: 18, label: "Office expense" },
  pension_profit_sharing: { line: 19, label: "Pension and profit-sharing plans" },
  rent_vehicles: { line: "20a", label: "Rent or lease — vehicles, machinery, equipment" },
  rent_other: { line: "20b", label: "Rent or lease — other business property" },
  repairs_maintenance: { line: 21, label: "Repairs and maintenance" },
  supplies: { line: 22, label: "Supplies" },
  taxes_licenses: { line: 23, label: "Taxes and licenses" },
  travel: { line: "24a", label: "Travel" },
  meals: { line: "24b", label: "Deductible meals" },
  utilities: { line: 25, label: "Utilities" },
  wages: { line: 26, label: "Wages" },
  other_expenses: { line: 27, label: "Other expenses" },
} as const;

export type ScheduleCCategoryKey = keyof typeof SCHEDULE_C_CATEGORIES;

/** Short keys used by some manual-entry UIs */
export type ScheduleCCategory = ScheduleCCategoryKey;

export const MANUAL_CATEGORY_MAP: Record<string, ScheduleCCategoryKey> = {
  office_expenses: "office_expense",
  advertising_marketing: "advertising",
  supplies: "supplies",
  meals: "meals",
  travel: "travel",
  utilities: "utilities",
  rent_lease: "rent_other",
  insurance: "insurance",
  contract_labor: "contract_labor",
  legal_professional: "legal_professional",
  car_truck: "car_truck",
  repairs_maintenance: "repairs_maintenance",
  taxes_licenses: "taxes_licenses",
  depreciation: "depreciation",
  wages: "wages",
  advertising: "advertising",
  repairs: "repairs_maintenance",
  rent: "rent_other",
  office_expense: "office_expense",
  rent_lease_business: "rent_other",
  car_truck_expenses: "car_truck",
  insurance_business: "insurance",
  interest_mortgage_business: "interest_mortgage",
  interest_other_business: "interest_other",
  other_business_expense: "other_expenses",
  home_office: "other_expenses",
};

/** Bucket for expenses not yet adjudicated to a Schedule C line */
export const UNCLASSIFIED_SCHEDULE_C = "unclassified" as const;

/** ManualTaxEntriesCard `value` → Schedule C key */
const MANUAL_UI_TO_SCHEDULE_C: Record<string, ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C> = {
  advertising_marketing: "advertising",
  car_truck_expenses: "car_truck",
  contract_labor: "contract_labor",
  depreciation: "depreciation",
  insurance_business: "insurance",
  interest_mortgage_business: "interest_mortgage",
  interest_other_business: "interest_other",
  legal_professional: "legal_professional",
  office_expense: "office_expense",
  rent_lease_business: "rent_other",
  repairs_maintenance: "repairs_maintenance",
  supplies: "supplies",
  taxes_licenses: "taxes_licenses",
  travel: "travel",
  meals: "meals",
  utilities: "utilities",
  wages: "wages",
  medical_dental: UNCLASSIFIED_SCHEDULE_C,
  state_local_taxes: UNCLASSIFIED_SCHEDULE_C,
  mortgage_interest: UNCLASSIFIED_SCHEDULE_C,
  charitable_cash: UNCLASSIFIED_SCHEDULE_C,
  charitable_noncash: UNCLASSIFIED_SCHEDULE_C,
  student_loan_interest: UNCLASSIFIED_SCHEDULE_C,
  health_insurance_self_employed: UNCLASSIFIED_SCHEDULE_C,
  home_office: "other_expenses",
  education_expenses: UNCLASSIFIED_SCHEDULE_C,
  other_business_expense: "other_expenses",
};

export function mapManualUiCategoryToScheduleC(
  uiCategory: string,
): ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C {
  const k = MANUAL_UI_TO_SCHEDULE_C[uiCategory];
  if (k !== undefined) return k;
  const m = MANUAL_CATEGORY_MAP[uiCategory];
  if (m !== undefined) return m;
  if (uiCategory in SCHEDULE_C_CATEGORIES) return uiCategory as ScheduleCCategoryKey;
  return UNCLASSIFIED_SCHEDULE_C;
}

/** Initialize expense totals map: every Schedule C key + unclassified */
export function emptyScheduleCExpenseTotals(): Record<ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C, number> {
  const o = { unclassified: 0 } as Record<ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C, number>;
  for (const key of Object.keys(SCHEDULE_C_CATEGORIES) as ScheduleCCategoryKey[]) {
    o[key] = 0;
  }
  return o;
}

export function sumScheduleCExpenses(
  m: Record<ScheduleCCategoryKey | typeof UNCLASSIFIED_SCHEDULE_C, number>,
): number {
  let s = 0;
  for (const v of Object.values(m)) {
    s += Number(v) || 0;
  }
  return Math.round(s * 100) / 100;
}
