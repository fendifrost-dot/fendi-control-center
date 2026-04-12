/**
 * Composes credit AI prompts: system rules + client state summary + retrieved knowledge + task instruction.
 * No database access.
 */

import type { CreditRetrievalTask, RetrievedKnowledge } from "./retrieveRelevantKnowledge.ts";

export function formatClientStateSummaryLine(detail: Record<string, unknown>, docs: Record<string, unknown>): string {
  const events = Array.isArray(detail.events) ? detail.events.length : 0;
  const matters = Array.isArray(detail.matters) ? detail.matters.length : 0;
  const respA = Array.isArray(docs.responses) ? docs.responses.length : 0;
  const actA = Array.isArray(docs.actions) ? docs.actions.length : 0;
  const client = detail.client && typeof detail.client === "object"
    ? (detail.client as Record<string, unknown>)
    : {};
  const name = String(client.legal_name ?? client.preferred_name ?? "unknown");
  return `Client state summary: name=${name}; timeline_events=${events}; matters=${matters}; document_actions=${actA}; document_responses=${respA}.`;
}

export function inferRetrievalTaskFromDocs(
  docs: Record<string, unknown>,
): CreditRetrievalTask {
  const n = Array.isArray(docs.responses) ? docs.responses.length : 0;
  return n > 0 ? "response_analysis" : "credit_analysis";
}

export function buildRetrievalIntentSummary(
  task: CreditRetrievalTask,
  detail: Record<string, unknown>,
  docs: Record<string, unknown>,
): string {
  const parts = [`task=${task}`];
  if (task === "response_analysis") {
    parts.push(`response_docs=${Array.isArray(docs.responses) ? docs.responses.length : 0}`);
  }
  const ev = Array.isArray(detail.events) ? detail.events.length : 0;
  parts.push(`events=${ev}`);
  return parts.join("; ").slice(0, 1200);
}

export function formatRetrievedKnowledgeSection(k: RetrievedKnowledge): string {
  const lines: string[] = [];
  const pushTyped = (type: string, arr: string[]) => {
    for (const x of arr) {
      lines.push(`- [type: ${type}] ${x}`);
    }
  };
  pushTyped("dispute_example", k.disputeExamples);
  pushTyped("analysis_pattern", k.analysisPatterns);
  pushTyped("violation_logic", k.violationLogic);
  if (lines.length === 0) return "";
  return ["RELEVANT KNOWLEDGE:", ...lines].join("\n");
}

/** User prompt sections: CLIENT STATE → RELEVANT KNOWLEDGE (if any) → JSON payloads → TASK. */
export function assembleCreditAnalysisUserPrompt(opts: {
  detail: Record<string, unknown>;
  docs: Record<string, unknown>;
  retrieved: RetrievedKnowledge;
  taskInstruction: string;
}): string {
  const summaryLine = formatClientStateSummaryLine(opts.detail, opts.docs);
  const retrievedBlock = formatRetrievedKnowledgeSection(opts.retrieved);
  const detailJson = JSON.stringify(opts.detail).slice(0, 80_000);
  const docsJson = JSON.stringify(opts.docs).slice(0, 30_000);

  const parts: string[] = ["CLIENT STATE:", summaryLine, ""];
  if (retrievedBlock) {
    parts.push(retrievedBlock, "");
  }
  parts.push(
    "Client detail JSON:",
    detailJson,
    "",
    "Client documents JSON:",
    docsJson,
    "",
    "TASK:",
    opts.taskInstruction,
  );
  return parts.join("\n");
}

export function assembleDisputeLetterUserPrompt(opts: {
  detail: Record<string, unknown>;
  disputeItem: Record<string, unknown>;
  retrieved: RetrievedKnowledge;
  taskInstruction: string;
}): string {
  const summaryLine = `bureau=${String(opts.disputeItem.bureau ?? "unknown")}; account=${String(opts.disputeItem.account_name ?? opts.disputeItem.account ?? "")}; client_detail_present=true.`;
  const retrievedBlock = formatRetrievedKnowledgeSection(opts.retrieved);
  const parts: string[] = ["CLIENT STATE:", summaryLine, ""];
  if (retrievedBlock) {
    parts.push(retrievedBlock, "");
  }
  parts.push(
    "Client detail JSON:",
    JSON.stringify(opts.detail).slice(0, 60_000),
    "",
    "Dispute item JSON:",
    JSON.stringify(opts.disputeItem),
    "",
    "TASK:",
    opts.taskInstruction,
  );
  return parts.join("\n");
}
