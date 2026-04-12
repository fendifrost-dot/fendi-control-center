/**
 * Retrieval-based knowledge for credit AI (orchestration only — no DB schema).
 *
 * Default: returns empty (failsafe). Optional:
 * - CREDIT_RETRIEVAL_URL — POST JSON body { task, intentSummary, caseStateSummary, maxItems } → JSON matching RetrievedKnowledge shape
 * - CREDIT_RETRIEVAL_INLINE_JSON — dev-only inline JSON for tests (no DB)
 */

export type CreditRetrievalTask = "credit_analysis" | "dispute_generation" | "response_analysis";

export interface RetrievalQuery {
  task: CreditRetrievalTask;
  /** Short query string from caseState + intent (deterministic, no randomness). */
  intentSummary: string;
  /** Optional compact case summary for the retriever. */
  caseStateSummary?: string;
  /** Capped 5–10 at call site. */
  maxItems?: number;
}

export interface RetrievedKnowledge {
  disputeExamples: string[];
  analysisPatterns: string[];
  violationLogic: string[];
}

const MAX_CAP = 10;

function empty(): RetrievedKnowledge {
  return { disputeExamples: [], analysisPatterns: [], violationLogic: [] };
}

function clampArrays(k: Partial<RetrievedKnowledge>, maxPerArray: number): RetrievedKnowledge {
  const take = (arr: unknown, n: number): string[] =>
    Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean).slice(0, n) : [];
  return {
    disputeExamples: take(k.disputeExamples, maxPerArray),
    analysisPatterns: take(k.analysisPatterns, maxPerArray),
    violationLogic: take(k.violationLogic, maxPerArray),
  };
}

function normalizePayload(j: Record<string, unknown>, maxItems: number): RetrievedKnowledge {
  const per = Math.min(Math.max(maxItems, 1), MAX_CAP);
  const n = Math.ceil(per / 3) + 3;
  return clampArrays(
    {
      disputeExamples: j.disputeExamples ?? j.dispute_examples,
      analysisPatterns: j.analysisPatterns ?? j.analysis_patterns,
      violationLogic: j.violationLogic ?? j.violation_logic,
    },
    n,
  );
}

/**
 * Retrieves prior-case patterns for injection into credit AI prompts.
 * Empty result is normal — callers proceed with base rules only.
 */
export async function retrieveRelevantKnowledge(input: RetrievalQuery): Promise<RetrievedKnowledge> {
  const maxItems = Math.min(Math.max(input.maxItems ?? 8, 5), MAX_CAP);

  const url = Deno.env.get("CREDIT_RETRIEVAL_URL")?.trim();
  if (url) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: input.task,
          intentSummary: input.intentSummary,
          caseStateSummary: input.caseStateSummary ?? null,
          maxItems,
        }),
      });
      if (resp.ok) {
        const j = await resp.json();
        if (j && typeof j === "object") return normalizePayload(j as Record<string, unknown>, maxItems);
      } else {
        console.error("[retrieveRelevantKnowledge] HTTP", resp.status, await resp.text().catch(() => ""));
      }
    } catch (e) {
      console.error("[retrieveRelevantKnowledge]", e);
    }
  }

  const inline = Deno.env.get("CREDIT_RETRIEVAL_INLINE_JSON")?.trim();
  if (inline) {
    try {
      const j = JSON.parse(inline) as Record<string, unknown>;
      return normalizePayload(j, maxItems);
    } catch (e) {
      console.error("[retrieveRelevantKnowledge] CREDIT_RETRIEVAL_INLINE_JSON parse error", e);
    }
  }

  return empty();
}
