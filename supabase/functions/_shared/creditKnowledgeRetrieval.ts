/**
 * RAG integration via Supabase RPC match_credit_knowledge (no schema changes here).
 * Fails open on error; pairs with retrieveRelevantKnowledge HTTP fallback.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { detectCreditTriggers } from "./detectCreditTriggers.ts";
import type { CreditRetrievalTask, RetrievedKnowledge, RetrievalQuery } from "./retrieveRelevantKnowledge.ts";
import { mergeRetrievedCapped, retrieveRelevantKnowledge } from "./retrieveRelevantKnowledge.ts";
import {
  type TriggerEvidenceContext,
  selectPrimaryTrigger,
} from "./selectPrimaryTrigger.ts";

export { detectCreditTriggers } from "./detectCreditTriggers.ts";
export { selectPrimaryTrigger } from "./selectPrimaryTrigger.ts";
export type { TriggerEvidenceContext } from "./selectPrimaryTrigger.ts";

/** Canonical KB trigger ids (align with credit_knowledge_base.trigger). */
export const KB_TRIGGER_PRIORITY = [
  "identity_theft_account_present",
  "reinserted_account",
  "duplicate_collection",
  "unauthorized_inquiry",
  "late_payment",
  "inconsistent_status",
  "missing_credit_report",
] as const;

export interface CaseStateForRetrieval {
  case_type?: string | null;
  /** Same as `primaryTrigger` — RPC `filter_trigger` (single focused trigger). */
  trigger?: string | null;
  /** From `selectPrimaryTrigger`: use for retrieval filter + dispute core argument. */
  primaryTrigger?: string | null;
  /** Up to two additional triggers (priority-ordered). */
  secondaryTriggers?: string[];
  /** Deterministic explanation for audits / clients. */
  triggerReasoning?: string;
  /** Heuristic 0–1 from `selectPrimaryTrigger`. */
  triggerConfidence?: number;
  /** Evidence snapshot used for confidence (optional echo for clients). */
  triggerEvidence?: TriggerEvidenceContext;
  /** All detected triggers, deduped and sorted by KB_TRIGGER_PRIORITY. */
  triggers?: string[];
  /**
   * Persisted machine-readable warning codes from prior runs (`warning_codes` merged into client `case_state`).
   * Biases retrieval toward broad mode and de-escalation when e.g. low_confidence / weak_evidence.
   */
  warningFlags?: string[];
}

/** When false, skip RPC `filter_trigger` and row trigger allowlist (broader retrieval; case_type still applies). */
export function shouldUseTriggerStrictFilter(caseState: CaseStateForRetrieval): boolean {
  const flags = caseState.warningFlags ?? [];
  if (flags.includes("low_confidence") || flags.includes("weak_evidence")) {
    return false;
  }
  const c = caseState.triggerConfidence;
  if (c == null) return true;
  return c >= 0.6;
}

export function getSimilarityThresholdForPrimary(primary: string | null | undefined): number {
  if (primary === "identity_theft_account_present") return 0.45;
  if (primary === "reinserted_account") return 0.4;
  return 0.3;
}

export type MergeWarningFlagsOptions = {
  /** Current-run trigger confidence; used for recovery clear. */
  triggerConfidence?: number;
  /** Approximate 2–3 cycles × 2 codes; older entries drop off. Default 6. */
  maxTail?: number;
};

/**
 * Merge prior flags with new codes for persistence on `case_state.warning_flags`.
 * - If confidence > 0.7 and this run adds no new codes → clear (recover from uncertainty).
 * - Keep only the last `maxTail` entries in sequence (decay), then unique-preserving order.
 */
export function mergeWarningFlagsForPersistence(
  previous: string[] | undefined,
  codes: string[],
  opts?: MergeWarningFlagsOptions,
): string[] {
  const tc = opts?.triggerConfidence;
  const maxTail = opts?.maxTail ?? 6;
  if (tc != null && tc > 0.7 && codes.length === 0) {
    return [];
  }
  const seq = [...(previous ?? []), ...codes];
  const tail = seq.slice(-maxTail);
  return [...new Set(tail)];
}

/** Lightweight priors for strategy bias (no DB). Values in 0–1. */
export const TRIGGER_PERFORMANCE_PRIORS: Record<string, number> = {
  reinserted_account: 0.85,
  identity_theft_account_present: 0.8,
  unauthorized_inquiry: 0.7,
  duplicate_collection: 0.55,
  inconsistent_status: 0.55,
  late_payment: 0.4,
  missing_credit_report: 0.5,
};

export function getTriggerPerformancePrior(primary: string | null | undefined): number {
  if (!primary) return 0.55;
  return TRIGGER_PERFORMANCE_PRIORS[primary] ?? 0.55;
}

/** Heuristic: retrieved text already aligns with primary trigger (broad-mode anchor satisfied). */
const PRIMARY_ANCHOR_PATTERNS: Record<string, RegExp> = {
  reinserted_account: /\bre-?insert|reappear|reinsertion|611\s*\(a\)/i,
  identity_theft_account_present: /\b605B|identity\s*theft|blocking|fraud|ftc/i,
  duplicate_collection: /\bduplicate|multiple\s+account|623/i,
  unauthorized_inquiry: /\b604\b|inquir|permissible\s+purpose/i,
  late_payment: /\blate\b|delinq|accuracy|completeness/i,
  inconsistent_status: /\bstatus|open|closed|inaccurat/i,
  missing_credit_report: /\breport|file|disclosure|access/i,
};

const PRIMARY_SPINE_ONE_LINER: Record<string, string> = {
  reinserted_account:
    "Reinsertion of a deleted tradeline requires notice under 15 U.S.C. § 1681i(a)(5)(B); failure to comply supports dispute and deletion.",
  identity_theft_account_present:
    "Blocking and suppression for identity-theft-related accounts are governed by 15 U.S.C. § 1681c-5 (FCRA § 605B) where applicable.",
  unauthorized_inquiry:
    "Hard inquiries require a permissible purpose under 15 U.S.C. § 1681b; unauthorized inquiries must be investigated and corrected.",
  duplicate_collection:
    "Duplicate or overlapping collection reporting may violate accuracy and duplication obligations under FCRA § 611 and furnisher duties.",
  inconsistent_status:
    "Tradeline status and balance information must reflect maximum possible accuracy under 15 U.S.C. § 1681e(b) and § 1681s-2.",
  late_payment:
    "Payment history and late-payment notation must be accurate, complete, and verified on reinvestigation under FCRA § 611.",
  missing_credit_report:
    "File disclosure and consumer access obligations must be satisfied before adverse use of withheld reports.",
};

export function getSystemAnchorViolationLine(primary: string): string {
  const line = PRIMARY_SPINE_ONE_LINER[primary];
  if (line) return `[System legal spine] ${line}`;
  const label = primary.replace(/_/g, " ");
  return `[System legal spine] ${label}: FCRA reinvestigation and maximum possible accuracy duties under 15 U.S.C. § 1681i apply to disputed tradelines.`;
}

function retrievalReflectsPrimaryAnchor(
  retrieved: RetrievedKnowledge,
  primary: string,
): boolean {
  const re = PRIMARY_ANCHOR_PATTERNS[primary];
  if (!re) return false;
  const blob = [
    ...retrieved.violationLogic,
    ...retrieved.analysisPatterns,
    ...retrieved.disputeExamples,
  ].join("\n");
  return re.test(blob);
}

/** Same heuristics as `retrievalReflectsPrimaryAnchor` — exported for tests / callers. */
export function alreadyHasPrimaryAnchor(
  retrieved: RetrievedKnowledge,
  primary: string,
): boolean {
  return retrievalReflectsPrimaryAnchor(retrieved, primary);
}

function firstSentenceHead(s: string, maxLen = 100): string {
  const t = s.trim();
  const dot = t.indexOf(". ");
  const chunk = dot > 0 && dot < 140 ? t.slice(0, dot + 1) : t.slice(0, maxLen);
  return chunk.trim().toLowerCase().replace(/\s+/g, " ");
}

function jaccardWordSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let inter = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) inter++;
  }
  const union = wordsA.size + wordsB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Stricter Jaccard bar for short heads — reduces false duplicate collapse. */
function dynamicJaccardThreshold(head: string): number {
  const len = head.split(/\s+/).filter((w) => w.length > 0).length;
  if (len < 8) return 0.68;
  if (len < 16) return 0.6;
  return 0.55;
}

/** Exact / prefix + light “semantic” overlap on first ~100 chars (no embeddings). */
function lineAlreadyPresentInRetrieved(text: string, retrieved: RetrievedKnowledge): boolean {
  const n = text.trim().toLowerCase();
  if (n.length < 12) return false;
  const head = firstSentenceHead(text, 100);
  const pool = [
    ...retrieved.violationLogic,
    ...retrieved.analysisPatterns,
    ...retrieved.disputeExamples,
  ];
  for (const line of pool) {
    const t = line.trim().toLowerCase();
    if (t === n) return true;
    const otherHead = firstSentenceHead(line, 100);
    if (head.length > 24 && otherHead.length > 24 && head === otherHead) return true;
    if (head.length > 28 && otherHead.length > 28) {
      const thresh = Math.max(
        dynamicJaccardThreshold(head),
        dynamicJaccardThreshold(otherHead),
      );
      if (jaccardWordSimilarity(head, otherHead) >= thresh) return true;
    }
    if (head.length > 20 && t.startsWith(head.slice(0, Math.min(80, head.length)))) return true;
  }
  return false;
}

/** Keep total items ≤ cap; violations first (legal spine), then patterns, then examples. */
function trimRetrievedToCap(retrieved: RetrievedKnowledge, cap: number): RetrievedKnowledge {
  const flat: Array<{ k: "v" | "p" | "d"; c: string }> = [
    ...retrieved.violationLogic.map((c) => ({ k: "v" as const, c })),
    ...retrieved.analysisPatterns.map((c) => ({ k: "p" as const, c })),
    ...retrieved.disputeExamples.map((c) => ({ k: "d" as const, c })),
  ].slice(0, cap);
  const out: RetrievedKnowledge = { disputeExamples: [], analysisPatterns: [], violationLogic: [] };
  for (const x of flat) {
    if (x.k === "v") out.violationLogic.push(x.c);
    else if (x.k === "p") out.analysisPatterns.push(x.c);
    else out.disputeExamples.push(x.c);
  }
  return out;
}

type RpcRow = {
  content?: string;
  type?: string;
  case_type?: string;
  trigger?: string;
  /** If RPC returns similarity, low scores are dropped when any row has scores. */
  similarity?: number;
};

function extractWarningFlagsFromDetail(
  detail: Record<string, unknown>,
  docs: Record<string, unknown>,
): string[] | undefined {
  const cs =
    detail.caseState ?? detail.case_state ?? docs.caseState ?? docs.case_state;
  if (isRecord(cs)) {
    const wf = cs.warning_flags ?? cs.warningFlags;
    if (Array.isArray(wf)) {
      const u = [...new Set(wf.map((x) => String(x).trim()).filter(Boolean))];
      return u.length ? u : undefined;
    }
  }
  if (Array.isArray(detail.warning_flags)) {
    const u = [...new Set(detail.warning_flags.map((x) => String(x).trim()).filter(Boolean))];
    return u.length ? u : undefined;
  }
  if (Array.isArray(detail.warningFlags)) {
    const u = [...new Set(detail.warningFlags.map((x) => String(x).trim()).filter(Boolean))];
    return u.length ? u : undefined;
  }
  return undefined;
}

/**
 * RPC fetch depth: low confidence → more rows from embedding search; strict/high confidence → tighter.
 */
export function computeRpcMatchCount(caseState: CaseStateForRetrieval): number {
  const flags = caseState.warningFlags ?? [];
  const priorUncertainty = flags.includes("low_confidence") || flags.includes("weak_evidence");
  const c = caseState.triggerConfidence;
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  const perf = getTriggerPerformancePrior(primary);
  let n = 6;
  if (c != null && c < 0.5) n = 8;
  else if (c != null && c < 0.6) n = 7;
  else if (priorUncertainty) n = 7;
  if (perf < 0.5 && c != null && c >= 0.6) n = Math.min(8, n + 1);
  return n;
}

function rowBucketType(row: RpcRow): "v" | "p" | "d" {
  const t = String(row.type ?? "").toLowerCase();
  if (t.includes("violation") || t.includes("logic")) return "v";
  if (t.includes("dispute")) return "d";
  if (t.includes("analysis") || t.includes("pattern")) return "p";
  return "p";
}

/** Broad-mode ranking: prefer primary trigger, violation_logic, matching case_type (deterministic). */
function scoreRpcRow(
  row: RpcRow,
  primaryTrigger: string | null | undefined,
  wantCaseType: string | null | undefined,
  broadMode: boolean,
): number {
  let s = 0;
  const rowTrg = row.trigger != null ? String(row.trigger).trim().toLowerCase() : "";
  const prim = primaryTrigger?.trim().toLowerCase() ?? "";
  if (prim && rowTrg === prim) s += 100;
  if (rowBucketType(row) === "v") s += 50;
  const rowCt = row.case_type != null ? String(row.case_type).trim().toLowerCase() : "";
  const wc = wantCaseType?.trim().toLowerCase();
  if (wc && rowCt && rowCt === wc) s += 40;
  else if (broadMode && wc && rowCt && rowCt !== wc) s -= 25;
  if (typeof row.similarity === "number") s += row.similarity * 10;
  return s;
}

export interface RetrieveKnowledgeIntent {
  /** Human-readable intent for query_text, e.g. "generate dispute letter Equifax" */
  intentLabel: string;
  task: CreditRetrievalTask;
}

/** Multi-source evidence for confidence weighting (deterministic). */
export function buildTriggerEvidenceContext(
  detail: Record<string, unknown>,
  docs: Record<string, unknown>,
  caseState: Record<string, unknown> | undefined,
  triggers: string[],
): TriggerEvidenceContext {
  let sourceCount = 1;
  const obsLen = (Array.isArray(detail.observations) ? detail.observations.length : 0) +
    (Array.isArray(docs.observations) ? docs.observations.length : 0);
  if (obsLen > 0) sourceCount++;

  const cs = detail.caseState ?? detail.case_state;
  const snapArr = isRecord(cs) && Array.isArray(cs.snapshots)
    ? cs.snapshots
    : Array.isArray(detail.snapshots)
    ? detail.snapshots
    : undefined;
  if (snapArr && snapArr.length >= 1) sourceCount++;

  const supportingSignalCount = triggers.length;
  const weakEvidenceOnly = triggers.length <= 1 && sourceCount <= 1 && obsLen === 0 &&
    !(snapArr && snapArr.length >= 2);

  return { sourceCount, supportingSignalCount, weakEvidenceOnly };
}

function sortTriggersByPriority(ids: string[]): string[] {
  const order = new Map<string, number>(KB_TRIGGER_PRIORITY.map((t, i) => [t, i]));
  return [...new Set(ids)].sort((a, b) => {
    const ia = order.get(a) ?? 99;
    const ib = order.get(b) ?? 99;
    return ia - ib;
  });
}

/** Pull human-readable strings from observations arrays (Hub / CG shapes). */
function appendObservationText(chunks: string[], obs: unknown): void {
  if (!obs) return;
  if (typeof obs === "string") {
    chunks.push(obs);
    return;
  }
  if (!Array.isArray(obs)) return;
  for (const item of obs) {
    if (typeof item === "string") chunks.push(item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const line = o.text ?? o.body ?? o.label ?? o.description ?? o.observation ?? o.summary ?? o.title;
      if (typeof line === "string") chunks.push(line);
      chunks.push(JSON.stringify(item));
    }
  }
}

/**
 * Build a single lowercased search blob from caseState, observations, and full payload.
 */
function collectTriggerSearchText(detail: Record<string, unknown>, docs: Record<string, unknown>): string {
  const chunks: string[] = [];
  const cs = detail.caseState ?? detail.case_state;
  if (typeof cs === "string") chunks.push(cs);
  else if (cs && typeof cs === "object") chunks.push(JSON.stringify(cs));
  appendObservationText(chunks, detail.observations);
  appendObservationText(chunks, docs.observations);
  chunks.push(JSON.stringify({ detail, docs }));
  return chunks.join("\n").toLowerCase();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function truthyFlag(x: unknown): boolean {
  if (x === true) return true;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  return false;
}

/**
 * Extract case_type + triggers from CG detail/docs via deterministic `detectCreditTriggers` only.
 */
export function extractCaseStateFromDetailDocs(
  detail: Record<string, unknown>,
  docs: Record<string, unknown>,
): CaseStateForRetrieval {
  const blob = collectTriggerSearchText(detail, docs);
  const csRaw = detail.caseState ?? detail.case_state;
  const caseState = isRecord(csRaw) ? csRaw : undefined;
  const observations = detail.observations ?? docs.observations;

  const triggers = detectCreditTriggers(caseState, observations);

  let case_type: string | undefined;
  if (caseState) {
    if (truthyFlag(caseState.mixed_file)) case_type = "mixed_file";
    else if (truthyFlag(caseState.identity_theft)) case_type = "identity_theft";
  }
  if (!case_type) {
    if (/\bmixed\s*file/i.test(blob)) case_type = "mixed_file";
    else if (/\bidentity\b/i.test(blob) && /\b(theft|fraud)\b/i.test(blob)) case_type = "identity_theft";
  }

  const sorted = sortTriggersByPriority(triggers);
  const triggerEvidence = buildTriggerEvidenceContext(detail, docs, caseState, sorted);
  const {
    primaryTrigger,
    secondaryTriggers,
    triggerReasoning,
    triggerConfidence,
  } = selectPrimaryTrigger(sorted, triggerEvidence);
  const warningFlags = extractWarningFlagsFromDetail(detail, docs);
  return {
    case_type: case_type ?? null,
    trigger: primaryTrigger,
    primaryTrigger,
    secondaryTriggers: secondaryTriggers.length ? secondaryTriggers : undefined,
    triggerReasoning,
    triggerConfidence: triggerConfidence > 0 ? triggerConfidence : undefined,
    triggerEvidence,
    triggers: sorted.length ? sorted : undefined,
    warningFlags,
  };
}

/** Suffix for HTTP retrieval `intentSummary` / `caseStateSummary` so CREDIT_RETRIEVAL_URL sees KB triggers. */
export function formatTriggersForRetrievalQuery(caseState: CaseStateForRetrieval): string {
  const segments: string[] = [];
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  if (primary) segments.push(`kb_primary=${primary}`);
  if (caseState.secondaryTriggers?.length) {
    segments.push(`kb_secondary=${caseState.secondaryTriggers.join(",")}`);
  }
  const list = caseState.triggers?.length
    ? caseState.triggers
    : caseState.trigger
    ? [caseState.trigger]
    : [];
  if (list.length) segments.push(`kb_triggers=${list.join(",")}`);
  if (caseState.triggerConfidence != null && caseState.triggerConfidence > 0) {
    segments.push(`kb_confidence=${caseState.triggerConfidence}`);
  }
  if (!shouldUseTriggerStrictFilter(caseState)) {
    segments.push("kb_retrieval_mode=broad");
  }
  const wf = caseState.warningFlags ?? [];
  if (wf.includes("low_confidence") || wf.includes("weak_evidence")) {
    segments.push("kb_prior_uncertainty=1");
  }
  if (!segments.length) return "";
  return `; ${segments.join(";")}`;
}

export type RetrievalNegativeFilter = {
  /** Keep only rows whose `trigger` matches one of these (if row has a trigger). */
  triggerAllowlist?: string[];
  /** Drop rows below this when RPC provides `similarity` on at least one row. */
  minSimilarity?: number;
};

function rpcRowsToRetrieved(
  rows: RpcRow[] | null,
  maxTotal: number,
  expectedCaseType: string | null | undefined,
  negativeFilter: RetrievalNegativeFilter | undefined,
  broadMode: boolean,
  primaryTrigger: string | null | undefined,
): RetrievedKnowledge {
  const out: RetrievedKnowledge = {
    disputeExamples: [],
    analysisPatterns: [],
    violationLogic: [],
    violationTriggers: [],
  };
  if (!Array.isArray(rows)) return out;
  const hasScores = rows.some((r) => r != null && typeof (r as RpcRow).similarity === "number");
  const minSim = hasScores ? (negativeFilter?.minSimilarity ?? 0.35) : 0;
  const allow = negativeFilter?.triggerAllowlist?.filter(Boolean).map((s) => s.trim().toLowerCase()) ??
    null;

  const candidates: { row: RpcRow; score: number }[] = [];

  for (const row of rows) {
    const content = String(row.content ?? "").trim();
    if (!content) continue;
    if (typeof row.similarity === "number" && hasScores && row.similarity < minSim) continue;

    const rowCt = row.case_type != null ? String(row.case_type).trim().toLowerCase() : "";
    const rowTrg = row.trigger != null ? String(row.trigger).trim().toLowerCase() : "";
    const wantCt = expectedCaseType?.trim().toLowerCase();

    if (!broadMode) {
      if (wantCt && rowCt && rowCt !== wantCt) continue;
      if (allow && allow.length && rowTrg) {
        if (!allow.some((a) => a === rowTrg)) continue;
      }
    }

    const score = scoreRpcRow(row, primaryTrigger, expectedCaseType, broadMode);
    candidates.push({ row, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  let count = 0;
  for (const { row } of candidates) {
    if (count >= maxTotal) break;
    const content = String(row.content ?? "").trim();
    const t = String(row.type ?? "").toLowerCase();
    if (t.includes("dispute")) out.disputeExamples.push(content);
    else if (t.includes("analysis") || t.includes("pattern")) out.analysisPatterns.push(content);
    else if (t.includes("violation") || t.includes("logic")) {
      out.violationLogic.push(content);
      const tr = row.trigger != null ? String(row.trigger).trim() : undefined;
      out.violationTriggers!.push(tr);
    } else out.analysisPatterns.push(content);
    count++;
  }
  if (!out.violationLogic.length || !out.violationTriggers?.length) delete out.violationTriggers;
  else if (out.violationTriggers.length !== out.violationLogic.length) {
    out.violationTriggers = out.violationTriggers.slice(0, out.violationLogic.length);
  }
  return out;
}

/**
 * Aligns with dispute assembly: reinsertion > identity > MOV > inquiry > accuracy > late payment.
 * Lines are plain text — we infer “trigger family” from content (same idea as `violationStrengthScore` in assemble).
 */
const VIOLATION_STRENGTH_ORDER = [
  "reinserted_account",
  "identity_theft_account_present",
  "mov_request",
  "unauthorized_inquiry",
  "inaccurate_account_data",
  "late_payment",
] as const;

function violationLineStrengthIndex(text: string): number {
  const s = text.toLowerCase();
  if (/re-?insert|reappear|reinsertion|611\s*\(a\)\(5\)/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("reinserted_account");
  }
  if (/605b|identity|theft|blocking|fraud/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("identity_theft_account_present");
  }
  if (/611\(a\)\(7\)|method\s+of\s+verification|\bmov\b|verification/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("mov_request");
  }
  if (/\b604\b|permissible|inquir/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("unauthorized_inquiry");
  }
  if (/inaccurat|607\(b\)|incomplete|maximum\s+possible|623/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("inaccurate_account_data");
  }
  if (/late|delinq|past\s+due|30|60|90/i.test(s)) {
    return VIOLATION_STRENGTH_ORDER.indexOf("late_payment");
  }
  return VIOLATION_STRENGTH_ORDER.length;
}

/** Prefer KB `trigger` when present; else text inference (stable as KB wording drifts). */
function strengthIndexFromTriggerOrText(trigger: string | undefined, text: string): number {
  if (trigger) {
    const ix = (VIOLATION_STRENGTH_ORDER as readonly string[]).indexOf(trigger);
    if (ix >= 0) return ix;
  }
  return violationLineStrengthIndex(text);
}

const TIER_1_TRIGGERS = new Set<string>(["reinserted_account", "identity_theft_account_present"]);

/** Internal pair (API stays parallel arrays on `RetrievedKnowledge`). */
type ViolationPair = { line: string; trigger?: string };

function toViolationPairs(lines: string[], triggers?: (string | undefined)[]): ViolationPair[] {
  return lines.map((line, i) => ({ line, trigger: triggers?.[i] }));
}

function fromViolationPairs(pairs: ViolationPair[]): Pick<RetrievedKnowledge, "violationLogic" | "violationTriggers"> {
  return {
    violationLogic: pairs.map((p) => p.line),
    violationTriggers: pairs.map((p) => p.trigger),
  };
}

function isTier1Line(line: string, trigger?: string): boolean {
  if (trigger && TIER_1_TRIGGERS.has(trigger)) return true;
  const ix = violationLineStrengthIndex(line);
  return ix === 0 || ix === 1;
}

/**
 * Tier-1 floor when uncertainty or elevated posture; relax when confidence is high and escalation is low.
 * When `analysisOnly` (no escalation context), bias toward tier-1 only under weak signals — keeps analysis legally anchored without dispute-level relaxation rules.
 */
export function shouldForceTier1(
  escalationLevel: number | undefined,
  confidence: number | undefined,
  analysisOnly: boolean,
): boolean {
  if (analysisOnly) {
    if (confidence == null) return true;
    return confidence < 0.6;
  }
  if (escalationLevel != null && escalationLevel >= 3) return true;
  if (confidence == null) return true;
  return confidence < 0.7;
}

function sortViolationPairsFromPairs(pairs: ViolationPair[]): ViolationPair[] {
  return [...pairs].sort((a, b) => {
    const ia = strengthIndexFromTriggerOrText(a.trigger, a.line);
    const ib = strengthIndexFromTriggerOrText(b.trigger, b.line);
    if (ia !== ib) return ia - ib;
    return violationLineTieBreakScore(b.line) - violationLineTieBreakScore(a.line);
  });
}

/** If the pool has a §611 reinsertion / §605B-class line but the top two are weaker only, swap in best tier-1. */
function ensureTierOneInTopTwo(sorted: ViolationPair[], forceTier1: boolean): ViolationPair[] {
  if (!forceTier1 || sorted.length < 2) return sorted;
  const tier1Pool = sorted.filter((p) => isTier1Line(p.line, p.trigger));
  if (tier1Pool.length === 0) return sorted;

  const a = sorted[0];
  const b = sorted[1];
  if (isTier1Line(a.line, a.trigger) || isTier1Line(b.line, b.trigger)) return sorted;

  const bestTier1 = [...tier1Pool].sort((x, y) =>
    strengthIndexFromTriggerOrText(x.trigger, x.line) - strengthIndexFromTriggerOrText(y.trigger, y.line)
  )[0];

  const wa = strengthIndexFromTriggerOrText(a.trigger, a.line);
  const wb = strengthIndexFromTriggerOrText(b.trigger, b.line);
  const replaceIdx = wa >= wb ? 0 : 1;
  const mixed: ViolationPair[] = [...sorted];
  mixed[replaceIdx] = bestTier1;
  return sortViolationPairsFromPairs(mixed);
}

function violationLineTieBreakScore(text: string): number {
  const s = text.toLowerCase();
  if (/re-?insert|reappear|deleted.*report|reinsertion/i.test(s)) return 100;
  if (/identity|theft|605b|fraud|blocking/i.test(s)) return 90;
  if (/611\(a\)\(7\)|method of verification|mov\b|verification/i.test(s)) return 78;
  if (/604|permissible|inquir/i.test(s)) return 72;
  if (/maximum possible accuracy|incomplete|inaccurate|623/i.test(s)) return 58;
  if (/late|delinq|past due|30|60|90/i.test(s)) return 42;
  return 25;
}

/**
 * Reserve up to two violation_logic slots when available, then patterns, then examples — minimum legal coverage.
 * The two violations are the strongest lines (metadata trigger when present), tier-1 floor when context demands it.
 */
export function reorderWithMinViolations(
  retrieved: RetrievedKnowledge,
  totalMax: number,
  opts?: {
    escalationLevel?: number;
    triggerConfidence?: number;
    /** True when `retrieveKnowledge` was called without composition (e.g. analyze-credit-strategy). */
    analysisOnlyTier1Bias?: boolean;
  },
): RetrievedKnowledge {
  let pairs = toViolationPairs(retrieved.violationLogic, retrieved.violationTriggers);
  pairs = sortViolationPairsFromPairs(pairs);
  const forceTier = shouldForceTier1(
    opts?.escalationLevel,
    opts?.triggerConfidence,
    opts?.analysisOnlyTier1Bias ?? false,
  );
  pairs = ensureTierOneInTopTwo(pairs, forceTier);
  const wantV = Math.min(2, pairs.length, totalMax);
  let vTake = pairs.slice(0, wantV);
  // Hard floor: never emit pattern-only output when any violation exists. If totalMax is 0, this can yield one violation over the nominal cap (legal floor).
  if (vTake.length === 0 && pairs.length > 0) {
    vTake = [pairs[0]];
  }
  let slots = totalMax - vTake.length;
  const p = [...retrieved.analysisPatterns];
  const d = [...retrieved.disputeExamples];

  const vPart = fromViolationPairs(vTake);
  const merged: RetrievedKnowledge = {
    disputeExamples: [],
    analysisPatterns: [],
    violationLogic: vPart.violationLogic,
    violationTriggers: vPart.violationTriggers,
  };
  for (const t of p) {
    if (slots <= 0) break;
    merged.analysisPatterns.push(t);
    slots--;
  }
  for (const t of d) {
    if (slots <= 0) break;
    merged.disputeExamples.push(t);
    slots--;
  }
  if (!merged.violationTriggers?.some((x) => x != null && String(x).trim() !== "")) {
    delete merged.violationTriggers;
  }
  return merged;
}

/**
 * Dispute-time retrieval composition (escalation-aware tier-1 rules).
 * Omit this when calling `retrieveKnowledge` from analysis-only flows so tier-1 bias follows the lighter analysis threshold (confidence below 0.6).
 */
export type RetrievalCompositionOptions = {
  /** From `determineEscalationLevel` (e.g. generate-dispute-letters); combined with `triggerConfidence` for `shouldForceTier1`. */
  escalationLevel?: number;
};

/** After merge: low certainty → cap dispute examples, fill with violation + analysis first. */
function applyLowConfidenceComposition(
  retrieved: RetrievedKnowledge,
  caseState: CaseStateForRetrieval,
  totalMax: number,
  composition?: RetrievalCompositionOptions,
): RetrievedKnowledge {
  const c = caseState.triggerConfidence;
  const flags = caseState.warningFlags ?? [];
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  const perf = getTriggerPerformancePrior(primary);
  const perfExpansionApplies = c != null && c >= 0.6;
  const broadMode = !shouldUseTriggerStrictFilter(caseState);
  const broadExampleCap = c != null && c < 0.5 ? 1 : 2;
  const prioritizeLogic = (c != null && c < 0.5) ||
    flags.includes("low_confidence") ||
    flags.includes("weak_evidence") ||
    (perfExpansionApplies && perf < 0.5);
  if (!prioritizeLogic) {
    if (!broadMode) return retrieved;
    let r = retrieved;
    if (r.disputeExamples.length > broadExampleCap) {
      r = { ...r, disputeExamples: r.disputeExamples.slice(0, broadExampleCap) };
    }
    return reorderWithMinViolations(r, totalMax, {
      escalationLevel: composition?.escalationLevel,
      triggerConfidence: caseState.triggerConfidence,
      analysisOnlyTier1Bias: composition === undefined,
    });
  }

  let maxExamples = perfExpansionApplies && perf < 0.5 ? 1 : 2;
  if (broadMode) maxExamples = Math.min(maxExamples, broadExampleCap);
  const d = retrieved.disputeExamples.slice(0, maxExamples);
  const v = [...retrieved.violationLogic];
  const p = [...retrieved.analysisPatterns];
  return reorderWithMinViolations(
    { violationLogic: v, analysisPatterns: p, disputeExamples: d },
    totalMax,
    {
      escalationLevel: composition?.escalationLevel,
      triggerConfidence: caseState.triggerConfidence,
      analysisOnlyTier1Bias: composition === undefined,
    },
  );
}

function buildRetrievalNegativeFilter(caseState: CaseStateForRetrieval): RetrievalNegativeFilter | undefined {
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  const minSimilarity = getSimilarityThresholdForPrimary(primary);

  if (!shouldUseTriggerStrictFilter(caseState)) {
    return { minSimilarity };
  }

  const allow = [
    caseState.primaryTrigger,
    caseState.trigger,
    ...(caseState.secondaryTriggers ?? []),
  ].filter(Boolean) as string[];
  if (!allow.length) return { minSimilarity };
  return { triggerAllowlist: allow, minSimilarity };
}

/** Primary + secondary first, then remaining (better embedding match for focused dispute). */
function orderedTriggerTermsForQuery(caseState: CaseStateForRetrieval): string[] {
  const full = caseState.triggers?.length
    ? caseState.triggers
    : caseState.trigger
    ? [caseState.trigger]
    : [];
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  const sec = caseState.secondaryTriggers ?? [];
  const out: string[] = [];
  if (primary) out.push(primary);
  for (const s of sec) {
    if (s && s !== primary && !out.includes(s)) out.push(s);
  }
  for (const t of full) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Legal anchor phrases to tighten embedding / keyword retrieval (deterministic). */
const PRIMARY_LEGAL_ANCHORS: Record<string, string> = {
  reinserted_account: "FCRA 611 reinsertion notice",
  identity_theft_account_present: "FCRA 605B identity theft blocking",
  unauthorized_inquiry: "FCRA 604 permissible purpose",
  duplicate_collection: "FCRA 623 furnisher direct dispute",
  inconsistent_status: "FCRA 611 maximum possible accuracy",
  late_payment: "FCRA 611 accuracy completeness",
  missing_credit_report: "FCRA file disclosure access",
};

function buildQueryText(intent: RetrieveKnowledgeIntent, caseState: CaseStateForRetrieval): string {
  const parts = [intent.intentLabel];
  if (caseState.case_type) parts.push(caseState.case_type.replace(/_/g, " "));
  const ordered = orderedTriggerTermsForQuery(caseState);
  for (let i = 0; i < ordered.length; i++) {
    const tr = ordered[i];
    parts.push(tr.replace(/_/g, " "));
    if (i === 0 && PRIMARY_LEGAL_ANCHORS[tr]) {
      parts.push(PRIMARY_LEGAL_ANCHORS[tr]);
    }
  }
  if (intent.task === "response_analysis") parts.push("bureau response rebuttal method of verification");
  if (intent.task === "dispute_generation") parts.push("FCRA dispute letter");
  if (intent.task === "credit_analysis") parts.push("credit strategy negative items");
  return parts.filter(Boolean).join(" ").slice(0, 4000);
}

/**
 * Calls public.match_credit_knowledge RPC. Safe if RPC missing — returns empty.
 */
export async function retrieveKnowledgeFromRpc(
  supabase: SupabaseClient,
  args: {
    intent: RetrieveKnowledgeIntent;
    caseState: CaseStateForRetrieval;
    matchCount?: number;
  },
): Promise<RetrievedKnowledge> {
  if (Deno.env.get("CREDIT_RPC_RETRIEVAL_DISABLED") === "1") {
    return { disputeExamples: [], analysisPatterns: [], violationLogic: [] };
  }

  const match_count = Math.min(Math.max(args.matchCount ?? computeRpcMatchCount(args.caseState), 5), 8);
  const query_text = buildQueryText(args.intent, args.caseState);

  const payload: Record<string, unknown> = {
    query_text,
    match_count,
  };
  if (args.caseState.case_type) payload.filter_case_type = args.caseState.case_type;
  if (shouldUseTriggerStrictFilter(args.caseState)) {
    const filterTrigger =
      args.caseState.primaryTrigger ??
      args.caseState.trigger ??
      selectPrimaryTrigger(
        args.caseState.triggers ?? [],
        args.caseState.triggerEvidence,
      ).primaryTrigger;
    if (filterTrigger) payload.filter_trigger = filterTrigger;
  }

  const broad = !shouldUseTriggerStrictFilter(args.caseState);
  const primaryForRank =
    args.caseState.primaryTrigger ??
    args.caseState.trigger ??
    selectPrimaryTrigger(
      args.caseState.triggers ?? [],
      args.caseState.triggerEvidence,
    ).primaryTrigger;

  try {
    const { data, error } = await supabase.rpc("match_credit_knowledge", payload);
    if (error) {
      console.error("[retrieveKnowledgeFromRpc]", error.message);
      return { disputeExamples: [], analysisPatterns: [], violationLogic: [] };
    }
    return rpcRowsToRetrieved(
      data as RpcRow[],
      match_count,
      args.caseState.case_type,
      buildRetrievalNegativeFilter(args.caseState),
      broad,
      primaryForRank,
    );
  } catch (e) {
    console.error("[retrieveKnowledgeFromRpc]", e);
    return { disputeExamples: [], analysisPatterns: [], violationLogic: [] };
  }
}

function firstRpcRowContentIgnoringSimilarity(rows: RpcRow[] | null): string | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const c = String(row.content ?? "").trim();
    if (c) return c;
  }
  return null;
}

/**
 * Secondary anchor attempt: targeted RPC row(s) for violation_logic + primary trigger — no similarity cut on rows.
 * Falls back to a second payload without `filter_type` if the RPC omits that parameter.
 */
async function fetchKbViolationAnchorLine(
  supabase: SupabaseClient,
  primaryTrigger: string,
  caseState: CaseStateForRetrieval,
  intent: RetrieveKnowledgeIntent,
): Promise<string | null> {
  if (Deno.env.get("CREDIT_RPC_RETRIEVAL_DISABLED") === "1") return null;
  const query_text = buildQueryText(intent, caseState);
  const variants: Record<string, unknown>[] = [
    { filter_type: "violation_logic", filter_trigger: primaryTrigger },
    { filter_trigger: primaryTrigger },
  ];
  for (const extra of variants) {
    const payload: Record<string, unknown> = {
      query_text,
      match_count: 1,
      ...extra,
    };
    if (caseState.case_type) payload.filter_case_type = caseState.case_type;
    try {
      const { data, error } = await supabase.rpc("match_credit_knowledge", payload);
      if (error) continue;
      const line = firstRpcRowContentIgnoringSimilarity(data as RpcRow[] | null);
      if (line) return line;
    } catch {
      continue;
    }
  }
  return null;
}

const ANCHOR_FETCH_TIMEOUT_MS = 120;
/** Per-primary soft suppression: avoids redundant anchor KB RPCs without starving other triggers. */
const lastAnchorKbFetchTsByTrigger: Record<string, number> = {};
/** Last successful KB anchor per primary (used when throttle skips a fetch). */
const lastKbAnchorByTrigger: Record<string, { line: string; ts: number }> = {};
export const KB_ANCHOR_TTL_MS = 5 * 60 * 1000;
const ANCHOR_KB_FETCH_THROTTLE_MS = 250;

/** Clears per-trigger KB anchor cache + throttle timestamps (unit tests only). */
export function resetKbAnchorCachesForTest(): void {
  for (const k of Object.keys(lastKbAnchorByTrigger)) delete lastKbAnchorByTrigger[k];
  for (const k of Object.keys(lastAnchorKbFetchTsByTrigger)) delete lastAnchorKbFetchTsByTrigger[k];
}

/** Current cache timestamp for a primary (unit tests only). */
export function getKbAnchorEntryTsForTest(primary: string): number | undefined {
  return lastKbAnchorByTrigger[primary]?.ts;
}

/** Seed a cache entry with `ageMs` elapsed since `ts` (unit tests only). */
export function seedKbAnchorCacheForTest(primary: string, line: string, ageMs: number): void {
  lastKbAnchorByTrigger[primary] = { line, ts: Date.now() - ageMs };
}

/** Exported for tests and TTL diagnostics; refreshes `ts` on successful read (touch-on-read). */
export function getCachedAnchor(primary: string | undefined): string | null {
  if (!primary) return null;
  const entry = lastKbAnchorByTrigger[primary];
  if (!entry) return null;
  if (Date.now() - entry.ts > KB_ANCHOR_TTL_MS) {
    delete lastKbAnchorByTrigger[primary];
    return null;
  }
  entry.ts = Date.now();
  return entry.line;
}

function canFetchAnchorKb(primary: string | undefined): boolean {
  if (!primary) return true;
  const last = lastAnchorKbFetchTsByTrigger[primary] ?? 0;
  return Date.now() - last >= ANCHOR_KB_FETCH_THROTTLE_MS;
}

function markAnchorKbFetch(primary: string | undefined): void {
  if (primary) lastAnchorKbFetchTsByTrigger[primary] = Date.now();
}

/**
 * Broad retrieval: prefer one KB violation line for the primary trigger, then `[System legal spine]` fallback.
 * Anchor RPC is time-bounded so tail latency stays predictable under load.
 */
export async function ensureBroadModePrimaryAnchor(
  supabase: SupabaseClient,
  retrieved: RetrievedKnowledge,
  caseState: CaseStateForRetrieval,
  cap: number,
  intent: RetrieveKnowledgeIntent,
): Promise<RetrievedKnowledge> {
  if (shouldUseTriggerStrictFilter(caseState)) return retrieved;
  const primary = caseState.primaryTrigger ?? caseState.trigger;
  if (!primary) return retrieved;
  if (alreadyHasPrimaryAnchor(retrieved, primary)) return retrieved;

  let kbLine: string | null = null;
  if (!canFetchAnchorKb(primary)) {
    const cached = getCachedAnchor(primary);
    if (cached && !lineAlreadyPresentInRetrieved(cached, retrieved)) {
      const next: RetrievedKnowledge = {
        ...retrieved,
        violationLogic: [cached, ...retrieved.violationLogic],
      };
      return trimRetrievedToCap(next, cap);
    }
    kbLine = null;
  } else {
    markAnchorKbFetch(primary);
    kbLine = await Promise.race([
      fetchKbViolationAnchorLine(supabase, primary, caseState, intent),
      new Promise<string | null>((resolve) =>
        setTimeout(() => resolve(null), ANCHOR_FETCH_TIMEOUT_MS)
      ),
    ]);
    const trimmed = kbLine?.trim();
    if (trimmed) lastKbAnchorByTrigger[primary] = { line: trimmed, ts: Date.now() };
  }

  let anchor: string | null = null;
  if (kbLine && !lineAlreadyPresentInRetrieved(kbLine, retrieved)) {
    anchor = kbLine;
  }
  if (!anchor) {
    const spine = getSystemAnchorViolationLine(primary);
    if (!lineAlreadyPresentInRetrieved(spine, retrieved)) anchor = spine;
  }
  if (!anchor) return retrieved;

  const next: RetrievedKnowledge = {
    ...retrieved,
    violationLogic: [anchor, ...retrieved.violationLogic],
  };
  return trimRetrievedToCap(next, cap);
}

/**
 * Primary integration: RPC match_credit_knowledge, then HTTP/inline fallback; merged and capped (max 8 items).
 * `mergeQuery` supplies task + summaries for the optional CREDIT_RETRIEVAL_URL path.
 *
 * **`composition`:** Pass `{ escalationLevel }` from dispute generation so tier-1 forcing uses escalation + the full confidence gate (below 0.7).
 * Omit for analysis-only callers (e.g. analyze-credit-strategy): tier-1 bias uses the lighter analysis rule (confidence below 0.6, or null confidence).
 */
export async function retrieveKnowledge(
  supabase: SupabaseClient,
  caseState: CaseStateForRetrieval,
  intent: RetrieveKnowledgeIntent,
  mergeQuery: RetrievalQuery,
  composition?: RetrievalCompositionOptions,
): Promise<RetrievedKnowledge> {
  const cap = Math.min(Math.max(mergeQuery.maxItems ?? 8, 5), 10);
  const fromRpc = await retrieveKnowledgeFromRpc(supabase, {
    intent,
    caseState,
    matchCount: computeRpcMatchCount(caseState),
  });
  const fromRemote = await retrieveRelevantKnowledge({ ...mergeQuery, maxItems: cap });
  let merged = mergeRetrievedCapped(fromRpc, fromRemote, cap);
  merged = applyLowConfidenceComposition(merged, caseState, cap, composition);
  /** Anchor is applied by dispute (and analysis) callers after fail-safe gate — gate uses pre-anchor retrieval. */
  return merged;
}
