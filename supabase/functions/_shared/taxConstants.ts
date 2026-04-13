// supabase/functions/_shared/taxConstants.ts
// Year-aware tax constants and deterministic computation functions.
// Source of truth: IRS revenue procedures for 2022-2025.
// These values were verified against TaxCalculatorPage.tsx in the frontend.

export const TAX_DATA: Record<number, {
  standardDeduction: Record<string, number>;
  brackets: Record<string, number[][]>;
  seCap: number;
}> = {
  2022: {
    standardDeduction: { single: 12950, married_filing_jointly: 25900, married_filing_separately: 12950, head_of_household: 19400 },
    brackets: {
      single: [[0,10275,.10],[10275,41775,.12],[41775,89075,.22],[89075,170050,.24],[170050,215950,.32],[215950,539900,.35],[539900,Infinity,.37]],
      married_filing_jointly: [[0,20550,.10],[20550,83550,.12],[83550,178150,.22],[178150,340100,.24],[340100,431900,.32],[431900,647850,.35],[647850,Infinity,.37]],
      married_filing_separately: [[0,10275,.10],[10275,41775,.12],[41775,89075,.22],[89075,170050,.24],[170050,215950,.32],[215950,323925,.35],[323925,Infinity,.37]],
      head_of_household: [[0,14650,.10],[14650,55900,.12],[55900,89050,.22],[89050,170050,.24],[170050,215950,.32],[215950,539900,.35],[539900,Infinity,.37]],
    },
    seCap: 147000,
  },
  2023: {
    standardDeduction: { single: 13850, married_filing_jointly: 27700, married_filing_separately: 13850, head_of_household: 20800 },
    brackets: {
      single: [[0,11000,.10],[11000,44725,.12],[44725,95375,.22],[95375,182100,.24],[182100,231250,.32],[231250,578125,.35],[578125,Infinity,.37]],
      married_filing_jointly: [[0,22000,.10],[22000,89450,.12],[89450,190750,.22],[190750,364200,.24],[364200,462500,.32],[462500,693750,.35],[693750,Infinity,.37]],
      married_filing_separately: [[0,11000,.10],[11000,44725,.12],[44725,95375,.22],[95375,182100,.24],[182100,231250,.32],[231250,346875,.35],[346875,Infinity,.37]],
      head_of_household: [[0,15700,.10],[15700,59850,.12],[59850,95350,.22],[95350,182100,.24],[182100,231250,.32],[231250,578100,.35],[578100,Infinity,.37]],
    },
    seCap: 160200,
  },
  2024: {
    standardDeduction: { single: 14600, married_filing_jointly: 29200, married_filing_separately: 14600, head_of_household: 21900 },
    brackets: {
      single: [[0,11600,.10],[11600,47150,.12],[47150,100525,.22],[100525,191950,.24],[191950,243725,.32],[243725,609350,.35],[609350,Infinity,.37]],
      married_filing_jointly: [[0,23200,.10],[23200,94300,.12],[94300,201050,.22],[201050,383900,.24],[383900,487450,.32],[487450,731200,.35],[731200,Infinity,.37]],
      married_filing_separately: [[0,11600,.10],[11600,47150,.12],[47150,100525,.22],[100525,191950,.24],[191950,243725,.32],[243725,365600,.35],[365600,Infinity,.37]],
      head_of_household: [[0,16550,.10],[16550,63100,.12],[63100,100500,.22],[100500,191950,.24],[191950,243700,.32],[243700,609350,.35],[609350,Infinity,.37]],
    },
    seCap: 168600,
  },
  2025: {
    standardDeduction: { single: 15000, married_filing_jointly: 30000, married_filing_separately: 15000, head_of_household: 22500 },
    brackets: {
      single: [[0,11925,.10],[11925,48475,.12],[48475,103350,.22],[103350,197300,.24],[197300,250525,.32],[250525,626350,.35],[626350,Infinity,.37]],
      married_filing_jointly: [[0,23850,.10],[23850,96950,.12],[96950,206700,.22],[206700,394600,.24],[394600,501050,.32],[501050,751600,.35],[751600,Infinity,.37]],
      married_filing_separately: [[0,11925,.10],[11925,48475,.12],[48475,103350,.22],[103350,197300,.24],[197300,250525,.32],[250525,375800,.35],[375800,Infinity,.37]],
      head_of_household: [[0,17000,.10],[17000,64850,.12],[64850,103350,.22],[103350,197300,.24],[197300,250500,.32],[250500,626350,.35],[626350,Infinity,.37]],
    },
    seCap: 176100,
  },
};

const SE_NET_RATE = 0.9235;   // 92.35% of net self-employment income
const SS_RATE = 0.124;        // 12.4% Social Security
const MEDICARE_RATE = 0.029;  // 2.9% Medicare

function getYearData(year: number) {
  return TAX_DATA[year] || TAX_DATA[2024]; // fallback to 2024 if unknown year
}

/** Normalize filing status strings to match our keys */
export function normalizeFilingStatus(raw: string): string {
  const s = String(raw || "single").toLowerCase().replace(/[^a-z_]/g, "_").replace(/_+/g, "_");
  if (s.includes("joint") || s === "mfj") return "married_filing_jointly";
  if (s.includes("separate") || s === "mfs") return "married_filing_separately";
  if (s.includes("head") || s === "hoh") return "head_of_household";
  if (s.includes("widow") || s.includes("qualifying")) return "married_filing_jointly"; // QW uses MFJ brackets
  return "single";
}

/** Get the standard deduction for a filing status and year */
export function getStandardDeduction(filingStatus: string, year: number): number {
  const data = getYearData(year);
  const status = normalizeFilingStatus(filingStatus);
  return data.standardDeduction[status] || data.standardDeduction["single"];
}

/** Calculate federal income tax using bracket walk */
export function calcFederalTax(taxableIncome: number, filingStatus: string, year: number): number {
  if (taxableIncome <= 0) return 0;
  const data = getYearData(year);
  const status = normalizeFilingStatus(filingStatus);
  const brackets = data.brackets[status] || data.brackets["single"];
  let tax = 0;
  for (const [lo, hi, rate] of brackets) {
    if (taxableIncome <= lo) break;
    tax += (Math.min(taxableIncome, hi) - lo) * rate;
  }
  return Math.round(tax * 100) / 100;
}

/** Calculate self-employment tax with loss clamping */
export function calcSETax(netBusinessIncome: number, year: number): {
  seTax: number;
  seDeduction: number;
  seBase: number;
  ssTax: number;
  medicareTax: number;
} {
  if (netBusinessIncome <= 0) {
    return { seTax: 0, seDeduction: 0, seBase: 0, ssTax: 0, medicareTax: 0 };
  }
  const data = getYearData(year);
  const seBase = Math.round(netBusinessIncome * SE_NET_RATE * 100) / 100;
  const ssTax = Math.round(Math.min(seBase, data.seCap) * SS_RATE * 100) / 100;
  const medicareTax = Math.round(seBase * MEDICARE_RATE * 100) / 100;
  const seTax = Math.round((ssTax + medicareTax) * 100) / 100;
  const seDeduction = Math.round(seTax / 2 * 100) / 100;
  return { seTax, seDeduction, seBase, ssTax, medicareTax };
}

/**
 * Full deterministic tax recomputation.
 * Takes Claude's classified data and recomputes all math.
 */
export function recomputeTaxDeterministic(params: {
  grossReceipts: number;
  totalExpenses: number;
  otherIncome: number;  // W-2 wages, interest, etc.
  filingStatus: string;
  year: number;
  estimatedPayments: number;
  federalWithheld: number;
}): {
  netProfit: number;
  seTax: number;
  seDeduction: number;
  totalIncome: number;
  agi: number;
  standardDeduction: number;
  taxableIncome: number;
  federalTax: number;
  totalTax: number;
  totalPayments: number;
  amountOwedOrRefund: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const { grossReceipts, totalExpenses, otherIncome, filingStatus, year, estimatedPayments, federalWithheld } = params;

  // Schedule C
  const netProfit = Math.round((grossReceipts - totalExpenses) * 100) / 100;

  // SE Tax
  const se = calcSETax(netProfit, year);

  // Total income = business income + other income
  // Business income flows through Schedule 1 â 1040 Line 8
  const businessIncomeFor1040 = netProfit; // Can be negative (net loss)
  const totalIncome = Math.round((otherIncome + Math.max(0, businessIncomeFor1040)) * 100) / 100;

  // AGI = total income - SE deduction
  // If net loss, it reduces total income (but can't go below 0 in most cases)
  const incomeWithLoss = Math.round((otherIncome + businessIncomeFor1040) * 100) / 100;
  const agi = Math.round(Math.max(0, incomeWithLoss - se.seDeduction) * 100) / 100;

  // Standard deduction
  const standardDeduction = getStandardDeduction(filingStatus, year);

  // Taxable income
  const taxableIncome = Math.round(Math.max(0, agi - standardDeduction) * 100) / 100;

  // Federal income tax
  const federalTax = calcFederalTax(taxableIncome, filingStatus, year);

  // Total tax = federal + SE
  const totalTax = Math.round((federalTax + se.seTax) * 100) / 100;

  // Payments
  const totalPayments = Math.round((estimatedPayments + federalWithheld) * 100) / 100;
  const amountOwedOrRefund = Math.round((totalTax - totalPayments) * 100) / 100;

  // Warnings
  if (totalExpenses === 0 && grossReceipts > 0) {
    warnings.push("Zero business expenses on Schedule C â verify with client.");
  }
  if (netProfit <= 0) {
    warnings.push(`Net business loss of $${Math.abs(netProfit).toFixed(2)} â SE tax is $0.`);
  }
  if (estimatedPayments === 0 && totalTax > 1000) {
    warnings.push("No estimated tax payments â client may owe underpayment penalties.");
  }

  return {
    netProfit,
    seTax: se.seTax,
    seDeduction: se.seDeduction,
    totalIncome,
    agi,
    standardDeduction,
    taxableIncome,
    federalTax,
    totalTax,
    totalPayments,
    amountOwedOrRefund,
    warnings,
  };
}
