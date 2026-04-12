/**
 * Deterministic dispute escalation from dispute_history, snapshots, dispute_outcomes, and explicit flags.
 * Does not infer beyond structured fields (conservative defaults).
 */

import { detectCreditTriggers } from "./detectCreditTriggers.ts";

export type EscalationLevel = 1 | 2 | 3 | 4;
export type EscalationStrategy = "initial" | "reinvestigation" | "non_compliance" | "pre_litigation";

export interface EscalationCaseState {
  dispute_history?: unknown[];
  snapshots?: unknown[];
  dispute_outcomes?: unknown[];
  /** From extractCaseState / detectCreditTriggers (optional). */
  triggers?: string[];
  /** Explicit: cycles without resolution (if upstream tracks). */
  failed_dispute_cycles?: number;
  /** Explicit: MOV / verification requested without adequate response. */
  verification_without_evidence_count?: number;
  /** Explicit: reporting violations continue after disputes. */
  continued_violations?: boolean;
}

export interface EscalationResult {
  level: EscalationLevel;
  strategy: EscalationStrategy;
}

export function strategyForLevel(level: EscalationLevel): EscalationStrategy {
  switch (level) {
    case 4:
      return "pre_litigation";
    case 3:
      return "non_compliance";
    case 2:
      return "reinvestigation";
    default:
      return "initial";
  }
}

/**
 * When trigger confidence is low, avoid strongest legal posture (downgrade one notch if ≥3).
 */
export function applyEscalationConfidenceGate(
  result: EscalationResult,
  triggerConfidence: number | undefined,
): EscalationResult {
  if (triggerConfidence == null || triggerConfidence >= 0.55) return result;
  if (result.level >= 3) {
    const nl = (result.level - 1) as EscalationLevel;
    return { level: nl, strategy: strategyForLevel(nl) };
  }
  return result;
}

/**
 * Prior runs persisted `low_confidence` / `weak_evidence` on case_state → keep posture conservative.
 */
export function applyPersistedUncertaintyEscalationBias(
  result: EscalationResult,
  warningFlags: string[] | undefined,
): EscalationResult {
  const flags = warningFlags ?? [];
  if (!flags.includes("low_confidence") && !flags.includes("weak_evidence")) return result;
  if (result.level >= 3) {
    const nl = (result.level - 1) as EscalationLevel;
    return { level: nl, strategy: strategyForLevel(nl) };
  }
  return result;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function truthy(x: unknown): boolean {
  if (x === true) return true;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  return false;
}

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function hasPriorDisputes(state: EscalationCaseState): boolean {
  const h = state.dispute_history;
  return Array.isArray(h) && h.length > 0;
}

/** Outcomes that indicate the bureau did not delete/modify as requested. */
function outcomeMeansNoMaterialChange(o: Record<string, unknown>): boolean {
  const r = String(o.outcome ?? o.status ?? o.result ?? o.disposition ?? "").trim().toLowerCase();
  if (
    r === "no_change" || r === "no change" || r === "unchanged" || r === "verified_as_accurate" ||
    r === "verified" || r === "frivolous" || r === "not_deleted"
  ) {
    return true;
  }
  if (truthy(o.no_change) || truthy(o.unchanged)) return true;
  return false;
}

/** Count outcomes indicating no material deletion/correction (proxy for failed dispute cycles). */
function countNoChangeOutcomes(state: EscalationCaseState): number {
  const o = state.dispute_outcomes;
  if (!Array.isArray(o)) return 0;
  return o.filter((x) => isRecord(x) && outcomeMeansNoMaterialChange(x)).length;
}

function countFailedCycles(state: EscalationCaseState): number {
  const n = num(state.failed_dispute_cycles);
  if (n !== null && n >= 0) return n;
  return countNoChangeOutcomes(state);
}

function hasContinuedViolations(state: EscalationCaseState): boolean {
  if (state.continued_violations === true) return true;
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes)) return false;
  return outcomes.some((x) =>
    isRecord(x) &&
    (truthy(x.continued_violation) || truthy(x.violation_continues) || truthy(x.continued_noncompliance))
  );
}

/** Bureau treated as verified / accurate but MOV inadequate or absent. */
function outcomeVerifiedWithoutAdequateMov(o: Record<string, unknown>): boolean {
  if (truthy(o.verified_without_evidence)) return true;
  const r = String(o.outcome ?? o.status ?? o.result ?? "").trim().toLowerCase();
  const looksVerified =
    r.includes("verified") || r.includes("accurate") || truthy(o.verified_as_accurate);
  const movBad = truthy(o.mov_not_provided) || truthy(o.method_of_verification_inadequate) ||
    truthy(o.no_method_of_verification);
  return looksVerified && movBad;
}

function hasVerifiedWithoutEvidenceOutcome(state: EscalationCaseState): boolean {
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes)) return false;
  return outcomes.some((x) => isRecord(x) && outcomeVerifiedWithoutAdequateMov(x));
}

/** No substantive bureau letter / response recorded. */
function outcomeAppearsNoResponse(o: Record<string, unknown>): boolean {
  const r = String(o.outcome ?? o.status ?? o.result ?? "").trim().toLowerCase();
  if (r.includes("no_response") || r.includes("no response") || r.includes("no_reply")) return true;
  if (truthy(o.no_bureau_response) || truthy(o.awaiting_response)) return true;
  return r === "pending" || r === "open";
}

function hasOnlyNoResponseOutcomes(state: EscalationCaseState): boolean {
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes) || outcomes.length === 0) return false;
  return outcomes.every((x) => isRecord(x) && outcomeAppearsNoResponse(x));
}

function outcomePartialDeletion(o: Record<string, unknown>): boolean {
  if (truthy(o.partial_deletion)) return true;
  const r = String(o.outcome ?? o.status ?? "").toLowerCase();
  return r.includes("partial") && (r.includes("delet") || r.includes("remov"));
}

function hasPartialDeletionOutcome(state: EscalationCaseState): boolean {
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes)) return false;
  return outcomes.some((x) => isRecord(x) && outcomePartialDeletion(x));
}

/** Bureau reported deletion, correction, or material improvement. */
function outcomePositiveProgress(o: Record<string, unknown>): boolean {
  if (truthy(o.deleted) || truthy(o.removed) || truthy(o.corrected) || truthy(o.positive_resolution)) {
    return true;
  }
  const r = String(o.outcome ?? o.status ?? o.result ?? "").trim().toLowerCase();
  if (r.includes("deleted") || r.includes("removed") || r.includes("corrected") || r.includes("updated")) {
    return true;
  }
  if (r.includes("partial") && (r.includes("favor") || r.includes("resolved"))) return true;
  return false;
}

function hasPositiveProgressOutcome(state: EscalationCaseState): boolean {
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes)) return false;
  return outcomes.some((x) => isRecord(x) && outcomePositiveProgress(x));
}

function repeatedVerificationWithoutEvidence(state: EscalationCaseState): boolean {
  const n = num(state.verification_without_evidence_count);
  if (n !== null && n >= 2) return true;
  const outcomes = state.dispute_outcomes;
  if (!Array.isArray(outcomes)) return false;
  let c = 0;
  for (const x of outcomes) {
    if (!isRecord(x)) continue;
    if (truthy(x.method_of_verification_inadequate) || truthy(x.mov_not_provided) ||
      truthy(x.verification_without_evidence)) {
      c++;
    }
  }
  return c >= 2;
}

function reinsertedDetected(state: EscalationCaseState): boolean {
  if (state.triggers?.includes("reinserted_account")) return true;
  const snap = state.snapshots;
  if (!Array.isArray(snap) || snap.length < 2) return false;
  const tr = detectCreditTriggers({ snapshots: snap }, undefined);
  return tr.includes("reinserted_account");
}

function isLevel4(state: EscalationCaseState): boolean {
  const cv = hasContinuedViolations(state);
  if (!cv) return false;
  const cycles = countFailedCycles(state);
  return cycles >= 2;
}

function isLevel3(state: EscalationCaseState): boolean {
  if (reinsertedDetected(state)) return true;
  if (repeatedVerificationWithoutEvidence(state)) return true;
  return false;
}

/**
 * Escalation order: 4 → 3 → 2 → 1.
 * Level 4: ≥2 failed cycles (explicit or derived from no-change outcomes) AND continued violations.
 * Level 3: reinserted account OR repeated verification without evidence.
 * Level 2: prior dispute_history present (follow-up / firm), unless already 3–4.
 * Level 1: first dispute (no history).
 */
function computeBaseEscalationLevel(caseState: EscalationCaseState): EscalationResult {
  if (isLevel4(caseState)) return { level: 4, strategy: "pre_litigation" };
  if (isLevel3(caseState)) return { level: 3, strategy: "non_compliance" };

  if (hasPriorDisputes(caseState) && hasVerifiedWithoutEvidenceOutcome(caseState)) {
    return { level: 3, strategy: "non_compliance" };
  }

  if (hasPriorDisputes(caseState)) {
    if (hasOnlyNoResponseOutcomes(caseState) && !hasVerifiedWithoutEvidenceOutcome(caseState)) {
      return { level: 2, strategy: "reinvestigation" };
    }
    if (hasPartialDeletionOutcome(caseState)) {
      return { level: 2, strategy: "reinvestigation" };
    }
    return { level: 2, strategy: "reinvestigation" };
  }

  return { level: 1, strategy: "initial" };
}

/**
 * De-escalation / hold: positive bureau progress → one step down; partial fix without new violations → cap follow-up tone.
 */
export function determineEscalationLevel(caseState: EscalationCaseState): EscalationResult {
  let result = computeBaseEscalationLevel(caseState);

  if (hasPositiveProgressOutcome(caseState) && result.level > 1) {
    const nl = (result.level - 1) as EscalationLevel;
    result = { level: nl, strategy: strategyForLevel(nl) };
  }

  if (
    hasPartialDeletionOutcome(caseState) &&
    !hasContinuedViolations(caseState) &&
    result.level >= 3
  ) {
    result = { level: 2, strategy: "reinvestigation" };
  }

  return result;
}

/**
 * Merge Credit Guardian `detail` with optional trigger list into escalation input.
 */
export function buildEscalationCaseState(
  detail: Record<string, unknown>,
  triggers: string[],
): EscalationCaseState {
  const cs =
    detail.caseState && typeof detail.caseState === "object" && !Array.isArray(detail.caseState)
      ? (detail.caseState as Record<string, unknown>)
      : undefined;

  const dispute_history = Array.isArray(detail.dispute_history)
    ? detail.dispute_history
    : Array.isArray(detail.disputes)
    ? detail.disputes
    : [];

  const dispute_outcomes = Array.isArray(detail.dispute_outcomes)
    ? detail.dispute_outcomes
    : Array.isArray(detail.outcomes)
    ? detail.outcomes
    : [];

  const snapshots = cs?.snapshots ?? cs?.report_snapshots ?? detail.snapshots ?? detail.report_snapshots;

  return {
    dispute_history,
    snapshots: Array.isArray(snapshots) ? snapshots : undefined,
    dispute_outcomes,
    triggers: triggers.length ? triggers : undefined,
    failed_dispute_cycles: num(cs?.failed_dispute_cycles) ?? undefined,
    verification_without_evidence_count: num(cs?.verification_without_evidence_count) ?? undefined,
    continued_violations: cs ? truthy(cs.continued_violations) : undefined,
  };
}
