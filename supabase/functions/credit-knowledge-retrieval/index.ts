import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * When set to `"1"`, **all** `match_credit_knowledge` RPC usage for credit KB is skipped:
 * - this edge function (embedding-based RPC), and
 * - `_shared/creditKnowledgeRetrieval.ts` (text RPC + anchor RPC).
 * Does **not** disable HTTP retrieval (`CREDIT_RETRIEVAL_URL` / inline) in the shared module.
 * @see docs/CREDIT_KB_RPC_RETRIEVAL_DISABLED.md
 */
function isCreditKbRpcRetrievalDisabled(): boolean {
  return Deno.env.get("CREDIT_RPC_RETRIEVAL_DISABLED") === "1";
}

const EMPTY_RETRIEVAL = {
  disputeExamples: [] as string[],
  analysisPatterns: [] as string[],
  violationLogic: [] as string[],
};

function jsonDisabledResponse(): Response {
  const body = {
    ...EMPTY_RETRIEVAL,
    credit_kb_rpc_retrieval_disabled: true,
    retrieval_disabled_reason: "CREDIT_RPC_RETRIEVAL_DISABLED=1 (no match_credit_knowledge RPC; embedding path skipped)",
  };
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Map RetrievalQuery.task → credit_knowledge_base.type */
const TASK_TYPE_MAP: Record<string, string[]> = {
  credit_analysis: ["analysis_pattern", "violation_logic"],
  dispute_generation: ["dispute_example", "violation_logic"],
  response_analysis: ["analysis_pattern", "dispute_example"],
};

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`OpenAI embedding error ${resp.status}: ${err}`);
  }
  const json = await resp.json();
  return json.data[0].embedding;
}

interface RetrievalRequest {
  task: string;
  intentSummary: string;
  caseStateSummary?: string;
  maxItems?: number;
}

interface KnowledgeRow {
  type: string;
  content: string;
  similarity: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (isCreditKbRpcRetrievalDisabled()) {
      console.log(
        JSON.stringify({
          ts: Date.now(),
          event: "credit_kb_rpc_retrieval_skipped",
          function: "credit-knowledge-retrieval",
          reason: "CREDIT_RPC_RETRIEVAL_DISABLED",
        }),
      );
      return jsonDisabledResponse();
    }

    const body: RetrievalRequest = await req.json();
    const { task, intentSummary, caseStateSummary, maxItems = 8 } = body;

    if (!intentSummary) {
      return new Response(JSON.stringify({ disputeExamples: [], analysisPatterns: [], violationLogic: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build query text from intent + case summary
    const queryText = [intentSummary, caseStateSummary].filter(Boolean).join(" ").slice(0, 4000);

    // Get embedding
    const embedding = await getEmbedding(queryText);

    // Determine which types to query based on task
    const types = TASK_TYPE_MAP[task] ?? ["dispute_example", "analysis_pattern", "violation_logic"];
    const perType = Math.ceil(Math.min(maxItems, 10) / types.length) + 2;

    // Query each relevant type in parallel
    const results = await Promise.all(
      types.map((t) =>
        supabase.rpc("match_credit_knowledge", {
          query_embedding: JSON.stringify(embedding),
          match_threshold: 0.4,
          match_count: perType,
          filter_type: t,
        })
      )
    );

    // Bucket results into the three arrays
    const disputeExamples: string[] = [];
    const analysisPatterns: string[] = [];
    const violationLogic: string[] = [];

    for (const { data, error } of results) {
      if (error) {
        console.error("[credit-knowledge-retrieval] RPC error:", error);
        continue;
      }
      for (const row of (data as KnowledgeRow[]) ?? []) {
        const bucket =
          row.type === "dispute_example" ? disputeExamples :
          row.type === "analysis_pattern" ? analysisPatterns :
          violationLogic;
        bucket.push(row.content);
      }
    }

    // Cap each array
    const cap = Math.ceil(Math.min(maxItems, 10) / 3) + 3;
    const response = {
      disputeExamples: disputeExamples.slice(0, cap),
      analysisPatterns: analysisPatterns.slice(0, cap),
      violationLogic: violationLogic.slice(0, cap),
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[credit-knowledge-retrieval] Error:", err);
    return new Response(JSON.stringify({ disputeExamples: [], analysisPatterns: [], violationLogic: [] }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
