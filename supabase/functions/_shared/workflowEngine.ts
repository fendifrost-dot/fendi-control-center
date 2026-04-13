import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { extractClientNameForTaxCommand } from "./taxTelegramParse.ts";

export type WorkflowIntent = "generate_tax_return" | "check_drive" | "add_manual_inputs";

export type IntentResult = {
  intent: WorkflowIntent;
  confidence: number;
  entities: {
    client_name: string | null;
    tax_year: number | null;
  };
  message: string;
};

export function resolveIntent(message: string): IntentResult {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const yearMatch = text.match(/\b(20[0-3]\d)\b/);
  const tax_year = yearMatch ? Number(yearMatch[1]) : null;
  const client_name = extractClientNameForTaxCommand(text);

  if (/\bcheck\s+drive\b/i.test(lower)) {
    return {
      intent: "check_drive",
      confidence: 0.95,
      entities: { client_name, tax_year },
      message: text,
    };
  }
  if (
    /\badd\b.*\b(advertising|mileage|supplies|meals|contracting|expense|deduction|income)\b/i.test(lower) ||
    /\brecord\b.*\b(income|expense|deduction)\b/i.test(lower)
  ) {
    return {
      intent: "add_manual_inputs",
      confidence: 0.9,
      entities: { client_name, tax_year },
      message: text,
    };
  }
  if (/\bgenerate\b.*\btax return\b/i.test(lower) || /\bprepare\b.*\btax/i.test(lower)) {
    return {
      intent: "generate_tax_return",
      confidence: 0.95,
      entities: { client_name, tax_year },
      message: text,
    };
  }

  return {
    intent: "check_drive",
    confidence: 0.2,
    entities: { client_name, tax_year },
    message: text,
  };
}

type WorkflowRunRow = {
  id: string;
  status: string;
  current_stage: string;
  locked_state: Record<string, unknown> | null;
};

export async function createWorkflowRun(
  supabase: SupabaseClient,
  intentResult: IntentResult,
): Promise<WorkflowRunRow> {
  const taxYear = intentResult.entities.tax_year ?? new Date().getFullYear();
  const clientName = intentResult.entities.client_name ?? "unknown";

  const { data: existing } = await supabase
    .from("workflow_runs")
    .select("id,status,current_stage,locked_state")
    .eq("intent", intentResult.intent)
    .eq("client_name", clientName)
    .eq("tax_year", taxYear)
    .in("status", ["running", "waiting_async"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return existing as WorkflowRunRow;
  }

  const payload = {
    client_name: clientName,
    tax_year: taxYear,
    intent: intentResult.intent,
    status: "running",
    current_stage: "load_state",
    locked_state: {
      client_name: clientName,
      tax_year: taxYear,
      intent: intentResult.intent,
      message: intentResult.message,
    },
  };

  const { data, error } = await supabase
    .from("workflow_runs")
    .insert(payload)
    .select("id,status,current_stage,locked_state")
    .single();
  if (error || !data) {
    throw new Error(`createWorkflowRun failed: ${error?.message || "unknown"}`);
  }
  return data as WorkflowRunRow;
}
