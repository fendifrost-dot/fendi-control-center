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
  /**
   * Optional KB row `trigger` per `violationLogic[i]` (same length when present).
   * Strength ranking prefers this over text inference when set.
   */
  violationTriggers?: (string | undefined)[];
}

const MAX_CAP = 10;

export function emptyRetrievedKnowledge(): RetrievedKnowledge {
  return { disputeExamples: [], analysisPatterns: [], violationLogic: [], violationTriggers: undefined };
}

function empty(): RetrievedKnowledge {
  return emptyRetrievedKnowledge();
}

/** Merge two retrieval results; total items across all buckets capped at totalMax (default 8). */
export function mergeRetrievedCapped(
  a: RetrievedKnowledge,
  b: RetrievedKnowledge,
  totalMax = 8,
): RetrievedKnowledge {
  const flat: Array<{ k: "d" | "p" | "v"; c: string; vTrig?: string }> = [
    ...a.disputeExamples.map((c) => ({ k: "d" as const, c })),
    ...a.analysisPatterns.map((c) => ({ k: "p" as const, c })),
    ...a.violationLogic.map((c, i) => ({
      k: "v" as const,
      c,
      vTrig: a.violationTriggers?.[i],
    })),
    ...b.disputeExamples.map((c) => ({ k: "d" as const, c })),
    ...b.analysisPatterns.map((c) => ({ k: "p" as const, c })),
    ...b.violationLogic.map((c, i) => ({
      k: "v" as const,
      c,
      vTrig: b.violationTriggers?.[i],
    })),
  ].slice(0, totalMax);

  const out: RetrievedKnowledge = {
    disputeExamples: [],
    analysisPatterns: [],
    violationLogic: [],
    violationTriggers: [],
  };
  for (const x of flat) {
    if (x.k === "d") out.disputeExamples.push(x.c);
    else if (x.k === "p") out.analysisPatterns.push(x.c);
    else {
      out.violationLogic.push(x.c);
      out.violationTriggers!.push(x.vTrig);
    }
  }
  if (out.violationTriggers!.length === 0) delete out.violationTriggers;
  return out;
}

function clampArrays(k: Partial<RetrievedKnowledge>, maxPerArray: number): RetrievedKnowledge {
  const take = (arr: unknown, n: number): string[] =>
    Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean).slice(0, n) : [];
  const v = take(k.violationLogic, maxPerArray);
  const ext = k as Record<string, unknown>;
  const vtRaw = k.violationTriggers ?? ext.violation_triggers;
  const vt = Array.isArray(vtRaw)
    ? vtRaw.slice(0, v.length).map((x) => (x == null ? undefined : String(x)))
    : undefined;
  const out: RetrievedKnowledge = {
    disputeExamples: take(k.disputeExamples, maxPerArray),
    analysisPatterns: take(k.analysisPatterns, maxPerArray),
    violationLogic: v,
    violationTriggers: vt && vt.length === v.length ? vt : undefined,
  };
  if (!out.violationTriggers?.length) delete out.violationTriggers;
  return out;
}

function normalizePayload(j: Record<string, unknown>, maxItems: number): RetrievedKnowledge {
  const per = Math.min(Math.max(maxItems, 1), MAX_CAP);
  const n = Math.ceil(per / 3) + 3;
  return clampArrays(
    {
      disputeExamples: (j.disputeExamples ?? j.dispute_examples) as string[] | undefined,
      analysisPatterns: (j.analysisPatterns ?? j.analysis_patterns) as string[] | undefined,
      violationLogic: (j.violationLogic ?? j.violation_logic) as string[] | undefined,
      violationTriggers: (j.violationTriggers ?? j.violation_triggers) as (string | undefined)[] | undefined,
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
