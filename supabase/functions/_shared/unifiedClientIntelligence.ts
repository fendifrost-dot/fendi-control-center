/**
 * Unified Client Intelligence Layer (credit domain).
 * Gathers cross-system state (Hub DB + Credit Guardian + Drive) and recommends next actions.
 * Does not replace workflows — injects grounding for tool orchestration.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "./creditGuardian.ts";
import { fuzzyClientSearch } from "./fuzzyClientSearch.ts";

export type CreditNextActionKind =
  | "create_compass_client"
  | "ingest_drive"
  | "run_compass_analysis"
  | "generate_disputes"
  | "run_guardian_analysis"
  | "generate_rebuttal"
  | "escalate_dispute"
  | "follow_user_intent";

export interface UnifiedCaseState {
  clientNameQuery: string;
  hubClientId: string | null;
  hubClientName: string | null;
  cgClientId: string | null;
  cgLegalName: string | null;
  existsInGuardian: boolean;
  /** Heuristic: Hub has credit_analyses and/or CG has matters. */
  existsInCompass: boolean;
  existsInDrive: boolean;
  timelineEventCount: number;
  matterCount: number;
  hasDisputeMatters: boolean;
  responseRowCount: number;
  actionAttachmentRowCount: number;
  hubDocumentCount: number;
  hubCreditAnalysisCount: number;
  driveFolderMatches: string[];
  hasNewData: boolean;
  recommendedNext: CreditNextActionKind;
  rationale: string;
}

function cgDisplayName(c: Record<string, unknown>): string {
  const n = c.name ?? c.legal_name ?? c.preferred_name;
  return typeof n === "string" ? n : "";
}

async function listDriveSubfolderNames(): Promise<string[]> {
  const key = Deno.env.get("Google_Cloud_Key");
  const raw = Deno.env.get("DRIVE_FOLDER_ID");
  if (!key || !raw) return [];
  const folderId = raw.includes("/folders/")
    ? raw.split("/folders/").pop()!.split("?")[0]
    : raw;
  const q = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(name)&key=${key}&pageSize=100`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const j = await resp.json();
    const files = j.files as Array<{ name?: string }> | undefined;
    return (files ?? []).map((f) => String(f.name || "")).filter(Boolean);
  } catch {
    return [];
  }
}

function nameMatchesFolder(query: string, folderName: string): boolean {
  const q = query.toLowerCase().trim();
  const f = folderName.toLowerCase().trim();
  if (q.length < 2) return false;
  return f.includes(q) || q.includes(f) || f.split(/\s+/).some((t) => t.length > 2 && q.includes(t));
}

/**
 * Broad client name extraction for credit messages (deterministic; LLM refines).
 */
export function extractCreditClientNameLoose(userMessage: string, conversationContext: string): string | null {
  const combined = `${userMessage}\n${conversationContext}`;
  const tryTrim = (s: string) => s.replace(/\b(my|the|a|our)\b/gi, "").trim();

  const patterns: RegExp[] = [
    /\banaly[sz]e\s+(.+?)\s+credit\b/i,
    /\badd\s+(.+?)\s+to\s+credit(\s+guardian)?\b/i,
    /\b(?:for|about|client)\s+([A-Za-z][A-Za-z0-9\s.'-]{1,60})(?:\s+credit|\s+report|\s*$)/i,
    /\b(?:sync|ingest)\s+(?:drive\s+)?(?:for\s+)?([A-Za-z][A-Za-z0-9\s.'-]{1,60})\b/i,
  ];
  for (const p of patterns) {
    const m = userMessage.match(p) || combined.match(p);
    if (m?.[1]) {
      const name = tryTrim(m[1]);
      if (name.length >= 2 && name.length <= 80) return name;
    }
  }
  return null;
}

function decideNext(state: Omit<UnifiedCaseState, "recommendedNext" | "rationale">): {
  recommendedNext: CreditNextActionKind;
  rationale: string;
} {
  const anywhere =
    state.existsInGuardian || state.hubClientId !== null || state.existsInDrive;

  if (!anywhere) {
    return {
      recommendedNext: "create_compass_client",
      rationale: "No Hub client, CG client, or Drive folder match — create/link client in Compass (or add Drive folder) first.",
    };
  }

  if (state.existsInDrive && state.timelineEventCount === 0 && state.hubDocumentCount === 0) {
    return {
      recommendedNext: "ingest_drive",
      rationale: "Drive folder exists but no timeline events or Hub documents — run Drive ingest to push data to Credit Guardian.",
    };
  }

  if (state.existsInGuardian && state.timelineEventCount > 0 && state.hubCreditAnalysisCount === 0) {
    return {
      recommendedNext: "run_guardian_analysis",
      rationale: "Timeline data exists but no stored Hub credit analysis — run analyze credit strategy.",
    };
  }

  if (state.hubCreditAnalysisCount > 0 && !state.hasDisputeMatters && state.actionAttachmentRowCount === 0) {
    return {
      recommendedNext: "generate_disputes",
      rationale: "Analysis exists; no dispute actions logged — generate dispute letters.",
    };
  }

  if (state.responseRowCount > 0) {
    return {
      recommendedNext: "generate_rebuttal",
      rationale: "Bureau/creditor responses present — draft rebuttal or escalation.",
    };
  }

  if (state.existsInGuardian && state.timelineEventCount > 5 && state.responseRowCount === 0) {
    return {
      recommendedNext: "escalate_dispute",
      rationale: "Multiple timeline events but no responses — consider escalation or method-of-verification.",
    };
  }

  return {
    recommendedNext: "follow_user_intent",
    rationale: "State is ambiguous or balanced — follow the user’s stated request with tools.",
  };
}

export async function gatherUnifiedClientState(
  supabase: SupabaseClient,
  clientNameQuery: string,
): Promise<UnifiedCaseState> {
  const q = clientNameQuery.trim();
  let hubClientId: string | null = null;
  let hubClientName: string | null = null;

  try {
    const fuzzy = await fuzzyClientSearch(q, { excludeCreditPipelineClients: false });
    if (fuzzy.exactMatch && !fuzzy.needsVerification) {
      hubClientId = fuzzy.exactMatch.id;
      hubClientName = fuzzy.exactMatch.name;
    } else if (fuzzy.fuzzyMatches.length === 1 && fuzzy.fuzzyMatches[0].confidence >= 0.7) {
      hubClientId = fuzzy.fuzzyMatches[0].id;
      hubClientName = fuzzy.fuzzyMatches[0].name;
    }
  } catch {
    /* ignore */
  }

  let cgClientId: string | null = null;
  let cgLegalName: string | null = null;
  let timelineEventCount = 0;
  let matterCount = 0;
  let hasDisputeMatters = false;
  let responseRowCount = 0;
  let actionAttachmentRowCount = 0;

  try {
    const resp = await fetchCreditGuardian({ action: "get_clients" });
    if (resp.ok) {
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const lower = q.toLowerCase();
      const match = rows.find((c: Record<string, unknown>) => {
        const n = cgDisplayName(c).toLowerCase();
        return n === lower || n.includes(lower) || lower.includes(n);
      }) as Record<string, unknown> | undefined;
      if (match?.id) {
        cgClientId = String(match.id);
        cgLegalName = cgDisplayName(match) || null;
        const detailResp = await fetchCreditGuardian({
          action: "get_client_detail",
          params: { client_id: cgClientId },
        });
        if (detailResp.ok) {
          const detail = await detailResp.json();
          const events = Array.isArray(detail?.events) ? detail.events : [];
          const matters = Array.isArray(detail?.matters) ? detail.matters : [];
          timelineEventCount = events.length;
          matterCount = matters.length;
          hasDisputeMatters = matters.some((m: Record<string, unknown>) =>
            String(m.matter_type ?? m.title ?? "").toLowerCase().includes("dispute")
          );
          const docsResp = await fetchCreditGuardian({
            action: "get_documents",
            params: { client_id: cgClientId },
          });
          if (docsResp.ok) {
            const docs = await docsResp.json();
            const responses = Array.isArray(docs?.responses) ? docs.responses : [];
            const actions = Array.isArray(docs?.actions) ? docs.actions : [];
            responseRowCount = responses.length;
            actionAttachmentRowCount = actions.length;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  let hubDocumentCount = 0;
  let hubCreditAnalysisCount = 0;
  if (hubClientId) {
    const { count: dc } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("client_id", hubClientId)
      .eq("is_deleted", false);
    hubDocumentCount = dc ?? 0;
  }
  // credit_analyses.client_id is stored as Fairway UUID when resolved via CG (see analyze-credit-strategy).
  const analysisClientId = cgClientId ?? hubClientId;
  if (analysisClientId) {
    const { count: ac } = await supabase
      .from("credit_analyses")
      .select("id", { count: "exact", head: true })
      .eq("client_id", analysisClientId);
    hubCreditAnalysisCount = ac ?? 0;
  }

  const driveNames = await listDriveSubfolderNames();
  const driveFolderMatches = driveNames.filter((n) => nameMatchesFolder(q, n));
  const existsInDrive = driveFolderMatches.length > 0;

  const existsInGuardian = cgClientId !== null;
  const existsInCompass = hubCreditAnalysisCount > 0 || matterCount > 0;

  const hasNewData = hubDocumentCount > 0 && hubCreditAnalysisCount === 0;

  const base: Omit<UnifiedCaseState, "recommendedNext" | "rationale"> = {
    clientNameQuery: q,
    hubClientId,
    hubClientName,
    cgClientId,
    cgLegalName,
    existsInGuardian,
    existsInCompass,
    existsInDrive,
    timelineEventCount,
    matterCount,
    hasDisputeMatters,
    responseRowCount,
    actionAttachmentRowCount,
    hubDocumentCount,
    hubCreditAnalysisCount,
    driveFolderMatches,
    hasNewData,
  };

  const { recommendedNext, rationale } = decideNext(base);
  return { ...base, recommendedNext, rationale };
}

export function formatUnifiedIntelForPrompt(state: UnifiedCaseState): string {
  const lines = [
    "### UNIFIED CREDIT INTELLIGENCE (system — use for tool choice; do not invent facts)",
    `Client query: "${state.clientNameQuery}"`,
    `- Hub client: ${state.hubClientId ? `${state.hubClientName} (${state.hubClientId})` : "not resolved"}`,
    `- Credit Guardian (Fairway): ${state.existsInGuardian ? `yes — ${state.cgLegalName ?? state.cgClientId}` : "no"}`,
    `- Drive folder name match: ${state.existsInDrive ? state.driveFolderMatches.join(", ") : "none under DRIVE_FOLDER_ID"}`,
    `- Timeline events (CG): ${state.timelineEventCount}`,
    `- Matters (CG): ${state.matterCount}${state.hasDisputeMatters ? " (has dispute-related)" : ""}`,
    `- Responses / dispute actions with attachments (CG): ${state.responseRowCount} / ${state.actionAttachmentRowCount}`,
    `- Hub documents / stored analyses: ${state.hubDocumentCount} / ${state.hubCreditAnalysisCount}`,
    `- Heuristic "Compass/analysis present": ${state.existsInCompass}`,
    `- Recommended next action: **${state.recommendedNext}** — ${state.rationale}`,
    "",
    "Respond to the user with: where the client was found (Drive / Guardian / Hub), current stage, and align tools with the recommended next action unless the user explicitly asked for something else.",
  ];
  return lines.join("\n");
}
