/**
 * Deterministic parsing of user-provided Schedule C / business numbers from free text (Telegram, etc.).
 * No LLM — regex + line-oriented extraction only.
 */

export type FinancialInputs = {
  income?: number;
  expenses?: {
    advertising?: number;
    supplies?: number;
    meals?: number;
    contracting?: number;
  };
  mileage?: {
    total?: number;
    business?: number;
    commute?: number;
  };
};

function parseMoney(s: string): number | undefined {
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** First capture group must be the numeric portion */
function firstMoneyAfterLabel(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m?.[1]) return undefined;
  return parseMoney(m[1].trim());
}

/**
 * Extract financial fields from a user message. Ignores narrative; only structured lines match.
 */
export function parseUserFinancialInputs(text: string): FinancialInputs {
  const t = text.replace(/\r\n/g, "\n");
  const out: FinancialInputs = { expenses: {} };

  const income =
    firstMoneyAfterLabel(t, /business\s+income\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    firstMoneyAfterLabel(t, /(?:^|\n)\s*income\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/im);
  if (income != null) out.income = income;

  const adv = firstMoneyAfterLabel(t, /advertising\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (adv != null) out.expenses!.advertising = adv;

  const sup = firstMoneyAfterLabel(t, /supplies\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (sup != null) out.expenses!.supplies = sup;

  const meals = firstMoneyAfterLabel(t, /meals\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (meals != null) out.expenses!.meals = meals;

  const contract = firstMoneyAfterLabel(t, /contracting\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (contract != null) out.expenses!.contracting = contract;

  const totalMi = firstMoneyAfterLabel(t, /total\s+mileage\s*\*?\*?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    firstMoneyAfterLabel(t, /total\s+mileage\s*\*?\*?\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:miles|mi)?/i);
  const commuteMi = firstMoneyAfterLabel(t, /commute\s+mileage\s*\*?\*?\s*:?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const businessMi = firstMoneyAfterLabel(t, /business\s+mileage\s*\*?\*?\s*:?\s*([\d,]+(?:\.\d{1,2})?)/i);

  if (totalMi != null || commuteMi != null || businessMi != null) {
    out.mileage = {};
    if (totalMi != null) out.mileage.total = totalMi;
    if (commuteMi != null) out.mileage.commute = commuteMi;
    if (businessMi != null) out.mileage.business = businessMi;
  }

  // Drop empty expenses object
  if (out.expenses && Object.keys(out.expenses).length === 0) delete out.expenses;

  return out;
}

function isNonEmptyExpenses(e?: FinancialInputs["expenses"]): e is NonNullable<FinancialInputs["expenses"]> {
  return !!e && Object.values(e).some((v) => v != null && Number(v) > 0);
}

/** Merge incoming parse into existing; new explicit values win, otherwise keep existing. */
export function mergeFinancialInputs(
  existing: FinancialInputs | undefined,
  incoming: FinancialInputs,
): FinancialInputs {
  const e = existing || {};
  const exIn = incoming.expenses || {};
  const exE = e.expenses || {};

  const merged: FinancialInputs = {
    income: incoming.income !== undefined && incoming.income !== null ? incoming.income : e.income,
    expenses: isNonEmptyExpenses(exIn) || isNonEmptyExpenses(exE)
      ? {
        advertising: exIn.advertising !== undefined ? exIn.advertising : exE.advertising,
        supplies: exIn.supplies !== undefined ? exIn.supplies : exE.supplies,
        meals: exIn.meals !== undefined ? exIn.meals : exE.meals,
        contracting: exIn.contracting !== undefined ? exIn.contracting : exE.contracting,
      }
      : undefined,
    mileage: incoming.mileage || e.mileage
      ? {
        total: incoming.mileage?.total !== undefined ? incoming.mileage?.total : e.mileage?.total,
        business: incoming.mileage?.business !== undefined ? incoming.mileage?.business : e.mileage?.business,
        commute: incoming.mileage?.commute !== undefined ? incoming.mileage?.commute : e.mileage?.commute,
      }
      : undefined,
  };

  if (merged.expenses) {
    const pruned: Record<string, number> = {};
    for (const [k, v] of Object.entries(merged.expenses)) {
      if (v != null && Number(v) > 0) pruned[k] = Number(v);
    }
    merged.expenses = Object.keys(pruned).length ? pruned as FinancialInputs["expenses"] : undefined;
  }
  if (merged.mileage) {
    const m = merged.mileage;
    if (m.total == null && m.business == null && m.commute == null) delete merged.mileage;
  }

  return merged;
}

const WORKFLOW_SOURCE = "workflow_parse_user_inputs";

export function buildManualEntriesFromFinancialInputs(fi: FinancialInputs): {
  manual_income: Array<Record<string, unknown>>;
  manual_deductions: Array<Record<string, unknown>>;
} {
  const manual_income: Array<Record<string, unknown>> = [];
  const manual_deductions: Array<Record<string, unknown>> = [];

  if (fi.income != null && fi.income > 0) {
    manual_income.push({
      id: crypto.randomUUID(),
      amount: fi.income,
      category: "business",
      description: "Business income (user message)",
      source: WORKFLOW_SOURCE,
      added_at: new Date().toISOString(),
    });
  }

  const exp = fi.expenses || {};
  const line = (
    key: keyof typeof exp,
    category: string,
    label: string,
  ) => {
    const amt = exp[key];
    if (amt == null || !(Number(amt) > 0)) return;
    manual_deductions.push({
      id: crypto.randomUUID(),
      category,
      amount: Number(amt),
      description: `${label} (user message)`,
      source: WORKFLOW_SOURCE,
      added_at: new Date().toISOString(),
    });
  };

  line("advertising", "advertising_marketing", "Advertising");
  line("supplies", "supplies", "Supplies");
  line("meals", "meals", "Meals");
  line("contracting", "contract_labor", "Contract labor");

  const bizMiles = fi.mileage?.business;
  if (bizMiles != null && bizMiles > 0) {
    const rate = 0.585;
    manual_deductions.push({
      id: crypto.randomUUID(),
      category: "car_truck_expenses",
      amount: Math.round(bizMiles * rate * 100) / 100,
      miles: bizMiles,
      description: `Business mileage × ${rate}/mi (user message)`,
      source: WORKFLOW_SOURCE,
      added_at: new Date().toISOString(),
    });
  }

  return { manual_income, manual_deductions };
}

/** Strip prior workflow-parse entries before merging new ones */
export function filterOutWorkflowSource(arr: unknown[] | undefined): unknown[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => {
    if (!x || typeof x !== "object") return true;
    return (x as Record<string, unknown>).source !== WORKFLOW_SOURCE;
  });
}
