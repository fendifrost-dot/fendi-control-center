import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import {
  ensureBroadModePrimaryAnchor,
  extractCaseStateFromDetailDocs,
  formatTriggersForRetrievalQuery,
  retrieveKnowledge,
} from "../_shared/creditKnowledgeRetrieval.ts";
import { assembleCreditAnalysisUserPrompt, buildRetrievalIntentSummary, inferRetrievalTaskFromDocs } from "../_shared/creditPromptComposer.ts";
import { cgDisplayName, resolveUnifiedClientFromName } from "../_shared/unifiedClientResolution.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `You are a credit repair analyst operating under FCRA, FDCPA, and CFPB guidelines.
SYSTEM RULES: follow FCRA/FDCPA; never fabricate facts. The user message is structured as: CLIENT STATE, optional RELEVANT KNOWLEDGE (typed prior-case snippets), client JSON, then TASK. Use RELEVANT KNOWLEDGE only when consistent with the client data; never invent facts.
Analyze the client's credit timeline events and generate a prioritized dispute strategy.

You MUST return valid JSON with exactly these top-level keys:

{
  "priority_disputes": [
    {
      "bureau": "Equifax|Experian|TransUnion",
      "account_name": "string",
      "violation_type": "string (e.g. FCRA §611, FDCPA §807)",
      "dispute_method": "string (e.g. online, certified mail, CFPB complaint)",
      "template_letter_type": "string (e.g. validation_demand, method_of_verification)",
      "confidence": 0.0
    }
  ],
  "bureau_strategies": {
    "Equifax": { "approach": "string", "items": [] },
    "Experian": { "approach": "string", "items": [] },
    "TransUnion": { "approach": "string", "items": [] }
  },
  "risk_flags": [
    { "flag": "string", "severity": "high|medium|low", "detail": "string" }
  ],
  "next_steps": [
    { "step": "string", "priority": 1, "timeline": "string" }
  ]
}

Rules:
- If no data is available for a key, return an empty array or object — never omit the key.
- For each dispute item, specify the bureau, account name, violation type, recommended dispute method, template letter type, and confidence score (0-1).
- Group strategies by bureau.
- Flag any patterns suggesting systemic violations.
- Return ONLY the JSON object, no markdown fences or extra text.`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    let clientId = (body.client_id ?? body.cg_client_id) as string | undefined;
    const clientName = body.client_name as string | undefined;

    if (!clientId && clientName) {
      const resolution = await resolveUnifiedClientFromName(clientName);
      if (resolution.needsVerification || !resolution.clientId) {
        return new Response(JSON.stringify({
          ok: false,
          needsVerification: true,
          message: resolution.message,
          searchedFor: clientName,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      clientId = resolution.clientId;
      console.log(`[RESOLVE] "${clientName}" resolved to client ${clientId} (${resolution.matchedName})`);
    }

    if (!clientId) {
      return new Response(JSON.stringify({
        ok: false,
        needsVerification: true,
        message: "I need a client name to analyze. Who would you like me to look up?",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [detailResp, docsResp] = await Promise.all([
      fetchCreditGuardian({ action: "get_client_detail", params: { client_id: clientId } }),
      fetchCreditGuardian({ action: "get_documents", params: { client_id: clientId } }),
    ]);
    if (!detailResp.ok) throw new Error(`get_client_detail failed: ${detailResp.status}`);
    if (!docsResp.ok) throw new Error(`get_documents failed: ${docsResp.status}`);

    const detail = await detailResp.json();
    const docs = await docsResp.json();
    const detailObj = detail as Record<string, unknown>;
    const docsObj = docs as Record<string, unknown>;
    const matchedDisplayName =
      cgDisplayName(detailObj) ||
      (typeof clientName === "string" ? clientName.trim() : "");

    const retrievalTask = inferRetrievalTaskFromDocs(docsObj);
    const caseState = extractCaseStateFromDetailDocs(detailObj, docsObj);
    const intentSummary =
      buildRetrievalIntentSummary(retrievalTask, detailObj, docsObj) + formatTriggersForRetrievalQuery(caseState);
    const intentLabel =
      retrievalTask === "response_analysis"
        ? "review bureau response rebuttal verification"
        : "analyze credit dispute strategy FCRA";
    let retrieved = await retrieveKnowledge(
      supabase,
      caseState,
      { intentLabel, task: retrievalTask },
      {
        task: retrievalTask,
        intentSummary,
        caseStateSummary: intentSummary.slice(0, 800),
        maxItems: 8,
      },
    );
    retrieved = await ensureBroadModePrimaryAnchor(supabase, retrieved, caseState, 8, {
      intentLabel,
      task: retrievalTask,
    });

    const userPrompt = assembleCreditAnalysisUserPrompt({
      detail: detailObj,
      docs: docsObj,
      retrieved,
      taskInstruction: "Return the required strategy object.",
    });

    const analysis = await callClaudeJSON<Record<string, unknown>>(SYSTEM_PROMPT, userPrompt, {
      required: ["priority_disputes", "bureau_strategies", "risk_flags", "next_steps"],
    });

    const { data: row, error } = await supabase
      .from("credit_analyses")
      .insert({
        client_id: clientId,
        analysis: analysis,
        model: "claude-sonnet-4-20250514",
      })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message || JSON.stringify(error));

    return new Response(JSON.stringify({
      ok: true,
      analysis_id: row.id,
      created_at: row.created_at,
      client_id: clientId,
      matched_display_name: matchedDisplayName || undefined,
      analysis,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[analyze-credit-strategy] Error:", err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || JSON.stringify(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
