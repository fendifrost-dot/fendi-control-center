/**
 * Credit Decision Engine — deterministic intent resolver + case-state checker.
 * Layered ON TOP of existing workflows. Does NOT modify or replace any existing logic.
 * 
 * Flow: detectCreditDomain → resolveIntent → checkCaseState → determineAction
 * 
 * Returns an action descriptor that the telegram-webhook can execute via existing
 * AGENT_TOOLS / workflow machinery. Never executes tools directly.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// ─── Types ──────────────────────────────────────────────────────

export type CreditIntent =
  | "create_client"
  | "analyze_credit"
  | "check_progress"
  | "generate_dispute"
  | "review_response"
  | "fix_missing_report"
  | "add_to_credit_guardian"
  | "general_credit_query";

export interface CaseState {
  clientExists: boolean;
  clientId: string | null;
  clientName: string | null;
  clientPipeline: string | null;
  hasReports: boolean;
  reportCount: number;
  bureausCovered: string[];
  hasObservations: boolean;
  observationCount: number;
  hasDisputeLetters: boolean;
  disputeLetterCount: number;
  pendingDisputeCount: number;
  hasCreditAnalysis: boolean;
  latestAnalysisId: string | null;
  hasNewDocsSinceLastAnalysis: boolean;
}

export interface CreditAction {
  /** Which existing workflow key to route to */
  workflowKey: string;
  /** Tool name to call directly (deterministic bypass) */
  toolName?: string;
  /** Args to pass to the tool */
  toolArgs?: Record<string, unknown>;
  /** Human-readable confirmation message to send BEFORE execution */
  confirmationMessage: string;
  /** Suggested next step to include in the response AFTER execution */
  nextStep: string;
  /** Whether the engine is confident enough to auto-execute */
  autoExecute: boolean;
  /** If false, ask a clarifying question instead */
  clarificationNeeded?: string;
}

export interface DecisionResult {
  isCreditDomain: boolean;
  intent: CreditIntent | null;
  extractedClientName: string | null;
  caseState: CaseState | null;
  action: CreditAction | null;
  /** Confidence 0-1 in the intent classification */
  confidence: number;
}

// ─── Domain Detection ───────────────────────────────────────────

const CREDIT_DOMAIN_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  // High confidence
  { pattern: /\bcredit\s*(report|score|bureau|dispute|guardian|compass|strategy|analysis|repair|file)\b/i, weight: 1.0 },
  { pattern: /\b(equifax|experian|transunion)\b/i, weight: 1.0 },
  { pattern: /\bdispute\s*(letter|strategy|item)\b/i, weight: 1.0 },
  { pattern: /\bfcra\b/i, weight: 1.0 },
  { pattern: /\bcredit\s*guardian\b/i, weight: 1.0 },
  { pattern: /\bcredit\s*compass\b/i, weight: 1.0 },
  { pattern: /\btradeline/i, weight: 0.9 },
  { pattern: /\bcollection\s*(account|item)/i, weight: 0.9 },
  { pattern: /\bcharge\s*off/i, weight: 0.9 },
  { pattern: /\blate\s*payment/i, weight: 0.85 },
  { pattern: /\bnegative\s*(item|account|mark)/i, weight: 0.85 },
  // Medium confidence
  { pattern: /\b(add|create|build|start)\b.*\bclient\b.*\bcredit\b/i, weight: 0.8 },
  { pattern: /\badd\b.*\b(to|in)\b.*\bcredit\s*guardian\b/i, weight: 1.0 },
  { pattern: /\bpull\b.*\breport\b/i, weight: 0.7 },
  { pattern: /\banalyze\b.*\bcredit\b/i, weight: 0.95 },
  { pattern: /\brun\b.*\bcredit\b/i, weight: 0.8 },
  { pattern: /\bcheck\b.*\bcredit\b/i, weight: 0.75 },
  { pattern: /\bcredit\b.*\b(status|progress|update)\b/i, weight: 0.8 },
  { pattern: /\bnew\s*(bureau|report)\b/i, weight: 0.7 },
  { pattern: /\bresponse\b.*\b(bureau|creditor)\b/i, weight: 0.8 },
  { pattern: /\b(bureau|creditor)\b.*\bresponse\b/i, weight: 0.8 },
  { pattern: /\brebuttal\b/i, weight: 0.85 },
];

/** Non-credit signals that should suppress credit routing even if "credit" appears */
const NON_CREDIT_SUPPRESSORS = [
  /\btax\b.*\bcredit\b/i,             // "tax credit" is NOT credit repair
  /\bcredit\s*card\s*payment/i,         // generic financial
  /\bearned\s*income\s*credit/i,        // tax credit
  /\bchild\s*tax\s*credit/i,
];

export function detectCreditDomain(text: string): { isCreditDomain: boolean; confidence: number } {
  const lower = text.toLowerCase();

  // Check suppressors first
  for (const sup of NON_CREDIT_SUPPRESSORS) {
    if (sup.test(lower)) {
      return { isCreditDomain: false, confidence: 0 };
    }
  }

  let maxWeight = 0;
  for (const { pattern, weight } of CREDIT_DOMAIN_PATTERNS) {
    if (pattern.test(text)) {
      maxWeight = Math.max(maxWeight, weight);
    }
  }

  return { isCreditDomain: maxWeight >= 0.6, confidence: maxWeight };
}

// ─── Intent Resolution ──────────────────────────────────────────

export function resolveIntent(text: string): { intent: CreditIntent; confidence: number; extractedName: string | null } {
  const lower = text.toLowerCase();

  // Extract client name from common patterns
  const extractedName = extractCreditClientName(text);

  // create_client
  if (/\b(add|create|new|build|start|set\s*up)\b.*\b(client|file|profile)\b/i.test(lower) ||
      /\b(add|create)\b.*\b(to|in)\b.*\bcredit\s*(guardian|compass)\b/i.test(lower) ||
      /\bblank\s*client\b/i.test(lower)) {
    return { intent: "add_to_credit_guardian", confidence: 0.95, extractedName };
  }

  // review_response — bureau/creditor response received
  if (/\b(response|replied|answer|received)\b.*\b(bureau|creditor|equifax|experian|transunion)\b/i.test(lower) ||
      /\b(bureau|creditor|equifax|experian|transunion)\b.*\b(response|replied|answered|sent\s*back)\b/i.test(lower) ||
      /\brebuttal\b/i.test(lower)) {
    return { intent: "review_response", confidence: 0.9, extractedName };
  }

  // fix_missing_report — bureau not showing, disclosure issues
  if (/\b(missing|not\s*showing|no\s*report|can'?t\s*find|disclosure)\b.*\b(report|bureau|credit)\b/i.test(lower) ||
      /\b(bureau|report)\b.*\b(missing|not\s*(showing|found)|unavailable)\b/i.test(lower)) {
    return { intent: "fix_missing_report", confidence: 0.85, extractedName };
  }

  // generate_dispute — explicit dispute generation
  if (/\b(generate|create|write|draft|send)\b.*\bdispute\b/i.test(lower) ||
      /\bdispute\s*letter/i.test(lower)) {
    return { intent: "generate_dispute", confidence: 0.95, extractedName };
  }

  // check_progress — status/progress inquiries
  if (/\b(check|show|what'?s|how'?s|status|progress|update)\b.*\bcredit\b/i.test(lower) ||
      /\bcredit\b.*\b(status|progress|update)\b/i.test(lower)) {
    return { intent: "check_progress", confidence: 0.8, extractedName };
  }

  // analyze_credit — the most common intent
  if (/\b(analyze|analysis|run|process|pull|review)\b.*\bcredit\b/i.test(lower) ||
      /\bcredit\b.*\b(analyze|analysis|strategy|report)\b/i.test(lower) ||
      /\b(equifax|experian|transunion)\b.*\b(report|analyze|pull)\b/i.test(lower)) {
    return { intent: "analyze_credit", confidence: 0.9, extractedName };
  }

  return { intent: "general_credit_query", confidence: 0.5, extractedName };
}

// ─── Client Name Extraction ─────────────────────────────────────

function extractCreditClientName(text: string): string | null {
  // "add Jabril to credit guardian"
  const addTo = text.match(/\b(?:add|create|set\s*up|start)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)\s+(?:to|in|on|for)\s+(?:credit\s*(?:guardian|compass)|the\s+system)/i);
  if (addTo?.[1]) return addTo[1].trim();

  // "analyze Jabril credit" / "Jabril's credit"
  const analyzeName = text.match(/\b(?:analyze|check|pull|run|review|process)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*?)(?:'s)?\s+(?:credit|report|dispute|equifax|experian|transunion)/i);
  if (analyzeName?.[1]) return analyzeName[1].trim();

  // "credit report for Jabril"
  const forName = text.match(/\b(?:credit|dispute|report|analysis|strategy)\s+(?:for|of)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/i);
  if (forName?.[1]) return forName[1].trim();

  // "generate dispute letters for Corey"
  const disputeFor = text.match(/\b(?:dispute|generate|create)\s+(?:letters?\s+)?(?:for|of)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/i);
  if (disputeFor?.[1]) return disputeFor[1].trim();

  // "check on Jabril" / "how's Jabril doing"
  const checkOn = text.match(/\b(?:check\s+on|how'?s|what'?s\s+(?:going\s+on\s+with|the\s+status\s+(?:of|for)))\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/i);
  if (checkOn?.[1]) {
    const name = checkOn[1].replace(/\s+(credit|doing|going|looking).*$/i, "").trim();
    if (name.length >= 2) return name;
  }

  return null;
}

// ─── Case State Check (read-only DB queries) ────────────────────

export async function checkCaseState(
  supabase: SupabaseClient,
  clientName: string | null,
): Promise<CaseState> {
  const empty: CaseState = {
    clientExists: false,
    clientId: null,
    clientName: null,
    clientPipeline: null,
    hasReports: false,
    reportCount: 0,
    bureausCovered: [],
    hasObservations: false,
    observationCount: 0,
    hasDisputeLetters: false,
    disputeLetterCount: 0,
    pendingDisputeCount: 0,
    hasCreditAnalysis: false,
    latestAnalysisId: null,
    hasNewDocsSinceLastAnalysis: false,
  };

  if (!clientName) return empty;

  // 1) Find client
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, client_pipeline")
    .ilike("name", `%${clientName}%`)
    .limit(5);

  if (!clients || clients.length === 0) return empty;
  const client = clients[0];

  const state: CaseState = {
    ...empty,
    clientExists: true,
    clientId: client.id,
    clientName: client.name,
    clientPipeline: client.client_pipeline,
  };

  // 2) Check documents (credit reports)
  const { data: docs, count: docCount } = await supabase
    .from("documents")
    .select("id, bureau, updated_at", { count: "exact" })
    .eq("client_id", client.id)
    .eq("doc_type", "credit_report")
    .eq("is_deleted", false)
    .limit(20);

  state.reportCount = docCount ?? 0;
  state.hasReports = state.reportCount > 0;
  state.bureausCovered = [...new Set((docs || []).map((d: any) => d.bureau).filter(Boolean))];

  // 3) Check observations
  const { count: obsCount } = await supabase
    .from("observations")
    .select("id", { count: "exact", head: true })
    .eq("client_id", client.id);

  state.observationCount = obsCount ?? 0;
  state.hasObservations = state.observationCount > 0;

  // 4) Check dispute letters
  const { data: disputes, count: disputeCount } = await supabase
    .from("dispute_letters")
    .select("id, status", { count: "exact" })
    .eq("client_id", client.id)
    .limit(50);

  state.disputeLetterCount = disputeCount ?? 0;
  state.hasDisputeLetters = state.disputeLetterCount > 0;
  state.pendingDisputeCount = (disputes || []).filter((d: any) => d.status === "draft").length;

  // 5) Check credit analyses
  const { data: analyses } = await supabase
    .from("credit_analyses")
    .select("id, created_at")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (analyses && analyses.length > 0) {
    state.hasCreditAnalysis = true;
    state.latestAnalysisId = analyses[0].id;

    // Check if any docs are newer than the latest analysis
    const latestAnalysisDate = analyses[0].created_at;
    if (latestAnalysisDate && docs && docs.length > 0) {
      state.hasNewDocsSinceLastAnalysis = docs.some(
        (d: any) => d.updated_at && d.updated_at > latestAnalysisDate
      );
    }
  }

  return state;
}

// ─── Action Determination ───────────────────────────────────────

export function determineAction(
  intent: CreditIntent,
  caseState: CaseState,
  extractedName: string | null,
  confidence: number,
): CreditAction {
  // Low confidence → ask clarifying question
  if (confidence < 0.6) {
    return {
      workflowKey: "",
      autoExecute: false,
      confirmationMessage: "",
      nextStep: "",
      clarificationNeeded: `I think this might be about credit repair, but I'm not sure. Could you clarify what you need? For example:\n• "Analyze [client name] credit report"\n• "Generate dispute letters for [client name]"\n• "Add [client name] to Credit Guardian"`,
    };
  }

  // No client name extracted → ask for it
  if (!extractedName && intent !== "general_credit_query") {
    return {
      workflowKey: "",
      autoExecute: false,
      confirmationMessage: "",
      nextStep: "",
      clarificationNeeded: `I need a client name to proceed. Who would you like me to work on?\n\nExample: "Analyze Jabril's credit report" or "Add Corey to Credit Guardian"`,
    };
  }

  switch (intent) {
    case "add_to_credit_guardian":
      if (caseState.clientExists) {
        return {
          workflowKey: "query_credit_compass",
          toolName: "query_credit_compass",
          toolArgs: { action: "create_assessment", client_name: extractedName },
          autoExecute: true,
          confirmationMessage: `📋 ${extractedName} already exists in the system (pipeline: ${caseState.clientPipeline}). Creating a new credit assessment file.`,
          nextStep: `Upload ${extractedName}'s credit reports to their Drive folder, then say "analyze ${extractedName} credit report" to process them.`,
        };
      }
      return {
        workflowKey: "query_credit_compass",
        toolName: "query_credit_compass",
        toolArgs: { action: "create_assessment", client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `📋 Creating client file for ${extractedName} in Credit Guardian.`,
        nextStep: `Upload ${extractedName}'s credit reports (Equifax, Experian, TransUnion) to their Google Drive folder, then say "analyze ${extractedName} credit report".`,
      };

    case "analyze_credit":
      if (!caseState.clientExists) {
        return {
          workflowKey: "query_credit_compass",
          toolName: "query_credit_compass",
          toolArgs: { action: "create_assessment", client_name: extractedName },
          autoExecute: true,
          confirmationMessage: `🔍 ${extractedName} isn't in the system yet. Creating their client file first.`,
          nextStep: `Upload ${extractedName}'s credit reports to their Drive folder, then run "analyze ${extractedName} credit report" again.`,
        };
      }
      if (!caseState.hasReports) {
        return {
          workflowKey: "analyze_credit_strategy",
          toolName: "analyze_client_credit",
          toolArgs: { client_name: extractedName },
          autoExecute: true,
          confirmationMessage: `🔍 Running Drive sync + credit analysis pipeline for ${extractedName}. No reports on file yet — this will pull any new files from Google Drive.`,
          nextStep: `If no reports are found after sync, upload ${extractedName}'s credit reports to their Google Drive folder.`,
        };
      }
      if (caseState.hasNewDocsSinceLastAnalysis || !caseState.hasCreditAnalysis) {
        return {
          workflowKey: "analyze_credit_strategy",
          toolName: "analyze_credit_strategy",
          toolArgs: { client_name: extractedName },
          autoExecute: true,
          confirmationMessage: `🔍 Running credit strategy analysis for ${extractedName}.\n📄 ${caseState.reportCount} report(s) on file covering: ${caseState.bureausCovered.join(", ") || "unknown bureaus"}\n📊 ${caseState.observationCount} observations extracted`,
          nextStep: caseState.hasDisputeLetters
            ? `${extractedName} has ${caseState.disputeLetterCount} dispute letter(s) on file. Say "generate dispute letters for ${extractedName}" to create new ones based on updated analysis.`
            : `Once analysis is complete, say "generate dispute letters for ${extractedName}" to create FCRA-compliant dispute letters.`,
        };
      }
      // Analysis exists and is up-to-date
      return {
        workflowKey: "analyze_credit_strategy",
        toolName: "get_client_report",
        toolArgs: { client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `📊 ${extractedName} already has an up-to-date credit analysis. Pulling the current report.`,
        nextStep: caseState.hasDisputeLetters
          ? `${extractedName} has ${caseState.disputeLetterCount} dispute letter(s). Say "check on ${extractedName}" for full status, or "generate dispute letters" for a fresh batch.`
          : `Ready to generate dispute letters. Say "generate dispute letters for ${extractedName}".`,
      };

    case "check_progress":
      if (!caseState.clientExists) {
        return {
          workflowKey: "",
          autoExecute: false,
          confirmationMessage: "",
          nextStep: "",
          clarificationNeeded: `I couldn't find ${extractedName} in the system. Would you like me to add them? Say "add ${extractedName} to Credit Guardian".`,
        };
      }
      return {
        workflowKey: "analyze_credit_strategy",
        toolName: "get_client_report",
        toolArgs: { client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `📋 Pulling progress report for ${extractedName}.\n• Reports: ${caseState.reportCount} (${caseState.bureausCovered.join(", ") || "none"})\n• Observations: ${caseState.observationCount}\n• Dispute letters: ${caseState.disputeLetterCount} (${caseState.pendingDisputeCount} pending)`,
        nextStep: caseState.hasNewDocsSinceLastAnalysis
          ? `New documents detected since last analysis. Say "analyze ${extractedName} credit report" to update.`
          : caseState.hasObservations && !caseState.hasDisputeLetters
            ? `Ready for disputes. Say "generate dispute letters for ${extractedName}".`
            : `To update, upload new reports and say "analyze ${extractedName} credit report".`,
      };

    case "generate_dispute":
      if (!caseState.clientExists) {
        return {
          workflowKey: "",
          autoExecute: false,
          confirmationMessage: "",
          nextStep: "",
          clarificationNeeded: `I couldn't find ${extractedName} in the system. Add them first: "add ${extractedName} to Credit Guardian"`,
        };
      }
      if (!caseState.hasObservations) {
        return {
          workflowKey: "analyze_credit_strategy",
          toolName: "analyze_client_credit",
          toolArgs: { client_name: extractedName },
          autoExecute: true,
          confirmationMessage: `⚠️ ${extractedName} has no credit observations yet. Running the full analysis pipeline first (Drive sync → ingestion → analysis).`,
          nextStep: `Once the analysis completes with negative items found, I'll generate the dispute letters automatically. If no negative items are found, no letters can be generated.`,
        };
      }
      return {
        workflowKey: "credit_analysis_and_disputes",
        toolName: "generate_dispute_letters",
        toolArgs: { client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `📝 Generating FCRA-compliant dispute letters for ${extractedName}.\n📊 Based on ${caseState.observationCount} observations across ${caseState.bureausCovered.join(", ") || "bureaus"}`,
        nextStep: `Letters will be generated per bureau. Review each letter before sending. Say "send dispute letter [letter_id]" to approve for delivery.`,
      };

    case "review_response":
      if (!caseState.clientExists) {
        return {
          workflowKey: "",
          autoExecute: false,
          confirmationMessage: "",
          nextStep: "",
          clarificationNeeded: `I couldn't find ${extractedName} in the system. Who received the response?`,
        };
      }
      return {
        workflowKey: "analyze_credit_strategy",
        toolName: "analyze_client_credit",
        toolArgs: { client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `📬 Processing bureau/creditor response for ${extractedName}. Running updated analysis to compare against prior disputes.`,
        nextStep: `After analysis, I'll compare results against prior disputes. If items weren't removed, say "generate dispute letters for ${extractedName}" to create rebuttals.`,
      };

    case "fix_missing_report":
      return {
        workflowKey: "credit_analysis_and_disputes",
        toolName: "analyze_credit_strategy",
        toolArgs: { client_name: extractedName },
        autoExecute: true,
        confirmationMessage: `🔎 Investigating missing report issue for ${extractedName}. Running analysis to identify disclosure/FCRA violations.`,
        nextStep: `If a bureau isn't reporting, I can generate a FCRA §609 disclosure request letter. Say "generate dispute letters for ${extractedName}" after analysis.`,
      };

    case "general_credit_query":
      return {
        workflowKey: "",
        autoExecute: false,
        confirmationMessage: "",
        nextStep: "",
        clarificationNeeded: `I can help with credit repair. Here's what I can do:\n\n• *Add a client:* "Add [name] to Credit Guardian"\n• *Analyze reports:* "Analyze [name] credit report"\n• *Check progress:* "How's [name] doing?"\n• *Generate disputes:* "Generate dispute letters for [name]"\n• *Handle responses:* "[name] got a response from Equifax"\n\nWhat would you like to do?`,
      };

    default:
      return {
        workflowKey: "",
        autoExecute: false,
        confirmationMessage: "",
        nextStep: "",
        clarificationNeeded: `Could you clarify your credit-related request? I can analyze reports, generate disputes, check progress, or add new clients.`,
      };
  }
}

// ─── Main Entry Point ───────────────────────────────────────────

export async function runCreditDecisionEngine(
  supabase: SupabaseClient,
  userMessage: string,
): Promise<DecisionResult> {
  // Step 1: Domain detection
  const { isCreditDomain, confidence: domainConfidence } = detectCreditDomain(userMessage);

  if (!isCreditDomain) {
    return {
      isCreditDomain: false,
      intent: null,
      extractedClientName: null,
      caseState: null,
      action: null,
      confidence: 0,
    };
  }

  // Step 2: Intent resolution
  const { intent, confidence: intentConfidence, extractedName } = resolveIntent(userMessage);

  // Step 3: Case state check (read-only)
  let caseState: CaseState | null = null;
  if (extractedName) {
    try {
      caseState = await checkCaseState(supabase, extractedName);
    } catch (err) {
      console.error("[CreditDecisionEngine] Case state check failed:", err);
      // Continue with null state — action determination handles this
    }
  }

  // Step 4: Determine action
  const overallConfidence = Math.min(domainConfidence, intentConfidence);
  const action = determineAction(
    intent,
    caseState || {
      clientExists: false, clientId: null, clientName: null, clientPipeline: null,
      hasReports: false, reportCount: 0, bureausCovered: [],
      hasObservations: false, observationCount: 0,
      hasDisputeLetters: false, disputeLetterCount: 0, pendingDisputeCount: 0,
      hasCreditAnalysis: false, latestAnalysisId: null, hasNewDocsSinceLastAnalysis: false,
    },
    extractedName,
    overallConfidence,
  );

  return {
    isCreditDomain: true,
    intent,
    extractedClientName: extractedName,
    caseState,
    action,
    confidence: overallConfidence,
  };
}
