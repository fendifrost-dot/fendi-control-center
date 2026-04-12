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
  const has =
    k.disputeExamples.length + k.analysisPatterns.length + k.violationLogic.length > 0;
  if (!has) return "";

  const lines: string[] = [
    "### Retrieved knowledge (prior patterns — use for consistency; ground every claim in client JSON below)",
  ];
  if (k.disputeExamples.length) {
    lines.push("Dispute examples:");
    k.disputeExamples.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (k.analysisPatterns.length) {
    lines.push("Analysis patterns:");
    k.analysisPatterns.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (k.violationLogic.length) {
    lines.push("Violation / statutory logic:");
    k.violationLogic.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  return lines.join("\n");
}

/** User prompt sections in required order: state summary → retrieved → payload → task. */
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

  return [
    summaryLine,
    "",
    retrievedBlock,
    "",
    "Client detail JSON:",
    detailJson,
    "",
    "Client documents JSON:",
    docsJson,
    "",
    opts.taskInstruction,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export function assembleDisputeLetterUserPrompt(opts: {
  detail: Record<string, unknown>;
  disputeItem: Record<string, unknown>;
  retrieved: RetrievedKnowledge;
  taskInstruction: string;
}): string {
  const summaryLine = `Dispute context summary: bureau=${String(opts.disputeItem.bureau ?? "unknown")}; client_detail_present=true.`;
  const retrievedBlock = formatRetrievedKnowledgeSection(opts.retrieved);
  return [
    summaryLine,
    "",
    retrievedBlock,
    "",
    "Client detail JSON:",
    JSON.stringify(opts.detail).slice(0, 60_000),
    "",
    "Dispute item JSON:",
    JSON.stringify(opts.disputeItem),
    "",
    opts.taskInstruction,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
