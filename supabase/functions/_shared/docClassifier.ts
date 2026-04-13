/**
 * Document classification for tax ingest — tuned for real Drive folders (messy names, nested paths).
 * Path-aware: pass `folderPath` / `relativePath` (e.g. "CHASE 2022/2022.pdf") so generic filenames resolve.
 */

export type DocClass =
  | "income_1099"
  | "income_w2"
  | "financial_statement"
  | "receipt_or_invoice"
  | "tax_form"
  | "identity_or_legal"
  | "requires_review";

export interface DocClassificationInput {
  filename: string;
  mimeType?: string;
  /** First ~2000 chars of extracted text, if available */
  textSample?: string;
  /**
   * Relative path from tax year folder, using `/` separators — e.g. `CHASE 2022/2022.pdf`.
   * Enables classification when the basename is only `2022.pdf`.
   */
  folderPath?: string;
  /** Alias for `folderPath` */
  relativePath?: string;
}

export interface DocClassification {
  docClass: DocClass;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

const FINANCIAL_FILENAME_HINTS = [
  "statement",
  "stmt",
  "sttmnt",
  "estmt",
  "estatement",
  "checking",
  "savings",
  "brokerage",
  "credit card",
  "creditcard",
  "visa",
  "mastercard",
  "amex",
  "americanexpress",
  "chase",
  "chime",
  "bofa",
  "bankofamerica",
  "wells",
  "wellsfargo",
  "citi",
  "citibank",
  "capital_one",
  "capitalone",
  "discover",
  "usaa",
  "pnc",
  "td_bank",
  "usbank",
  "regions",
  "suntrust",
  "truist",
  "ally",
  "schwab",
  "fidelity",
  "vanguard",
  "cashapp",
  "cash_app",
  "venmo",
  "paypal",
  "zelle",
  "stripe",
  "square",
  "plaid",
  "activity",
  "transactions",
  "account_summary",
  "monthly",
  "eStmt",
  "pdf",
];

/** Folder / path segments that imply bank or card statements */
const PATH_BANK_CONTEXT = [
  "chase",
  "chime",
  "bofa",
  "bankofamerica",
  "wells",
  "wellsfargo",
  "citi",
  "citibank",
  "amex",
  "americanexpress",
  "capital",
  "capitalone",
  "discover",
  "usaa",
  "pnc",
  "schwab",
  "fidelity",
  "usbank",
  "truist",
  "regions",
  "sttmnt",
  "stmt",
  "statement",
  "checking",
  "savings",
  "brokerage",
  "venmo",
  "paypal",
  "zelle",
  "drive-download",
];

const TEXT_FINANCIAL_PATTERNS = [
  "beginning balance",
  "ending balance",
  "deposits and credits",
  "withdrawals and debits",
  "statement period",
  "statement date",
  "account number",
  "account ending in",
  "transaction history",
  "transaction detail",
  "available balance",
  "current balance",
  "annual percentage yield",
  "apy",
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\\/g, "/").trim();
}

/** Fuzzy 1099: uber_f1099k, 699874_1099K_1, 1099-k, 1099_k, etc. */
function haystackLooksLike1099(haystack: string): boolean {
  return /f1099k|1099[\s_-]*k\b|1099k|1099[\s_-]*nec|1099[\s_-]*misc|1099[\s_-]*int|1099[\s_-]*div|1099[\s_-]*b\b|1099[\s_-]*r\b|1099[\s_-]*g\b|ssa[\s_-]*1099|ssa1099/i.test(
    haystack,
  );
}

function haystackLooksLikeW2(haystack: string): boolean {
  return /\bw[\s_-]*2\b|w2form|w-2c?\b/i.test(haystack);
}

/** `CHASE 2022/2022.pdf` — institution in path + year-only PDF */
function pathImpliesFinancialStatement(pathLower: string, baseName: string): boolean {
  const b = baseName.trim().toLowerCase();
  const pathOk = PATH_BANK_CONTEXT.some((k) => pathLower.includes(k));
  if (!pathOk) return false;
  if (/^\d{4}\.pdf$/i.test(b)) return true;
  if (/^chase\s+o\.pdf$/i.test(b)) return true;
  return false;
}

function basenameOnly(filename: string): string {
  const parts = filename.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? filename;
}

export function classifyDocument(input: DocClassificationInput): DocClassification {
  try {
    const pathCtx = normalize(input.relativePath || input.folderPath || "");
    const baseName = basenameOnly(input.filename || "");
    const baseLower = baseName.toLowerCase();
    const haystack = normalize(`${pathCtx} ${baseName}`);
    const text = (input.textSample || "").toLowerCase();
    const mime = (input.mimeType || "").toLowerCase();

    const filenameReasons: string[] = [];
    const textReasons: string[] = [];
    let filenameClass: DocClass | null = null;
    let textClass: DocClass | null = null;

    // --- Images: never drop silently — vision pipeline (Gemini/Claude) ---
    if (mime.startsWith("image/")) {
      return {
        docClass: "requires_review",
        confidence: "medium",
        reasons: [
          `mime:${mime} — image document; routed to vision-capable extractor`,
          "audit:image_requires_gemini_or_claude_vision",
          pathCtx ? `path_context:${pathCtx}` : "",
        ].filter(Boolean),
      };
    }

    // --- Fuzzy 1099 (path + filename) — must run before generic "1099" substring rules ---
    if (haystackLooksLike1099(haystack)) {
      let sub = "1099";
      if (/1099[\s_-]*k|1099k|f1099k/i.test(haystack)) sub = "1099-K";
      else if (/1099[\s_-]*nec/i.test(haystack)) sub = "1099-NEC";
      else if (/1099[\s_-]*misc/i.test(haystack)) sub = "1099-MISC";
      else if (/1099[\s_-]*int/i.test(haystack)) sub = "1099-INT";
      else if (/1099[\s_-]*div/i.test(haystack)) sub = "1099-DIV";
      else if (/1099[\s_-]*b\b/i.test(haystack)) sub = "1099-B";
      filenameClass = "income_1099";
      filenameReasons.push(`fuzzy 1099 match (${sub}) in path/filename: ${haystack.slice(0, 120)}`);
    }

    // --- W-2 fuzzy ---
    if (!filenameClass && haystackLooksLikeW2(haystack)) {
      filenameClass = "income_w2";
      filenameReasons.push("fuzzy W-2 match in path/filename");
    }

    // --- Path-based bank statements: CHASE 2022/2022.pdf ---
    if (!filenameClass && pathCtx && pathImpliesFinancialStatement(pathCtx, baseName)) {
      filenameClass = "financial_statement";
      filenameReasons.push(`path+file imply bank statement (path contains institution, file=${baseName})`);
    }

    // --- Classic filename: contains "1099" substring ---
    if (!filenameClass && haystack.includes("1099")) {
      filenameClass = "income_1099";
      if (baseLower.includes("-nec") || baseLower.includes("nec")) {
        filenameReasons.push("filename contains 1099 (NEC)");
      } else if (baseLower.includes("-k") || baseLower.includes("1099k")) {
        filenameReasons.push("filename contains 1099 (K)");
      } else if (baseLower.includes("-misc") || baseLower.includes("misc")) {
        filenameReasons.push("filename contains 1099 (MISC)");
      } else if (baseLower.includes("-int") || baseLower.includes("1099int")) {
        filenameReasons.push("filename contains 1099 (INT)");
      } else if (baseLower.includes("-div") || baseLower.includes("1099div")) {
        filenameReasons.push("filename contains 1099 (DIV)");
      } else if (baseLower.includes("-b") || baseLower.includes("1099b")) {
        filenameReasons.push("filename contains 1099 (B)");
      } else if (baseLower.includes("-r") || baseLower.includes("1099r")) {
        filenameReasons.push("filename contains 1099 (R)");
      } else if (baseLower.includes("-g") || baseLower.includes("1099g")) {
        filenameReasons.push("filename contains 1099 (G)");
      } else {
        filenameReasons.push("filename contains 1099");
      }
    }

    if (!filenameClass && (baseLower.includes("ssa-1099") || baseLower.includes("ssa1099"))) {
      filenameClass = "income_1099";
      filenameReasons.push("filename contains SSA-1099");
    }

    if (!filenameClass && (baseLower.includes("w-2") || baseLower.includes("w2"))) {
      filenameClass = "income_w2";
      filenameReasons.push(`filename contains w-2/w2`);
    }

    // Filename / full haystack financial hints (Chime-Checking..., chase o.pdf, etc.)
    if (!filenameClass && FINANCIAL_FILENAME_HINTS.some((k) => haystack.includes(k))) {
      filenameClass = "financial_statement";
      const matched = FINANCIAL_FILENAME_HINTS.find((k) => haystack.includes(k));
      filenameReasons.push(`haystack matches financial hint '${matched}'`);
    }

    if (
      !filenameClass &&
      (baseLower.includes("receipt") || baseLower.includes("invoice") || baseLower.includes("bill"))
    ) {
      filenameClass = "receipt_or_invoice";
      const matched = ["receipt", "invoice", "bill"].find((kw) => baseLower.includes(kw));
      filenameReasons.push(`filename contains '${matched}'`);
    }

    if (
      !filenameClass &&
      (baseLower.includes("1040") ||
        baseLower.includes("schedule c") ||
        baseLower.includes("schedule se") ||
        baseLower.includes("k-1") ||
        baseLower.includes("k1") ||
        baseLower.includes("property tax"))
    ) {
      filenameClass = "tax_form";
      filenameReasons.push("filename suggests tax form");
    }

    if (
      !filenameClass &&
      (baseLower.includes(" id") ||
        baseLower.startsWith("id") ||
        baseLower.includes("license") ||
        baseLower.includes("passport") ||
        baseLower.includes("ssn") ||
        baseLower.includes("ein") ||
        baseLower.includes("llc") ||
        baseLower.includes("formation") ||
        baseLower.includes("articles"))
    ) {
      filenameClass = "identity_or_legal";
      filenameReasons.push("filename suggests identity/legal");
    }

    // Duplicate copy hint (audit only — still classify same as without)
    if (/\(\s*1\s*\)|\bcopy\b/i.test(baseName)) {
      filenameReasons.push("note:possible_duplicate_filename_variant");
    }

    // --- Text-sample confirmation ---
    if (text) {
      if (
        text.includes("nonemployee compensation") ||
        text.includes("payer's tin") ||
        text.includes("recipient's tin")
      ) {
        textClass = "income_1099";
        textReasons.push("text suggests 1099");
      } else if (
        text.includes("wages, tips, other compensation") ||
        text.includes("employer identification number")
      ) {
        textClass = "income_w2";
        textReasons.push("text suggests W-2");
      } else if (TEXT_FINANCIAL_PATTERNS.some((p) => text.includes(p))) {
        textClass = "financial_statement";
        textReasons.push("text suggests bank statement");
      } else if (
        text.includes("invoice") ||
        text.includes("bill to") ||
        text.includes("amount due") ||
        text.includes("subtotal")
      ) {
        textClass = "receipt_or_invoice";
        textReasons.push("text suggests receipt/invoice");
      }
    }

    const allReasons = [...filenameReasons, ...textReasons];

    if (filenameClass !== null && textClass !== null) {
      if (filenameClass === textClass) {
        return { docClass: filenameClass, confidence: "high", reasons: allReasons };
      }
      return {
        docClass: filenameClass,
        confidence: "low",
        reasons: [
          ...allReasons,
          `conflicting signals: filename suggests ${filenameClass}, text suggests ${textClass}`,
        ],
      };
    }

    if (filenameClass !== null) {
      return { docClass: filenameClass, confidence: "medium", reasons: filenameReasons };
    }

    if (textClass !== null) {
      return { docClass: textClass, confidence: "medium", reasons: textReasons };
    }

    if (mime.includes("pdf") || mime.startsWith("image/")) {
      return {
        docClass: "requires_review",
        confidence: "low",
        reasons: [
          "no keyword match; requires_review for binary document",
          pathCtx ? `path_was:${pathCtx}` : "no_folder_path_passed",
        ],
      };
    }

    return {
      docClass: "requires_review",
      confidence: "low",
      reasons: ["no matching signals — requires_review for supervised extraction"],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      docClass: "requires_review",
      confidence: "low",
      reasons: [`classifier error (requires_review): ${msg}`],
    };
  }
}
