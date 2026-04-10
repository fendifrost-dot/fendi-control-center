/**
 * Deterministic parsing for Telegram tax commands (manual income / deductions).
 * Kept in _shared for unit tests and reuse.
 */

/** Normalize Telegram/iOS punctuation that breaks $ and name matching. */
export function normalizeTelegramTaxText(raw: string): string {
  return raw
    .trim()
    .replace(/\uFF04/g, "$") // fullwidth dollar
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/\s+/g, " ");
}

/** Best-effort client name from common Telegram phrasings (deterministic path for /do tax). */
export function extractClientNameForTaxCommand(userMessage: string): string | null {
  const msg = userMessage.trim().replace(/\s+/g, " ");
  const normalized = msg
    .replace(/[’]/g, "'")
    .replace(/\b(?:'s)\b/gi, "")
    .replace(/\s+return\b/gi, "")
    .trim();
  const cleanup = (name: string): string => {
    return name
      .replace(/[’]/g, "'")
      .replace(/\b(?:'s)\b/gi, "")
      .replace(/\bfor\s+20\d{2}\b/gi, "")
      .replace(/\b20\d{2}\b/g, "")
      .replace(/\b(?:tax|return|forms?)\b/gi, "")
      .replace(/^[\s"'`""''.,.;:!?]+|[\s"'`""''.,.;:!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const gen = msg.match(/generate\s+(.+?)\s+tax\s+return/i);
  if (gen?.[1]) {
    const name = cleanup(gen[1].replace(/^the\s+/i, ""));
    if (name.length >= 2 && name.length < 120) return name;
  }
  const doTax = normalized.match(
    /(?:^|\b)(?:do|prepare|file|complete|run|generate)\s+(.+?)\s+tax(?:\s+docs?|(?:\s+return)?)?(?:\s+for\s+20\d{2})?$/i,
  );
  if (doTax?.[1]) {
    const name = cleanup(doTax[1].replace(/^the\s+/i, ""));
    if (name.length >= 2 && name.length < 120) return name;
  }
  const possessive = normalized.match(/(?:^|\b)(.+?)\s+(?:20\d{2}\s+)?tax\s+return\b/i);
  if (possessive?.[1]) {
    const name = cleanup(possessive[1].replace(/^the\s+/i, ""));
    if (name.length >= 2 && name.length < 120) return name;
  }
  const forYear = msg.match(/\bfor\s+([A-Za-z][A-Za-z\s.'-]+?)\s+for\s+(20\d{2})\b/i);
  if (forYear?.[1]) {
    const name = cleanup(forYear[1]);
    if (name.length >= 2 && name.length < 120) return name;
  }
  const tr = msg.match(/tax\s+return\s+for\s+([A-Za-z][A-Za-z\s.'-]+?)(?:\s+for\s+20\d{2}|\s*$)/i);
  if (tr?.[1]) {
    const name = cleanup(tr[1]);
    if (name.length >= 2 && name.length < 120) return name;
  }
  return null;
}

/** Parse a dollar amount: prefers $..., else largest plausible currency number (not a tax year). */
function parseMoneyAmount(t: string, taxYear: number): number | null {
  const dollar = t.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (dollar?.[1]) {
    const n = parseFloat(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  let best = 0;
  const re = /\b(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n >= 1900 && n <= 2100 && Math.abs(n - taxYear) < 2) continue;
    if (n === taxYear || n === taxYear % 100) continue;
    if (n < 1 || n > 99_999_999) continue;
    if (n > best) best = n;
  }
  return best > 0 ? best : null;
}

/** Deterministic parse → add_manual_income (bypasses Grok tool selection). */
export function tryParseManualIncomeMessage(text: string): {
  client_name: string;
  tax_year: number;
  amount: number;
  category?: string;
  description?: string;
} | null {
  const t = normalizeTelegramTaxText(text);
  const lower = t.toLowerCase();
  if (/\b(add|record|log)\s+.*\b(deduction|deduct)\b/i.test(t) && !/\bincome\b/i.test(t)) return null;

  const wantsIncome =
    /\b(add|record|log)\s+(?:manual\s+)?income\b/i.test(t) ||
    (/\b(add|record|log)\b/i.test(t) && /\b(?:business\s+)?income\b/i.test(t)) ||
    (/\bbusiness\s+income\b/i.test(t) && /\b(add|record|log)\b/i.test(t));
  if (!wantsIncome) return null;

  // Freeform: "add income Sam Higgins 2022 161229.90 business"
  const free = t.match(
    /^(?:add|record|log)\s+income\s+([A-Za-z][A-Za-z\s.'-]+?)\s+(20[0-3][0-9])\s+([\d,]+(?:\.\d{1,2})?)\b/i,
  );
  if (free?.[1] && free[2] && free[3]) {
    const tax_year = parseInt(free[2], 10);
    const amount = parseFloat(free[3].replace(/,/g, ""));
    if (tax_year >= 2000 && tax_year <= 2036 && Number.isFinite(amount) && amount > 0) {
      const client_name = free[1].trim();
      if (client_name.length >= 2) {
        let category: string | undefined = "other";
        if (lower.includes("business") || lower.includes("1099") || lower.includes("freelance")) {
          category = "freelance";
        }
        if (lower.includes("cash")) category = "cash";
        return { client_name, tax_year, amount, category, description: t.slice(0, 500) };
      }
    }
  }

  const yearMatch = t.match(/\b(20[0-3][0-9])\b/);
  if (!yearMatch) return null;
  const tax_year = parseInt(yearMatch[1], 10);
  if (tax_year < 2000 || tax_year > 2036) return null;

  const amount = parseMoneyAmount(t, tax_year);
  if (amount == null) return null;

  let client_name = "";
  const forYear = t.match(/\bfor\s+([A-Za-z][A-Za-z\s.'-]+?)\s+(20[0-3][0-9])\b/);
  if (forYear?.[1]) {
    client_name = forYear[1].replace(/\s+from\s+.*$/i, "").trim();
  }
  if (!client_name || client_name.length < 2) {
    const alt = extractClientNameForTaxCommand(t);
    if (alt) client_name = alt;
  }
  if (!client_name || client_name.length < 2) return null;

  let category: string | undefined = "other";
  if (lower.includes("business") || lower.includes("1099") || lower.includes("freelance")) category = "freelance";
  if (lower.includes("cash")) category = "cash";
  if (lower.includes("rental")) category = "rental_cash";
  if (lower.includes("tip")) category = "tips";
  if (lower.includes("side")) category = "side_job";

  return {
    client_name,
    tax_year,
    amount,
    category,
    description: t.slice(0, 500),
  };
}

export function tryParseManualDeductionMessage(text: string): {
  client_name: string;
  tax_year: number;
  category: string;
  amount: number;
  description?: string;
  miles?: number;
} | null {
  const t = normalizeTelegramTaxText(text);
  const lower = t.toLowerCase();
  const wantsDed =
    /\b(add|record|log)\b/i.test(t) &&
    (/\b(deduction|deduct)\b/i.test(t) || /\b(?:business\s+)?expense\b/i.test(t));
  if (!wantsDed) return null;
  if (/\bincome\b/i.test(t) && !/\b(deduction|deduct|expense)\b/i.test(t)) return null;

  const yearMatch = t.match(/\b(20[0-3][0-9])\b/);
  if (!yearMatch) return null;
  const tax_year = parseInt(yearMatch[1], 10);

  const amount = parseMoneyAmount(t, tax_year);
  if (amount == null) return null;

  let client_name = "";
  const forYear = t.match(/\bfor\s+([A-Za-z][A-Za-z\s.'-]+?)\s+(20[0-3][0-9])\b/);
  if (forYear?.[1]) {
    client_name = forYear[1].replace(/\s+from\s+.*$/i, "").trim();
  }
  if (!client_name || client_name.length < 2) {
    const alt = extractClientNameForTaxCommand(t);
    if (alt) client_name = alt;
  }
  if (!client_name || client_name.length < 2) return null;

  let category = "other_business_expense";
  if (lower.includes("mileage") || /\bmiles?\b/i.test(t) || lower.includes("vehicle") || lower.includes("car")) {
    category = "car_truck_expenses";
  } else if (lower.includes("meal")) category = "meals";
  else if (lower.includes("supply")) category = "supplies";
  else if (lower.includes("travel")) category = "travel";
  else if (lower.includes("software") || lower.includes("subscription")) category = "office_expense";
  else if (lower.includes("charit")) category = "charitable_cash";
  else if (lower.includes("medical")) category = "medical_dental";
  else if (/\bhome\s*office\b/i.test(t)) category = "office_expense";

  const milesMatch = t.match(/\b(\d+(?:\.\d+)?)\s*(?:business\s+)?miles?\b/i);
  const miles = milesMatch ? parseFloat(milesMatch[1]) : undefined;

  return {
    client_name,
    tax_year,
    category,
    amount,
    description: t.slice(0, 500),
    miles,
  };
}

/** Broad intent: used to exit unrelated flows (e.g. playlist confirm) so tax routing can run. */
export function looksLikeManualTaxCommand(text: string): boolean {
  const t = normalizeTelegramTaxText(text);
  return (
    tryParseManualIncomeMessage(t) != null ||
    tryParseManualDeductionMessage(t) != null ||
    /^\s*(?:add|record|log)\b.*\b(?:manual\s+)?(?:income|deduction|deduct|business\s+income)\b/i.test(t)
  );
}
