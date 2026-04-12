/**
 * Fail-safe before dispute letter assembly: block when evidence + retrieval are too thin.
 */

import type { CaseStateForRetrieval } from "./creditKnowledgeRetrieval.ts";
import type { RetrievedKnowledge } from "./retrieveRelevantKnowledge.ts";

/** Structured follow-up when generation is blocked (client / UI can drive onboarding). */
export const INSUFFICIENT_DATA_NEXT_ACTION = "request_additional_documents" as const;

export const INSUFFICIENT_DATA_RECOMMENDED_INPUTS: readonly string[] = [
  "latest credit report (all bureaus)",
  "identity theft affidavit (if applicable)",
  "billing statements or account records",
];

export type InsufficientDataRouting = {
  next_action: string;
  recommended_inputs: readonly string[];
};

/** Contextual routing when generation is blocked — improves UX without new schemas. */
export function nextActionFor(primary?: string | null): InsufficientDataRouting {
  if (primary === "identity_theft_account_present") {
    return {
      next_action: "request_identity_theft_docs",
      recommended_inputs: [
        "FTC Identity Theft Report",
        "government ID",
        "proof of address",
      ],
    };
  }
  if (primary === "unauthorized_inquiry") {
    return {
      next_action: "request_permissible_purpose_proof",
      recommended_inputs: [
        "application records",
        "credit pull authorization logs",
      ],
    };
  }
  return {
    next_action: INSUFFICIENT_DATA_NEXT_ACTION,
    recommended_inputs: INSUFFICIENT_DATA_RECOMMENDED_INPUTS,
  };
}

/** Non-system violation_logic lines that look legally substantive (KB or similar). */
export function hasStrongViolationLogic(retrieved: RetrievedKnowledge): boolean {
  for (const line of retrieved.violationLogic) {
    if (line.includes("[System legal spine]")) continue;
    const t = line.trim();
    if (t.length < 45) continue;
    if (
      /\b(FCRA|Fair Credit|15\s*U\.S\.C\.|U\.S\.C\.|§\s*61[01]|reinvestigation|method\s+of\s+verification|maximum\s+possible\s+accuracy)/i
        .test(t)
    ) {
      return true;
    }
  }
  return false;
}

function hasWeakEvidenceSignal(caseState: CaseStateForRetrieval): boolean {
  if (caseState.triggerEvidence?.weakEvidenceOnly) return true;
  const flags = caseState.warningFlags ?? [];
  return flags.includes("weak_evidence");
}

/**
 * Stop full letter generation when confidence is low, evidence is weak, and KB gave no strong violations.
 */
export function shouldBlockDisputeGeneration(
  caseState: CaseStateForRetrieval,
  retrieved: RetrievedKnowledge,
): boolean {
  const c = caseState.triggerConfidence;
  if (c == null || c >= 0.5) return false;
  if (!hasWeakEvidenceSignal(caseState)) return false;
  if (hasStrongViolationLogic(retrieved)) return false;
  return true;
}
