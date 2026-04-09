/** Consistency checks on generated json_summary before PDFs — returns human-readable warnings. */

/** Same priority as generate-tax-documents: Schedule C net profit before Schedule SE. */
function netSelfEmploymentIncomeForCheck(summary: Record<string, unknown>): number {
  const c = (summary.schedule_c || {}) as Record<string, unknown>;
  const se = (summary.schedule_se || {}) as Record<string, unknown>;
  const fromC =
    Number(c.net_profit) ||
    Number(c.net_profit_or_loss) ||
    Number(c.line_31) ||
    Number(c.net_income) ||
    0;
  if (Number.isFinite(fromC) && fromC !== 0) return fromC;
  return (
    Number(se.net_earnings_from_self_employment) ||
    Number(se.net_earnings) ||
    Number(se.net_profit) ||
    0
  );
}

export function crossCheckReturn(summary: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const form1040 = (summary.form_1040 || {}) as Record<string, unknown>;
  const schedC = (summary.schedule_c || {}) as Record<string, unknown>;
  const schedSE = (summary.schedule_se || {}) as Record<string, unknown>;

  const otherIncome = Number(form1040.other_income);
  const netProfit = Number(schedC.net_profit);
  if (Number.isFinite(netProfit) && netProfit !== 0 && Number.isFinite(otherIncome)) {
    if (Math.abs(otherIncome - netProfit) > 25) {
      warnings.push(
        `Schedule C net profit ($${netProfit}) may not align with Form 1040 other income / business income lines — verify flow to Schedule 1.`,
      );
    }
  }

  const netSE = netSelfEmploymentIncomeForCheck(summary);
  const seTaxReported =
    Number(schedSE.se_tax) ||
    Number(form1040.self_employment_tax) ||
    0;
  if (Number.isFinite(netSE) && netSE > 0 && Number.isFinite(seTaxReported) && seTaxReported > 0) {
    const expectedSE = Math.round(netSE * 0.9235 * 0.153 * 100) / 100;
    if (Math.abs(seTaxReported - expectedSE) > 15) {
      warnings.push(
        `SE tax check: expected ~$${expectedSE.toFixed(0)} (92.35% × 15.3% of net SE income), got $${seTaxReported} (schedule_se.se_tax or form_1040.self_employment_tax) — verify Schedule SE.`,
      );
    }
  }

  const agi = Number(form1040.adjusted_gross_income);
  const totalIncome = Number(form1040.total_income);
  const seDed = Number(form1040.self_employment_tax_deduction) || 0;
  if (Number.isFinite(totalIncome) && Number.isFinite(agi)) {
    const expectedAgi = Math.round((totalIncome - seDed) * 100) / 100;
    if (Math.abs(agi - expectedAgi) > 15) {
      warnings.push(
        `AGI cross-check: total income $${totalIncome} minus SE deduction $${seDed} ≈ $${expectedAgi}, but AGI is $${agi}.`,
      );
    }
  }

  const std = Number(form1040.standard_deduction) || 0;
  if (Number.isFinite(agi) && std > 0) {
    const taxable = Number(form1040.taxable_income);
    const expectedTaxable = Math.max(0, agi - std);
    if (Number.isFinite(taxable) && Math.abs(taxable - expectedTaxable) > 15) {
      warnings.push(`Taxable income may not equal AGI ($${agi}) − standard deduction ($${std}).`);
    }
  }

  const totalExp = Number(schedC.total_expenses);
  if (!totalExp || totalExp === 0) {
    warnings.push("⚠️ Zero business expenses on Schedule C — ask the client about deductions.");
  }

  const est = Number(form1040.estimated_payments);
  if (!est || est === 0) {
    warnings.push("No estimated tax payments recorded — client may owe underpayment penalties if applicable.");
  }

  return warnings;
}
