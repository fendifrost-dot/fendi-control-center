import type { DocClass } from "./docClassifier.ts";
import { SCHEDULE_C_CATEGORIES, type ScheduleCCategoryKey } from "./categories.ts";

/** IRS Schedule C Part II labels — deterministic anchor for prompts (no AI classification). */
export function scheduleCExpenseLineLabels(): Record<ScheduleCCategoryKey, string> {
  const o = {} as Record<ScheduleCCategoryKey, string>;
  for (const k of Object.keys(SCHEDULE_C_CATEGORIES) as ScheduleCCategoryKey[]) {
    o[k] = SCHEDULE_C_CATEGORIES[k].label;
  }
  return o;
}

export const INCOME_1099_PROMPT: string = `You are a tax document extractor specializing in 1099-series income forms. Your job is to extract the exact figures printed on this form — nothing more, nothing less.

This is an authoritative income source. The amounts on this form are canonical and should be reported exactly. Do not add, infer, or extrapolate income that is not explicitly printed on this form.

Extract the following and return ONLY valid JSON:
{
  "form_subtype": "NEC" | "MISC" | "K" | "INT" | "DIV" | "B" | "R" | "G" | "SSA" | "other",
  "tax_year": <YYYY as number>,
  "payer": {
    "name": "<payer name>",
    "tin": "<payer TIN/EIN>"
  },
  "recipient": {
    "name": "<recipient name>",
    "tin_last4": "<last 4 digits of recipient TIN only — never output the full SSN>"
  },
  "boxes": {
    "<box_label>": <amount as number>
  },
  "notes": "<any relevant notes, or empty string>"
}

Box label examples:
- "box_1_nonemployee_compensation": 161229.90
- "box_2_direct_sales_indicator": 0
- "box_4_federal_income_tax_withheld": 0
- "box_1_wages_tips_other_compensation": 85000.00 (W-2 style — use only for 1099 variants that report wages)

Include every box that has a non-zero dollar amount. Omit boxes that are blank or zero.
Do not fabricate amounts. If a field is not visible or not present, omit it.`;

export const INCOME_W2_PROMPT: string = `You are a tax document extractor specializing in W-2 wage statements. Your job is to extract the exact figures printed on this form — nothing more, nothing less.

This is an authoritative income source. The amounts on this form are canonical and should be reported exactly. Do not add, infer, or extrapolate income that is not explicitly printed on this form.

Extract the following and return ONLY valid JSON:
{
  "tax_year": <YYYY as number>,
  "employer": {
    "name": "<employer name>",
    "ein": "<employer EIN>"
  },
  "employee": {
    "name": "<employee name>",
    "ssn_last4": "<last 4 digits of SSN only — NEVER output the full SSN under any circumstances>"
  },
  "federal": {
    "box_1_wages_tips_other": <amount>,
    "box_2_federal_income_tax_withheld": <amount>,
    "box_3_social_security_wages": <amount>,
    "box_4_social_security_tax_withheld": <amount>,
    "box_5_medicare_wages_tips": <amount>,
    "box_6_medicare_tax_withheld": <amount>
  },
  "box_12": [
    { "code": "<letter code>", "amount": <amount> }
  ],
  "box_14": [
    { "description": "<description>", "amount": <amount> }
  ],
  "state": [
    {
      "state_code": "<2-letter state>",
      "box_15_state_employer_id": "<id>",
      "box_16_state_wages_tips": <amount>,
      "box_17_state_income_tax": <amount>
    }
  ],
  "notes": "<any relevant notes, or empty string>"
}

Omit any field that is blank or zero. Do not fabricate amounts. If a field is not visible, omit it.`;

export const FINANCIAL_STATEMENT_PROMPT: string = `You are analyzing a bank/credit card/payment-platform statement for a self-employed taxpayer.

INCOME RULE: Do NOT use deposits as "reported income" for tax totals — authoritative income comes from 1099/W-2. The field reported_income MUST be null.

YOUR JOB: Extract EVERY transaction row from this document with maximum fidelity. Do not summarize into categories. Do not assign IRS Schedule C lines (downstream system does that).

Return ONLY valid JSON:
{
  "account_type": "checking" | "savings" | "credit_card" | "brokerage" | "payment_platform" | "other",
  "institution_name": "<institution name>",
  "statement_period": { "start": "<YYYY-MM-DD>", "end": "<YYYY-MM-DD>" },
  "beginning_balance": <number or null>,
  "ending_balance": <number or null>,
  "transactions": [
    {
      "date": "<YYYY-MM-DD>",
      "description": "<exact text from statement>",
      "amount": <negative for money OUT, positive for money IN>,
      "category": "deposit" | "withdrawal" | "payment" | "fee" | "transfer" | "interest" | "other"
    }
  ],
  "reported_income": null,
  "reported_income_reason": "Use 1099/W-2 for income; statement is for cashflow only",
  "notes": ""
}

Rules:
- Include ALL transactions; do not drop rows.
- Negative amount = debit/charge/payment out; positive = deposit/credit in.
- Do NOT label business vs personal.
- Do NOT map to IRS lines.`;

/** When heuristics could not classify — still extract structured financial data if present */
export const REQUIRES_REVIEW_EXTRACTION_PROMPT: string = `You are analyzing a document that may be a tax form, bank statement, receipt, or mixed scan.

If this is a bank or card statement: extract the same JSON shape as a financial statement:
- account_type, institution_name, statement_period, transactions[] with date, description, amount (negative=outflow), category (banking type only), reported_income: null.

If this is clearly a 1099 or W-2, return the appropriate specialized shape (boxes/employer fields) if you can read them; otherwise return best-effort extracted_data with income_items/expense_items arrays.

If nothing financial is readable, return:
{ "account_type": "other", "institution_name": "", "statement_period": { "start": "", "end": "" }, "transactions": [], "reported_income": null, "notes": "unreadable or non-financial" }

Never invent dollar amounts.`;

export const RECEIPT_OR_INVOICE_PROMPT: string = `You are a tax document extractor specializing in business expense receipts and invoices. Your job is to extract expense information for deduction categorization.

This is a deductible business expense candidate. Do not treat it as income. Do not estimate income from it.

Extract the following and return ONLY valid JSON:
{
  "document_type": "receipt" | "invoice" | "bill" | "other",
  "vendor_name": "<vendor or merchant name>",
  "date": "<YYYY-MM-DD>",
  "line_items": [
    {
      "description": "<item description>",
      "amount": <amount as positive number>,
      "category": "office" | "meals" | "travel" | "supplies" | "software" | "equipment" | "utilities" | "marketing" | "professional_services" | "other"
    }
  ],
  "subtotal": <amount before tax>,
  "tax_amount": <sales tax, if present, else 0>,
  "total": <total amount paid>,
  "payment_method": "<cash | credit | check | other, if visible>",
  "notes": "<any relevant notes, or empty string>"
}

Do not fabricate amounts. If a field is not visible, omit it or use null.`;

export function pickSystemPrompt(docClass: DocClass): string | null {
  switch (docClass) {
    case "income_1099":
      return INCOME_1099_PROMPT;
    case "income_w2":
      return INCOME_W2_PROMPT;
    case "financial_statement":
      return FINANCIAL_STATEMENT_PROMPT;
    case "receipt_or_invoice":
      return RECEIPT_OR_INVOICE_PROMPT;
    case "requires_review":
      return REQUIRES_REVIEW_EXTRACTION_PROMPT;
    case "tax_form":
    case "identity_or_legal":
      return null;
    default:
      return null;
  }
}
