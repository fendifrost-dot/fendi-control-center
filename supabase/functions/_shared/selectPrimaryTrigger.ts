/**
 * Picks one primary trigger for retrieval filter and dispute focus; optional secondary (max 2).
 * Override: reinsertion > identity theft > rest. Secondaries are compatibility-filtered.
 * (Future: optional retrieval bias from measured per-trigger success rates — needs analytics.)
 */

export const PRIMARY_TRIGGER_SELECTION_ORDER = [
  "reinserted_account",
  "identity_theft_account_present",
  "unauthorized_inquiry",
  "duplicate_collection",
  "inconsistent_status",
  "late_payment",
] as const;

/** Optional evidence context from case JSON (multi-source → higher confidence). */
export interface TriggerEvidenceContext {
  /** Distinct sources: observations, snapshots, structured fields (min 1). */
  sourceCount?: number;
  /** Independent detected triggers / signals. */
  supportingSignalCount?: number;
  /** Single weak path (e.g. blob-only, no observations). */
  weakEvidenceOnly?: boolean;
}

export interface PrimaryTriggerSelection {
  primaryTrigger: string | null;
  secondaryTriggers: string[];
  /** Human-readable, deterministic rationale for audits / UI. */
  triggerReasoning: string;
  /** Heuristic 0–1 (deterministic; weighted by evidence when context provided). */
  triggerConfidence: number;
}

const ORDER_SET = new Set<string>(PRIMARY_TRIGGER_SELECTION_ORDER);

/** Secondary must not contradict the primary legal theory. */
export function secondaryCompatibleWithPrimary(primary: string, candidate: string): boolean {
  if (candidate === primary) return false;
  if (primary === "identity_theft_account_present") {
    return candidate !== "late_payment" && candidate !== "inconsistent_status";
  }
  if (primary === "reinserted_account") {
    return candidate !== "late_payment" && candidate !== "inconsistent_status";
  }
  return true;
}

function pickPrimaryWithReason(normalized: string[]): {
  primary: string | null;
  reasoning: string;
} {
  if (!normalized.length) {
    return { primary: null, reasoning: "No triggers in input." };
  }

  if (normalized.includes("reinserted_account")) {
    return {
      primary: "reinserted_account",
      reasoning:
        "Primary is reinserted_account: highest-priority when present (reinsertion / prior deletion and reappearance).",
    };
  }

  if (normalized.includes("identity_theft_account_present")) {
    return {
      primary: "identity_theft_account_present",
      reasoning:
        "Primary is identity_theft_account_present: mandatory override over weaker signals when reinsertion is not present (fraud / blocking theory).",
    };
  }

  for (const id of PRIMARY_TRIGGER_SELECTION_ORDER) {
    if (normalized.includes(id)) {
      return {
        primary: id,
        reasoning: `Primary selected by priority order: ${id} (first matching standard trigger).`,
      };
    }
  }

  const fallback = normalized[0];
  return {
    primary: fallback,
    reasoning:
      `Fallback primary: ${fallback} (no match in standard priority list; using first remaining id).`,
  };
}

function confidenceScore(
  primary: string | null,
  normalized: string[],
  usedFallbackPrimary: boolean,
  evidence?: TriggerEvidenceContext,
): number {
  if (!primary) return 0;
  let c = 0.7;
  if (primary === "reinserted_account" || primary === "identity_theft_account_present") {
    c = 0.88;
  } else {
    c = 0.82;
  }
  if (usedFallbackPrimary) {
    c = Math.min(c, 0.74);
  }
  if (normalized.length > 4) c = Math.max(0.5, c - 0.06);
  if (normalized.length >= 2 && normalized.length <= 3) c = Math.min(0.96, c + 0.06);

  if (evidence?.sourceCount != null) {
    if (evidence.sourceCount >= 2) c += 0.08;
    if (evidence.sourceCount >= 3) c += 0.05;
  }
  const sig = evidence?.supportingSignalCount ?? normalized.length;
  if (sig > 1) {
    c += Math.min(0.12, (sig - 1) * 0.05);
  }
  if (evidence?.weakEvidenceOnly) {
    c -= 0.2;
  }

  c = Math.min(0.95, Math.max(0.45, c));
  return Math.round(c * 100) / 100;
}

/**
 * Select primary + secondary triggers from a detected list.
 * - Primary: reinserted > identity (override) > priority list > first unknown.
 * - Secondary: up to 2 other ids in priority order, excluding incompatible pairs.
 * @param evidence Optional multi-source weighting for `triggerConfidence`.
 */
export function selectPrimaryTrigger(
  triggers: string[],
  evidence?: TriggerEvidenceContext,
): PrimaryTriggerSelection {
  const normalized = [...new Set(triggers.map((t) => String(t).trim()).filter(Boolean))];
  if (!normalized.length) {
    return {
      primaryTrigger: null,
      secondaryTriggers: [],
      triggerReasoning: "No triggers detected.",
      triggerConfidence: 0,
    };
  }

  const { primary, reasoning: primaryReason } = pickPrimaryWithReason(normalized);
  const usedFallbackPrimary = Boolean(primary && !ORDER_SET.has(primary));

  const secondary: string[] = [];
  if (primary) {
    for (const id of PRIMARY_TRIGGER_SELECTION_ORDER) {
      if (id === primary) continue;
      if (!normalized.includes(id)) continue;
      if (!secondaryCompatibleWithPrimary(primary, id)) continue;
      secondary.push(id);
      if (secondary.length >= 2) break;
    }
    for (const id of normalized) {
      if (secondary.length >= 2) break;
      if (id === primary || secondary.includes(id)) continue;
      if (ORDER_SET.has(id)) continue;
      if (!secondaryCompatibleWithPrimary(primary, id)) continue;
      secondary.push(id);
    }
  }

  let triggerReasoning = primaryReason;
  if (evidence?.sourceCount != null || evidence?.weakEvidenceOnly) {
    triggerReasoning += ` Evidence: sources≈${evidence.sourceCount ?? "?"}, weakOnly=${Boolean(evidence.weakEvidenceOnly)}.`;
  }
  if (secondary.length) {
    triggerReasoning += ` Secondary (compatible, max 2): ${secondary.join(", ")}.`;
  } else {
    triggerReasoning += " No compatible secondary triggers.";
  }

  const ev: TriggerEvidenceContext | undefined = evidence
    ? {
      ...evidence,
      supportingSignalCount: evidence.supportingSignalCount ?? normalized.length,
    }
    : undefined;

  const triggerConfidence = confidenceScore(primary, normalized, usedFallbackPrimary, ev);

  return {
    primaryTrigger: primary,
    secondaryTriggers: secondary,
    triggerReasoning,
    triggerConfidence,
  };
}
