/**
 * Layer-2 decision engine: natural language → workflow key + confidence.
 * Deterministic regex first; callers may blend LLM classification later.
 *
 * Layer-1 case memory lives in DB (see migration credit_case_memory); inject snippets via fetchCaseMemorySnippet.
 */

export type CreditWorkflowKey = "analyze_credit_strategy" | "credit_analysis_and_disputes" | "drive_ingest";

export interface CreditWorkflowDecision {
  workflowKey: CreditWorkflowKey;
  confidence: number;
  reasons: string[];
}

const DISPUTE_LETTER_PATTERNS: RegExp[] = [
  /\bdispute\s+letter/i,
  /\bgenerate\s+(updated?\s+)?(dispute|rebuttal)/i,
  /\brebuttal/i,
  /\bcompare\b.*\b(credit\s+)?report/i,
  /\bcompare\b.*\b(dispute|bureau|removal)/i,
  /\bwhat\b.*\bremoved\b/i,
  /\bbureau(s)?\s+removed/i,
  /\bdelet(ed|ion)\b.*\b(tradeline|account|negative)/i,
  /\bre-?insert/i,
  /\bstagnat/i,
  /\bupdated?\s+dispute/i,
  /\bnew\s+dispute\s+letter/i,
];

const ANALYSIS_PATTERNS: RegExp[] = [
  /\banalyze\b.*\bcredit\b/i,
  /\bcredit\s+analysis/i,
  /\bcredit\s+strateg/i,
  /\bcredit\s+report\b/i,
  /\bpull\b.*\breport\b/i,
  /\bdispute\s+strateg/i,
  /\bcredit\b.*\bdispute/i,
  /\b(experian|equifax|transunion)\b.*\breport/i,
  /\bcheck\b.*\bcredit\b/i,
  /\breview\b.*\bcredit\b/i,
];

/** Broad drive/ingest phrasing (non–explicit-CG). */
const DRIVE_INGEST_PATTERNS: RegExp[] = [
  /\badd\b.*\b(credit\s+guardian|to\s+credit(\s+guardian)?)/i,
  /\b(enroll|register)\b.*\b(in\s+)?credit\s+guardian/i,
  /\bsync\b.*\bdrive/i,
  /\bingest\b.*\b(drive|folder|client)/i,
  /\bpull\b.*\b(files?|documents?)\b.*\bdrive/i,
  /\bimport\b.*\b(drive|folder)/i,
  /\bscan\b.*\bdrive/i,
  /\bupload\b.*\b(credit|reports?).*\b(drive|folder)/i,
  /\bprocess\b.*\b(drive|folder).*\bcredit/i,
  /\bput\b.*\bin\b.*\bcredit\s+guardian/i,
  /\bsync\b.*\bto\b.*\bcredit\s+guardian/i,
  /\bingest\b.*\binto\b.*\bcredit\s+guardian/i,
  /\bonboard\b.*\b(into|to)\b.*(\bcg\b|credit\s+guardian)/i,
  /\bregister\b.*\bin\b.*\bcredit\s+guardian/i,
  /\bload\b.*\binto\b.*\bcredit\s+guardian/i,
  /\bbring\b.*\binto\b.*\bcredit\s+guardian/i,
  /\bimport\b.*\binto\b.*\bcredit\s+guardian/i,
];

/** Credit Guardian or standalone CG token (word boundary). */
const RE_CREDIT_GUARDIAN_TARGET = /(?:credit\s+guardian|\bcg\b)/i;

const RE_EXPLICIT_ACTION_VERBS =
  /\b(add|put|onboard|register|sync|ingest|import|enroll|load|bring)\b/i;

function firstMatchReason(patterns: RegExp[], text: string, label: string): string | null {
  for (const p of patterns) {
    if (p.test(text)) return label;
  }
  return null;
}

/**
 * Explicit operator command: action verb + (credit guardian | cg).
 * Bypasses confidence gating when used by telegram routing.
 * Negations like "don't add …" are excluded.
 */
export function isExplicitCreditGuardianIngestIntent(lowerText: string): boolean {
  if (/\b(don't|do not|never)\s+(add|put|sync|ingest|onboard|register|import|enroll|load|bring)\b/i.test(lowerText)) {
    return false;
  }
  if (!RE_CREDIT_GUARDIAN_TARGET.test(lowerText)) return false;
  if (!RE_EXPLICIT_ACTION_VERBS.test(lowerText)) return false;
  return true;
}

/** Strip trailing status phrases between the name and "to Credit Guardian" (not part of the client name). */
function stripCgIngestNameNoise(s: string): string {
  let t = s.trim();
  t = t.replace(/\s+(?:dispute|credit)\s+progress$/i, "");
  return t.trim();
}

/** Normalize quoted titles, punctuation noise, and whitespace for extracted CG client names. */
export function normalizeExtractedCgClientName(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^["'`""''´]+|["'`""''´]+$/g, "");
  s = stripCgIngestNameNoise(s);
  s = s.replace(/^(?:mr\.?|mrs\.?|ms\.?|miss\.?|dr\.?|prof\.?)\s+/i, "");
  s = s.replace(/[.,;:!?…]+$/g, "");
  s = s.replace(/\b(the|a|an|my|our)\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 80) return null;
  return s;
}

/**
 * Extract client/person segment for explicit Credit Guardian ingest commands.
 * Returns null if no name found (caller may still run full-folder ingest without client_name).
 */
export function extractCreditGuardianClientNameForIngest(message: string): string | null {
  const t = message.trim();
  const NAME = String.raw`(?:[A-Za-z0-9][A-Za-z0-9\s.'\/&\-]{0,78}?)`;

  const patterns: RegExp[] = [
    /\b(?:add|put|sync|ingest|onboard|register|load|bring|import|enroll)\s+["']([^"']{2,80})["']\s+(?:to|into|in)\s+(?:credit\s+guardian|\bcg\b)\b/i,
    new RegExp(
      String.raw`\b(?:add|put|sync|ingest|onboard|register|load|bring|import|enroll)\s+(?:client\s+)?([A-Za-z0-9][A-Za-z0-9.'\-]*)\s+dispute\s+progress\s+(?:to|into|in)\s+(?:credit\s+guardian|\bcg\b)\b`,
      "i",
    ),
    new RegExp(
      String.raw`\b(?:add|put|sync|ingest|onboard|register|load|bring|import|enroll)\s+(?:client\s+)?(${NAME})\s+(?:to|into|in)\s+(?:credit\s+guardian|\bcg\b)\b`,
      "i",
    ),
    new RegExp(
      String.raw`(?:^|[.!?]\s*)(?:please|hey|ok)[,.\s]+(?:add|put)\s+(?:client\s+)?(${NAME})\s+(?:to|into|in)\s+(?:credit\s+guardian|\bcg\b)\b`,
      "i",
    ),
    new RegExp(
      String.raw`\b(?:add|put)\s+(?:client\s+)?(${NAME})\s+to\s+credit\s+guardian\b`,
      "i",
    ),
    new RegExp(String.raw`\bput\s+(?:client\s+)?(${NAME})\s+in\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\bsync\s+(?:client\s+)?(${NAME})\s+to\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\bingest\s+(?:client\s+)?(${NAME})\s+into\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(
      String.raw`\bonboard\s+(?:client\s+)?(${NAME})\s+(?:into|to)\s+(?:credit\s+guardian|\bcg\b)\b`,
      "i",
    ),
    new RegExp(String.raw`\bregister\s+(?:client\s+)?(${NAME})\s+in\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\bload\s+(?:client\s+)?(${NAME})\s+into\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\bbring\s+(?:client\s+)?(${NAME})\s+into\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\bimport\s+(?:client\s+)?(${NAME})\s+into\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
    new RegExp(String.raw`\benroll\s+(?:client\s+)?(${NAME})\s+in\s+(?:credit\s+guardian|\bcg\b)\b`, "i"),
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) {
      const normalized = normalizeExtractedCgClientName(m[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

/**
 * Pick Credit Guardian execution workflow from user text (lowercase trimmed).
 * Explicit Credit Guardian ingest commands win first (confidence 1.0).
 */
export function inferCreditWorkflowKey(lowerText: string): CreditWorkflowDecision {
  if (isExplicitCreditGuardianIngestIntent(lowerText)) {
    return {
      workflowKey: "drive_ingest",
      confidence: 1,
      reasons: ["explicit_credit_guardian_action"],
    };
  }

  const reasons: string[] = [];
  let workflowKey: CreditWorkflowKey = "analyze_credit_strategy";
  let confidence = 0.55;

  /** Pronoun-led credit references — below auto-exec threshold so Telegram can still rescue with session binding. */
  if (/\b(her|his|their)\s+(credit|report|file|dispute|case)\b/i.test(lowerText)) {
    reasons.push("credit_pronoun_reference");
    return { workflowKey: "analyze_credit_strategy", confidence: 0.58, reasons };
  }

  const drive = firstMatchReason(DRIVE_INGEST_PATTERNS, lowerText, "drive_ingest");
  if (drive) {
    reasons.push(drive);
    return { workflowKey: "drive_ingest", confidence: 0.82, reasons };
  }

  const dispute = firstMatchReason(DISPUTE_LETTER_PATTERNS, lowerText, "dispute_or_compare");
  if (dispute) {
    reasons.push(dispute);
    workflowKey = "credit_analysis_and_disputes";
    confidence = 0.88;
    return { workflowKey, confidence, reasons };
  }

  const analysis = firstMatchReason(ANALYSIS_PATTERNS, lowerText, "credit_analysis");
  if (analysis) {
    reasons.push(analysis);
    workflowKey = "analyze_credit_strategy";
    confidence = 0.85;
    return { workflowKey, confidence, reasons };
  }

  if (/\bcredit\b/i.test(lowerText) && /\b(dispute|bureau|tradeline|score|report)\b/i.test(lowerText)) {
    reasons.push("credit_domain_keywords");
    return { workflowKey: "analyze_credit_strategy", confidence: 0.62, reasons };
  }

  reasons.push("no_credit_match");
  return { workflowKey: "analyze_credit_strategy", confidence: 0.2, reasons };
}

/**
 * Lane-1 auto-execution gate. Explicit Credit Guardian ingest always passes.
 */
export function shouldAutoExecuteCreditIntent(lowerText: string): boolean {
  if (isExplicitCreditGuardianIngestIntent(lowerText)) return true;
  const d = inferCreditWorkflowKey(lowerText);
  return d.confidence >= 0.6;
}

/**
 * Lane 2 only: general credit education / definitions without an execution request.
 * When false and credit tools are implied, routing should prefer Lane 1.
 */
export function isCreditInformationalOnly(lowerText: string): boolean {
  const t = lowerText.trim();
  if (!/\b(credit|bureau|fico|score|tradeline|dispute|equifax|experian|transunion|guardian)\b/i.test(t)) {
    return false;
  }
  if (
    /\b(analyze|generate|run|execute|sync|ingest|pull|create|send|letter|compare|review|check|file|upload|add\s+to)\b/i.test(t)
  ) {
    return false;
  }
  if (/^(what|how|why|when|who|explain|define|tell me about|is it true|can you explain)\b/i.test(t)) {
    return true;
  }
  if (/\b(what is|what's)\b.*\b(credit score|fico|apr|utilization)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Borderline credit workflow (e.g. pronoun reference at 0.58) — promote to Lane 1 without lowering global auto-exec threshold. */
export function shouldRescueCreditLane1(lowerText: string): boolean {
  if (isExplicitCreditGuardianIngestIntent(lowerText)) return false;
  const d = inferCreditWorkflowKey(lowerText);
  return d.confidence >= 0.55 && d.confidence < 0.6 && d.reasons[0] !== "no_credit_match";
}

export interface CaseMemorySnippetRow {
  case_phase: string | null;
  memory_summary: string | null;
  cg_client_id: string | null;
}

/**
 * Optional memory blob for agentic prompt injection (Layer-3 grounding).
 * Safe to call with service-role Supabase client; returns empty string if no row.
 */
export function formatCaseMemorySnippet(row: CaseMemorySnippetRow | null, clientName: string): string {
  if (!row || (!row.memory_summary && !row.case_phase)) return "";
  const parts = [`Case memory for "${clientName}":`];
  if (row.case_phase) parts.push(`Phase: ${row.case_phase}.`);
  if (row.memory_summary) parts.push(row.memory_summary);
  if (row.cg_client_id) parts.push(`Credit Guardian client id: ${row.cg_client_id}.`);
  return parts.join(" ");
}
