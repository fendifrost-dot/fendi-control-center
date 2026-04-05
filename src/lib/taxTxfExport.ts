import type { TaxJsonSummary } from "./taxReturnModel";

/** Minimal TurboTax TXF (V042) from reviewed json_summary — works without CC Tax REST. */
export function generateTxfFromJsonSummary(
  clientName: string,
  taxYear: number,
  summary: TaxJsonSummary,
): string {
  const f = summary.form_1040 || {};
  const c = summary.schedule_c;
  const lines: string[] = [];
  const now = new Date();
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

  const add = (n: number, amount: number, _desc: string) => {
    if (!amount) return;
    lines.push("TD", `N${n}`, "C1", "L1", `$${amount.toFixed(2)}`, "^");
  };

  lines.push("V042", "Afendifrost", `D${fmt(now)}`, "^");

  add(521, Number(f.wages) || 0, "Wages");
  add(523, Number(f.taxable_interest) || 0, "Interest");
  add(525, Number(f.ordinary_dividends) || 0, "Dividends");
  add(540, Number(f.total_income) || 0, "Total income");
  add(543, Number(f.adjusted_gross_income) || 0, "AGI");
  add(544, Number(f.standard_deduction) || 0, "Standard deduction");
  add(550, Number(f.taxable_income) || 0, "Taxable income");
  add(551, Number(f.total_tax) || 0, "Tax");
  add(575, Number(f.total_tax) || 0, "Total tax");
  add(576, Number(f.total_payments) || 0, "Total payments");
  const owed = Number(f.amount_owed_or_refund);
  if (owed < 0) add(577, Math.abs(owed), "Refund");
  else if (owed > 0) add(578, owed, "Owed");

  if (c) {
    add(1092, Number(c.gross_receipts) || 0, "Sched C gross");
    add(1093, Number(c.total_expenses) || 0, "Sched C expenses");
    add(1094, Number(c.net_profit) || 0, "Sched C net");
  }

  lines.push("");
  lines.push(`# ${clientName} ${taxYear} — generated from Tax Prep review (verify before filing)`);
  return lines.join("\n");
}
