/**
 * Pure helper functions for deterministic workflow routing.
 * Used by telegram-webhook edge function and tested via Vitest.
 */

export interface WorkflowEntry {
  key: string;
  name: string;
  description: string;
  trigger_phrases: string[];
  tools: string[];
}

export function normalizeText(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

export function matchWorkflows(
  input: string,
  workflows: WorkflowEntry[]
): { matches: WorkflowEntry[]; chosen?: WorkflowEntry } {
  const norm = normalizeText(input);
  if (!norm) return { matches: [] };

  const matched: WorkflowEntry[] = [];

  for (const wf of workflows) {
    for (const phrase of wf.trigger_phrases) {
      const np = normalizeText(phrase);
      if (
        norm === np ||
        norm.includes(np) ||
        (norm.length >= 4 && np.includes(norm))
      ) {
        matched.push(wf);
        break; // one match per workflow is enough
      }
    }
  }

  if (matched.length === 1) {
    return { matches: matched, chosen: matched[0] };
  }
  return { matches: matched };
}

export function formatWorkflowList(
  workflows: WorkflowEntry[],
  implementedKeys: Set<string>
): string {
  if (!workflows.length) return "No workflows registered.";

  const lines = workflows.map((wf) => {
    const status = implementedKeys.has(wf.key) ? "✅ Implemented" : "⚠️ Not Implemented";
    const triggers = (wf.trigger_phrases || []).slice(0, 4).join(", ");
    const tools = (wf.tools || []).join(", ") || "—";
    return [
      `*${wf.name}* — \`${wf.key}\``,
      `  ${wf.description}`,
      `  Triggers: ${triggers}`,
      `  Tools: ${tools}`,
      `  Status: ${status}`,
    ].join("\n");
  });

  return `📋 *Workflow Registry*\n\n${lines.join("\n\n")}`;
}

export function formatNoMatch(workflows: WorkflowEntry[]): string {
  const suggestions = workflows
    .slice(0, 6)
    .map((wf) => `• *${wf.name}* — try: \`${wf.trigger_phrases[0] || wf.key}\``)
    .join("\n");

  return [
    "❓ No matching workflow for that request.",
    "",
    "Run /workflows to see everything available.",
    "",
    "Suggestions:",
    suggestions,
  ].join("\n");
}

export function generateHeaderDedupeKey(taskId: string): string {
  return `task:${taskId}:header`;
}
