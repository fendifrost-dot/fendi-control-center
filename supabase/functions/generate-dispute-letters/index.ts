import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { assembleDispute, buildDisputeAssemblyClientState } from "../_shared/assembleDispute.ts";
import {
  applyEscalationConfidenceGate,
  applyPersistedUncertaintyEscalationBias,
  buildEscalationCaseState,
  determineEscalationLevel,
} from "../_shared/disputeEscalation.ts";
import { nextActionFor, shouldBlockDisputeGeneration } from "../_shared/disputeGenerationGate.ts";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import {
  ensureBroadModePrimaryAnchor,
  extractCaseStateFromDetailDocs,
  formatTriggersForRetrievalQuery,
  mergeWarningFlagsForPersistence,
  retrieveKnowledge,
  type RetrievalCompositionOptions,
} from "../_shared/creditKnowledgeRetrieval.ts";
import { validateDisputeStrategy } from "../_shared/validateDisputeStrategy.ts";
import { getAccessToken, searchDriveFolder, uploadFileToDrive } from "../_shared/googleDriveUpload.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function normalizeDriveRootId(): string | null {
  const raw = Deno.env.get("DRIVE_FOLDER_ID");
  if (!raw) return null;
  return raw.includes("/folders/") ? raw.split("/folders/").pop()!.split("?")[0] : raw;
}

function displayNameFromDetail(d: Record<string, unknown>): string {
  const n = d.name ?? d.legal_name ?? d.preferred_name;
  return typeof n === "string" && n.trim() ? n.trim() : "Client";
}

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

    const caseState = extractCaseStateFromDetailDocs(detailObj, {});
    const intentSummary = [
      `task=dispute_generation`,
      `bureau=${String(disputeItem.bureau ?? "unknown")}`,
      `account=${String(disputeItem.account_name ?? disputeItem.account ?? "")}`.slice(0, 400),
    ].join("; ") + formatTriggersForRetrievalQuery(caseState);
    const intentLabel = [
      "generate dispute letter",
      String(disputeItem.bureau ?? ""),
      String(disputeItem.account_name ?? disputeItem.account ?? ""),
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);

    const triggers = caseState.triggers?.length
      ? caseState.triggers
      : caseState.trigger
      ? [caseState.trigger]
      : [];

    const escalationInput = buildEscalationCaseState(detailObj, triggers);
    const escalation = applyPersistedUncertaintyEscalationBias(
      applyEscalationConfidenceGate(
        determineEscalationLevel(escalationInput),
        caseState.triggerConfidence,
      ),
      caseState.warningFlags,
    );

    const composition: RetrievalCompositionOptions = { escalationLevel: escalation.level };

    let retrieved = await retrieveKnowledge(
      supabase,
      caseState,
      { intentLabel, task: "dispute_generation" },
      {
        task: "dispute_generation",
        intentSummary,
        caseStateSummary: intentSummary.slice(0, 800),
        maxItems: 8,
      },
      composition,
    );

    const retrievalCap = 8;
    if (shouldBlockDisputeGeneration(caseState, retrieved)) {
      const vs = validateDisputeStrategy({
        primaryTrigger: caseState.primaryTrigger ?? caseState.trigger ?? null,
        escalationLevel: escalation.level,
        secondaryTriggers: caseState.secondaryTriggers ?? [],
        triggerConfidence: caseState.triggerConfidence,
        triggerEvidence: caseState.triggerEvidence,
      });
      const routing = nextActionFor(caseState.primaryTrigger ?? caseState.trigger);
      return new Response(
        JSON.stringify({
          ok: true,
          blocked: true,
          reason: "insufficient_verified_data",
          message:
            "Insufficient verified data to generate a strong dispute. Additional documentation recommended.",
          next_action: routing.next_action,
          recommended_inputs: [...routing.recommended_inputs],
          case_state_patch: {
            warning_flags: mergeWarningFlagsForPersistence(caseState.warningFlags, vs.warningCodes, {
              triggerConfidence: caseState.triggerConfidence,
            }),
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    retrieved = await ensureBroadModePrimaryAnchor(
      supabase,
      retrieved,
      caseState,
      retrievalCap,
      { intentLabel, task: "dispute_generation" },
    );

    const assembled = assembleDispute({
      clientState: buildDisputeAssemblyClientState(detailObj, disputeItem),
      triggers,
      primaryTrigger: caseState.primaryTrigger ?? caseState.trigger,
      secondaryTriggers: caseState.secondaryTriggers,
      triggerReasoning: caseState.triggerReasoning,
      triggerConfidence: caseState.triggerConfidence,
      triggerEvidence: caseState.triggerEvidence,
      retrievedKnowledge: retrieved,
      escalation,
    });

    const draft: Record<string, unknown> = {
      subject: assembled.subject,
      letter_body: assembled.letterBody,
      bureau: assembled.bureau,
      legal_citations: assembled.legalCitations,
      confidence: assembled.retrievalSparse ? 0.65 : 0.88,
      assembly_mode: "structured",
      escalation_level: escalation.level,
      escalation_strategy: escalation.strategy,
      primary_trigger: assembled.primaryTrigger,
      secondary_triggers: assembled.secondaryTriggers,
      trigger_reasoning: assembled.triggerReasoning,
      trigger_confidence: assembled.triggerConfidence,
      trigger_evidence: caseState.triggerEvidence ?? null,
      strategy_warnings: assembled.strategyWarnings,
      warning_codes: assembled.warningCodes,
      /** Merge into client `case_state.warning_flags` so the next run biases retrieval + escalation. */
      case_state_patch: {
        warning_flags: mergeWarningFlagsForPersistence(caseState.warningFlags, assembled.warningCodes, {
          triggerConfidence: assembled.triggerConfidence,
        }),
      },
    };

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

    let driveUpload: {
      attempted: boolean;
      uploaded: boolean;
      file_name?: string;
      web_view_link?: string;
      error?: string;
    } = { attempted: false, uploaded: false };

    if (Deno.env.get("DISPUTE_LETTERS_UPLOAD_DRIVE") !== "false") {
      const root = normalizeDriveRootId();
      if (root) {
        driveUpload.attempted = true;
        try {
          const token = await getAccessToken();
          const label = displayNameFromDetail(detailObj);
          let folderId = await searchDriveFolder(token, label, root);
          if (!folderId) folderId = await searchDriveFolder(token, label.toUpperCase(), root);
          if (folderId) {
            const safeBureau = String(draft.bureau || "bureau").replace(/[^\w\-]+/g, "_").slice(0, 40);
            const fname = `Dispute-${safeBureau}-${String(row.id).slice(0, 8)}.txt`;
            const textBody = new TextEncoder().encode(
              `Subject: ${assembled.subject}\n\n${assembled.letterBody}`,
            );
            const up = await uploadFileToDrive(token, fname, textBody, "text/plain", folderId);
            driveUpload = {
              attempted: true,
              uploaded: true,
              file_name: fname,
              web_view_link: up.webViewLink,
            };
          }
        } catch (e) {
          driveUpload.error = e instanceof Error ? e.message : String(e);
          console.error("[generate-dispute-letters] Drive upload failed:", e);
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      letter_id: row.id,
      created_at: row.created_at,
      draft,
      drive_upload: driveUpload,
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
