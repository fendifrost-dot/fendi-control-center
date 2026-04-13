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
  let tax_year = yearMatch ? Number(yearMatch[1]) : null;
  let client_name = extractClientNameForTaxCommand(text);

  // If parser returned a 4-digit year as "name", recover real client from "… for Name"
  if (client_name && /^\d{4}$/.test(client_name.trim())) {
    client_name = null;
  }
  if (!client_name) {
    const forClient = text.match(
      /\b(?:tax\s+return|return)\s+for\s+([A-Za-z][A-Za-z\s.'-]+?)(?:\s*[,\n]|\s+Include\b|\s+Business\b|\s+EIN:|\s+for\s+20\d{2}|$)/i,
    );
    if (forClient?.[1]) {
      client_name = forClient[1].replace(/\s+/g, " ").trim();
    }
  }

  if (/\bcheck\s+drive\b/i.test(lower)) {
    let cn = client_name;
    if (!cn) {
      const m = text.match(/\bcheck\s+drive\b[^\n]*\bfor\s+([A-Za-z][A-Za-z\s.'-]+)/i);
      cn = m?.[1]?.replace(/\s+/g, " ").trim() ?? null;
    }
    if (!tax_year) {
      const y = text.match(/\b(20[0-3]\d)\b/);
      tax_year = y ? Number(y[1]) : null;
    }
    return {
      intent: "check_drive",
      confidence: 0.95,
      entities: { client_name: cn, tax_year },
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

async function resolveClientRow(
  supabase: SupabaseClient,
  nameRaw: string | null,
): Promise<{ id: string; name: string } | null> {
  const trimmed = (nameRaw ?? "").trim();
  if (!trimmed || trimmed === "unknown" || /^\d{4}$/.test(trimmed)) return null;
  const escapeIlike = (s: string) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const { data } = await supabase
    .from("clients")
    .select("id,name")
    .ilike("name", `%${escapeIlike(trimmed)}%`)
    .neq("client_pipeline", "credit")
    .limit(1)
    .maybeSingle();
  if (data?.id && data?.name) return { id: String(data.id), name: String(data.name) };
  return null;
}

export async function createWorkflowRun(
  supabase: SupabaseClient,
  intentResult: IntentResult,
): Promise<WorkflowRunRow> {
  let taxYear = intentResult.entities.tax_year ?? new Date().getFullYear();
  let clientName = intentResult.entities.client_name ?? "unknown";
  if (clientName === "unknown" || /^\d{4}$/.test(clientName.trim())) {
    const re = extractClientNameForTaxCommand(intentResult.message);
    if (re && !/^\d{4}$/.test(re.trim())) clientName = re;
  }

  const resolved = await resolveClientRow(supabase, clientName === "unknown" ? null : clientName);
  const finalClientName = resolved?.name ?? clientName;
  const clientId = resolved?.id ?? null;

  const { data: existing } = await supabase
    .from("workflow_runs")
    .select("id,status,current_stage,locked_state")
    .eq("intent", intentResult.intent)
    .eq("client_name", finalClientName)
    .eq("tax_year", taxYear)
    .in("status", ["running", "waiting_async"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return existing as WorkflowRunRow;
  }

  const payload = {
    client_name: finalClientName,
    tax_year: taxYear,
    intent: intentResult.intent,
    status: "running",
    current_stage: "load_state",
    locked_state: {
      client_name: finalClientName,
      tax_year: taxYear,
      client_id: clientId,
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
