import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { assembleDisputeLetterUserPrompt } from "../_shared/creditPromptComposer.ts";
import { retrieveRelevantKnowledge } from "../_shared/retrieveRelevantKnowledge.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT =
  "You are a compliance-aware credit dispute specialist. The user message includes: a short context line, optional retrieved prior-case dispute examples and violation logic, then client JSON and the dispute item. Use retrieval only when it matches the facts; do not fabricate legal outcomes. Draft concise, formal dispute letters referencing applicable FCRA sections.";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "generate");

    if (action === "send") {
      const letterId = body.letter_id as string;
      if (!letterId) throw new Error("letter_id is required for send");
      const { error } = await supabase
        .from("dispute_letters")
        .update({ status: "approved_to_send" })
        .eq("id", letterId);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true, sent: false, status: "approved_to_send", letter_id: letterId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientId = body.client_id as string;
    const disputeItem = body.dispute_item as Record<string, unknown> | undefined;
    const analysisId = body.analysis_id as string | undefined;
    if (!clientId || !disputeItem) throw new Error("client_id and dispute_item are required");

    const detailResp = await fetchCreditGuardian({ action: "get_client_detail", params: { client_id: clientId } });
    if (!detailResp.ok) throw new Error(`get_client_detail failed: ${detailResp.status}`);
    const detail = await detailResp.json();
    const detailObj = detail as Record<string, unknown>;

    const intentSummary = [
      `task=dispute_generation`,
      `bureau=${String(disputeItem.bureau ?? "unknown")}`,
      `account=${String(disputeItem.account_name ?? disputeItem.account ?? "")}`.slice(0, 400),
    ].join("; ");

    const retrieved = await retrieveRelevantKnowledge({
      task: "dispute_generation",
      intentSummary,
      caseStateSummary: intentSummary.slice(0, 800),
      maxItems: 8,
    });

    const userPrompt = assembleDisputeLetterUserPrompt({
      detail: detailObj,
      disputeItem,
      retrieved,
      taskInstruction: "Return JSON with keys: subject, letter_body, bureau, legal_citations (array), confidence.",
    });

    const draft = await callClaudeJSON<Record<string, unknown>>(SYSTEM_PROMPT, userPrompt, {
      required: ["subject", "letter_body", "bureau"],
    });

    const { data: row, error } = await supabase
      .from("dispute_letters")
      .insert({
        client_id: clientId,
        analysis_id: analysisId ?? null,
        bureau: String(draft.bureau || "unknown"),
        letter_content: String(draft.letter_body || ""),
        status: "draft",
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      letter_id: row.id,
      created_at: row.created_at,
      draft,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
