/**
 * Cross-layer sanity check: structural output vs primary trigger + escalation + confidence.
 */

import { secondaryCompatibleWithPrimary } from "./selectPrimaryTrigger.ts";
import type { TriggerEvidenceContext } from "./selectPrimaryTrigger.ts";

export type StrategyWarningCode =
  | "low_confidence"
  | "weak_evidence"
  | "trigger_conflict"
  | "strategic_mismatch";

export interface DisputeStrategyValidation {
  ok: boolean;
  warnings: string[];
  /** Machine-readable codes for `assembleDispute` behavior. */
  warningCodes: StrategyWarningCode[];
}

export function validateDisputeStrategy(opts: {
  primaryTrigger: string | null;
  escalationLevel: number;
  secondaryTriggers: string[];
  triggerConfidence?: number;
  triggerEvidence?: TriggerEvidenceContext;
}): DisputeStrategyValidation {
  const warnings: string[] = [];
  const warningCodes: StrategyWarningCode[] = [];
  const {
    primaryTrigger,
    escalationLevel,
    secondaryTriggers,
    triggerConfidence,
    triggerEvidence,
  } = opts;

  if (triggerConfidence != null && triggerConfidence < 0.5) {
    warnings.push(
      "Low-confidence trigger detection — verify inputs before proceeding.",
    );
    warningCodes.push("low_confidence");
  }

  if (triggerEvidence?.weakEvidenceOnly) {
    warnings.push("Weak evidence: single thin signal path — confirm with additional documents if possible.");
    warningCodes.push("weak_evidence");
  }

  if (primaryTrigger) {
    for (const s of secondaryTriggers) {
      if (!secondaryCompatibleWithPrimary(primaryTrigger, s)) {
        warnings.push(`Trigger conflict: secondary "${s}" is incompatible with primary "${primaryTrigger}".`);
        warningCodes.push("trigger_conflict");
        break;
      }
    }
  }

  if (!primaryTrigger && escalationLevel >= 3) {
    warnings.push("Escalation is elevated but no primary trigger is set — review case data.");
    warningCodes.push("strategic_mismatch");
  }

  if (primaryTrigger === "late_payment" && escalationLevel >= 4) {
    warnings.push("Pre-litigation escalation with late_payment as sole primary may be strategically weak — confirm facts.");
    warningCodes.push("strategic_mismatch");
  }

  if (escalationLevel >= 4 && secondaryTriggers.length === 0 && primaryTrigger === "missing_credit_report") {
    warnings.push("Pre-litigation with missing_credit_report only — verify bureau access facts before send.");
    warningCodes.push("strategic_mismatch");
  }

  if (escalationLevel <= 1 && secondaryTriggers.length > 2) {
    warnings.push("Many secondaries with low escalation — ensure retrieval focus matches intent.");
    warningCodes.push("strategic_mismatch");
  }

  return { ok: warningCodes.length === 0, warnings, warningCodes };
}
